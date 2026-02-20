import { Hono } from 'hono';
import type { Env, AppVariables } from './types';
import { bucketRouter } from './middleware/bucket-router';
import { getObject } from './services/object';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// ── Global error handler ──────────────────────────────────────────────────────

app.onError((err, c) => {
	console.error('Unhandled error:', err);
	return c.text('Internal Server Error', 500);
});

// ── Root ──────────────────────────────────────────────────────────────────────

app.get('/', (c) => c.text('Object CDN'));

// ── Serve object (catch-all GET + HEAD) ───────────────────────────────────────

const serveObject = [bucketRouter, async (c: any) => {
	const key = c.var.objectKey;
	if (!key) {
		return c.text('Not Found', 404);
	}

	const cacheConfig = c.env.CACHE;
	const customTags = c.req.query('tags')?.split(',').filter(Boolean) ?? [];

	const cacheEnabled = cacheConfig?.cacheEnabled !== false;
	const bypassParamEnabled = cacheConfig?.bypassParamEnabled ?? false;
	const bypassParamName = cacheConfig?.bypassParamName ?? 'no-cache';
	const bypassCache =
		!cacheEnabled || (bypassParamEnabled && c.req.query(bypassParamName) !== undefined);

	return getObject({
		bucket: c.var.bucket,
		key,
		request: c.req.raw,
		ctx: c.executionCtx,
		storageConfig: c.env.STORAGE,
		cacheConfig,
		securityConfig: c.env.SECURITY,
		bypassCache,
		customTags,
	});
}] as const;

app.get('/*', ...serveObject);
app.on('HEAD', '/*', ...serveObject);

export default app;
