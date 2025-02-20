import { getContentTypeFromKey } from "../utils/contentType.js";

export async function handleImageRequest(key, env) {
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 1000;

  let object;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      object = await env.IMAGES.get(key);
      if (object) break;
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
      }
    } catch (fetchError) {
      console.error(`Attempt ${attempt + 1} failed:`, fetchError);
      if (attempt === MAX_RETRIES - 1) throw fetchError;
    }
  }

  if (!object) {
    return new Response("Object Not Found", {
      status: 404,
      headers: {
        "Content-Type": "text/plain",
      },
    });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Content-Type", getContentTypeFromKey(key));
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set(
    "Content-Security-Policy",
    "default-src 'none'; img-src 'self'",
  );
  headers.set(
    "Cache-Control",
    "public, max-age=86400, stale-while-revalidate=86400",
  );
  headers.set("Vary", "Accept-Encoding");

  return new Response(object.body, { headers });
}
