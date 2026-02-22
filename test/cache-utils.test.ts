import { describe, it, expect } from 'vitest';
import { generateCacheTags, buildCacheControl, buildResponseHeaders } from '../src/utils/cache';
import type { CacheConfig } from '../src/types';

const baseCacheConfig: CacheConfig = {
	defaultMaxAge: 86400,
	defaultStaleWhileRevalidate: 86400,
	cacheEnabled: true,
	bypassParamEnabled: false,
	bypassParamName: 'no-cache',
	cacheTags: {
		enabled: true,
		prefix: 'cdn-',
		defaultTags: ['cdn', 'r2-objects'],
	},
	objectTypeConfig: {
		image: { maxAge: 86400, tags: ['images'] },
		static: { maxAge: 604800, tags: ['static'] },
	},
};


describe('generateCacheTags', () => {
	it('generates tags with prefix, type, and defaults', () => {
		const tags = generateCacheTags('image', baseCacheConfig, 'photo.jpg', 'cdn.example.com');
		expect(tags).toContain('cdn-cdn.example.com/photo.jpg');
		expect(tags).toContain('cdn-type-image');
		expect(tags).toContain('cdn-cdn');
		expect(tags).toContain('cdn-r2-objects');
	});

	it('returns empty array when tags disabled', () => {
		const config = { ...baseCacheConfig, cacheTags: { ...baseCacheConfig.cacheTags, enabled: false } };
		const tags = generateCacheTags('image', config, 'photo.jpg');
		expect(tags).toEqual([]);
	});

	it('works without host', () => {
		const tags = generateCacheTags('video', baseCacheConfig, 'clip.mp4');
		expect(tags).toContain('cdn-clip.mp4');
		expect(tags).toContain('cdn-type-video');
	});
});

describe('buildCacheControl', () => {
	it('uses object-type-specific maxAge', () => {
		const cc = buildCacheControl('image', baseCacheConfig);
		expect(cc).toBe('public, max-age=86400, stale-while-revalidate=86400');
	});

	it('uses static maxAge for static type', () => {
		const cc = buildCacheControl('static', baseCacheConfig);
		expect(cc).toBe('public, max-age=604800, stale-while-revalidate=86400');
	});

	it('falls back to default maxAge for unconfigured types', () => {
		const cc = buildCacheControl('binary', baseCacheConfig);
		expect(cc).toBe('public, max-age=86400, stale-while-revalidate=86400');
	});
});

describe('buildResponseHeaders', () => {
	it('sets ETag, Content-Length, Accept-Ranges, Cache-Control', () => {
		const r2Headers = new Headers({ 'Content-Type': 'image/jpeg' });
		const headers = buildResponseHeaders(r2Headers, 'image', baseCacheConfig, {
			etag: '"abc123"',
			size: 1024,
			objectKey: 'photo.jpg',
			host: 'cdn.example.com',
		});
		expect(headers.get('ETag')).toBe('"abc123"');
		expect(headers.get('Content-Length')).toBe('1024');
		expect(headers.get('Accept-Ranges')).toBe('bytes');
		expect(headers.get('Cache-Control')).toContain('max-age=86400');
		expect(headers.has('Vary')).toBe(false);
	});

	it('sets X-Content-Type-Options nosniff', () => {
		const r2Headers = new Headers({ 'Content-Type': 'image/jpeg' });
		const headers = buildResponseHeaders(r2Headers, 'image', baseCacheConfig, {
			etag: '"abc"',
			size: 100,
			objectKey: 'x.jpg',
		});
		expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
		// No CSP on a static asset CDN
		expect(headers.has('Content-Security-Policy')).toBe(false);
	});

	it('sets no-store when bypass is true', () => {
		const r2Headers = new Headers({ 'Content-Type': 'image/jpeg' });
		const headers = buildResponseHeaders(r2Headers, 'image', baseCacheConfig, {
			etag: '"abc"',
			size: 100,
			objectKey: 'x.jpg',
			bypass: true,
		});
		expect(headers.get('Cache-Control')).toBe('no-store, max-age=0');
		// No cache tags on bypass
		expect(headers.has('Cache-Tag')).toBe(false);
	});

	it('sets Cache-Tag header', () => {
		const r2Headers = new Headers({ 'Content-Type': 'image/jpeg' });
		const headers = buildResponseHeaders(r2Headers, 'image', baseCacheConfig, {
			etag: '"abc"',
			size: 100,
			objectKey: 'photo.jpg',
			host: 'cdn.example.com',
		});
		const cacheTag = headers.get('Cache-Tag');
		expect(cacheTag).toContain('cdn-type-image');
		expect(cacheTag).toContain('cdn-cdn');
		// Should NOT have X-Cache-Tags (removed)
		expect(headers.has('X-Cache-Tags')).toBe(false);
	});

	it('includes custom tags', () => {
		const r2Headers = new Headers({ 'Content-Type': 'image/jpeg' });
		const headers = buildResponseHeaders(r2Headers, 'image', baseCacheConfig, {
			etag: '"abc"',
			size: 100,
			objectKey: 'photo.jpg',
			customTags: ['product-123', 'promo'],
		});
		const cacheTag = headers.get('Cache-Tag')!;
		expect(cacheTag).toContain('product-123');
		expect(cacheTag).toContain('promo');
	});

	it('preserves R2 httpMetadata Content-Type', () => {
		const r2Headers = new Headers({ 'Content-Type': 'image/webp' });
		const headers = buildResponseHeaders(r2Headers, 'image', baseCacheConfig, {
			etag: '"abc"',
			size: 100,
			objectKey: 'photo.jpg', // extension says jpeg, but R2 says webp
		});
		expect(headers.get('Content-Type')).toBe('image/webp');
	});

	it('falls back to extension when R2 has no Content-Type', () => {
		const r2Headers = new Headers();
		const headers = buildResponseHeaders(r2Headers, 'image', baseCacheConfig, {
			etag: '"abc"',
			size: 100,
			objectKey: 'photo.jpg',
		});
		expect(headers.get('Content-Type')).toBe('image/jpeg');
	});
});
