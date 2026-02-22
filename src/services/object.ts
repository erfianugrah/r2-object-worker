/**
 * Core object serving logic.
 *
 * Fetches objects from R2 (via binding or S3 API) and serves them with a
 * two-tier caching strategy:
 *
 * ## Caching tiers
 *
 * 1. **Cache API** (Cloudflare edge cache) — used for objects <= ~28 MB.
 *    Stored via `cache.put()` using a dual FixedLengthStream pump so the
 *    client response streams in parallel with the cache write.
 *
 * 2. **KV cache** (Workers KV) — fallback for objects > ~28 MB where the
 *    Cache API silently drops entries. Uses `.tee()` to split the R2 body:
 *    one branch streams to the client, the other is consumed by
 *    `kvCachePutStream()` which writes 20 MiB chunks incrementally. See
 *    `kv-cache.ts` for the full chunked storage/retrieval implementation.
 *
 * ## Cache lookup order
 *
 *    Cache API → KV cache → R2 origin
 *
 * Both cache layers are best-effort: failures are logged but never kill the
 * request. Cache API hits are identified by Cloudflare's `CF-Cache-Status: HIT`
 * header; KV hits are identified by our `X-KV-Cache-Status: HIT` header.
 *
 * ## Request flow
 *
 * - **Full GET**: check cache → fetch from R2 → stream to client + cache in background
 * - **Range GET**: check cache (Cache API handles Range automatically) → check KV
 *   (KV slices across chunk boundaries) → fetch partial from R2, return 206,
 *   background-cache the full object for next time
 * - **Conditional GET** (If-None-Match / If-Modified-Since): Cache API handles
 *   304 automatically; for origin, R2's `onlyIf` returns body-less R2Object → 304
 * - **HEAD**: same as GET with `ignoreMethod: true` on cache.match()
 */

import { AwsClient } from 'aws4fetch';
import type { StorageConfig, CacheConfig } from '../types';
import { getContentType, getObjectType } from '../utils/content-type';
import { buildResponseHeaders } from '../utils/cache';
import { kvCacheMatch, kvCachePut, kvCachePutStream } from './kv-cache';

/**
 * Threshold above which objects bypass the Cache API and use KV instead.
 * The Cache API has an undocumented ~28.5 MB silent limit (28.5 MB = HIT,
 * 29 MB = MISS, tested at AMS colo). We use 28 MiB as a conservative cutoff.
 */
const CACHE_API_SIZE_LIMIT = 28 * 1024 * 1024; // 28 MiB

// ── R2 binding fetch with retry ───────────────────────────────────────────────

async function r2Get(
	bucket: R2Bucket,
	key: string,
	options: R2GetOptions,
	storageConfig: StorageConfig,
): Promise<R2ObjectBody | R2Object | null> {
	const { maxRetries, retryDelay, exponentialBackoff } = storageConfig;

	for (let attempt = 0; attempt < maxRetries; attempt++) {
		try {
			const obj = await bucket.get(key, options);
			return obj;
		} catch (err) {
			if (attempt === maxRetries - 1) throw err;
			const delay = exponentialBackoff ? retryDelay * Math.pow(2, attempt) : retryDelay;
			await new Promise((r) => setTimeout(r, delay));
		}
	}
	return null;
}

// ── S3 API fetch (alternative to R2 binding) ─────────────────────────────────

// Cache the AwsClient instance — credentials don't change per-request
let cachedS3Client: AwsClient | null = null;
let cachedS3ClientKey = '';

function getS3Client(accessKeyId: string, secretAccessKey: string): AwsClient {
	const key = `${accessKeyId}:${secretAccessKey}`;
	if (cachedS3Client && cachedS3ClientKey === key) return cachedS3Client;
	cachedS3Client = new AwsClient({
		accessKeyId,
		secretAccessKey,
		service: 's3',
		region: 'auto',
	});
	cachedS3ClientKey = key;
	return cachedS3Client;
}

async function s3Fetch(
	s3Endpoint: string,
	accessKeyId: string,
	secretAccessKey: string,
	r2BucketName: string,
	key: string,
	request: Request,
): Promise<Response> {
	const client = getS3Client(accessKeyId, secretAccessKey);

	const s3Url = `${s3Endpoint}/${r2BucketName}/${key}`;

	// Forward Range and conditional headers to S3
	const s3Headers: Record<string, string> = {};
	const rangeHeader = request.headers.get('Range');
	if (rangeHeader) s3Headers['Range'] = rangeHeader;
	const ifNoneMatch = request.headers.get('If-None-Match');
	if (ifNoneMatch) s3Headers['If-None-Match'] = ifNoneMatch;
	const ifModifiedSince = request.headers.get('If-Modified-Since');
	if (ifModifiedSince) s3Headers['If-Modified-Since'] = ifModifiedSince;

	const signedRequest = await client.sign(s3Url, {
		method: 'GET',
		headers: s3Headers,
	});

	return fetch(signedRequest);
}

// ── Main entry point ─────────────────────────────────────────────────────────

export async function getObject(opts: {
	bucket: R2Bucket;
	key: string;
	request: Request;
	ctx: ExecutionContext;
	storageConfig: StorageConfig;
	cacheConfig: CacheConfig;
	bypassCache: boolean;
	customTags?: string[];
	/** Use S3 API instead of R2 binding for fetch + cache */
	useS3?: boolean;
	s3Endpoint?: string;
	s3AccessKeyId?: string;
	s3SecretAccessKey?: string;
	r2BucketName?: string;
	/** KV namespace for caching objects that exceed Cache API's ~28.5MB limit */
	kvCache?: KVNamespace;
}): Promise<Response> {
	const {
		bucket, key, request, ctx,
		storageConfig, cacheConfig,
		bypassCache, customTags,
		useS3, s3Endpoint, s3AccessKeyId, s3SecretAccessKey, r2BucketName,
		kvCache,
	} = opts;

	const cache = (caches as unknown as { default: Cache }).default;
	const cacheUrl = new URL(request.url).toString();

	// For cache.match(): pass the original request so the Cache API can handle
	// Range, If-None-Match, and If-Modified-Since headers automatically
	// (returns 206 for Range, 304 for conditional requests)
	const cacheMatchKey = new Request(cacheUrl, request);

	// For cache.put(): use a plain GET request (we store the full response)
	const cachePutKey = new Request(cacheUrl, { method: 'GET' });

	// ── Cache check (best-effort — never let cache errors kill the request) ──
	if (!bypassCache) {
		try {
			const cached = await cache.match(cacheMatchKey, { ignoreMethod: true });
			if (cached) {
				console.log(`Cache HIT for key "${key}"`);
				return cached;
			}
			console.log(`Cache MISS for key "${key}"`);
		} catch (err) {
			console.error(`Cache match error for key "${key}":`, err);
		}

		// ── KV fallback check (for objects > Cache API limit) ────────────────
		if (kvCache) {
			try {
				const kvCached = await kvCacheMatch(kvCache, cacheUrl, request);
				if (kvCached) {
					console.log(`KV Cache HIT for key "${key}"`);
					return kvCached;
				}
			} catch (err) {
				console.error(`KV cache match error for key "${key}":`, err);
			}
		}
	}

	// ── S3 API path ──────────────────────────────────────────────────────────
	// Alternative fetch path using signed S3 requests instead of R2 bindings.
	// Activated via `?via=s3` query param. Does not currently have KV fallback
	// for large objects — only the R2 binding path does.
	if (useS3 && (!s3Endpoint || !s3AccessKeyId || !s3SecretAccessKey || !r2BucketName)) {
		console.warn(`S3 path requested for key "${key}" but missing config:`,
			{ s3Endpoint: !!s3Endpoint, s3AccessKeyId: !!s3AccessKeyId, s3SecretAccessKey: !!s3SecretAccessKey, r2BucketName: !!r2BucketName });
	}
	if (useS3 && s3Endpoint && s3AccessKeyId && s3SecretAccessKey && r2BucketName) {
		return getObjectViaS3({
			s3Endpoint, s3AccessKeyId, s3SecretAccessKey,
			r2BucketName, key, request, ctx,
			cache, cachePutKey, cacheConfig, bypassCache, customTags,
		});
	}

	// ── R2 binding path ──────────────────────────────────────────────────────
	return getObjectViaR2({
		bucket, key, request, ctx, storageConfig,
		cache, cachePutKey, cacheConfig, bypassCache, customTags,
		kvCache,
	});
}

// ── S3 API implementation ────────────────────────────────────────────────────

async function getObjectViaS3(opts: {
	s3Endpoint: string;
	s3AccessKeyId: string;
	s3SecretAccessKey: string;
	r2BucketName: string;
	key: string;
	request: Request;
	ctx: ExecutionContext;
	cache: Cache;
	cachePutKey: Request;
	cacheConfig: CacheConfig;
	bypassCache: boolean;
	customTags?: string[];
}): Promise<Response> {
	const {
		s3Endpoint, s3AccessKeyId, s3SecretAccessKey,
		r2BucketName, key, request, ctx,
		cache, cachePutKey, cacheConfig, bypassCache, customTags,
	} = opts;

	async function cacheFullFromS3(): Promise<void> {
		const fullRequest = new Request(request.url, { method: 'GET' });
		const fullResponse = await s3Fetch(
			s3Endpoint,
			s3AccessKeyId,
			s3SecretAccessKey,
			r2BucketName,
			key,
			fullRequest,
		);
		if (!fullResponse.ok || !fullResponse.body) return;

		const fullContentType = fullResponse.headers.get('Content-Type') || getContentType(key);
		const fullObjectType = getObjectType(fullContentType);
		const fullSize = parseInt(fullResponse.headers.get('Content-Length') || '0', 10);
		const fullEtag = fullResponse.headers.get('ETag') || '';
		const fullHost = new URL(request.url).hostname;

		const fullHeaders = new Headers();
		fullHeaders.set('Content-Type', fullContentType);
		const cacheResponseHeaders = buildResponseHeaders(fullHeaders, fullObjectType, cacheConfig, {
			etag: fullEtag,
			size: fullSize,
			objectKey: key,
			host: fullHost,
			customTags,
			bypass: false,
		});
		const cacheHeaders = buildCachePutHeaders(cacheResponseHeaders, String(fullSize));
		await cache.put(cachePutKey, new Response(fullResponse.body, { status: 200, headers: cacheHeaders }));
		console.log(`S3 cache.put() succeeded for key "${key}"`);
		try {
			const verify = await cache.match(cachePutKey, { ignoreMethod: true });
			console.log(`S3 cache.verify ${verify ? 'HIT' : 'MISS'} for key "${key}"`);
		} catch (err) {
			console.error(`S3 cache.verify failed for key "${key}":`, err);
		}
	}

	let s3Response: Response;
	try {
		s3Response = await s3Fetch(s3Endpoint, s3AccessKeyId, s3SecretAccessKey, r2BucketName, key, request);
	} catch (err) {
		console.error(`S3 fetch failed for key "${key}":`, err);
		return new Response('Origin Error', { status: 502, headers: { 'Content-Type': 'text/plain' } });
	}

	if (s3Response.status === 404) {
		return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
	}

	if (s3Response.status === 304) {
		return new Response(null, {
			status: 304,
			headers: { ETag: s3Response.headers.get('ETag') || '' },
		});
	}

	if (!s3Response.ok || !s3Response.body) {
		return new Response(`Origin Error: ${s3Response.status}`, {
			status: 502,
			headers: { 'Content-Type': 'text/plain' },
		});
	}

	// Build response headers from S3 response
	const contentType = s3Response.headers.get('Content-Type') || getContentType(key);
	const objectType = getObjectType(contentType);
	const size = parseInt(s3Response.headers.get('Content-Length') || '0', 10);
	const etag = s3Response.headers.get('ETag') || '';
	const host = new URL(request.url).hostname;

	const r2Headers = new Headers();
	r2Headers.set('Content-Type', contentType);

	const headers = buildResponseHeaders(r2Headers, objectType, cacheConfig, {
		etag,
		size,
		objectKey: key,
		host,
		customTags,
		bypass: bypassCache,
	});

	// Mark the response so we can tell which path was used
	headers.set('X-Fetch-Via', 's3');

	// ── Range response from S3 ───────────────────────────────────────────────
	// Don't try to cache partial responses — let a full GET populate the cache.
	// The Cache API automatically serves Range requests from a cached full response.
	if (s3Response.status === 206) {
		if (!bypassCache && request.method === 'GET') {
			ctx.waitUntil((async () => {
				try {
					await cacheFullFromS3();
				} catch (err) {
					console.error(`S3 range cache.put() failed for key "${key}":`, err);
				}
			})());
		}
		const contentRange = s3Response.headers.get('Content-Range');
		if (contentRange) headers.set('Content-Range', contentRange);
		const cl = s3Response.headers.get('Content-Length');
		if (cl) headers.set('Content-Length', cl);
		return new Response(s3Response.body, { status: 206, headers });
	}

	// ── Bypass or HEAD: return without caching ───────────────────────────────
	if (bypassCache || request.method !== 'GET') {
		return new Response(s3Response.body, { status: 200, headers });
	}

	// ── Stream to both client and cache.put() via FixedLengthStream ─────────
	if (!s3Response.body) {
		return new Response(null, { status: 200, headers });
	}

	const s3Size = parseInt(s3Response.headers.get('Content-Length') || '0', 10);
	if (!s3Size) {
		// Unknown size — can't use FixedLengthStream; return without caching
		console.warn(`S3 response missing Content-Length for key "${key}", skipping cache`);
		return new Response(s3Response.body, { status: 200, headers });
	}

	const cacheStream = new FixedLengthStream(s3Size);
	const clientStream = new FixedLengthStream(s3Size);

	// Start cache.put() immediately as a floating promise — NOT in waitUntil()
	const cacheHeaders = buildCachePutHeaders(headers, String(s3Size));
	const cachePutPromise = cache.put(
		cachePutKey,
		new Response(cacheStream.readable, { status: 200, headers: cacheHeaders }),
	);
	cachePutPromise
		.then(() => console.log(`S3 cache.put() resolved for key "${key}"`))
		.catch((err) => console.error(`S3 cache.put() failed for key "${key}":`, err));

	// Pump: read from S3, write to both FixedLengthStreams
	const reader = s3Response.body.getReader();
	const cacheWriter = cacheStream.writable.getWriter();
	const clientWriter = clientStream.writable.getWriter();

	const pump = (async () => {
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				await Promise.all([cacheWriter.write(value), clientWriter.write(value)]);
			}
			await Promise.all([cacheWriter.close(), clientWriter.close()]);
		} catch (err) {
			console.error(`S3 stream pump error for key "${key}":`, err);
			cacheWriter.abort(err).catch(() => {});
			clientWriter.abort(err).catch(() => {});
		}
		// Wait for cache.put() to fully persist after the stream is consumed
		await cachePutPromise;
	})();

	// Register pump+cache as background task to keep it alive
	ctx.waitUntil(pump);

	return new Response(clientStream.readable, { status: 200, headers });
}

// ── R2 binding implementation ────────────────────────────────────────────────

async function getObjectViaR2(opts: {
	bucket: R2Bucket;
	key: string;
	request: Request;
	ctx: ExecutionContext;
	storageConfig: StorageConfig;
	cache: Cache;
	cachePutKey: Request;
	cacheConfig: CacheConfig;
	bypassCache: boolean;
	customTags?: string[];
	kvCache?: KVNamespace;
}): Promise<Response> {
	const {
		bucket, key, request, ctx, storageConfig,
		cache, cachePutKey, cacheConfig, bypassCache, customTags,
		kvCache,
	} = opts;

	async function cacheFullFromR2(): Promise<void> {
		const fullObject = await r2Get(bucket, key, {}, storageConfig);
		if (!fullObject || !('body' in fullObject) || !fullObject.body) return;

		const fullBody = fullObject as R2ObjectBody;
		const fullHeaders = new Headers();
		fullBody.writeHttpMetadata(fullHeaders);
		if (!fullHeaders.has('Content-Type')) {
			fullHeaders.set('Content-Type', getContentType(key));
		}
		const fullObjectType = getObjectType(fullHeaders.get('Content-Type')!);
		const fullHost = new URL(request.url).hostname;

		const cacheResponseHeaders = buildResponseHeaders(fullHeaders, fullObjectType, cacheConfig, {
			etag: fullBody.httpEtag,
			size: fullBody.size,
			objectKey: key,
			host: fullHost,
			customTags,
			bypass: false,
		});
		const cacheHeaders = buildCachePutHeaders(cacheResponseHeaders, String(fullBody.size));

		if (kvCache && fullBody.size > CACHE_API_SIZE_LIMIT) {
			// Large object — stream into KV cache (no full-body buffering)
			const maxAge = parseInt(cacheHeaders.get('Cache-Control')?.match(/max-age=(\d+)/)?.[1] || '86400', 10);
			await kvCachePutStream(kvCache, cachePutKey.url, fullBody.body, fullBody.size, cacheHeaders, maxAge);
		} else {
			await cache.put(cachePutKey, new Response(fullBody.body, { status: 200, headers: cacheHeaders }));
			console.log(`R2 cache.put() succeeded for key "${key}"`);
			try {
				const verify = await cache.match(cachePutKey, { ignoreMethod: true });
				console.log(`R2 cache.verify ${verify ? 'HIT' : 'MISS'} for key "${key}"`);
			} catch (err) {
				console.error(`R2 cache.verify failed for key "${key}":`, err);
			}
		}
	}

	// Pass conditional headers to R2 via onlyIf (documented: accepts Headers).
	// Parse Range header into explicit R2Range for forward compatibility
	// (range: Headers works in practice but is not in the official API docs).
	const rangeHeader = request.headers.get('Range');
	const hasConditional = request.headers.has('If-None-Match') || request.headers.has('If-Modified-Since');
	const r2Opts: R2GetOptions = {
		...(rangeHeader ? { range: parseRangeHeader(rangeHeader) } : {}),
		...(hasConditional ? { onlyIf: request.headers } : {}),
	};

	let object: R2ObjectBody | R2Object | null;
	try {
		object = await r2Get(bucket, key, r2Opts, storageConfig);
	} catch (err) {
		console.error(`R2 fetch failed for key "${key}":`, err);
		return new Response('Origin Error', { status: 502, headers: { 'Content-Type': 'text/plain' } });
	}

	if (!object) {
		return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
	}

	// ── 304 Not Modified (R2 returns R2Object without body when onlyIf fails) ─
	if (!('body' in object) || object.body === null) {
		return new Response(null, {
			status: 304,
			headers: { ETag: object.httpEtag },
		});
	}

	const body = object as R2ObjectBody;

	// ── Build response ────────────────────────────────────────────────────────
	const r2Headers = new Headers();
	body.writeHttpMetadata(r2Headers);

	// Use R2's content type (set at upload), fall back to extension-based detection
	if (!r2Headers.has('Content-Type')) {
		r2Headers.set('Content-Type', getContentType(key));
	}
	const objectType = getObjectType(r2Headers.get('Content-Type')!);

	const host = new URL(request.url).hostname;
	const headers = buildResponseHeaders(r2Headers, objectType, cacheConfig, {
		etag: body.httpEtag,
		size: body.size,
		objectKey: key,
		host,
		customTags,
		bypass: bypassCache,
	});

	// Mark the response so we can tell which path was used
	headers.set('X-Fetch-Via', 'r2-binding');

	// ── Range response ───────────────────────────────────────────────────────
	// Don't try to cache partial responses — let a full GET populate the cache.
	// The Cache API automatically serves Range requests from a cached full response.
	if (rangeHeader && body.range) {
		if (!bypassCache && request.method === 'GET') {
			ctx.waitUntil((async () => {
				try {
					await cacheFullFromR2();
				} catch (err) {
					console.error(`R2 range cache.put() failed for key "${key}":`, err);
				}
			})());
		}
		headers.set('Content-Range', buildContentRange(body.range, body.size));
		headers.set('Content-Length', String(rangeLength(body.range, body.size)));
		return new Response(body.body, { status: 206, headers });
	}

	// ── Bypass or HEAD: return without caching ───────────────────────────────
	if (bypassCache || request.method !== 'GET') {
		return new Response(body.body, { status: 200, headers });
	}

	// ── Decide caching strategy based on object size ────────────────────────
	// Cache API silently drops objects > ~28.5 MB. Use KV as fallback for those.
	const useKVCache = kvCache && body.size > CACHE_API_SIZE_LIMIT;

	if (useKVCache) {
		// ── KV path: stream to client + KV in parallel via .tee() ───────────
		// .tee() splits the R2 body: one branch streams to client, the other
		// streams into KV chunk-by-chunk (never buffering the full body).
		const [clientBranch, kvBranch] = body.body.tee();

		const cacheHeaders = buildCachePutHeaders(headers, String(body.size));
		const maxAge = parseInt(cacheHeaders.get('Cache-Control')?.match(/max-age=(\d+)/)?.[1] || '86400', 10);
		const cacheUrl = cachePutKey.url;

		ctx.waitUntil((async () => {
			try {
				await kvCachePutStream(kvCache, cacheUrl, kvBranch, body.size, cacheHeaders, maxAge);
			} catch (err) {
				console.error(`KV cache.put() failed for key "${key}":`, err);
			}
		})());

		return new Response(clientBranch, { status: 200, headers });
	}

	// ── Cache API path: stream to both client and cache.put() via FixedLengthStream ─
	// Two FixedLengthStream instances: one for the client, one for cache.put().
	// FixedLengthStream sets Content-Length on the Response (not chunked), which
	// is critical for cache.put() to know the body size upfront.
	// We pump R2 chunks into both writers simultaneously — true streaming, no
	// buffering the entire body in memory.
	const cacheStream = new FixedLengthStream(body.size);
	const clientStream = new FixedLengthStream(body.size);

	// Start cache.put() immediately as a floating promise — NOT in waitUntil().
	// It consumes from cacheStream.readable as the pump pushes chunks in.
	const cacheHeaders = buildCachePutHeaders(headers, String(body.size));
	const cachePutPromise = cache.put(
		cachePutKey,
		new Response(cacheStream.readable, { status: 200, headers: cacheHeaders }),
	);
	// Log cache.put() outcome — errors are non-fatal
	cachePutPromise
		.then(() => console.log(`R2 cache.put() resolved for key "${key}" (size=${body.size})`))
		.catch((err) => console.error(`R2 cache.put() failed for key "${key}":`, err));

	// Pump: read from R2, write to both FixedLengthStreams
	const reader = body.body.getReader();
	const cacheWriter = cacheStream.writable.getWriter();
	const clientWriter = clientStream.writable.getWriter();

	const pump = (async () => {
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				await Promise.all([cacheWriter.write(value), clientWriter.write(value)]);
			}
			await Promise.all([cacheWriter.close(), clientWriter.close()]);
		} catch (err) {
			console.error(`R2 stream pump error for key "${key}":`, err);
			cacheWriter.abort(err).catch(() => {});
			clientWriter.abort(err).catch(() => {});
		}
		// Wait for cache.put() to fully persist after the stream is consumed
		await cachePutPromise;
		// Verify the entry actually persisted
		try {
			const verify = await cache.match(cachePutKey, { ignoreMethod: true });
			console.log(`R2 cache.verify ${verify ? 'HIT' : 'MISS'} for key "${key}" (size=${body.size})`);
		} catch (err) {
			console.error(`R2 cache.verify error for key "${key}":`, err);
		}
	})();

	// Register pump+cache as a background task so the runtime keeps it alive
	// after the response starts streaming to the client
	ctx.waitUntil(pump);

	return new Response(clientStream.readable, { status: 200, headers });
}

// ── Cache header helpers ──────────────────────────────────────────────────────

/** Build minimal headers for cache.put() — only what's needed for serving.
 *  Preserves R2 httpMetadata headers (Content-Disposition, Content-Encoding,
 *  Last-Modified) so cached responses retain download filenames and support
 *  conditional requests via If-Modified-Since. */
function buildCachePutHeaders(
	responseHeaders: Headers,
	contentLength: string,
): Headers {
	const h = new Headers({
		'Content-Type': responseHeaders.get('Content-Type') || 'application/octet-stream',
		'Cache-Control': responseHeaders.get('Cache-Control') || 'public, max-age=86400',
		'Content-Length': contentLength,
		'Accept-Ranges': 'bytes',
		'X-Content-Type-Options': 'nosniff',
	});
	// Propagate headers that the Cache API uses for conditional matching
	// and that clients need for correct behavior
	const propagate = ['ETag', 'Last-Modified', 'Content-Disposition', 'Content-Encoding', 'Content-Language', 'Cache-Tag'];
	for (const name of propagate) {
		const value = responseHeaders.get(name);
		if (value) h.set(name, value);
	}
	return h;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildContentRange(range: R2Range, total: number): string {
	if ('suffix' in range && range.suffix) {
		const start = total - range.suffix;
		return `bytes ${start}-${total - 1}/${total}`;
	}
	const offset = 'offset' in range ? (range.offset ?? 0) : 0;
	const length = 'length' in range ? range.length : undefined;
	const end = length ? offset + length - 1 : total - 1;
	return `bytes ${offset}-${end}/${total}`;
}

function rangeLength(range: R2Range, total: number): number {
	if ('length' in range && range.length) return range.length;
	if ('suffix' in range && range.suffix) return range.suffix;
	if ('offset' in range) return total - (range.offset ?? 0);
	return total;
}

/**
 * Parse an HTTP Range header (e.g. "bytes=0-499", "bytes=100-", "bytes=-500")
 * into an R2Range object. Only the first range is used (multi-range not supported).
 * Falls back to reading from offset 0 if the header cannot be parsed.
 */
function parseRangeHeader(header: string): R2Range {
	const match = header.match(/^bytes=(\d*)-(\d*)$/);
	if (!match) return { offset: 0 };

	const [, startStr, endStr] = match;

	// Suffix range: "bytes=-500"
	if (!startStr && endStr) {
		return { suffix: parseInt(endStr, 10) };
	}

	const offset = parseInt(startStr, 10);

	// Open-ended: "bytes=100-"
	if (!endStr) {
		return { offset };
	}

	// Closed range: "bytes=0-499"
	const end = parseInt(endStr, 10);
	return { offset, length: end - offset + 1 };
}
