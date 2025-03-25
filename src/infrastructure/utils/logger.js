import pino from 'pino';

/**
 * Logger utility for application-wide logging
 */
export class Logger {
  constructor(config) {
    this.config = config;
    this.env = config?.env?.ENVIRONMENT || 'development';
    
    // Get logging config
    const loggingConfig = config?.env?.LOGGING || {};
    
    // Create the pino logger instance
    this.logger = pino({
      level: loggingConfig.level || this.getLogLevel(),
      base: {
        env: this.env,
        worker: 'r2-object-worker'
      },
      redact: loggingConfig.redact || ['headers.authorization', 'headers.cookie'],
      transport: (loggingConfig.pretty === true || this.env === 'development') ? {
        target: 'pino-pretty',
        options: {
          colorize: true
        }
      } : undefined
    });
  }

  /**
   * Get the log level based on environment
   */
  getLogLevel() {
    const envMap = {
      'development': 'debug',
      'staging': 'info',
      'production': 'info'
    };
    return envMap[this.env] || 'info';
  }

  /**
   * Create a child logger with breadcrumb context
   */
  child(context) {
    return this.logger.child(context);
  }

  /**
   * Log debug message with breadcrumb
   */
  debug(message, data = {}, breadcrumb = null) {
    const logData = this.addBreadcrumb(data, breadcrumb);
    this.logger.debug(logData, message);
  }

  /**
   * Log info message with breadcrumb
   */
  info(message, data = {}, breadcrumb = null) {
    const logData = this.addBreadcrumb(data, breadcrumb);
    this.logger.info(logData, message);
  }

  /**
   * Log warning message with breadcrumb
   */
  warn(message, data = {}, breadcrumb = null) {
    const logData = this.addBreadcrumb(data, breadcrumb);
    this.logger.warn(logData, message);
  }

  /**
   * Log error message with breadcrumb
   */
  error(message, data = {}, breadcrumb = null) {
    const logData = this.addBreadcrumb(data, breadcrumb);
    this.logger.error(logData, message);
  }

  /**
   * Add breadcrumb trail to log data
   */
  addBreadcrumb(data, breadcrumb) {
    // Get logging config
    const loggingConfig = this.config?.env?.LOGGING || {};
    
    // Skip if breadcrumbs are disabled
    if (loggingConfig.breadcrumbs === false) return data;
    
    if (!breadcrumb) return data;
    
    return {
      ...data,
      breadcrumb: Array.isArray(breadcrumb) ? breadcrumb : [breadcrumb]
    };
  }

  /**
   * Create request logger with trace context
   */
  createRequestLogger(request) {
    // Extract trace ID from headers or generate new one
    const traceId = request.headers.get('x-trace-id') || crypto.randomUUID();
    const requestId = crypto.randomUUID().slice(0, 8);
    
    // Get additional request context
    const requestData = {
      traceId,
      requestId,
      url: request.url,
      method: request.method,
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      cfRay: request.headers.get('cf-ray'),
      cfCountry: request.headers.get('cf-ipcountry'),
      cfConnectingIp: request.headers.get('cf-connecting-ip'),
      accept: request.headers.get('accept'),
      acceptEncoding: request.headers.get('accept-encoding')
    };
    
    // Add timing information
    requestData.startTime = Date.now();
    
    return this.child(requestData);
  }
  
  /**
   * Log request completion with timing
   */
  logRequestCompletion(logger, response, additionalInfo = {}) {
    // Get the startTime from the context if available
    const startTime = additionalInfo.startTime || this.getContextValue(logger, 'startTime');
    
    // Skip if no startTime was recorded
    if (!startTime) {
      return;
    }
    
    const duration = Date.now() - startTime;
    const statusCode = response.status;
    const contentType = response.headers.get('content-type');
    const contentLength = response.headers.get('content-length');
    const cacheStatus = response.headers.get('x-cache-status');
    const etag = response.headers.get('etag');
    
    logger.info(`Request completed in ${duration}ms with status ${statusCode}`, {
      duration,
      statusCode,
      contentType,
      contentLength,
      cacheStatus,
      etag,
      ...additionalInfo
    }, ['request_complete', `status_${statusCode}`, `cache_${cacheStatus?.toLowerCase() || 'unknown'}`]);
    
    return duration;
  }
  
  /**
   * Safely get a value from logger context
   */
  getContextValue(logger, key) {
    // Different loggers store context differently
    // Try different common patterns
    if (typeof logger.bindings === 'function') {
      return logger.bindings()[key];
    } else if (logger._childLevel && logger._childLevel.bindings) {
      return logger._childLevel.bindings[key]; 
    } else if (logger.context) {
      return logger.context[key];
    } else {
      // For pino child loggers, the context is often attached directly
      return logger[key];
    }
  }

  /**
   * Log cache-related events
   */
  logCacheEvent(key, status, data = {}, breadcrumb = null) {
    // Add more details to cache events for better debugging
    const detailedData = {
      ...data,
      cacheKey: key,
      cacheStatus: status,
      timestamp: Date.now(),
      ttl: data.ttl || this.config?.getCacheConfig()?.defaultMaxAge || 86400
    };
    
    const eventBreadcrumb = breadcrumb || [`cache_${status.toLowerCase()}`];
    
    // Enhanced message
    const message = `Cache ${status} for key: ${key}${data.size ? ` (${this.formatBytes(data.size)})` : ''}`;
    
    this.info(message, detailedData, eventBreadcrumb);
    
    return detailedData;
  }
  
  /**
   * Format bytes to human-readable format
   */
  formatBytes(bytes, decimals = 2) {
    if (!bytes || bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
    
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }
  
  /**
   * Log R2 storage events with performance tracking
   */
  logStorageEvent(operation, key, data = {}, breadcrumb = null) {
    const timestamp = Date.now();
    const duration = data.startTime ? timestamp - data.startTime : null;
    
    const detailedData = {
      ...data,
      storageKey: key,
      operation,
      timestamp,
      ...(duration ? { duration } : {})
    };
    
    const eventBreadcrumb = breadcrumb || [`r2_${operation.toLowerCase()}`];
    
    // Enhanced message
    let message = `R2 ${operation}`;
    if (key) message += ` for key: ${key}`;
    if (duration) message += ` (${duration}ms)`;
    if (data.size) message += ` [${this.formatBytes(data.size)}]`;
    
    this.info(message, detailedData, eventBreadcrumb);
    
    return detailedData;
  }
}