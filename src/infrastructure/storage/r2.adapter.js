import { Logger } from "../utils/logger.js";

/**
 * R2 Storage adapter for interacting with Cloudflare R2
 */
export class R2StorageAdapter {
  constructor(bucket, config) {
    this.bucket = bucket;
    this.config = config;
    this.storageConfig = config.getStorageConfig();
    this.logger = new Logger(config);
  }

  /**
   * Get an object from R2 with retry logic
   */
  async getObject(key, options = {}) {
    const maxRetries = options.maxRetries || this.storageConfig.maxRetries;
    const retryDelay = options.retryDelay || this.storageConfig.retryDelay;
    const exponentialBackoff = options.exponentialBackoff !== undefined ? 
      options.exponentialBackoff : this.storageConfig.exponentialBackoff;
    
    // Create a specific logger for this operation
    const opLogger = this.logger.child({ 
      operation: 'r2_get_object', 
      key,
      maxRetries,
      retryDelay 
    });
    
    opLogger.debug('Fetching object from R2', { options }, 'r2_fetch_start');

    let object;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        opLogger.debug(`R2 fetch attempt ${attempt + 1}/${maxRetries}`, {
          attempt: attempt + 1,
          hasRange: !!options.range,
          hasCondition: !!options.onlyIf
        }, ['r2_fetch_start', `attempt_${attempt + 1}`]);
        
        // Support getting object with range header
        if (options.range) {
          object = await this.bucket.get(key, {
            range: options.range,
            onlyIf: options.onlyIf
          });
        } else {
          object = await this.bucket.get(key, {
            onlyIf: options.onlyIf
          });
        }
        
        if (object) {
          opLogger.debug('R2 fetch successful', {
            attempt: attempt + 1,
            size: object.size,
            etag: object.httpEtag
          }, ['r2_fetch_start', `attempt_${attempt + 1}`, 'r2_fetch_success']);
          break;
        }
        
        opLogger.warn('R2 fetch returned no object', {
          attempt: attempt + 1,
          key
        }, ['r2_fetch_start', `attempt_${attempt + 1}`, 'r2_fetch_empty']);
        
        // If no object and not last attempt, wait before retrying
        if (attempt < maxRetries - 1) {
          // Calculate delay with exponential backoff if enabled
          const delay = exponentialBackoff 
            ? retryDelay * Math.pow(2, attempt)
            : retryDelay;
          
          opLogger.debug(`Waiting ${delay}ms before retry`, {
            delay,
            nextAttempt: attempt + 2
          }, ['r2_fetch_start', `attempt_${attempt + 1}`, 'r2_fetch_empty', 'r2_retry_wait']);
            
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      } catch (fetchError) {
        opLogger.error(`R2 fetch attempt ${attempt + 1} failed`, {
          attempt: attempt + 1,
          error: {
            message: fetchError.message,
            name: fetchError.name,
            stack: fetchError.stack
          }
        }, ['r2_fetch_start', `attempt_${attempt + 1}`, 'r2_fetch_error']);
        
        // If it's the last attempt, throw the error
        if (attempt === maxRetries - 1) {
          opLogger.error('R2 fetch failed after all retry attempts', {
            key,
            maxRetries,
            error: {
              message: fetchError.message,
              name: fetchError.name
            }
          }, ['r2_fetch_start', 'r2_fetch_max_retries', 'r2_fetch_failure']);
          throw fetchError;
        }
        
        // Otherwise wait before retrying
        const delay = exponentialBackoff 
          ? retryDelay * Math.pow(2, attempt)
          : retryDelay;
        
        opLogger.debug(`Waiting ${delay}ms before retry after error`, {
          delay,
          nextAttempt: attempt + 2
        }, ['r2_fetch_start', `attempt_${attempt + 1}`, 'r2_fetch_error', 'r2_retry_wait']);
          
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    if (!object) {
      opLogger.warn('R2 fetch completed but no object found', {
        key
      }, ['r2_fetch_start', 'r2_fetch_complete', 'r2_fetch_not_found']);
    }

    return object;
  }

  /**
   * List objects in the bucket
   */
  async listObjects(options = {}) {
    const listOptions = {
      prefix: options.prefix || '',
      limit: options.limit || this.storageConfig.defaultListLimit,
      cursor: options.cursor,
      delimiter: options.delimiter,
      include: options.include
    };
    
    // Create a specific logger for this operation
    const opLogger = this.logger.child({
      operation: 'r2_list_objects',
      prefix: listOptions.prefix,
      limit: listOptions.limit,
      delimiter: listOptions.delimiter
    });
    
    opLogger.debug('Listing objects from R2', { options: listOptions }, 'r2_list_start');
    
    try {
      const result = await this.bucket.list(listOptions);
      
      opLogger.debug('R2 list successful', {
        objectCount: result.objects.length,
        truncated: result.truncated,
        hasCursor: !!result.cursor
      }, ['r2_list_start', 'r2_list_success']);
      
      return result;
    } catch (error) {
      opLogger.error('R2 list operation failed', {
        error: {
          message: error.message,
          name: error.name,
          stack: error.stack
        }
      }, ['r2_list_start', 'r2_list_error']);
      
      throw error;
    }
  }
  
  /**
   * Check if an object exists
   */
  async objectExists(key) {
    // Create a specific logger for this operation
    const opLogger = this.logger.child({
      operation: 'r2_object_exists',
      key
    });
    
    opLogger.debug('Checking if object exists in R2', { key }, 'r2_head_start');
    
    try {
      const headObject = await this.bucket.head(key);
      const exists = !!headObject;
      
      opLogger.debug(`Object ${exists ? 'exists' : 'does not exist'} in R2`, {
        key,
        exists,
        etag: headObject?.etag
      }, ['r2_head_start', exists ? 'r2_head_found' : 'r2_head_not_found']);
      
      return exists;
    } catch (error) {
      opLogger.error('Error checking if object exists', {
        key,
        error: {
          message: error.message,
          name: error.name,
          stack: error.stack
        }
      }, ['r2_head_start', 'r2_head_error']);
      
      return false;
    }
  }
  
  /**
   * Get object metadata
   */
  async getObjectMetadata(key) {
    // Create a specific logger for this operation
    const opLogger = this.logger.child({
      operation: 'r2_get_metadata',
      key
    });
    
    opLogger.debug('Getting object metadata from R2', { key }, 'r2_head_meta_start');
    
    try {
      const metadata = await this.bucket.head(key);
      
      if (metadata) {
        opLogger.debug('Retrieved object metadata', {
          key,
          size: metadata.size,
          etag: metadata.etag,
          uploadedTime: metadata.uploaded
        }, ['r2_head_meta_start', 'r2_head_meta_success']);
      } else {
        opLogger.warn('Object metadata not found', { key }, ['r2_head_meta_start', 'r2_head_meta_not_found']);
      }
      
      return metadata;
    } catch (error) {
      opLogger.error('Error getting object metadata', {
        key,
        error: {
          message: error.message,
          name: error.name,
          stack: error.stack
        }
      }, ['r2_head_meta_start', 'r2_head_meta_error']);
      
      return null;
    }
  }
}