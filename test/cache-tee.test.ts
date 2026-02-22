/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeAll } from 'vitest';
import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from 'cloudflare:test';
import app from '../src/index';

/**
 * Tests for ReadableStream.tee() with the Cache API in the local dev runtime.
 *
 * The production code uses a manual pump with dual FixedLengthStream instances
 * to split the R2 body into a client stream and a cache stream. This test suite
 * validates .tee() as an alternative approach and compares both strategies.
 */

const cache = (caches as unknown as { default: Cache }).default;

// Helper: generate deterministic test data of a given size
function makeTestData(size: number, seed = 0x42): Uint8Array {
	const data = new Uint8Array(size);
	for (let i = 0; i < size; i++) {
		data[i] = (seed + i) & 0xff;
	}
	return data;
}

// Helper: create a ReadableStream from a Uint8Array
function streamFrom(data: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(data);
			controller.close();
		},
	});
}

// Helper: create a ReadableStream that emits data in chunks
function chunkedStreamFrom(data: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
	let offset = 0;
	return new ReadableStream({
		pull(controller) {
			if (offset >= data.length) {
				controller.close();
				return;
			}
			const end = Math.min(offset + chunkSize, data.length);
			controller.enqueue(data.slice(offset, end));
			offset = end;
		},
	});
}

// Helper: read a ReadableStream into a Uint8Array
async function streamToArray(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}
	const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
	const result = new Uint8Array(totalLength);
	let pos = 0;
	for (const chunk of chunks) {
		result.set(chunk, pos);
		pos += chunk.length;
	}
	return result;
}

// Helper: integration test via the full Hono app (same pattern as integration.test.ts)
async function fetchApp(request: Request): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await app.fetch(request, env, ctx);
	const body = await res.arrayBuffer();
	await waitOnExecutionContext(ctx);
	return new Response(body, {
		status: res.status,
		headers: res.headers,
	});
}

// ─── Direct Cache API + .tee() tests ────────────────────────────────────────

describe('ReadableStream.tee() basics', () => {
	it('both branches produce identical data', async () => {
		const original = makeTestData(4096);
		const stream = streamFrom(original);
		const [branch1, branch2] = stream.tee();

		const [result1, result2] = await Promise.all([
			streamToArray(branch1),
			streamToArray(branch2),
		]);

		expect(result1).toEqual(original);
		expect(result2).toEqual(original);
	});

	it('both branches produce identical data from chunked stream', async () => {
		const original = makeTestData(10000);
		const stream = chunkedStreamFrom(original, 1024);
		const [branch1, branch2] = stream.tee();

		const [result1, result2] = await Promise.all([
			streamToArray(branch1),
			streamToArray(branch2),
		]);

		expect(result1).toEqual(original);
		expect(result2).toEqual(original);
	});
});

describe('.tee() with cache.put()', () => {
	it('stores and retrieves a teed stream via Cache API', async () => {
		const data = makeTestData(2048);
		const stream = streamFrom(data);
		const [clientBranch, cacheBranch] = stream.tee();

		const url = 'https://tee-test.local/basic-tee-put';
		const cacheKey = new Request(url);

		await cache.put(
			cacheKey,
			new Response(cacheBranch, {
				status: 200,
				headers: {
					'Content-Type': 'application/octet-stream',
					'Cache-Control': 'public, max-age=3600',
					'Content-Length': '2048',
				},
			}),
		);

		// Client branch should still be readable and correct
		const clientData = await streamToArray(clientBranch);
		expect(clientData).toEqual(data);

		// Cached response should match
		const cached = await cache.match(cacheKey);
		expect(cached).toBeTruthy();
		const cachedBody = new Uint8Array(await cached!.arrayBuffer());
		expect(cachedBody).toEqual(data);
	});

	it('cache.put() works when client branch is consumed first', async () => {
		const data = makeTestData(4096);
		const stream = streamFrom(data);
		const [clientBranch, cacheBranch] = stream.tee();

		// Consume client branch fully before cache.put()
		const clientData = await streamToArray(clientBranch);
		expect(clientData).toEqual(data);

		const url = 'https://tee-test.local/client-first';
		const cacheKey = new Request(url);
		await cache.put(
			cacheKey,
			new Response(cacheBranch, {
				status: 200,
				headers: {
					'Content-Type': 'application/octet-stream',
					'Cache-Control': 'public, max-age=3600',
					'Content-Length': '4096',
				},
			}),
		);

		const cached = await cache.match(cacheKey);
		expect(cached).toBeTruthy();
		const cachedBody = new Uint8Array(await cached!.arrayBuffer());
		expect(cachedBody).toEqual(data);
	});

	it('cache.put() works when cache branch is consumed first', async () => {
		const data = makeTestData(4096);
		const stream = streamFrom(data);
		const [clientBranch, cacheBranch] = stream.tee();

		const url = 'https://tee-test.local/cache-first';
		const cacheKey = new Request(url);

		// Put cache branch first
		await cache.put(
			cacheKey,
			new Response(cacheBranch, {
				status: 200,
				headers: {
					'Content-Type': 'application/octet-stream',
					'Cache-Control': 'public, max-age=3600',
					'Content-Length': '4096',
				},
			}),
		);

		// Then consume client branch
		const clientData = await streamToArray(clientBranch);
		expect(clientData).toEqual(data);

		const cached = await cache.match(cacheKey);
		expect(cached).toBeTruthy();
		const cachedBody = new Uint8Array(await cached!.arrayBuffer());
		expect(cachedBody).toEqual(data);
	});

	it('concurrent consumption: cache.put() and client read in parallel', async () => {
		const data = makeTestData(8192);
		const stream = chunkedStreamFrom(data, 1024);
		const [clientBranch, cacheBranch] = stream.tee();

		const url = 'https://tee-test.local/concurrent';
		const cacheKey = new Request(url);

		// Run cache.put() and client read concurrently
		const [clientData] = await Promise.all([
			streamToArray(clientBranch),
			cache.put(
				cacheKey,
				new Response(cacheBranch, {
					status: 200,
					headers: {
						'Content-Type': 'application/octet-stream',
						'Cache-Control': 'public, max-age=3600',
						'Content-Length': '8192',
					},
				}),
			),
		]);

		expect(clientData).toEqual(data);

		const cached = await cache.match(cacheKey);
		expect(cached).toBeTruthy();
		const cachedBody = new Uint8Array(await cached!.arrayBuffer());
		expect(cachedBody).toEqual(data);
	});
});

describe('.tee() with various body sizes', () => {
	const sizes = [
		{ label: '0 bytes (empty)', size: 0 },
		{ label: '1 byte', size: 1 },
		{ label: '1 KB', size: 1024 },
		{ label: '64 KB', size: 64 * 1024 },
		{ label: '256 KB', size: 256 * 1024 },
		{ label: '1 MB', size: 1024 * 1024 },
		{ label: '5 MB', size: 5 * 1024 * 1024 },
	];

	for (const { label, size } of sizes) {
		it(`tee + cache.put() with ${label} body`, { timeout: 30_000 }, async () => {
			const data = makeTestData(size);
			const stream = size > 0 ? chunkedStreamFrom(data, 64 * 1024) : streamFrom(data);
			const [clientBranch, cacheBranch] = stream.tee();

			const url = `https://tee-test.local/size-${size}`;
			const cacheKey = new Request(url);

			const [clientData] = await Promise.all([
				streamToArray(clientBranch),
				cache.put(
					cacheKey,
					new Response(cacheBranch, {
						status: 200,
						headers: {
							'Content-Type': 'application/octet-stream',
							'Cache-Control': 'public, max-age=3600',
							'Content-Length': String(size),
						},
					}),
				),
			]);

			expect(clientData.length).toBe(size);
			expect(clientData).toEqual(data);

			const cached = await cache.match(cacheKey);
			expect(cached).toBeTruthy();
			// Note: Cache API may strip Content-Length header internally;
			// verify body length instead
			const cachedBody = new Uint8Array(await cached!.arrayBuffer());
			expect(cachedBody.length).toBe(size);
			expect(cachedBody).toEqual(data);
		});
	}
});

describe('.tee() preserves response headers through cache', () => {
	it('round-trips Content-Type, ETag, Cache-Control', async () => {
		const data = makeTestData(512);
		const stream = streamFrom(data);
		const [clientBranch, cacheBranch] = stream.tee();

		const url = 'https://tee-test.local/headers-roundtrip';
		const cacheKey = new Request(url);

		await cache.put(
			cacheKey,
			new Response(cacheBranch, {
				status: 200,
				headers: {
					'Content-Type': 'image/jpeg',
					'Cache-Control': 'public, max-age=86400',
					'Content-Length': '512',
					ETag: '"abc123"',
					'Accept-Ranges': 'bytes',
					'X-Content-Type-Options': 'nosniff',
				},
			}),
		);

		// Consume client branch
		await streamToArray(clientBranch);

		const cached = await cache.match(cacheKey);
		expect(cached).toBeTruthy();
		expect(cached!.headers.get('Content-Type')).toBe('image/jpeg');
		expect(cached!.headers.get('ETag')).toBe('"abc123"');
		expect(cached!.headers.get('Cache-Control')).toContain('max-age=86400');
		expect(cached!.headers.get('Accept-Ranges')).toBe('bytes');
	});

	it('cache serves Range from teed full response', async () => {
		const data = makeTestData(4096);
		const stream = streamFrom(data);
		const [clientBranch, cacheBranch] = stream.tee();

		const url = 'https://tee-test.local/range-from-tee';
		const cacheKey = new Request(url);

		await cache.put(
			cacheKey,
			new Response(cacheBranch, {
				status: 200,
				headers: {
					'Content-Type': 'application/octet-stream',
					'Cache-Control': 'public, max-age=3600',
					'Content-Length': '4096',
					'Accept-Ranges': 'bytes',
				},
			}),
		);

		await streamToArray(clientBranch);

		// Request a Range from the cached full response
		const rangeReq = new Request(url, {
			headers: { Range: 'bytes=0-511' },
		});
		const rangeRes = await cache.match(rangeReq);
		expect(rangeRes).toBeTruthy();
		expect(rangeRes!.status).toBe(206);
		expect(rangeRes!.headers.get('Content-Range')).toMatch(/^bytes 0-511\/4096$/);

		const rangeBody = new Uint8Array(await rangeRes!.arrayBuffer());
		expect(rangeBody.length).toBe(512);
		expect(rangeBody).toEqual(data.slice(0, 512));
	});
});

describe('.tee() vs FixedLengthStream comparison', () => {
	it('FixedLengthStream: stores and retrieves correctly', async () => {
		const data = makeTestData(4096);
		const sourceStream = streamFrom(data);

		const cacheStream = new FixedLengthStream(data.length);
		const clientStream = new FixedLengthStream(data.length);

		const url = 'https://tee-test.local/fls-comparison';
		const cacheKey = new Request(url);

		const cachePutPromise = cache.put(
			cacheKey,
			new Response(cacheStream.readable, {
				status: 200,
				headers: {
					'Content-Type': 'application/octet-stream',
					'Cache-Control': 'public, max-age=3600',
					'Content-Length': String(data.length),
				},
			}),
		);

		// Pump source into both FLS writers
		const reader = sourceStream.getReader();
		const cacheWriter = cacheStream.writable.getWriter();
		const clientWriter = clientStream.writable.getWriter();

		const pump = (async () => {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				await Promise.all([cacheWriter.write(value), clientWriter.write(value)]);
			}
			await Promise.all([cacheWriter.close(), clientWriter.close()]);
		})();

		const [clientData] = await Promise.all([
			streamToArray(clientStream.readable),
			pump,
		]);
		await cachePutPromise;

		expect(clientData).toEqual(data);

		const cached = await cache.match(cacheKey);
		expect(cached).toBeTruthy();
		const cachedBody = new Uint8Array(await cached!.arrayBuffer());
		expect(cachedBody).toEqual(data);
	});

	it('.tee() and FixedLengthStream produce identical cache entries', async () => {
		const data = makeTestData(8192, 0xAB);

		// --- .tee() path ---
		const teeStream = chunkedStreamFrom(data, 2048);
		const [teeClient, teeCacheBranch] = teeStream.tee();

		const teeUrl = 'https://tee-test.local/compare-tee';
		const teeCacheKey = new Request(teeUrl);

		const [teeClientData] = await Promise.all([
			streamToArray(teeClient),
			cache.put(
				teeCacheKey,
				new Response(teeCacheBranch, {
					status: 200,
					headers: {
						'Content-Type': 'application/octet-stream',
						'Cache-Control': 'public, max-age=3600',
						'Content-Length': '8192',
					},
				}),
			),
		]);

		// --- FixedLengthStream path ---
		const flsSource = chunkedStreamFrom(data, 2048);
		const flsCacheStream = new FixedLengthStream(data.length);
		const flsClientStream = new FixedLengthStream(data.length);

		const flsUrl = 'https://tee-test.local/compare-fls';
		const flsCacheKey = new Request(flsUrl);

		const flsCachePutPromise = cache.put(
			flsCacheKey,
			new Response(flsCacheStream.readable, {
				status: 200,
				headers: {
					'Content-Type': 'application/octet-stream',
					'Cache-Control': 'public, max-age=3600',
					'Content-Length': '8192',
				},
			}),
		);

		const flsReader = flsSource.getReader();
		const flsCacheWriter = flsCacheStream.writable.getWriter();
		const flsClientWriter = flsClientStream.writable.getWriter();

		const flsPump = (async () => {
			while (true) {
				const { done, value } = await flsReader.read();
				if (done) break;
				await Promise.all([flsCacheWriter.write(value), flsClientWriter.write(value)]);
			}
			await Promise.all([flsCacheWriter.close(), flsClientWriter.close()]);
		})();

		const [flsClientData] = await Promise.all([
			streamToArray(flsClientStream.readable),
			flsPump,
		]);
		await flsCachePutPromise;

		// Both client branches should match original
		expect(teeClientData).toEqual(data);
		expect(flsClientData).toEqual(data);

		// Both cached responses should match
		const teeCached = await cache.match(teeCacheKey);
		const flsCached = await cache.match(flsCacheKey);
		expect(teeCached).toBeTruthy();
		expect(flsCached).toBeTruthy();

		const teeCachedBody = new Uint8Array(await teeCached!.arrayBuffer());
		const flsCachedBody = new Uint8Array(await flsCached!.arrayBuffer());
		expect(teeCachedBody).toEqual(data);
		expect(flsCachedBody).toEqual(data);
		expect(teeCachedBody).toEqual(flsCachedBody);
	});
});

describe('.tee() with integration (full worker)', () => {
	const TEE_TEST_KEY = 'tee-integration-test.jpg';

	beforeAll(async () => {
		const bucket = env.R2 as R2Bucket;
		await bucket.put(TEE_TEST_KEY, makeTestData(8192, 0xEE), {
			httpMetadata: { contentType: 'image/jpeg' },
		});
	});

	it('worker caches response, second request is a HIT with identical body', async () => {
		// Unique key to avoid collisions with other tests
		const key = 'tee-integ-unique.jpg';
		const bucket = env.R2 as R2Bucket;
		const data = makeTestData(2048, 0xCC);
		await bucket.put(key, data, {
			httpMetadata: { contentType: 'image/jpeg' },
		});

		// First request - populates cache via FixedLengthStream pump
		const res1 = await fetchApp(new Request(`https://cdn.erfianugrah.com/${key}`));
		expect(res1.status).toBe(200);
		const body1 = new Uint8Array(await res1.arrayBuffer());
		expect(body1).toEqual(data);

		// Second request - served from cache
		const res2 = await fetchApp(new Request(`https://cdn.erfianugrah.com/${key}`));
		expect(res2.status).toBe(200);
		expect(res2.headers.get('CF-Cache-Status')).toBe('HIT');
		const body2 = new Uint8Array(await res2.arrayBuffer());
		expect(body2).toEqual(data);

		// Body integrity: both responses must be byte-identical
		expect(body1).toEqual(body2);

		await bucket.delete(key);
	});

	it('teed cache entry supports Range requests with correct bytes', async () => {
		const key = 'tee-integ-range.bin';
		const bucket = env.R2 as R2Bucket;
		const data = makeTestData(4096, 0xDD);
		await bucket.put(key, data, {
			httpMetadata: { contentType: 'application/octet-stream' },
		});

		// Full GET to populate cache
		const res1 = await fetchApp(new Request(`https://cdn.erfianugrah.com/${key}`));
		expect(res1.status).toBe(200);

		// Range from cache
		const res2 = await fetchApp(new Request(`https://cdn.erfianugrah.com/${key}`, {
			headers: { Range: 'bytes=1024-2047' },
		}));
		expect(res2.status).toBe(206);
		expect(res2.headers.get('CF-Cache-Status')).toBe('HIT');
		expect(res2.headers.get('Content-Range')).toMatch(/^bytes 1024-2047\/4096$/);

		const rangeBody = new Uint8Array(await res2.arrayBuffer());
		expect(rangeBody.length).toBe(1024);
		expect(rangeBody).toEqual(data.slice(1024, 2048));

		await bucket.delete(key);
	});

	it('teed cache entry supports suffix Range requests', async () => {
		const key = 'tee-integ-suffix.bin';
		const bucket = env.R2 as R2Bucket;
		const data = makeTestData(2048, 0xAA);
		await bucket.put(key, data, {
			httpMetadata: { contentType: 'application/octet-stream' },
		});

		// Full GET to populate cache
		const res1 = await fetchApp(new Request(`https://cdn.erfianugrah.com/${key}`));
		expect(res1.status).toBe(200);

		// Suffix range from cache: last 256 bytes
		const res2 = await fetchApp(new Request(`https://cdn.erfianugrah.com/${key}`, {
			headers: { Range: 'bytes=-256' },
		}));
		expect(res2.status).toBe(206);
		expect(res2.headers.get('CF-Cache-Status')).toBe('HIT');
		expect(res2.headers.get('Content-Range')).toMatch(/^bytes 1792-2047\/2048$/);

		const rangeBody = new Uint8Array(await res2.arrayBuffer());
		expect(rangeBody.length).toBe(256);
		expect(rangeBody).toEqual(data.slice(1792, 2048));

		await bucket.delete(key);
	});
});
