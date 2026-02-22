# R2 Object Worker

A Cloudflare Worker that serves objects from R2 buckets with two-tier caching (Cache API + KV fallback), range request support, conditional request handling, and multi-bucket routing. Built with TypeScript and Hono.

## How it works

A single worker instance fronts multiple R2 buckets, routing requests by hostname:

- `cdn.erfianugrah.com` -> `images-weur` R2 bucket
- `videos.erfi.dev` -> `videos` R2 bucket

### Two-tier caching

Objects are cached at two layers, with automatic routing based on size:

| Tier | Used for | Mechanism | Why |
|------|----------|-----------|-----|
| **Cache API** | Objects <= 28 MB | `cache.put()` via dual FixedLengthStream pump | Cloudflare edge cache, fastest |
| **Workers KV** | Objects > 28 MB | Chunked 20 MiB entries with JSON manifest | Cache API silently drops entries above ~28.5 MB |

**Cache lookup order:** Cache API -> KV cache -> R2 origin

On cache miss, the worker fetches from R2 and streams to the client while simultaneously caching in the background:

- **<= 28 MB (Cache API path):** Two `FixedLengthStream` instances are created — one for the client, one for `cache.put()`. A pump reads R2 chunks and writes to both streams simultaneously. `cache.put()` runs as a floating promise (not in `waitUntil()`) so backpressure flows correctly.

- **> 28 MB (KV path):** `.tee()` splits the R2 body stream — one branch goes to the client, the other is consumed by `kvCachePutStream()` in `waitUntil()`. The stream is read incrementally, assembling 20 MiB chunks on the fly, and each chunk is uploaded to KV as it fills. Peak memory usage is ~20 MiB regardless of total object size.

### The Cache API size limit

The Cloudflare Cache API has an **undocumented ~28.5 MB per-object size limit** in production. `cache.put()` resolves without error but silently discards the entry — `cache.match()` returns nothing. The official docs claim 512 MB.

This was empirically determined by deploying a test worker that writes synthetic objects at various sizes using 5 different body strategies (ArrayBuffer, FixedLengthStream, `.tee()`, R2 body stream, R2+tee). **All strategies hit the same wall:**

- 28.5 MB (29,884,416 bytes) = **HIT**
- 29.0 MB (30,408,704 bytes) = **MISS**

Tested at AMS colo. The limit is server-side, not related to streaming or body type.

### KV storage layout

Each KV-cached object uses multiple keys:

```
Small objects (<= 20 MiB):
  {url}       -> JSON metadata (KVCacheMetadata in KV metadata field)
  {url}_body  -> raw ArrayBuffer

Large objects (> 20 MiB):
  {url}           -> JSON ChunkManifest + KVCacheMetadata
  {url}_chunk_0   -> first 20 MiB
  {url}_chunk_1   -> next 20 MiB
  ...
  {url}_chunk_N   -> final chunk (may be < 20 MiB)
```

All keys share the same `expirationTtl` (matching the object's `max-age`) so they auto-expire together.

### Cache keys

Two cache keys are used per request:

- `cacheMatchKey = new Request(url, request)` — inherits the original request's Range, If-None-Match, and If-Modified-Since headers. `cache.match()` handles these automatically, returning 206 for range requests and 304 for conditional requests.
- `cachePutKey = new Request(url, { method: 'GET' })` — a plain GET used for `cache.put()` and KV, storing the full 200 response.

`cache.match()` is called with `{ ignoreMethod: true }` so HEAD requests also hit cache.

### Range requests

On a cache miss with a Range header, the worker returns 206 to the client immediately from R2, then background-fetches the full object and caches it via `ctx.waitUntil()`. Subsequent requests (range or full) are served from cache.

For KV-cached chunked objects, range requests are handled by calculating which chunks overlap with the requested byte range, fetching only those chunks, and slicing at chunk boundaries to extract the exact bytes.

### Conditional requests

R2 accepts `Headers` objects directly for `onlyIf` and `range` options. When an `onlyIf` condition fails (e.g. ETag matches), R2 returns an `R2Object` without a body — the worker detects this with `!('body' in object)` and returns 304.

## Project structure

```
src/
  index.ts                  Hono app, routes (GET /, GET/HEAD /*)
  types.ts                  All TypeScript interfaces
  middleware/
    bucket-router.ts        Resolves R2 bucket from host + path prefix
  services/
    object.ts               Core logic: R2 fetch, cache/KV routing, streaming, range/conditional
    kv-cache.ts             KV cache: chunked storage, streaming writes, range retrieval
  utils/
    cache.ts                Cache tags, Cache-Control, response header building
    content-type.ts         MIME detection, ObjectType classification
test/
  cache-tee.test.ts         20 .tee() and Cache API tests (stream splitting, sizes, range)
  integration.test.ts       13 integration tests (worker-level via MWFE)
  cache-utils.test.ts       13 cache utility unit tests
  content-type.test.ts      12 content type unit tests
  env.d.ts                  Type declarations for cloudflare:test
wrangler.jsonc              Flat config (no env blocks)
vitest.config.ts            @cloudflare/vitest-pool-workers config
tsconfig.json               TypeScript config
```

## Configuration

All configuration lives in `wrangler.jsonc` as worker vars. No environment-specific blocks — one flat config deployed directly.

### Bucket routing

```jsonc
"BUCKET_ROUTING": {
  "routes": [
    { "host": "cdn.erfianugrah.com", "pathPrefix": "/", "bucket": "R2", "bucketName": "images-weur" },
    { "host": "videos.erfi.dev", "pathPrefix": "/", "bucket": "VIDEOS", "bucketName": "videos" }
  ],
  "defaultBucket": "R2"
}
```

Host patterns support wildcards (`*.erfi.dev`). Routes are matched in order (first match wins). The `stripPrefix` option removes the path prefix from the R2 key when set.

### Cache

```jsonc
"CACHE": {
  "defaultMaxAge": 86400,
  "defaultStaleWhileRevalidate": 86400,
  "cacheEnabled": true,
  "bypassParamEnabled": true,
  "bypassParamName": "no-cache",
  "cacheTags": {
    "enabled": true,
    "prefix": "cdn-",
    "defaultTags": ["cdn", "r2-objects"]
  },
  "objectTypeConfig": {
    "image": { "maxAge": 86400, "tags": ["images"] },
    "static": { "maxAge": 604800, "tags": ["static"] },
    "document": { "maxAge": 86400, "tags": ["documents"] },
    "video": { "maxAge": 604800, "tags": ["media", "video"] },
    "audio": { "maxAge": 604800, "tags": ["media", "audio"] }
  }
}
```

Cache bypass: `?no-cache` query param skips cache and returns `Cache-Control: no-store`. Also bypassed when the request includes `Cache-Control: no-cache`.

### KV namespace

```jsonc
"kv_namespaces": [
  { "binding": "CDN_CACHE", "id": "e8005733f5a6456ba493ec1454fade26" }
]
```

The `CDN_CACHE` binding is optional. If not present, objects > 28 MB are served from R2 on every request without caching.

### Storage

```jsonc
"STORAGE": {
  "maxRetries": 3,
  "retryDelay": 1000,
  "exponentialBackoff": true
}
```

R2 operations retry up to 3 times with exponential backoff (1s, 2s, 4s).

## Cache tags and purging

Every cached response gets a `Cache-Tag` header with tags derived from:

1. Object-specific tag: `cdn-cdn.erfianugrah.com/path/to/file.jpg`
2. Type tag: `cdn-type-image`
3. Object type config tags: `cdn-images`
4. Default tags: `cdn-cdn`, `cdn-r2-objects`
5. Custom tags via `?tags=foo,bar` query param

Purge by tag:

```bash
curl -X POST "https://api.cloudflare.com/client/v4/zones/{zone_id}/purge_cache" \
  -H "Authorization: Bearer {api_token}" \
  -H "Content-Type: application/json" \
  --data '{"tags":["cdn-type-image"]}'
```

Note: Cache tag purging only affects Cache API entries. KV-cached objects expire via `expirationTtl` — there is no tag-based purge mechanism for KV. To force-evict a KV-cached object, delete its keys from the `CDN_CACHE` namespace via the Cloudflare dashboard or API.

## Content type detection

R2's `httpMetadata` (via `writeHttpMetadata()`) is the source of truth for Content-Type. The worker only falls back to extension-based detection if R2 doesn't provide one. Supported object types: `image`, `video`, `audio`, `document`, `static`, `font`, `archive`, `binary`.

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Returns "Object CDN" |
| GET | `/*` | Serve object from R2 with caching |
| HEAD | `/*` | Same as GET (returns headers only, hits cache via `ignoreMethod`) |

Query params: `?no-cache` (bypass cache), `?tags=a,b` (add custom cache tags), `?via=s3` (use S3 API instead of R2 binding).

### Response headers

| Header | Value | Meaning |
|--------|-------|---------|
| `X-Fetch-Via` | `r2-binding` or `s3` | Which origin path was used (only on cache miss) |
| `CF-Cache-Status` | `HIT` | Served from Cache API (set by Cloudflare, not by us) |
| `CF-Cache-Status` | `DYNAMIC` | Response was generated by the worker (includes KV hits and origin fetches) |
| `X-KV-Cache-Status` | `HIT` | Served from KV cache |

`CF-Cache-Status` is managed by Cloudflare's Cache API layer — we never set it ourselves. Cache API hits show `HIT`; everything else shows `DYNAMIC`. To identify KV cache hits, check for `X-KV-Cache-Status: HIT`.

## Development

```bash
npm install
npm run dev          # wrangler dev on port 9001
npm run typecheck    # tsc --noEmit
npm test             # vitest run (58 tests)
npm run test:watch   # vitest watch mode
```

## Deployment

```bash
npm run deploy       # wrangler deploy (single flat config, no env flag needed)
```

CI/CD: GitHub Actions workflow in `.github/workflows/deploy.yml`.

## Error handling

- Cache operations (both Cache API and KV) are wrapped in try/catch — cache failures never kill the request
- R2 fetch failures return 502
- Global `app.onError()` returns 500
- R2 operations retry with exponential backoff

## Observability

- `logpush: true` — Cloudflare Logpush enabled
- `observability.enabled: true` — Cloudflare observability enabled
- `console.log()` for cache HIT/MISS/put results
- `console.error()` for R2, cache, and KV failures (visible in Workers logs)
- KV cache writes log chunk count, total size, and TTL

## Dependencies

- **hono** — Router framework
- **aws4fetch** — S3 API request signing (for `?via=s3` path)
- **@cloudflare/vitest-pool-workers** — Test runner (dev)
- **@cloudflare/workers-types** — Type definitions (dev)
- **wrangler** — CLI and bundler (dev)
- **vitest** — Test framework (dev)
- **typescript** — Type checking (dev)
