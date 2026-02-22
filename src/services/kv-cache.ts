/**
 * KV-based cache fallback for large objects.
 *
 * ## Why this exists
 *
 * The Cloudflare Cache API has an undocumented ~28.5 MB per-object size limit
 * in production. `cache.put()` resolves without error but silently discards
 * entries above this threshold — `cache.match()` returns nothing. The official
 * docs claim a 512 MB limit; the real cutoff was empirically determined at
 * 28.5 MB (29,884,416 bytes = HIT, 30,408,704 bytes = MISS, tested at AMS
 * colo with buffer, FixedLengthStream, .tee(), R2 body, and R2+tee strategies).
 *
 * Workers KV has a 25 MiB per-value hard limit but no silent rejection — writes
 * either succeed or throw. By chunking objects into 20 MiB pieces with a JSON
 * manifest, we can cache arbitrarily large objects (up to MAX_KV_CACHE_SIZE).
 *
 * ## Storage layout
 *
 * Each cached object uses multiple KV keys:
 *
 * ### Small objects (<= 20 MiB) — two keys:
 *   - `{cacheKey}`       → JSON text `{ singleEntry: true }`, with KVCacheMetadata
 *   - `{cacheKey}_body`  → raw ArrayBuffer of the full body
 *
 * ### Large objects (> 20 MiB) — N+1 keys:
 *   - `{cacheKey}`           → JSON ChunkManifest, with KVCacheMetadata
 *   - `{cacheKey}_chunk_0`   → first 20 MiB of body
 *   - `{cacheKey}_chunk_1`   → next 20 MiB
 *   - ...
 *   - `{cacheKey}_chunk_N-1` → final chunk (may be < 20 MiB)
 *
 * All keys share the same `expirationTtl` so they auto-expire together.
 *
 * ## TTL strategy
 *
 * - **expirationTtl** (on writes): set to `max(60, maxAge)` — KV auto-deletes
 *   entries after this many seconds. CF minimum is 60s.
 * - **cacheTtl** (on reads): controls how long the KV edge cache keeps a hot
 *   copy. Set to `max(60, maxAge)` for body/chunk reads. CF minimum is 30s.
 * - A manual `createdAt + maxAge` check on reads provides belt-and-suspenders
 *   expiry for edge cases where KV's eventual consistency causes clock drift.
 *
 * ## Memory management
 *
 * Two write functions are provided:
 * - `kvCachePut()`: accepts a pre-buffered ArrayBuffer. Fine for objects that
 *   already fit in memory (e.g., < ~100 MB on a 128 MB Worker limit).
 * - `kvCachePutStream()`: reads a ReadableStream incrementally, assembling
 *   20 MiB chunks on the fly. Peak memory is ~20 MiB regardless of total size.
 *   This is the primary write path for large objects from the `.tee()`'d R2 body.
 */

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Max body size for a single KV value. KV hard limit is 25 MiB; we use 20 MiB
 * as a conservative threshold to leave headroom for metadata overhead.
 */
const MAX_SINGLE_ENTRY = 20 * 1024 * 1024; // 20 MiB

/** Chunk size for splitting large objects across multiple KV keys. */
const CHUNK_SIZE = 20 * 1024 * 1024; // 20 MiB

/** Maximum total object size we'll attempt to cache in KV. */
const MAX_KV_CACHE_SIZE = 500 * 1024 * 1024; // 500 MiB

/**
 * Minimum `cacheTtl` for KV edge reads (seconds).
 * CF enforces a minimum of 30s; we use 60s to align with expirationTtl minimum.
 */
const MIN_CACHE_TTL = 60;

/**
 * Minimum `expirationTtl` for KV writes (seconds).
 * CF enforces a minimum of 60s — writes with lower values are rejected.
 */
const MIN_EXPIRATION_TTL = 60;

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Metadata stored alongside every KV cache entry (in the KV metadata field).
 * Limited to 1024 bytes serialized JSON by CF, so we keep it lean.
 */
interface KVCacheMetadata {
	/** MIME type of the cached object */
	contentType: string;
	/** Total body size in bytes (used for integrity checks) */
	contentLength: number;
	/** ETag from R2 (already quoted per RFC 9110) */
	etag: string;
	/** Whether the body is split across multiple chunk keys */
	isChunked: boolean;
	/** Timestamp when this entry was written (Date.now()) */
	createdAt: number;
	/** Cache max-age in seconds (mirrors Cache-Control max-age) */
	maxAge: number;
	/** Subset of original response headers to restore on cache hit */
	headers: Record<string, string>;
}

/**
 * Manifest stored as the JSON value of the base key for chunked objects.
 * Read first during cache match to know how many chunks to fetch.
 */
interface ChunkManifest {
	/** Total body size across all chunks */
	totalSize: number;
	/** Number of chunk keys (`_chunk_0` through `_chunk_{N-1}`) */
	chunkCount: number;
	/** Byte size of each chunk (last chunk may be smaller) */
	chunkSizes: number[];
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Try to serve a request from KV cache. Returns null on cache miss.
 *
 * Supports Range requests: for single-entry objects, slices the ArrayBuffer;
 * for chunked objects, streams only the overlapping chunks and slices at
 * chunk boundaries.
 *
 * Responses include `X-KV-Cache-Status: HIT` so the origin is visible in
 * curl/devtools. `CF-Cache-Status` is left to Cloudflare (will be `DYNAMIC`).
 */
export async function kvCacheMatch(
	kv: KVNamespace,
	cacheKey: string,
	request: Request,
): Promise<Response | null> {
	try {
		// Read metadata key first — uses minimum cacheTtl since we don't
		// know the object's maxAge until we read the metadata.
		const { value: metaValue, metadata } = await kv.getWithMetadata<KVCacheMetadata>(
			cacheKey,
			{ type: 'text', cacheTtl: MIN_CACHE_TTL },
		);

		if (!metaValue || !metadata) return null;

		// Belt-and-suspenders expiry check. The expirationTtl on writes should
		// handle auto-deletion, but KV's eventual consistency means an edge
		// node might still serve a stale copy briefly after expiry.
		const age = (Date.now() - metadata.createdAt) / 1000;
		if (age > metadata.maxAge) {
			console.log(`KV cache expired for "${cacheKey}" (age=${Math.round(age)}s, maxAge=${metadata.maxAge}s)`);
			return null;
		}

		// Body/chunk reads use the object's maxAge as cacheTtl so the KV edge
		// cache keeps hot entries warm for the full cache duration.
		const readCacheTtl = Math.max(MIN_CACHE_TTL, metadata.maxAge);
		const rangeHeader = request.headers.get('Range');

		if (!metadata.isChunked) {
			// ── Single entry: body stored at `{cacheKey}_body` ───────────────
			const body = await kv.get(`${cacheKey}_body`, { type: 'arrayBuffer', cacheTtl: readCacheTtl });
			if (!body) return null;

			if (body.byteLength !== metadata.contentLength) {
				console.warn(`KV size mismatch for "${cacheKey}": got ${body.byteLength}, expected ${metadata.contentLength}`);
				return null;
			}

			return buildResponse(body, metadata, rangeHeader);
		}

		// ── Chunked entry: manifest stored as JSON in the base key ───────────
		const manifest: ChunkManifest = JSON.parse(metaValue);
		if (!manifest.chunkCount || !manifest.chunkSizes) return null;

		if (rangeHeader) {
			return buildChunkedRangeResponse(kv, cacheKey, manifest, metadata, rangeHeader, readCacheTtl);
		}

		return buildChunkedFullResponse(kv, cacheKey, manifest, metadata, readCacheTtl);
	} catch (err) {
		console.error(`KV cache match error for "${cacheKey}":`, err);
		return null;
	}
}

/**
 * Store a pre-buffered ArrayBuffer body in KV cache.
 *
 * Use this when the full body is already in memory (e.g., objects under ~100 MB).
 * For larger objects where buffering would exceed the Worker memory limit, use
 * `kvCachePutStream()` instead.
 *
 * @param kv       - KV namespace binding (CDN_CACHE)
 * @param cacheKey - Full URL string used as the cache key
 * @param body     - Complete body as ArrayBuffer
 * @param headers  - Response headers (Content-Type, ETag, Cache-Control, etc.)
 * @param maxAge   - Cache duration in seconds (from Cache-Control max-age)
 */
export async function kvCachePut(
	kv: KVNamespace,
	cacheKey: string,
	body: ArrayBuffer,
	headers: Headers,
	maxAge: number,
): Promise<void> {
	const size = body.byteLength;

	if (size > MAX_KV_CACHE_SIZE) {
		console.log(`KV cache skip: "${cacheKey}" too large (${(size / 1024 / 1024).toFixed(1)}MB > ${MAX_KV_CACHE_SIZE / 1024 / 1024}MB)`);
		return;
	}

	const metadata: KVCacheMetadata = {
		contentType: headers.get('Content-Type') || 'application/octet-stream',
		contentLength: size,
		etag: headers.get('ETag') || '',
		isChunked: size > MAX_SINGLE_ENTRY,
		createdAt: Date.now(),
		maxAge,
		headers: extractCacheHeaders(headers),
	};

	const expirationTtl = Math.max(MIN_EXPIRATION_TTL, maxAge);

	try {
		if (!metadata.isChunked) {
			// Two keys: metadata JSON at base key, raw body at `_body` key
			await Promise.all([
				kv.put(cacheKey, JSON.stringify({ singleEntry: true }), { metadata, expirationTtl }),
				kv.put(`${cacheKey}_body`, body, {
					metadata: { contentType: metadata.contentType },
					expirationTtl,
				}),
			]);
			console.log(`KV cache stored "${cacheKey}" single entry (${(size / 1024 / 1024).toFixed(1)}MB, ttl=${expirationTtl}s)`);
		} else {
			// Slice ArrayBuffer into CHUNK_SIZE pieces and upload all in parallel
			const chunkCount = Math.ceil(size / CHUNK_SIZE);
			const chunkSizes: number[] = [];
			const puts: Promise<void>[] = [];

			for (let i = 0; i < chunkCount; i++) {
				const start = i * CHUNK_SIZE;
				const end = Math.min(start + CHUNK_SIZE, size);
				const chunkData = body.slice(start, end);
				chunkSizes.push(chunkData.byteLength);

				puts.push(
					kv.put(`${cacheKey}_chunk_${i}`, chunkData, {
						metadata: { chunkIndex: i, size: chunkData.byteLength },
						expirationTtl,
					}),
				);
			}

			const manifest: ChunkManifest = { totalSize: size, chunkCount, chunkSizes };
			puts.push(kv.put(cacheKey, JSON.stringify(manifest), { metadata, expirationTtl }));

			await Promise.all(puts);
			console.log(`KV cache stored "${cacheKey}" chunked (${chunkCount} chunks, ${(size / 1024 / 1024).toFixed(1)}MB, ttl=${expirationTtl}s)`);
		}
	} catch (err) {
		console.error(`KV cache put error for "${cacheKey}":`, err);
	}
}

/**
 * Stream a ReadableStream body into KV cache without buffering the entire
 * object in memory.
 *
 * This is the primary write path for large objects. It reads from the stream
 * (typically a `.tee()`'d branch of the R2 body), assembles bytes into a
 * CHUNK_SIZE buffer, and uploads each full chunk to KV immediately. Peak
 * memory usage is ~1 chunk (20 MiB) regardless of total object size.
 *
 * For a 232 MB video, this produces 12 chunks uploaded concurrently via
 * `Promise.all()`, plus a manifest key — 13 KV writes total.
 *
 * @param kv        - KV namespace binding (CDN_CACHE)
 * @param cacheKey  - Full URL string used as the cache key
 * @param body      - ReadableStream to read from (consumed fully)
 * @param totalSize - Known total body size (from R2 object.size / Content-Length)
 * @param headers   - Response headers (Content-Type, ETag, Cache-Control, etc.)
 * @param maxAge    - Cache duration in seconds (from Cache-Control max-age)
 */
export async function kvCachePutStream(
	kv: KVNamespace,
	cacheKey: string,
	body: ReadableStream<Uint8Array>,
	totalSize: number,
	headers: Headers,
	maxAge: number,
): Promise<void> {
	if (totalSize > MAX_KV_CACHE_SIZE) {
		console.log(`KV cache skip: "${cacheKey}" too large (${(totalSize / 1024 / 1024).toFixed(1)}MB > ${MAX_KV_CACHE_SIZE / 1024 / 1024}MB)`);
		return;
	}

	const isChunked = totalSize > MAX_SINGLE_ENTRY;
	const metadata: KVCacheMetadata = {
		contentType: headers.get('Content-Type') || 'application/octet-stream',
		contentLength: totalSize,
		etag: headers.get('ETag') || '',
		isChunked,
		createdAt: Date.now(),
		maxAge,
		headers: extractCacheHeaders(headers),
	};

	const expirationTtl = Math.max(MIN_EXPIRATION_TTL, maxAge);

	try {
		const reader = body.getReader();

		if (!isChunked) {
			// Small object (< 20 MiB): safe to accumulate in memory, then store
			// as a single KV value. This path is rarely hit since objects under
			// 28 MB go through the Cache API instead, but handles the edge case
			// where someone explicitly routes a small object through KV.
			const parts: Uint8Array[] = [];
			let bytesRead = 0;
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				parts.push(value);
				bytesRead += value.byteLength;
			}
			const buf = new Uint8Array(bytesRead);
			let offset = 0;
			for (const part of parts) {
				buf.set(part, offset);
				offset += part.byteLength;
			}

			await Promise.all([
				kv.put(cacheKey, JSON.stringify({ singleEntry: true }), { metadata, expirationTtl }),
				kv.put(`${cacheKey}_body`, buf.buffer, {
					metadata: { contentType: metadata.contentType },
					expirationTtl,
				}),
			]);
			console.log(`KV stream stored "${cacheKey}" single entry (${(bytesRead / 1024 / 1024).toFixed(1)}MB, ttl=${expirationTtl}s)`);
			return;
		}

		// ── Chunked streaming ───────────────────────────────────────────────
		//
		// Read from the stream, copy bytes into a fixed-size chunk buffer.
		// When the buffer fills to CHUNK_SIZE, upload that chunk to KV and
		// allocate a fresh buffer. This keeps peak memory at ~20 MiB.
		//
		// Stream reads may yield fragments of any size (typically 64 KB from
		// R2), so we handle partial fills and cross-chunk boundaries within
		// a single read() result.
		let chunkIndex = 0;
		let chunkBuf = new Uint8Array(CHUNK_SIZE);
		let chunkFill = 0; // bytes written into current chunkBuf
		const chunkSizes: number[] = [];
		const pendingPuts: Promise<void>[] = [];

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			// A single stream read may span multiple chunk boundaries
			let srcOffset = 0;
			while (srcOffset < value.byteLength) {
				const space = CHUNK_SIZE - chunkFill;
				const toCopy = Math.min(space, value.byteLength - srcOffset);
				chunkBuf.set(value.subarray(srcOffset, srcOffset + toCopy), chunkFill);
				chunkFill += toCopy;
				srcOffset += toCopy;

				if (chunkFill === CHUNK_SIZE) {
					// Chunk full — slice the underlying buffer and upload.
					// We must .slice() because we reuse the Uint8Array allocation
					// and the KV put is async (would see mutated data otherwise).
					const chunkData = chunkBuf.buffer.slice(0, chunkFill);
					const idx = chunkIndex;
					chunkSizes.push(chunkFill);
					pendingPuts.push(
						kv.put(`${cacheKey}_chunk_${idx}`, chunkData, {
							metadata: { chunkIndex: idx, size: chunkFill },
							expirationTtl,
						}),
					);
					chunkIndex++;
					chunkBuf = new Uint8Array(CHUNK_SIZE);
					chunkFill = 0;
				}
			}
		}

		// Flush any remaining bytes as the final (smaller) chunk
		if (chunkFill > 0) {
			const chunkData = chunkBuf.buffer.slice(0, chunkFill);
			const idx = chunkIndex;
			chunkSizes.push(chunkFill);
			pendingPuts.push(
				kv.put(`${cacheKey}_chunk_${idx}`, chunkData, {
					metadata: { chunkIndex: idx, size: chunkFill },
					expirationTtl,
				}),
			);
			chunkIndex++;
		}

		// Store manifest (chunk map) + metadata at the base key
		const manifest: ChunkManifest = { totalSize, chunkCount: chunkIndex, chunkSizes };
		pendingPuts.push(kv.put(cacheKey, JSON.stringify(manifest), { metadata, expirationTtl }));

		// All chunk uploads run concurrently — KV handles parallel writes fine
		await Promise.all(pendingPuts);
		console.log(`KV stream stored "${cacheKey}" chunked (${chunkIndex} chunks, ${(totalSize / 1024 / 1024).toFixed(1)}MB, ttl=${expirationTtl}s)`);
	} catch (err) {
		console.error(`KV cache stream put error for "${cacheKey}":`, err);
	}
}

// ── Response builders ────────────────────────────────────────────────────────

/**
 * Build a full or partial (206) response from a single-entry ArrayBuffer.
 * If the request includes a Range header, slices the buffer and returns 206.
 */
function buildResponse(
	body: ArrayBuffer,
	metadata: KVCacheMetadata,
	rangeHeader: string | null,
): Response {
	const headers = buildHeaders(metadata);

	if (rangeHeader) {
		const range = parseRange(rangeHeader, body.byteLength);
		if (range) {
			const slice = body.slice(range.start, range.end + 1);
			headers.set('Content-Range', `bytes ${range.start}-${range.end}/${body.byteLength}`);
			headers.set('Content-Length', String(slice.byteLength));
			return new Response(slice, { status: 206, headers });
		}
	}

	headers.set('Content-Length', String(body.byteLength));
	return new Response(body, { status: 200, headers });
}

/**
 * Reconstruct response headers from stored metadata.
 * Sets `X-KV-Cache-Status: HIT` so the response origin is visible in headers.
 *
 * We intentionally do NOT set `CF-Cache-Status` — that header is managed by
 * Cloudflare's Cache API tier. Setting it ourselves on KV responses would be
 * misleading (it would appear as a Cache API hit in server-timing and logs).
 * Cloudflare will add its own `CF-Cache-Status: DYNAMIC` since the response
 * didn't come through the Cache API.
 */
function buildHeaders(metadata: KVCacheMetadata): Headers {
	const h = new Headers();
	h.set('Content-Type', metadata.contentType);
	h.set('Accept-Ranges', 'bytes');
	h.set('X-Content-Type-Options', 'nosniff');
	h.set('X-KV-Cache-Status', 'HIT');

	// Restore original cache headers preserved at write time
	for (const [key, value] of Object.entries(metadata.headers)) {
		h.set(key, value);
	}

	if (metadata.etag) h.set('ETag', metadata.etag);
	return h;
}

/**
 * Stream all chunks sequentially into a ReadableStream for a full (200) response.
 * Chunks are fetched from KV one at a time to avoid loading the entire object
 * into memory. The response starts streaming as soon as the first chunk arrives.
 */
async function buildChunkedFullResponse(
	kv: KVNamespace,
	cacheKey: string,
	manifest: ChunkManifest,
	metadata: KVCacheMetadata,
	cacheTtl: number,
): Promise<Response> {
	const headers = buildHeaders(metadata);
	headers.set('Content-Length', String(manifest.totalSize));

	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();

	// Fire-and-forget async IIFE — the response streams as chunks arrive.
	// Errors abort the stream (client sees a truncated response).
	(async () => {
		try {
			for (let i = 0; i < manifest.chunkCount; i++) {
				const chunk = await kv.get(`${cacheKey}_chunk_${i}`, {
					type: 'arrayBuffer',
					cacheTtl,
				});
				if (!chunk) throw new Error(`Missing chunk ${i} for "${cacheKey}"`);
				await writer.write(new Uint8Array(chunk));
			}
			await writer.close();
		} catch (err) {
			console.error(`KV chunked stream error for "${cacheKey}":`, err);
			writer.abort(err).catch(() => {});
		}
	})();

	return new Response(readable, { status: 200, headers });
}

/**
 * Serve a Range request from chunked KV storage.
 *
 * Calculates which chunks overlap with the requested byte range, fetches only
 * those chunks, and slices at chunk boundaries to extract the exact byte range.
 * For example, a `bytes=104857600-105906175` request on a 232 MB file with
 * 20 MB chunks only fetches chunks 5 and 6 (not all 12).
 */
async function buildChunkedRangeResponse(
	kv: KVNamespace,
	cacheKey: string,
	manifest: ChunkManifest,
	metadata: KVCacheMetadata,
	rangeHeader: string,
	cacheTtl: number,
): Promise<Response | null> {
	const range = parseRange(rangeHeader, manifest.totalSize);
	if (!range) return null;

	const headers = buildHeaders(metadata);
	const rangeLength = range.end - range.start + 1;
	headers.set('Content-Range', `bytes ${range.start}-${range.end}/${manifest.totalSize}`);
	headers.set('Content-Length', String(rangeLength));

	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();

	(async () => {
		try {
			let bytesWritten = 0;
			let chunkOffset = 0; // byte offset of current chunk's start within the total body

			for (let i = 0; i < manifest.chunkCount && bytesWritten < rangeLength; i++) {
				const chunkSize = manifest.chunkSizes[i];
				const chunkEnd = chunkOffset + chunkSize - 1;

				// Skip chunks that don't overlap with the requested range
				if (chunkEnd >= range.start && chunkOffset <= range.end) {
					const chunk = await kv.get(`${cacheKey}_chunk_${i}`, {
						type: 'arrayBuffer',
						cacheTtl,
					});
					if (!chunk) throw new Error(`Missing chunk ${i}`);

					// Slice within this chunk to extract only the overlapping bytes
					const sliceStart = Math.max(0, range.start - chunkOffset);
					const sliceEnd = Math.min(chunkSize, range.end - chunkOffset + 1);
					const slice = new Uint8Array(chunk.slice(sliceStart, sliceEnd));

					await writer.write(slice);
					bytesWritten += slice.byteLength;
				}

				chunkOffset += chunkSize;
			}

			await writer.close();
		} catch (err) {
			console.error(`KV chunked range error for "${cacheKey}":`, err);
			writer.abort(err).catch(() => {});
		}
	})();

	return new Response(readable, { status: 206, headers });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse an HTTP Range header into start/end byte offsets.
 * Supports: `bytes=0-499`, `bytes=100-`, `bytes=-500` (suffix).
 * Only the first range is used (multi-range not supported).
 * Returns null for unparseable or out-of-bounds ranges.
 */
function parseRange(header: string, total: number): { start: number; end: number } | null {
	const match = header.match(/^bytes=(\d*)-(\d*)$/);
	if (!match) return null;

	const [, startStr, endStr] = match;

	// Suffix range: "bytes=-500" means the last 500 bytes
	if (!startStr && endStr) {
		const suffix = parseInt(endStr, 10);
		return { start: total - suffix, end: total - 1 };
	}

	const start = parseInt(startStr, 10);
	const end = endStr ? parseInt(endStr, 10) : total - 1;

	if (start > end || start >= total) return null;
	return { start, end: Math.min(end, total - 1) };
}

/**
 * Extract the subset of response headers worth preserving in KV metadata.
 * These are restored on cache hits so the response looks identical to a
 * fresh R2 fetch. Kept minimal to stay within KV's 1024-byte metadata limit.
 */
function extractCacheHeaders(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	const preserve = [
		'Cache-Control', 'Cache-Tag', 'Last-Modified',
		'Content-Disposition', 'Content-Encoding', 'Content-Language',
	];
	for (const name of preserve) {
		const value = headers.get(name);
		if (value) result[name] = value;
	}
	return result;
}
