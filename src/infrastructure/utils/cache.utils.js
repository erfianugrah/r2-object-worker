/**
 * Utilities for Cloudflare caching
 */
export class CacheUtils {
  /**
   * Create a cacheable request that only sets cache tags
   */
  static createCacheableRequest(request, options = {}, config) {
    const { objectType, customTags } = options;
    
    // Generate cache tags using our utility method
    const tags = this.generateCacheTags(objectType, config);
    
    // Add any custom tags provided in the options
    if (customTags && Array.isArray(customTags) && customTags.length > 0) {
      tags.push(...customTags);
    }
    
    // Return request with only cacheTags in cf object
    return new Request(request.url, {
      method: request.method,
      headers: request.headers,
      cf: tags.length > 0 ? { cacheTags: tags } : undefined
    });
  }

  /**
   * Add cache headers to a response
   */
  static addCacheHeaders(response, options = {}, config) {
    const cacheConfig = config.getCacheConfig();
    const { objectType, customTags } = options;
    
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
    
    // Add cache tags to the response headers for visibility and debugging
    // This helps users see what tags are associated with a response
    this.addCacheTags(headers, objectType, config);
    
    // Add any custom tags provided in the options
    if (customTags && Array.isArray(customTags) && customTags.length > 0) {
      const existingTags = headers.get('Cache-Tag') || '';
      const separator = existingTags ? ',' : '';
      const newTagsValue = existingTags + separator + customTags.join(',');
      
      // Set both the standard Cache-Tag and the custom X-Cache-Tags header
      headers.set('Cache-Tag', newTagsValue);
      headers.set('X-Cache-Tags', newTagsValue);
    }
    
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
   * Add cache tags to the response headers for visibility and debugging
   * Cache tags are set in both cf.cacheTags and response headers
   */
  static addCacheTags(headers, objectType, config) {
    const cacheConfig = config.getCacheConfig();
    const cacheTagConfig = cacheConfig.cacheTags || {};
    
    // Skip if cache tags are not enabled
    if (!cacheTagConfig.enabled) {
      return;
    }
    
    const tags = this.generateCacheTags(objectType, config);
    
    // Set the Cache-Tag header if we have tags
    if (tags.length > 0) {
      // Set the visible Cache-Tag header for debugging and user visibility
      headers.set('Cache-Tag', tags.join(','));
      
      // Add a custom header that won't be stripped by Cloudflare
      headers.set('X-Cache-Tags', tags.join(','));
    }
  }
  
  /**
   * Generate an array of cache tags based on config and object type
   */
  static generateCacheTags(objectType, config) {
    const cacheConfig = config.getCacheConfig();
    const cacheTagConfig = cacheConfig.cacheTags || {};
    
    const tags = [];
    const prefix = cacheTagConfig.prefix || '';
    
    // Add default tags
    if (Array.isArray(cacheTagConfig.defaultTags)) {
      tags.push(...cacheTagConfig.defaultTags.map(tag => `${prefix}${tag}`));
    }
    
    // Add object type specific tags
    if (objectType) {
      const objectTypeConfig = config.getObjectTypeCacheConfig(objectType) || {};
      if (objectTypeConfig.tags && Array.isArray(objectTypeConfig.tags)) {
        tags.push(...objectTypeConfig.tags.map(tag => `${prefix}${tag}`));
      }
      
      // Add the object type itself as a tag
      tags.push(`${prefix}type-${objectType}`);
    }
    
    // Add any custom tags from options if provided in future
    return tags;
  }

  /**
   * Get content-specific cache configuration 
   * Note: Only used for cache tags with Cache API, not for CF object caching
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