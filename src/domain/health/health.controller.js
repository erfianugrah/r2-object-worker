/**
 * Controller for handling health check HTTP requests
 */
export class HealthController {
  constructor(healthService) {
    this.healthService = healthService;
  }

  /**
   * Handle health check request
   */
  async handleHealthCheck() {
    const result = await this.healthService.checkHealth();
    
    if (result.status === "healthy") {
      return new Response("OK", {
        status: 200,
        headers: {
          "Content-Type": "text/plain",
          "Cache-Control": "no-store",
        },
      });
    } else {
      return new Response("Service Unavailable", {
        status: 503,
        headers: {
          "Content-Type": "text/plain",
          "Cache-Control": "no-store",
        },
      });
    }
  }
}