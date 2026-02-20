/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, beforeAll, expect } from 'vitest';
import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from 'cloudflare:test';
import app from '../src/index';

const TEST_KEY = 'test-image.jpg';
const TEST_BODY = new Uint8Array(2048).fill(0xff);

async function fetchApp(request: Request): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await app.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

beforeAll(async () => {
	const bucket = env.R2 as R2Bucket;
	await bucket.put(TEST_KEY, TEST_BODY, {
		httpMetadata: { contentType: 'image/jpeg' },
	});
	await bucket.put('test-video.mp4', new Uint8Array(8192).fill(0xab), {
		httpMetadata: { contentType: 'video/mp4' },
	});
});

describe('GET object', () => {
	it('returns 200 with correct headers for existing object', async () => {
		const res = await fetchApp(new Request(`https://cdn.erfianugrah.com/${TEST_KEY}`));
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('image/jpeg');
		expect(res.headers.get('Content-Length')).toBe('2048');
		expect(res.headers.get('ETag')).toBeTruthy();
		expect(res.headers.get('Accept-Ranges')).toBe('bytes');
		expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(res.headers.get('Cache-Tag')).toContain('cdn-type-image');

		const body = await res.arrayBuffer();
		expect(body.byteLength).toBe(2048);
	});

	it('returns 404 for missing object', async () => {
		const res = await fetchApp(new Request('https://cdn.erfianugrah.com/does-not-exist.jpg'));
		expect(res.status).toBe(404);
		await res.body?.cancel();
	});

	it('returns root message at /', async () => {
		const res = await fetchApp(new Request('https://cdn.erfianugrah.com/'));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('Object CDN');
	});
});

describe('HEAD request', () => {
	it('returns 200 with headers but no body', async () => {
		const res = await fetchApp(new Request(`https://cdn.erfianugrah.com/${TEST_KEY}?no-cache`, {
			method: 'HEAD',
		}));
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('image/jpeg');
		expect(res.headers.get('Content-Length')).toBe('2048');
		expect(res.headers.get('ETag')).toBeTruthy();
	});
});

describe('Range requests', () => {
	it('returns 206 with Content-Range for Range header', async () => {
		const res = await fetchApp(new Request(`https://cdn.erfianugrah.com/${TEST_KEY}?no-cache`, {
			headers: { Range: 'bytes=0-1023' },
		}));
		expect(res.status).toBe(206);
		expect(res.headers.get('Content-Range')).toMatch(/^bytes 0-1023\/2048$/);
		expect(res.headers.get('Content-Length')).toBe('1024');

		const body = await res.arrayBuffer();
		expect(body.byteLength).toBe(1024);
	});

	it('returns 206 for suffix range', async () => {
		const res = await fetchApp(new Request(`https://cdn.erfianugrah.com/${TEST_KEY}?no-cache`, {
			headers: { Range: 'bytes=-512' },
		}));
		expect(res.status).toBe(206);
		expect(res.headers.get('Content-Range')).toMatch(/^bytes 1536-2047\/2048$/);
		await res.body?.cancel();
	});
});

describe('Conditional requests', () => {
	it('returns 304 for matching If-None-Match', async () => {
		// First get the ETag
		const first = await fetchApp(new Request(`https://cdn.erfianugrah.com/${TEST_KEY}?no-cache`));
		const etag = first.headers.get('ETag')!;
		await first.body?.cancel();

		// Conditional request
		const res = await fetchApp(new Request(`https://cdn.erfianugrah.com/${TEST_KEY}?no-cache`, {
			headers: { 'If-None-Match': etag },
		}));
		expect(res.status).toBe(304);
		expect(res.headers.get('ETag')).toBe(etag);
	});
});

describe('Cache bypass', () => {
	it('returns no-store when bypass param is set', async () => {
		const res = await fetchApp(new Request(`https://cdn.erfianugrah.com/${TEST_KEY}?no-cache`));
		expect(res.status).toBe(200);
		expect(res.headers.get('Cache-Control')).toBe('no-store, max-age=0');
		await res.body?.cancel();
	});
});

describe('Cache API integration', () => {
	it('caches on first GET, returns HIT on second', async () => {
		const key = 'cache-test-unique.jpg';
		const bucket = env.R2 as R2Bucket;
		await bucket.put(key, new Uint8Array(64).fill(0xdd), {
			httpMetadata: { contentType: 'image/jpeg' },
		});

		// First request — populates cache
		const res1 = await fetchApp(new Request(`https://cdn.erfianugrah.com/${key}`));
		expect(res1.status).toBe(200);
		expect(res1.headers.get('CF-Cache-Status')).toBeNull();
		await res1.body?.cancel();

		// Second request — should come from cache
		const res2 = await fetchApp(new Request(`https://cdn.erfianugrah.com/${key}`));
		expect(res2.status).toBe(200);
		expect(res2.headers.get('CF-Cache-Status')).toBe('HIT');
		await res2.body?.cancel();

		await bucket.delete(key);
	});

	it('serves 206 from cache after full object is cached', async () => {
		const key = 'range-cache-test.mp4';
		const bucket = env.R2 as R2Bucket;
		await bucket.put(key, new Uint8Array(4096).fill(0xcc), {
			httpMetadata: { contentType: 'video/mp4' },
		});

		// Full GET to populate cache
		const res1 = await fetchApp(new Request(`https://cdn.erfianugrah.com/${key}`));
		expect(res1.status).toBe(200);
		await res1.body?.cancel();

		// Range request — should be served from cache as 206
		const res2 = await fetchApp(new Request(`https://cdn.erfianugrah.com/${key}`, {
			headers: { Range: 'bytes=0-511' },
		}));
		expect(res2.status).toBe(206);
		expect(res2.headers.get('CF-Cache-Status')).toBe('HIT');
		expect(res2.headers.get('Content-Range')).toMatch(/^bytes 0-511\/4096$/);
		await res2.body?.cancel();

		await bucket.delete(key);
	});
});

describe('Content-Type detection', () => {
	it('uses R2 httpMetadata Content-Type when available', async () => {
		const bucket = env.R2 as R2Bucket;
		await bucket.put('custom-type.bin', new Uint8Array(16), {
			httpMetadata: { contentType: 'application/x-custom' },
		});

		const res = await fetchApp(new Request('https://cdn.erfianugrah.com/custom-type.bin?no-cache'));
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('application/x-custom');
		await res.body?.cancel();

		await bucket.delete('custom-type.bin');
	});
});

describe('Security headers', () => {
	it('applies image-specific CSP for image objects', async () => {
		const res = await fetchApp(new Request(`https://cdn.erfianugrah.com/${TEST_KEY}`));
		expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'none'; img-src 'self'");
		await res.body?.cancel();
	});

	it('applies default CSP for non-image objects', async () => {
		const bucket = env.R2 as R2Bucket;
		await bucket.put('test.zip', new Uint8Array(16), {
			httpMetadata: { contentType: 'application/zip' },
		});

		const res = await fetchApp(new Request('https://cdn.erfianugrah.com/test.zip'));
		expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'none'");
		await res.body?.cancel();

		await bucket.delete('test.zip');
	});
});
