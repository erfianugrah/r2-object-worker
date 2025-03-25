import { ContentTypeUtils } from "../../infrastructure/utils/content-type.utils.js";
import { CacheUtils } from "../../infrastructure/utils/cache.utils.js";
import { Logger } from "../../infrastructure/utils/logger.js";

/**
 * Service for handling object business logic
 */
export class ObjectService {
  constructor(objectRepository, config) {
    this.objectRepository = objectRepository;
    this.config = config;
    this.logger = new Logger(config);
  }

  /**
   * Get object with appropriate headers
   */
  async getObject(key, request, options = {}) {
    // Create a request-specific logger with trace ID
    const requestLogger = this.logger.createRequestLogger(request);
    
    // Extract options
    const { customTags, bypassCache } = options;
    
    // Log request details
    requestLogger.info(`Object request for key: ${key}`, { 
      key, 
      bypassCache,
      customTags 
    }, 'request_start');
    
    // Create a cacheable request to enable CF caching
    const cacheKey = new URL(request.url);
    const cacheRequest = new Request(cacheKey, request);
    
    // Skip cache check if bypass is requested
    let response;
    if (!bypassCache) {
      // Check if we have the response in the cache
      requestLogger.debug('Checking cache', { cacheKey: cacheKey.toString() }, 'cache_check');
      
      const cache = caches.default;
      response = await cache.match(cacheRequest);
      
      if (response) {
        // Log detailed cache hit
        const contentLength = parseInt(response.headers.get('content-length'), 10);
        const mimeType = response.headers.get('content-type');
        const requestStartTime = requestLogger.startTime || Date.now();
        this.logger.logCacheEvent(key, 'HIT', {
          size: contentLength,
          type: mimeType,
          etag: response.headers.get('etag'),
          lastModified: response.headers.get('last-modified'),
          responseTime: Date.now() - requestStartTime
        }, ['request_start', 'cache_hit']);
        
        // Add an indicator that response was served from cache
        const headers = new Headers(response.headers);
        headers.set("X-Cache-Status", "HIT");
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers
        });
      }
      
      // Log cache miss
      requestLogger.debug(`Cache miss for key: ${key}`, {}, ['request_start', 'cache_miss']);
    } else {
      requestLogger.debug(`Cache bypass for key: ${key}`, {}, ['request_start', 'cache_bypass']);
    }
    
    // Fetch from R2 with timing
    const fetchStartTime = Date.now();
    requestLogger.debug(`Fetching object from R2: ${key}`, {
      startTime: fetchStartTime
    }, ['request_start', 'r2_fetch_start']);
    
    try {
      const object = await this.objectRepository.getObjectByKey(key);
      const fetchDuration = Date.now() - fetchStartTime;
      
      // Log detailed R2 fetch completion
      this.logger.logStorageEvent('FETCH', key, {
        startTime: fetchStartTime,
        duration: fetchDuration,
        size: object.size,
        etag: object.httpEtag,
        uploaded: object.uploaded
      }, ['request_start', 'r2_fetch_start', 'r2_fetch_complete']);
      
      // Determine content type and object type
      const contentType = ContentTypeUtils.getContentTypeFromKey(key);
      const objectType = ContentTypeUtils.getObjectTypeFromContentType(contentType);
      
      requestLogger.debug(`Object retrieved from R2`, { 
        objectType,
        contentType,
        size: object.size,
        etag: object.httpEtag
      }, ['request_start', 'r2_fetch', 'r2_success']);
      
      // Generate headers
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      headers.set("Content-Type", contentType);
      
      // Add cache bypass indicator if requested
      if (bypassCache) {
        headers.set("X-Cache-Status", "BYPASS");
        headers.set("Cache-Control", "no-store, max-age=0");
      }
      
      // Create the response
      response = new Response(object.body, { headers });
      
      // Only add cache headers and store in cache if not bypassing
      if (!bypassCache) {
        // Add cache and security headers (including custom tags)
        response = CacheUtils.addCacheHeaders(response, { objectType, customTags }, this.config);
        
        // Cache the response for future requests - with timing
        const cacheStoreStart = Date.now();
        requestLogger.debug(`Storing response in cache`, {
          objectType,
          contentType,
          cacheKey: cacheKey.toString(),
          startTime: cacheStoreStart
        }, ['request_start', 'r2_fetch_complete', 'cache_store_start']);
        
        const cache = caches.default;
        await cache.put(cacheRequest, response.clone());
        
        // Log cache store metrics
        const cacheStoreDuration = Date.now() - cacheStoreStart; 
        this.logger.logCacheEvent(key, 'STORE', {
          size: object.size,
          type: contentType,
          objectType,
          startTime: cacheStoreStart,
          duration: cacheStoreDuration,
          maxAge: this.config.getObjectTypeCacheConfig(objectType)?.maxAge || this.config.getCacheConfig().defaultMaxAge
        }, ['request_start', 'r2_fetch_complete', 'cache_store_start', 'cache_store_complete']);
        
        // Set cache status to MISS since we had to fetch from R2
        const responseHeaders = new Headers(response.headers);
        responseHeaders.set("X-Cache-Status", "MISS");
        response = new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders
        });
        
        // Log request completion metrics
        this.logger.logRequestCompletion(requestLogger, response, {
          key,
          objectType,
          cacheStatus: 'MISS',
          r2FetchTime: fetchDuration,
          cacheStoreTime: cacheStoreDuration,
          size: object.size,
          startTime: requestLogger.startTime
        });
      } else {
        // Set cache status
        const responseHeaders = new Headers(response.headers);
        responseHeaders.set("X-Cache-Status", "BYPASS");
        response = new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders  
        });
        
        // Log request completion metrics for bypass
        this.logger.logRequestCompletion(requestLogger, response, {
          key,
          objectType,
          cacheStatus: 'BYPASS',
          r2FetchTime: fetchDuration,
          bypassReason: bypassCache === true ? 'explicit' : 'configuration',
          size: object.size,
          startTime: requestLogger.startTime
        });
      }
      
      return response;
    } catch (error) {
      // Calculate error time and log detailed error info
      const errorTime = Date.now();
      const fetchAttemptDuration = errorTime - fetchStartTime;
      const requestStartTime = requestLogger.startTime || Date.now();
      
      // Log comprehensive error details
      this.logger.error(`Error fetching object from R2: ${key} (${error.name}: ${error.message})`, {
        key,
        status: error.statusCode || 500,
        duration: fetchAttemptDuration,
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
          code: error.code
        },
        timeElapsed: errorTime - requestStartTime
      }, ['request_start', 'r2_fetch_start', 'r2_fetch_error']);
      
      // Re-throw the error
      throw error;
    }
  }
  
  /**
   * List objects with optional prefix and limit
   */
  async listObjects(prefix = "", limit = 100, request = null) {
    // Create a request-specific logger with trace ID if request is provided
    const requestLogger = request 
      ? this.logger.createRequestLogger(request)
      : this.logger.child({ operation: 'listObjects' });
    
    requestLogger.info('List objects request', { 
      prefix, 
      limit 
    }, 'list_request_start');
    
    // Use default list limit from config if not specified
    const actualLimit = limit || this.config.getStorageConfig().defaultListLimit;
    
    try {
      requestLogger.debug('Fetching objects from R2', { 
        prefix, 
        limit: actualLimit 
      }, ['list_request_start', 'r2_list_fetch']);
      
      const result = await this.objectRepository.listObjects({
        prefix,
        limit: actualLimit
      });
      
      const objectCount = result.objects.length;
      requestLogger.info(`Retrieved ${objectCount} objects from R2`, { 
        count: objectCount,
        truncated: result.truncated,
        cursor: !!result.cursor
      }, ['list_request_start', 'r2_list_fetch', 'r2_list_success']);
      
      // Transform the result to a simpler format
      const formattedResult = {
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
      
      requestLogger.debug('Transformed list results', {
        objectTypes: formattedResult.objects.map(obj => obj.type)
          .filter((v, i, a) => a.indexOf(v) === i) // Get unique types
      }, ['list_request_start', 'r2_list_fetch', 'r2_list_success', 'list_response_complete']);
      
      return formattedResult;
    } catch (error) {
      requestLogger.error('Error listing objects from R2', {
        prefix,
        limit: actualLimit,
        error: {
          message: error.message,
          stack: error.stack
        }
      }, ['list_request_start', 'r2_list_fetch', 'r2_list_error']);
      
      throw error;
    }
  }
}