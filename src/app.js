import { Config } from "./infrastructure/config/config.js";
import { R2StorageAdapter } from "./infrastructure/storage/r2.adapter.js";
import { Router } from "./infrastructure/router/router.js";
import { ObjectRepository } from "./domain/objects/object.repository.js";
import { ObjectService } from "./domain/objects/object.service.js";
import { ObjectController } from "./domain/objects/object.controller.js";
import { HealthService } from "./domain/health/health.service.js";
import { HealthController } from "./domain/health/health.controller.js";

/**
 * Application factory that initializes all components
 */
export function createApp(env) {
  // Load configuration from environment
  const config = new Config(env);
  
  // Initialize infrastructure with the configured R2 bucket binding from config
  const bucketBinding = config.getBucketBinding();
  const storageAdapter = new R2StorageAdapter(env[bucketBinding], config);
  
  // Initialize domains
  // Object domain
  const objectRepository = new ObjectRepository(storageAdapter);
  const objectService = new ObjectService(objectRepository, config);
  const objectController = new ObjectController(objectService, config);
  
  // Health domain
  const healthService = new HealthService(storageAdapter);
  const healthController = new HealthController(healthService);
  
  // Initialize router
  const router = new Router(objectController, healthController, config);
  
  return router;
}