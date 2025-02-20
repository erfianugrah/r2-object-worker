/**
 * Utilities for Cloudflare caching
 */
export class CacheUtils {
  /**
   * Create a cacheable request with appropriate CF properties
   */
  static createCacheableRequest(request, options = {}, config) {
    const cacheConfig = config.getCacheConfig();
    const { objectType } = options;
    const cacheTtl = options.cacheTtl || cacheConfig.defaultMaxAge;
    const cacheEverything = options.cacheEverything !== undefined ? 
      options.cacheEverything : cacheConfig.cacheEverything;
    
    // Clone the request and add CF-specific cache properties
    return new Request(request.url, {
      method: request.method,
      headers: request.headers,
      cf: {
        // Cache everything option enables caching for all file types
        cacheEverything,
        // Set the TTL for the cache
        cacheTtl,
        // Cache based on content type if specified
        ...(objectType && this.getObjectSpecificCacheConfig(objectType, config))
      }
    });
  }

  /**
   * Add cache headers to a response
   */
  static addCacheHeaders(response, options = {}, config) {
    const cacheConfig = config.getCacheConfig();
    const { objectType } = options;
    
    // Get object-specific cache config or use defaults
    const objectTypeConfig = config.getObjectTypeCacheConfig(objectType) || {};
    
    const maxAge = options.maxAge || objectTypeConfig.maxAge || cacheConfig.defaultMaxAge;
    const staleWhileRevalidate = options.staleWhileRevalidate || cacheConfig.defaultStaleWhileRevalidate;
    const isPrivate = options.isPrivate || false;

    const headers = new Headers(response.headers);
    
    // Set Cache-Control
    const cacheControl = this.generateCacheControl({
      objectType,
      maxAge, 
      staleWhileRevalidate,
      isPrivate
    }, config);
    headers.set('Cache-Control', cacheControl);
    
    // Set Vary header for proper cache differentiation
    headers.set('Vary', 'Accept-Encoding');
    
    // Add cache tags if enabled
    this.addCacheTags(headers, objectType, config);
    
    // Add security headers based on object type
    const securityHeaders = config.getObjectTypeSecurityHeaders(objectType);
    for (const [key, value] of Object.entries(securityHeaders)) {
      headers.set(key, value);
    }

    // Create a new response with the updated headers
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
  
  /**
   * Add cache tags to the response
   */
  static addCacheTags(headers, objectType, config) {
    const cacheConfig = config.getCacheConfig();
    const cacheTagConfig = cacheConfig.cacheTags || {};
    
    // Skip if cache tags are not enabled
    if (!cacheTagConfig.enabled) {
      return;
    }
    
    const tags = [];
    const prefix = cacheTagConfig.prefix || '';
    
    // Add default tags
    if (Array.isArray(cacheTagConfig.defaultTags)) {
      tags.push(...cacheTagConfig.defaultTags.map(tag => `${prefix}${tag}`));
    }
    
    // Add object type specific tags
    const objectTypeConfig = config.getObjectTypeCacheConfig(objectType) || {};
    if (objectTypeConfig.tags && Array.isArray(objectTypeConfig.tags)) {
      tags.push(...objectTypeConfig.tags.map(tag => `${prefix}${tag}`));
    }
    
    // Add the object type itself as a tag
    if (objectType) {
      tags.push(`${prefix}type-${objectType}`);
    }
    
    // Set the Cache-Tag header if we have tags
    if (tags.length > 0) {
      headers.set('Cache-Tag', tags.join(','));
    }
  }

  /**
   * Get content-specific cache configuration 
   */
  static getObjectSpecificCacheConfig(objectType, config) {
    return config.getObjectTypeCacheConfig(objectType);
  }

  /**
   * Generate cache control header value
   */
  static generateCacheControl(options, config) {
    const cacheConfig = config.getCacheConfig();
    const {
      objectType,
      maxAge = cacheConfig.defaultMaxAge,
      staleWhileRevalidate = cacheConfig.defaultStaleWhileRevalidate,
      isPrivate = false,
    } = options;

    // For sensitive object types, restrict caching
    if (config.isSensitiveObjectType(objectType)) {
      return 'private, no-store, max-age=0';
    }

    // Default cache control
    return `${isPrivate ? 'private' : 'public'}, max-age=${maxAge}, stale-while-revalidate=${staleWhileRevalidate}`;
  }
}