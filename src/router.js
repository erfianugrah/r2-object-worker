import { handleImageRequest } from "./handlers/imageHandler.js";
import {
  handleError,
  MethodNotAllowedError,
  ValidationError,
} from "./utils/errors.js";

export async function router(request, env) {
  try {
    const url = new URL(request.url);

    // Handle root path, health and _health endpoints with same response for LB
    if (
      url.pathname === "/" || url.pathname === "/_health" ||
      url.pathname === "/health"
    ) {
      return new Response("OK", {
        status: 200,
        headers: {
          "Content-Type": "text/plain",
          "Cache-Control": "no-store",
        },
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
