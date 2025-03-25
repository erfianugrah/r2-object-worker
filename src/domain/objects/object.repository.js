import { NotFoundError } from "../../infrastructure/errors/error.handler.js";
import { Logger } from "../../infrastructure/utils/logger.js";

/**
 * Repository for handling object storage operations (merged with former ImageRepository)
 */
export class ObjectRepository {
  constructor(storageAdapter, config) {
    this.storageAdapter = storageAdapter;
    this.config = config;
    this.logger = new Logger(config);
  }

  /**
   * Get an object by key
   */
  async getObjectByKey(key) {
    const logger = this.logger.child({ 
      operation: 'getObjectByKey', 
      key 
    });
    
    logger.debug('Retrieving object from storage', {}, 'storage_get_start');
    
    try {
      const object = await this.storageAdapter.getObject(key);
      
      if (!object) {
        logger.warn('Object not found', { key }, ['storage_get_start', 'object_not_found']);
        throw new NotFoundError("Object Not Found");
      }
      
      logger.debug('Object retrieved successfully', { 
        size: object.size,
        etag: object.httpEtag
      }, ['storage_get_start', 'storage_get_success']);
      
      return object;
    } catch (error) {
      // Only log if it's not already a NotFoundError (which we already logged)
      if (!(error instanceof NotFoundError)) {
        logger.error('Error retrieving object', {
          key,
          error: {
            message: error.message,
            name: error.name,
            stack: error.stack
          }
        }, ['storage_get_start', 'storage_get_error']);
      }
      
      throw error;
    }
  }
  
  /**
   * List objects with optional prefix and limit
   */
  async listObjects(options = {}) {
    const { prefix = '', limit = 1000 } = options;
    
    const logger = this.logger.child({ 
      operation: 'listObjects', 
      prefix,
      limit
    });
    
    logger.debug('Listing objects from storage', { options }, 'storage_list_start');
    
    try {
      const result = await this.storageAdapter.listObjects(options);
      
      logger.debug('Objects listed successfully', { 
        count: result.objects.length,
        truncated: result.truncated
      }, ['storage_list_start', 'storage_list_success']);
      
      return result;
    } catch (error) {
      logger.error('Error listing objects', {
        options,
        error: {
          message: error.message,
          name: error.name,
          stack: error.stack
        }
      }, ['storage_list_start', 'storage_list_error']);
      
      throw error;
    }
  }
}