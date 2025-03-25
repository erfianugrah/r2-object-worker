import { CacheUtils } from "../../infrastructure/utils/cache.utils.js";
import { ContentTypeUtils } from "../../infrastructure/utils/content-type.utils.js";
import { Logger } from "../../infrastructure/utils/logger.js";

/**
 * Controller for handling object-related HTTP requests
 */
export class ObjectController {
  constructor(objectService, config) {
    this.objectService = objectService;
    this.config = config;
    this.logger = new Logger(config);
  }

  /**
   * Handle object request
   */
  async handleObjectRequest(request, url) {
    // Create a controller-level request logger
    const ctrlLogger = this.logger.createRequestLogger(request);
    const requestStartTime = Date.now();
    
    // Extract key from path
    const key = url.pathname.slice(1);
    
    // Log request received with detailed info
    ctrlLogger.info(`Object controller received request for: ${key}`, {
      key,
      url: url.toString(),
      queryParams: Object.fromEntries(url.searchParams.entries()),
      method: request.method,
      path: url.pathname,
      acceptHeader: request.headers.get('accept'),
      acceptEncoding: request.headers.get('accept-encoding')
    }, 'controller_request_start');
    
    // Extract custom tags from query parameters if provided
    const customTags = url.searchParams.get("tags") ? 
      url.searchParams.get("tags").split(",") : 
      [];
    
    // Check cache settings
    const cacheConfig = this.config.getCacheConfig();
    
    // Check if caching is globally disabled or bypassed via query parameter
    const cacheEnabled = cacheConfig.cacheEnabled !== false; // Default to true if not specified
    const bypassParamEnabled = cacheConfig.bypassParamEnabled;
    const bypassParamName = cacheConfig.bypassParamName || 'no-cache';
    const bypassCache = !cacheEnabled || (bypassParamEnabled && url.searchParams.has(bypassParamName));
    
    // Log cache decision
    ctrlLogger.debug(`Cache settings for request: ${key}`, {
      cacheEnabled,
      bypassParamEnabled,
      bypassParamName,
      bypassCache,
      bypassReason: !cacheEnabled ? 'global_setting' : 
                    (bypassParamEnabled && url.searchParams.has(bypassParamName)) ? 'query_param' : 'none'
    }, ['controller_request_start', 'cache_decision']);
    
    // Create a cacheable request if it's GET method and caching is enabled and not bypassed
    let cachableRequest = request;
    if (request.method === "GET" && !bypassCache) {
      const objectType = ContentTypeUtils.getObjectTypeFromKey(key);
      // Using createCacheableRequest with support for custom tags
      cachableRequest = CacheUtils.createCacheableRequest(
        request, 
        { objectType, customTags }, 
        this.config
      );
      
      ctrlLogger.debug(`Created cacheable request for key: ${key}`, {
        objectType,
        hasCustomTags: customTags.length > 0,
        tags: customTags
      }, ['controller_request_start', 'cache_decision', 'cacheable_request_created']);
    }
    
    // Process the request through service layer
    try {
      const startServiceTime = Date.now();
      const response = await this.objectService.getObject(key, cachableRequest, { customTags, bypassCache });
      const serviceDuration = Date.now() - startServiceTime;
      
      // Log the completed request
      const totalDuration = Date.now() - requestStartTime;
      const cacheStatus = response.headers.get('x-cache-status');
      
      ctrlLogger.info(`Object controller completed request for: ${key}`, {
        key,
        method: request.method,
        status: response.status,
        cacheStatus,
        contentType: response.headers.get('content-type'),
        contentLength: response.headers.get('content-length'),
        serviceDuration,
        totalDuration,
        overhead: totalDuration - serviceDuration
      }, ['controller_request_start', 'controller_request_complete']);
      
      return response;
    } catch (error) {
      // Log controller-level error
      ctrlLogger.error(`Controller error processing request for: ${key}`, {
        key,
        error: {
          name: error.name,
          message: error.message,
          statusCode: error.statusCode,
          stack: error.stack
        },
        duration: Date.now() - requestStartTime
      }, ['controller_request_start', 'controller_request_error']);
      
      // Re-throw for global error handler
      throw error;
    }
  }

  /**
   * Handle object list request
   */
  async handleListRequest(request, url) {
    // Create a controller-level request logger
    const ctrlLogger = this.logger.createRequestLogger(request);
    const requestStartTime = Date.now();
    
    // Extract and log list parameters
    const prefix = url.searchParams.get("prefix") || "";
    const limitParam = url.searchParams.get("limit");
    // Use default from config if not specified in query
    const limit = limitParam ? 
      parseInt(limitParam, 10) : 
      this.config.getStorageConfig().defaultListLimit;
    
    // Log list request details
    ctrlLogger.info(`List objects request received`, {
      prefix,
      limit,
      url: url.toString(),
      queryParams: Object.fromEntries(url.searchParams.entries())
    }, 'list_request_start');
    
    try {
      // Pass the request object for tracing and measure service time
      const serviceStartTime = Date.now();
      const result = await this.objectService.listObjects(prefix, limit, request);
      const serviceDuration = Date.now() - serviceStartTime;
      
      // Prepare response
      const response = new Response(JSON.stringify(result), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          "X-Object-Count": result.objects.length.toString(),
          "X-List-Truncated": result.truncated.toString(),
          "X-Cursor-Present": (!!result.cursor).toString()
        }
      });
      
      // Log list completion with metrics
      const totalDuration = Date.now() - requestStartTime;
      ctrlLogger.info(`List objects request completed`, {
        prefix,
        limit,
        objectCount: result.objects.length,
        truncated: result.truncated,
        hasCursor: !!result.cursor,
        objectTypes: [...new Set(result.objects.map(obj => obj.type))],
        serviceDuration,
        totalDuration,
        overhead: totalDuration - serviceDuration
      }, ['list_request_start', 'list_request_complete']);
      
      return response;
    } catch (error) {
      // Log controller-level error
      ctrlLogger.error(`Controller error processing list request`, {
        prefix,
        limit,
        error: {
          name: error.name,
          message: error.message,
          statusCode: error.statusCode,
          stack: error.stack
        },
        duration: Date.now() - requestStartTime
      }, ['list_request_start', 'list_request_error']);
      
      // Re-throw for global error handler
      throw error;
    }
  }
}