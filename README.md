# R2 Objects Worker

[![npm version](https://img.shields.io/npm/v/r2-objects-worker)](https://www.npmjs.com/package/r2-objects-worker)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Tests](https://img.shields.io/github/actions/workflow/status/erfi/r2-object-worker/test.yml?branch=main&label=tests)](https://github.com/erfi/r2-object-worker/actions)
[![Deploy](https://img.shields.io/github/actions/workflow/status/erfi/r2-object-worker/deploy.yml?branch=main&label=deploy)](https://github.com/erfi/r2-object-worker/actions)

A Cloudflare Worker for serving objects (images, documents, videos, etc.) from R2 buckets with proper caching, content type handling, and cache invalidation support.

## Features

- Serves any type of object from R2 storage with proper content types
- Implements Cloudflare Cache API for explicit caching control and CF-Cache-Status headers
- Configurable cache tags for selective cache purging
- Advanced caching strategies based on object type
- Optimized for different content types (images, documents, videos, static assets, fonts, archives)
- Supports range requests for partial content (useful for video/audio streaming)
- Content type auto-detection based on file extensions
- Conditional requests with ETags for efficient validation caching
- Configurable via wrangler.jsonc with environment-specific overrides
- Health check endpoint
- Object listing endpoint with prefix filtering
- Domain-driven design architecture
- Centralized error handling
- Retry logic with exponential backoff for R2 operations
- Comprehensive logging with Pino

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

### Architectural Patterns

The application implements several architectural patterns:

1. **Repository Pattern**: The ObjectRepository abstracts data access from business logic
2. **Adapter Pattern**: The R2StorageAdapter isolates the R2 implementation details
3. **Dependency Injection**: All components receive their dependencies through constructors
4. **Middleware Pattern**: Request processing includes middleware-like functions for headers and caching
5. **Router**: Pattern-based routing with method filtering

## Caching Strategy

The worker implements a multi-layered caching strategy:

1. **Cloudflare Cache API** - Explicitly stores and retrieves responses from Cloudflare's cache
2. **Cache Tags** - Configurable object-type and custom tags for selective cache purging
3. **Content-Type Based Optimization** - Different caching strategies based on content type
4. **Cache-Control Headers** - Standard cache control with stale-while-revalidate support
5. **ETags and Conditional Requests** - Efficient validation caching

All caching behavior is configurable via the wrangler.jsonc file.

## Supported Object Types

The worker automatically detects and optimizes handling for these object types:

- **image**: Images (jpg, png, gif, webp, svg, etc.)
- **video**: Video files (mp4, webm, avi, etc.)
- **audio**: Audio files (mp3, wav, ogg, etc.)
- **document**: Documents (pdf, doc, docx, etc.)
- **static**: Static web assets (js, css, html, etc.)
- **font**: Font files (woff, woff2, ttf, etc.)
- **archive**: Archive files (zip, tar, gz, etc.)
- **binary**: Generic binary files

Each object type can have custom caching, security, and optimization settings.

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
     },
     "sensitiveTypes": ["private", "secure"]
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

### Configuration via Environment Variables

All configuration can be overridden using environment variables at runtime. The Config class will prioritize values from the environment over the defaults in wrangler.jsonc.

## Logging

The application implements comprehensive logging using Pino:

- Log levels configurable by environment
- Request ID and trace ID tracking
- Breadcrumb trails for tracking request flow
- Performance metrics logging
- Redaction of sensitive information
- Structured logging format for easy querying
- Pretty printing in development mode

## Error Handling

The application implements centralized error handling:

- Custom error classes with HTTP status codes
- Automatic error response formatting
- Error logging and monitoring support
- Different error responses based on error type

## API Endpoints

- `GET /` - Returns basic info about the CDN
- `GET /_health` - Health check endpoint
- `GET /_list?prefix=<prefix>&limit=<limit>` - List objects with optional prefix and limit
- `GET /<key>` - Retrieve object by key with appropriate content type and caching

## Custom Cache Tags

You can add custom cache tags to objects by including them in the URL query parameter:

```
GET /images/photo.jpg?tags=product-123,promo-summer
```

This adds the specified tags to the Cloudflare cache entry, allowing you to purge specific items by tag later. Custom tags appear in both the Cache-Tag response header and the cf.cacheTags object.

Tags are applied in three levels:
1. Default tags from configuration (e.g., "cdn", "r2-objects")
2. Object-type specific tags (e.g., "images" for image files)
3. Custom tags provided in the URL query parameter

## Cache Invalidation

Objects can be purged from the cache using Cloudflare's cache purge API, targeting specific cache tags:

```bash
curl -X POST "https://api.cloudflare.com/client/v4/zones/{zone_id}/purge_cache" \
     -H "Authorization: Bearer {api_token}" \
     -H "Content-Type: application/json" \
     --data '{"tags":["cdn-images","cdn-type-image","product-123"]}'
```

Examples of tags you can use for purging:
- `cdn-images` - Purge all image files
- `cdn-type-video` - Purge all video files
- `product-123` - Purge a specific product image that had this custom tag
- `promo-summer` - Purge all assets related to a summer promotion

## Performance Considerations

The worker implements several performance optimizations:

1. **Content Type Detection**: Efficient extension-based content type detection
2. **Range Requests**: Support for partial content requests to optimize large media streaming
3. **ETag-based Validation**: Conditional request handling to minimize bandwidth
4. **Smart Cache TTLs**: Different caching durations based on content type
5. **Cloudflare Cache API**: Direct integration with Cloudflare's caching infrastructure
6. **Cache Tags**: Granular cache invalidation
7. **Retry Logic**: Automatic retries with exponential backoff

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

## Extending the Worker

### Adding New Object Types

To add support for a new object type:

1. Update the content-type.utils.js to include the new type and its extensions
2. Add cache configuration for the new type in the default config
3. Add security headers for the new type in the default config
4. Test with example objects of the new type

### Custom Request Processing

The router can be extended to add custom request handling:

1. Add a new pattern in the router
2. Create a new controller, service, and repository if needed
3. Update the router to use the new components

## Recent Changes

### Added Pino Logging
- Comprehensive structured logging system
- Request tracing with IDs
- Performance metrics
- Log levels configurable by environment

### Improved Error Handling
- Custom error classes with HTTP status codes
- Centralized error handling
- Detailed error logging

### Enhanced Caching
- Added advanced caching strategies
- Support for cache tags
- Improved cache control headers

### Updated Router
- Pattern-based routing
- Method filtering
- Improved request handling

## License

[MIT](./LICENSE)