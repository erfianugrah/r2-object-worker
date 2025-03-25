/**
 * Custom error classes
 */
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.statusCode = 400;
  }
}

export class MethodNotAllowedError extends Error {
  constructor(allowedMethods = "GET") {
    super("Method Not Allowed");
    this.name = "MethodNotAllowedError";
    this.statusCode = 405;
    this.allowedMethods = allowedMethods;
  }
}

export class NotFoundError extends Error {
  constructor(message = "Resource Not Found") {
    super(message);
    this.name = "NotFoundError";
    this.statusCode = 404;
  }
}

export class RangeNotSatisfiableError extends Error {
  constructor(message = "Range Not Satisfiable") {
    super(message);
    this.name = "RangeNotSatisfiableError";
    this.statusCode = 416;
  }
}

/**
 * Global error handler
 */
export function handleError(error, request, logger) {
  // Use the provided logger or fallback to console
  const log = logger || console;
  
  // Create breadcrumb trail based on error type
  const breadcrumb = ['error', error.name || 'unknown_error'];
  
  if (error instanceof ValidationError) {
    log.warn("Validation error handling request:", {
      error: error.message,
      statusCode: error.statusCode,
    }, breadcrumb);
    
    return new Response(error.message, {
      status: error.statusCode,
      headers: { "Content-Type": "text/plain" },
    });
  }

  if (error instanceof MethodNotAllowedError) {
    log.warn("Method not allowed error:", {
      error: error.message,
      statusCode: error.statusCode,
      allowedMethods: error.allowedMethods
    }, breadcrumb);
    
    return new Response(error.message, {
      status: error.statusCode,
      headers: {
        "Allow": error.allowedMethods,
        "Content-Type": "text/plain",
      },
    });
  }

  if (error instanceof NotFoundError) {
    log.warn("Resource not found error:", {
      error: error.message,
      statusCode: error.statusCode,
      url: request?.url
    }, breadcrumb);
    
    return new Response(error.message, {
      status: error.statusCode,
      headers: { "Content-Type": "text/plain" },
    });
  }

  if (error instanceof RangeNotSatisfiableError) {
    log.warn("Range not satisfiable error:", {
      error: error.message,
      statusCode: error.statusCode,
    }, breadcrumb);
    
    return new Response(error.message, {
      status: error.statusCode,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Handle any unexpected errors
  log.error("Unexpected error:", {
    error: {
      message: error.message,
      name: error.name,
      stack: error.stack
    },
    url: request?.url,
    method: request?.method
  }, [...breadcrumb, 'server_error']);
  
  return new Response("Internal Server Error", {
    status: 500,
    headers: { "Content-Type": "text/plain" },
  });
}