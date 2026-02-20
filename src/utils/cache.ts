import type { CacheConfig, ObjectType, SecurityConfig } from '../types';
import { getContentType } from './content-type';

// ── Cache tags ────────────────────────────────────────────────────────────────

export function generateCacheTags(
	objectType: ObjectType | undefined,
	cacheConfig: CacheConfig,
	objectKey?: string,
	host?: string,
): string[] {
	const tagConfig = cacheConfig.cacheTags;
	if (!tagConfig?.enabled) return [];

	const tags: string[] = [];
	const prefix = tagConfig.prefix ?? '';

	if (host && objectKey) {
		tags.push(`${prefix}${host}/${objectKey}`);
	} else if (objectKey) {
		tags.push(`${prefix}${objectKey}`);
	}

	if (objectType) {
		tags.push(`${prefix}type-${objectType}`);
	}

	if (Array.isArray(tagConfig.defaultTags)) {
		tags.push(...tagConfig.defaultTags.map((t) => `${prefix}${t}`));
	}

	return tags;
}

// ── Cache-Control header ──────────────────────────────────────────────────────

export function buildCacheControl(
	objectType: ObjectType | undefined,
	cacheConfig: CacheConfig,
): string {
	const otConfig = objectType ? cacheConfig.objectTypeConfig[objectType] : undefined;
	const maxAge = otConfig?.maxAge ?? cacheConfig.defaultMaxAge;
	const swr = cacheConfig.defaultStaleWhileRevalidate;

	return `public, max-age=${maxAge}, stale-while-revalidate=${swr}`;
}

// ── Build response headers ────────────────────────────────────────────────────
//
// Starts from R2's httpMetadata headers (Content-Type, Content-Encoding,
// Content-Disposition, Content-Language, Cache-Control, Expires) as the base.
// Only adds/overrides what R2 doesn't provide or what we need to control.

export function buildResponseHeaders(
	r2Headers: Headers,
	objectType: ObjectType,
	cacheConfig: CacheConfig,
	securityConfig: SecurityConfig,
	extra: {
		etag: string;
		size: number;
		objectKey: string;
		host?: string;
		customTags?: string[];
		bypass?: boolean;
	},
): Headers {
	const headers = new Headers(r2Headers);

	// ETag — always from R2 (httpEtag is already quoted per RFC 9110)
	headers.set('ETag', extra.etag);

	// Content-Type — trust R2's httpMetadata; fall back to extension detection
	if (!headers.has('Content-Type')) {
		headers.set('Content-Type', getContentType(extra.objectKey));
	}

	// Content-Length — from R2 object size
	headers.set('Content-Length', String(extra.size));

	// Accept-Ranges — we support range requests
	headers.set('Accept-Ranges', 'bytes');

	if (extra.bypass) {
		headers.set('Cache-Control', 'no-store, max-age=0');
		return headers;
	}

	// Cache-Control — override R2's (which may be set per-object at upload) with
	// our per-object-type policy. If you want R2's Cache-Control to take
	// precedence, remove this line.
	headers.set('Cache-Control', buildCacheControl(objectType, cacheConfig));
	headers.set('Vary', 'Accept-Encoding');

	// Cache tags
	const tags = generateCacheTags(objectType, cacheConfig, extra.objectKey, extra.host);
	if (extra.customTags?.length) tags.push(...extra.customTags);
	if (tags.length) {
		headers.set('Cache-Tag', tags.join(','));
	}

	// Security headers
	const secHeaders = { ...securityConfig.headers.default };
	if (securityConfig.headers[objectType]) {
		Object.assign(secHeaders, securityConfig.headers[objectType]);
	}
	for (const [k, v] of Object.entries(secHeaders)) {
		headers.set(k, v);
	}

	return headers;
}
