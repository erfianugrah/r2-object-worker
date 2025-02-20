export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = url.pathname.slice(1); // Extract key from URL path

    // Validate request method and key
    if (!request.method || !key) {
      return new Response("Invalid Request", { status: 400 });
    }

    const MAX_RETRIES = 3;
    const RETRY_DELAY = 1000; // 1 second

    try {
      switch (request.method) {
        case "GET": {
          // GET request: Retrieve the image from R2 store with retries
          let object;
          for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
              object = await env.IMAGES.get(key);
              if (object) break;
              if (attempt < MAX_RETRIES - 1) {
                await new Promise((resolve) =>
                  setTimeout(resolve, RETRY_DELAY)
                );
              }
            } catch (fetchError) {
              console.error(`Attempt ${attempt + 1} failed:`, fetchError);
              if (attempt === MAX_RETRIES - 1) throw fetchError;
            }
          }

          if (!object) {
            // Image not found in R2 store after all retries
            return new Response("Object Not Found", {
              status: 404,
              headers: {
                "Content-Type": "text/plain",
              },
            });
          }

          // Image found, prepare response headers
          const headers = new Headers();
          object.writeHttpMetadata(headers);
          headers.set("etag", object.httpEtag);

          // Set Content-Type based on file extension
          const contentType = getContentTypeFromKey(key);
          headers.set("Content-Type", contentType);

          // Security headers
          headers.set("X-Content-Type-Options", "nosniff");
          headers.set(
            "Content-Security-Policy",
            "default-src 'none'; img-src 'self'",
          );

          // CORS headers - uncomment and configure as needed
          // headers.set('Access-Control-Allow-Origin', '*');
          // headers.set('Access-Control-Allow-Methods', 'GET');
          // headers.set('Vary', 'Origin');

          // Enhanced cache control
          headers.set(
            "Cache-Control",
            "public, max-age=86400, stale-while-revalidate=86400",
          );
          headers.set("Vary", "Accept-Encoding");

          // Return the image with appropriate headers
          return new Response(object.body, { headers });
        }
        default: {
          // Unsupported method
          return new Response("Method Not Allowed", {
            status: 405,
            headers: {
              "Allow": "GET",
              "Content-Type": "text/plain",
            },
          });
        }
      }
    } catch (error) {
      console.error("Error handling request:", error);
      return new Response("Internal Server Error", {
        status: 500,
        headers: {
          "Content-Type": "text/plain",
        },
      });
    }
  },
};

// Utility function to determine Content-Type based on file extension
function getContentTypeFromKey(key) {
  const extensions = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    // Add more MIME types as needed
  };
  const ext = key.split(".").pop()?.toLowerCase() || "";
  return extensions[ext] || "application/octet-stream";
}
