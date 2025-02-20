import { handleHealthCheck } from "./handlers/healthCheck.js";
import { handleImageRequest } from "./handlers/imageHandler.js";
import {
  handleError,
  MethodNotAllowedError,
  ValidationError,
} from "./utils/errors.js";

export async function router(request, env) {
  try {
    const url = new URL(request.url);

    // Handle health check endpoint
    if (url.pathname === "/_health") {
      return await handleHealthCheck(env);
    }

    // Handle root path
    if (url.pathname === "/") {
      return new Response("Image CDN", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    const key = url.pathname.slice(1);

    if (!request.method) {
      throw new ValidationError("Invalid Request");
    }

    if (request.method !== "GET") {
      throw new MethodNotAllowedError();
    }

    return await handleImageRequest(key, env);
  } catch (error) {
    return handleError(error);
  }
}
