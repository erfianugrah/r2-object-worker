// ── Env bindings ──────────────────────────────────────────────────────────────

/**
 * Worker environment bindings.
 * R2 buckets are bound dynamically (R2, VIDEOS, etc.) so we use
 * an index signature plus the explicit config vars.
 */
export interface Env {
	BUCKET_ROUTING: BucketRoutingConfig;
	CACHE: CacheConfig;
	SECURITY: SecurityConfig;
	STORAGE: StorageConfig;
	ENVIRONMENT: string;
	[key: string]: unknown;
}

// ── Bucket routing ────────────────────────────────────────────────────────────

export interface BucketRoute {
	/** Hostname glob, e.g. "cdn.erfianugrah.com" or "*.erfi.dev" */
	host: string;
	/** Path prefix, e.g. "/" or "/images". Must start with "/" */
	pathPrefix: string;
	/** Name of the R2 binding in wrangler config */
	bucket: string;
	/** If true, the pathPrefix is stripped from the R2 key */
	stripPrefix?: boolean;
}

export interface BucketRoutingConfig {
	routes: BucketRoute[];
	defaultBucket: string;
}

// ── Storage ───────────────────────────────────────────────────────────────────

export interface StorageConfig {
	maxRetries: number;
	retryDelay: number;
	exponentialBackoff: boolean;
}

// ── Cache ─────────────────────────────────────────────────────────────────────

export interface CacheTagConfig {
	enabled: boolean;
	prefix: string;
	defaultTags: string[];
}

export interface ObjectTypeCacheConfig {
	maxAge?: number;
	tags?: string[];
}

export interface CacheConfig {
	defaultMaxAge: number;
	defaultStaleWhileRevalidate: number;
	cacheEnabled: boolean;
	bypassParamEnabled: boolean;
	bypassParamName: string;
	cacheTags: CacheTagConfig;
	objectTypeConfig: Record<string, ObjectTypeCacheConfig>;
}

// ── Security ──────────────────────────────────────────────────────────────────

export interface SecurityHeadersConfig {
	[headerName: string]: string;
}

export interface SecurityConfig {
	headers: {
		default: SecurityHeadersConfig;
		[objectType: string]: SecurityHeadersConfig;
	};
}

// ── Object types ──────────────────────────────────────────────────────────────

export type ObjectType =
	| 'image'
	| 'video'
	| 'audio'
	| 'font'
	| 'document'
	| 'static'
	| 'archive'
	| 'binary';

// ── Hono context variables ────────────────────────────────────────────────────

/** Variables set by bucket-router middleware */
export interface AppVariables {
	bucket: R2Bucket;
	bucketName: string;
	objectKey: string;
}
