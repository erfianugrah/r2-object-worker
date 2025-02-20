export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

export class MethodNotAllowedError extends Error {
  constructor() {
    super("Method Not Allowed");
    this.name = "MethodNotAllowedError";
  }
}

export function handleError(error) {
  console.error("Error handling request:", error);

  if (error instanceof ValidationError) {
    return new Response(error.message, {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  if (error instanceof MethodNotAllowedError) {
    return new Response(error.message, {
      status: 405,
      headers: {
        "Allow": "GET",
        "Content-Type": "text/plain",
      },
    });
  }

  return new Response("Internal Server Error", {
    status: 500,
    headers: { "Content-Type": "text/plain" },
  });
}
