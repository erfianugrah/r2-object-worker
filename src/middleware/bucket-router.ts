import { createMiddleware } from 'hono/factory';
import type { Env, AppVariables, BucketRoute } from '../types';

/**
 * Middleware that resolves the R2 bucket binding and object key based on
 * the BUCKET_ROUTING config (host + path prefix matching).
 *
 * Sets c.var.bucket, c.var.bucketName, and c.var.objectKey.
 */
export const bucketRouter = createMiddleware<{
	Bindings: Env;
	Variables: AppVariables;
}>(async (c, next) => {
	const routing = c.env.BUCKET_ROUTING;
	const hostname = new URL(c.req.url).hostname;
	const pathname = new URL(c.req.url).pathname;

	let matched: BucketRoute | undefined;

	if (routing?.routes) {
		// Find the first matching route (most-specific first in config)
		for (const route of routing.routes) {
			if (matchHost(route.host, hostname) && pathname.startsWith(route.pathPrefix)) {
				matched = route;
				break;
			}
		}
	}

	const bucketName = matched?.bucket ?? routing?.defaultBucket ?? 'R2';
	const bucket = c.env[bucketName] as R2Bucket | undefined;

	if (!bucket) {
		return c.text(`R2 binding "${bucketName}" not found`, 500);
	}

	// Derive the object key: strip the path prefix if configured
	let objectKey = pathname.slice(1); // remove leading /
	if (matched?.stripPrefix && matched.pathPrefix !== '/') {
		const prefixWithoutSlash = matched.pathPrefix.replace(/^\//, '');
		if (objectKey.startsWith(prefixWithoutSlash)) {
			objectKey = objectKey.slice(prefixWithoutSlash.length).replace(/^\//, '');
		}
	}

	c.set('bucket', bucket);
	c.set('bucketName', bucketName);
	c.set('objectKey', objectKey);

	await next();
});

/**
 * Match a hostname against a pattern that supports leading wildcard:
 *   "*.erfi.dev"  matches  "cdn.erfi.dev", "videos.erfi.dev"
 *   "cdn.erfianugrah.com"  matches exactly
 */
function matchHost(pattern: string, hostname: string): boolean {
	if (pattern === '*') return true;
	if (pattern.startsWith('*.')) {
		const suffix = pattern.slice(1); // ".erfi.dev"
		return hostname.endsWith(suffix) && hostname.length > suffix.length;
	}
	return pattern === hostname;
}
