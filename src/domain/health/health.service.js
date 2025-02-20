/**
 * Service for handling health check logic
 */
export class HealthService {
  constructor(storageAdapter) {
    this.storageAdapter = storageAdapter;
  }

  /**
   * Check if the service is healthy
   */
  async checkHealth() {
    try {
      // Try to list one object to verify connectivity
      // Use same parameters expected by the test
      await this.storageAdapter.bucket.list({ limit: 1 });
      return { status: "healthy" };
    } catch (error) {
      console.error("Health check failed:", error);
      return { status: "unhealthy", error };
    }
  }
}