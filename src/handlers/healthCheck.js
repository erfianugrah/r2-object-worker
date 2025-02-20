export async function handleHealthCheck(env) {
  try {
    // Try to list one object from R2 to verify connectivity
    const list = await env.IMAGES.list({ limit: 1 });
    // Return a 200 with plain text "OK" as expected by Cloudflare LB health checks
    return new Response("OK", {
      status: 200,
      headers: {
        "Content-Type": "text/plain",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Health check failed:", error);
    // Return a 503 with plain text for Cloudflare LB
    return new Response("Service Unavailable", {
      status: 503,
      headers: {
        "Content-Type": "text/plain",
        "Cache-Control": "no-store",
      },
    });
  }
}
