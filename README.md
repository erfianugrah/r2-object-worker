# R2 Objects Worker

A Cloudflare Worker for serving objects (images, documents, videos, etc.) from R2 buckets with proper caching, content type handling, and cache invalidation support.

## Features

- Serves any type of object from R2 storage with proper content types
- Implements Cloudflare Cache API for explicit caching control and CF-Cache-Status headers
- Configurable cache tags for selective cache purging
- Advanced caching strategies based on object type
- Optimized for different content types (images, documents, videos, static assets)
- Configurable via wrangler.jsonc with environment-specific overrides
- Health check endpoint
- Object listing endpoint with prefix filtering
- Domain-driven design architecture

## Architecture

The application follows a domain-driven design approach with the following structure:

- `src/domain/` - Business logic organized by domain
  - `objects/` - Object handling logic (repositories, services, controllers)
  - `health/` - Health check functionality
- `src/infrastructure/` - Infrastructure code
  - `config/` - Configuration loader with environment variable support
  - `storage/` - R2 storage adapter
  - `utils/` - Utilities for caching, content types, etc.
  - `errors/` - Centralized error handling
  - `router/` - Request routing based on paths and methods

## Caching Strategy

The worker implements a multi-layered caching strategy:

1. **Cloudflare Cache API** - Explicitly stores and retrieves responses from Cloudflare's cache
2. **Cache Tags** - Configurable object-type and custom tags for selective cache purging
3. **Content-Type Optimizations** - Different caching strategies based on content type
4. **Cache-Control Headers** - Standard cache control with stale-while-revalidate support
5. **ETags and Conditional Requests** - Efficient validation caching

All caching behavior is configurable via the wrangler.jsonc file.

## Configuration

All configuration is managed through `wrangler.jsonc`. The configuration is structured in three main sections:

1. **Storage Configuration**
   - Controls behavior of storage operations (retries, timeouts, etc.)
   ```json
   "STORAGE": {
     "maxRetries": 3,
     "retryDelay": 1000,
     "exponentialBackoff": true,
     "defaultListLimit": 1000
   }
   ```

2. **Cache Configuration**
   - Sets cache TTLs and strategies based on object type
   - Configures Cloudflare-specific caching features
   - Configures cache tags for cache purging
   ```json
   "CACHE": {
     "defaultMaxAge": 86400,
     "defaultStaleWhileRevalidate": 86400,
     "cacheEverything": true,
     "cacheTags": {
       "enabled": true,
       "prefix": "cdn-",
       "defaultTags": ["cdn", "r2-objects"]
     },
     "objectTypeConfig": {
       "image": {
         "polish": "lossy",
         "webp": true,
         "maxAge": 86400,
         "tags": ["images"]
       }
     }
   }
   ```

3. **Security Configuration**
   - Defines security headers based on object type
   ```json
   "SECURITY": {
     "headers": {
       "default": {
         "X-Content-Type-Options": "nosniff",
         "Content-Security-Policy": "default-src 'none'"
       },
       "image": {
         "Content-Security-Policy": "default-src 'none'; img-src 'self'"
       }
     }
   }
   ```

The configuration is loaded at runtime and injected into components via dependency injection.

## Development

### Prerequisites

- Node.js 16+
- npm or yarn
- Wrangler CLI (`npm install -g wrangler`)

### Setup

1. Clone the repository
2. Install dependencies: `npm install`
3. Configure wrangler.jsonc with your settings
4. Run the development server: `npm run dev`

### Testing

- Run tests: `npm test`
- Run tests in watch mode: `npm run test:watch`

## Deployment

- Deploy to staging: `npm run deploy:staging`
- Deploy to production: `npm run deploy:prod`

## API Endpoints

- `GET /` - Returns basic info about the CDN
- `GET /_health` - Health check endpoint
- `GET /_list?prefix=<prefix>&limit=<limit>` - List objects with optional prefix and limit
- `GET /<key>` - Retrieve object by key with appropriate content type and caching

## Cache Invalidation

Objects can be purged from the cache using Cloudflare's cache purge API, targeting specific cache tags:

```bash
curl -X POST "https://api.cloudflare.com/client/v4/zones/{zone_id}/purge_cache" \
     -H "Authorization: Bearer {api_token}" \
     -H "Content-Type: application/json" \
     --data '{"tags":["cdn-images","cdn-type-image"]}'
```

## License

MIT