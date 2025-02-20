import { ContentTypeUtils } from "../../infrastructure/utils/content-type.utils.js";
import { CacheUtils } from "../../infrastructure/utils/cache.utils.js";

/**
 * Service for handling object business logic
 */
export class ObjectService {
  constructor(objectRepository, config) {
    this.objectRepository = objectRepository;
    this.config = config;
  }

  /**
   * Get object with appropriate headers
   */
  async getObject(key, request) {
    // Create a cacheable request to enable CF caching
    const cacheKey = new URL(request.url);
    const cacheRequest = new Request(cacheKey, request);
    
    // Check if we have the response in the cache
    const cache = caches.default;
    let response = await cache.match(cacheRequest);
    
    if (response) {
      return response;
    }
    
    // Otherwise, fetch from R2
    const object = await this.objectRepository.getObjectByKey(key);
    
    // Determine content type and object type
    const contentType = ContentTypeUtils.getContentTypeFromKey(key);
    const objectType = ContentTypeUtils.getObjectTypeFromContentType(contentType);
    
    // Generate headers
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("Content-Type", contentType);
    
    // Create the response
    response = new Response(object.body, { headers });
    
    // Add cache and security headers
    response = CacheUtils.addCacheHeaders(response, { objectType }, this.config);
    
    // Cache the response for future requests
    await cache.put(cacheRequest, response.clone());
    
    return response;
  }
  
  /**
   * List objects with optional prefix and limit
   */
  async listObjects(prefix = "", limit = 100) {
    // Use default list limit from config if not specified
    const actualLimit = limit || this.config.getStorageConfig().defaultListLimit;
    
    const result = await this.objectRepository.listObjects({
      prefix,
      limit: actualLimit
    });
    
    // Transform the result to a simpler format
    return {
      objects: result.objects.map(obj => ({
        key: obj.key,
        size: obj.size,
        etag: obj.etag,
        uploaded: obj.uploaded,
        type: ContentTypeUtils.getObjectTypeFromKey(obj.key)
      })),
      truncated: result.truncated,
      cursor: result.cursor
    };
  }
}