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
export function handleError(error) {
  console.error("Error handling request:", error);

  if (error instanceof ValidationError) {
    return new Response(error.message, {
      status: error.statusCode,
      headers: { "Content-Type": "text/plain" },
    });
  }

  if (error instanceof MethodNotAllowedError) {
    return new Response(error.message, {
      status: error.statusCode,
      headers: {
        "Allow": error.allowedMethods,
        "Content-Type": "text/plain",
      },
    });
  }

  if (error instanceof NotFoundError) {
    return new Response(error.message, {
      status: error.statusCode,
      headers: { "Content-Type": "text/plain" },
    });
  }

  if (error instanceof RangeNotSatisfiableError) {
    return new Response(error.message, {
      status: error.statusCode,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Handle any unexpected errors
  console.error("Unexpected error:", error.stack || error);
  return new Response("Internal Server Error", {
    status: 500,
    headers: { "Content-Type": "text/plain" },
  });
}