import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, AppVariables } from './types';
import { bucketRouter } from './middleware/bucket-router';
import { getObject } from './services/object';

type AppContext = Context<{ Bindings: Env; Variables: AppVariables }>;

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// ── Global error handler ──────────────────────────────────────────────────────

app.onError((err, c) => {
	console.error('Unhandled error:', err);
	return c.text('Internal Server Error', 500);
});

// ── Root ──────────────────────────────────────────────────────────────────────

app.get('/', (c) => c.text('Object CDN'));

// ── Serve object (catch-all GET + HEAD) ───────────────────────────────────────

const serveObject = [bucketRouter, async (c: AppContext) => {
	const key = c.var.objectKey;
	if (!key) {
		return c.text('Not Found', 404);
	}

	const cacheConfig = c.env.CACHE;
	// Sanitize custom tags: allow only alphanumeric, hyphens, underscores, dots, slashes
	const customTags = (c.req.query('tags')?.split(',').filter(Boolean) ?? [])
		.map((t) => t.replace(/[^a-zA-Z0-9\-_./]/g, ''))
		.filter(Boolean);

	const cacheEnabled = cacheConfig?.cacheEnabled !== false;
	const bypassParamEnabled = cacheConfig?.bypassParamEnabled ?? false;
	const bypassParamName = cacheConfig?.bypassParamName ?? 'no-cache';
	const bypassCache =
		!cacheEnabled || (bypassParamEnabled && c.req.query(bypassParamName) !== undefined);

	const useS3 = c.req.query('via') === 's3';

	return getObject({
		bucket: c.var.bucket,
		key,
		request: c.req.raw,
		ctx: c.executionCtx,
		storageConfig: c.env.STORAGE,
		cacheConfig,
		bypassCache,
		customTags,
		useS3,
		s3Endpoint: c.env.S3?.endpoint,
		s3AccessKeyId: c.env.S3_ACCESS_KEY_ID,
		s3SecretAccessKey: c.env.S3_SECRET_ACCESS_KEY,
		r2BucketName: c.var.r2BucketName,
		kvCache: c.env.CDN_CACHE,
	});
}] as const;

app.get('/*', ...serveObject);
app.on('HEAD', '/*', ...serveObject);

export default app;
