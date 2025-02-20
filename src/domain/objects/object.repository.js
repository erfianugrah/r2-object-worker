import { NotFoundError } from "../../infrastructure/errors/error.handler.js";

/**
 * Repository for handling object storage operations (merged with former ImageRepository)
 */
export class ObjectRepository {
  constructor(storageAdapter) {
    this.storageAdapter = storageAdapter;
  }

  /**
   * Get an object by key
   */
  async getObjectByKey(key) {
    const object = await this.storageAdapter.getObject(key);
    
    if (!object) {
      throw new NotFoundError("Object Not Found");
    }
    
    return object;
  }
  
  /**
   * List objects with optional prefix and limit
   */
  async listObjects(options = {}) {
    return await this.storageAdapter.listObjects(options);
  }
}