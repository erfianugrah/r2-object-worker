/**
 * R2 Storage adapter for interacting with Cloudflare R2
 */
export class R2StorageAdapter {
  constructor(bucket, config) {
    this.bucket = bucket;
    this.config = config;
    this.storageConfig = config.getStorageConfig();
  }

  /**
   * Get an object from R2 with retry logic
   */
  async getObject(key, options = {}) {
    const maxRetries = options.maxRetries || this.storageConfig.maxRetries;
    const retryDelay = options.retryDelay || this.storageConfig.retryDelay;
    const exponentialBackoff = options.exponentialBackoff !== undefined ? 
      options.exponentialBackoff : this.storageConfig.exponentialBackoff;

    let object;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
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
        
        if (object) break;
        
        // If no object and not last attempt, wait before retrying
        if (attempt < maxRetries - 1) {
          // Calculate delay with exponential backoff if enabled
          const delay = exponentialBackoff 
            ? retryDelay * Math.pow(2, attempt)
            : retryDelay;
            
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      } catch (fetchError) {
        console.error(`R2 fetch attempt ${attempt + 1} failed:`, fetchError);
        
        // If it's the last attempt, throw the error
        if (attempt === maxRetries - 1) throw fetchError;
        
        // Otherwise wait before retrying
        const delay = exponentialBackoff 
          ? retryDelay * Math.pow(2, attempt)
          : retryDelay;
          
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
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
    
    return await this.bucket.list(listOptions);
  }
  
  /**
   * Check if an object exists
   */
  async objectExists(key) {
    try {
      const headObject = await this.bucket.head(key);
      return !!headObject;
    } catch (error) {
      console.error(`Error checking if object exists: ${error}`);
      return false;
    }
  }
  
  /**
   * Get object metadata
   */
  async getObjectMetadata(key) {
    try {
      return await this.bucket.head(key);
    } catch (error) {
      console.error(`Error getting object metadata: ${error}`);
      return null;
    }
  }
}