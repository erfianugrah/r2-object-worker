import { CacheUtils } from "../../infrastructure/utils/cache.utils.js";
import { ContentTypeUtils } from "../../infrastructure/utils/content-type.utils.js";

/**
 * Controller for handling object-related HTTP requests
 */
export class ObjectController {
  constructor(objectService, config) {
    this.objectService = objectService;
    this.config = config;
  }

  /**
   * Handle object request
   */
  async handleObjectRequest(request, url) {
    const key = url.pathname.slice(1);
    
    // Create a cacheable request if it's GET method
    let cachableRequest = request;
    if (request.method === "GET") {
      const objectType = ContentTypeUtils.getObjectTypeFromKey(key);
      cachableRequest = CacheUtils.createCacheableRequest(request, { objectType }, this.config);
    }
    
    return await this.objectService.getObject(key, cachableRequest);
  }

  /**
   * Handle object list request
   */
  async handleListRequest(request, url) {
    const prefix = url.searchParams.get("prefix") || "";
    const limitParam = url.searchParams.get("limit");
    // Use default from config if not specified in query
    const limit = limitParam ? 
      parseInt(limitParam, 10) : 
      this.config.getStorageConfig().defaultListLimit;
    
    const result = await this.objectService.listObjects(prefix, limit);
    
    return new Response(JSON.stringify(result), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache"
      }
    });
  }
}