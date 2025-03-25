/**
 * Configuration loader class for Worker
 * Loads configuration from worker environment variables
 */
export class Config {
  constructor(env) {
    this.env = env;
    
    // Environment name
    this.environment = env.ENVIRONMENT || 'development';
    
    // Store R2 bucket binding configuration
    this.bucketBinding = env.R2_BUCKET_BINDING || 'R2';
    
    // Use environment variables directly with fallbacks
    this.storage = env.STORAGE || this.getDefaultStorage();
    this.cache = env.CACHE || this.getDefaultCache();
    this.security = env.SECURITY || this.getDefaultSecurity();
  }
  
  /**
   * Get default storage configuration
   */
  getDefaultStorage() {
    return {
      maxRetries: 3,
      retryDelay: 1000,
      exponentialBackoff: true,
      defaultListLimit: 1000
    };
  }
  
  /**
   * Get default cache configuration
   */
  getDefaultCache() {
    return {
      defaultMaxAge: 86400, // 1 day in seconds
      defaultStaleWhileRevalidate: 86400,
      staticAssetsTtl: 604800, // 7 days in seconds
      cacheEverything: true,
      cacheEnabled: true, // Global toggle to enable/disable caching
      bypassParamEnabled: true,
      bypassParamName: 'no-cache',
      cacheTags: {
        enabled: true,
        prefix: 'cdn-',
        defaultTags: ['cdn', 'r2-objects']
      },
      objectTypeConfig: {
        image: {
          polish: 'lossy',
          webp: true,
          maxAge: 86400,
          tags: ['images']
        },
        static: {
          maxAge: 604800,
          minify: {
            javascript: true,
            css: true,
            html: true
          },
          tags: ['static']
        },
        document: {
          maxAge: 86400,
          tags: ['documents']
        },
        video: {
          maxAge: 604800,
          tags: ['media', 'video']
        },
        audio: {
          maxAge: 604800,
          tags: ['media', 'audio']
        }
      },
      sensitiveTypes: ['private', 'secure']
    };
  }
  
  /**
   * Get default security configuration
   */
  getDefaultSecurity() {
    return {
      headers: {
        default: {
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'"
        },
        image: {
          'Content-Security-Policy': "default-src 'none'; img-src 'self'"
        },
        document: {
          'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"
        },
        font: {
          'Content-Security-Policy': "default-src 'none'; font-src 'self'"
        }
      }
    };
  }
  
  /**
   * Get storage config
   */
  getStorageConfig() {
    return this.storage;
  }
  
  /**
   * Get cache config
   */
  getCacheConfig() {
    return this.cache;
  }
  
  /**
   * Get security config
   */
  getSecurityConfig() {
    return this.security;
  }
  
  /**
   * Get bucket binding name
   */
  getBucketBinding() {
    return this.bucketBinding;
  }
  
  /**
   * Get cache settings for specific object type
   */
  getObjectTypeCacheConfig(objectType) {
    if (objectType && this.cache.objectTypeConfig[objectType]) {
      return this.cache.objectTypeConfig[objectType];
    }
    return {};
  }
  
  /**
   * Get security headers for specific object type
   */
  getObjectTypeSecurityHeaders(objectType) {
    // Start with default headers
    const headers = { ...this.security.headers.default };
    
    // Add object-type specific headers if available
    if (objectType && this.security.headers[objectType]) {
      return { ...headers, ...this.security.headers[objectType] };
    }
    
    return headers;
  }
  
  /**
   * Check if object type is in sensitive types list
   */
  isSensitiveObjectType(objectType) {
    return this.cache.sensitiveTypes.includes(objectType);
  }
}