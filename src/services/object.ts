import type { StorageConfig, CacheConfig, SecurityConfig } from '../types';
import { getContentType, getObjectType } from '../utils/content-type';
import { buildResponseHeaders } from '../utils/cache';

// ── R2 fetch with retry ───────────────────────────────────────────────────────

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

// ── Get object with tee()-based caching ───────────────────────────────────────

export async function getObject(opts: {
	bucket: R2Bucket;
	key: string;
	request: Request;
	ctx: ExecutionContext;
	storageConfig: StorageConfig;
	cacheConfig: CacheConfig;
	securityConfig: SecurityConfig;
	bypassCache: boolean;
	customTags?: string[];
}): Promise<Response> {
	const {
		bucket, key, request, ctx,
		storageConfig, cacheConfig, securityConfig,
		bypassCache, customTags,
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
				const cc = request.headers.get('Cache-Control');
				if (cc?.includes('no-cache')) {
					if (cached.body) await cached.body.cancel();
				} else {
					return cached;
				}
			}
		} catch {
			// Cache API failure — proceed to R2
		}
	}

	// ── R2 fetch ──────────────────────────────────────────────────────────────
	// Pass request.headers directly to R2 — it handles Range, If-None-Match,
	// If-Modified-Since, etc. natively (accepts Headers object)
	const rangeHeader = request.headers.get('Range');
	const hasConditional = request.headers.has('If-None-Match') || request.headers.has('If-Modified-Since');
	const r2Opts: R2GetOptions = {
		...(rangeHeader ? { range: request.headers } : {}),
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
	const headers = buildResponseHeaders(r2Headers, objectType, cacheConfig, securityConfig, {
		etag: body.httpEtag,
		size: body.size,
		objectKey: key,
		host,
		customTags,
		bypass: bypassCache,
	});

	// ── Range response ───────────────────────────────────────────────────────
	// Serve 206 to client immediately. In background, fetch the full object
	// and cache it so subsequent range/GET requests are served from cache.
	// cache.put() rejects 206, so we must store a full 200 separately.
	if (rangeHeader && body.range) {
		headers.set('Content-Range', buildContentRange(body.range, body.size));
		headers.set('Content-Length', String(rangeLength(body.range, body.size)));

		if (!bypassCache) {
			ctx.waitUntil((async () => {
				try {
					const fullObj = await bucket.get(key);
					if (fullObj && 'body' in fullObj) {
						const fullHeaders = new Headers(headers);
						fullHeaders.delete('Content-Range');
						fullHeaders.set('Content-Length', String(fullObj.size));
						await cache.put(cachePutKey, new Response(fullObj.body, {
							status: 200,
							headers: fullHeaders,
						}));
					}
				} catch (err) {
					console.error('Background cache of full object failed:', err);
				}
			})());
		}

		return new Response(body.body, { status: 206, headers });
	}

	// ── Bypass: return without caching ────────────────────────────────────────
	if (bypassCache) {
		return new Response(body.body, { status: 200, headers });
	}

	// ── tee() the stream: one for cache, one for client ───────────────────────
	const [streamForCache, streamForClient] = body.body.tee();

	// Cache put is best-effort — swallow errors so the client still gets the response
	ctx.waitUntil(
		cache.put(cachePutKey, new Response(streamForCache, { status: 200, headers: new Headers(headers) }))
			.catch((err) => console.error('Cache put failed:', err)),
	);

	return new Response(streamForClient, { status: 200, headers });
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
