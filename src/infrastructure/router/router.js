import {
  handleError,
  MethodNotAllowedError,
  ValidationError,
} from "../errors/error.handler.js";

/**
 * Router for handling all incoming requests
 */
export class Router {
  constructor(objectController, healthController) {
    this.objectController = objectController;
    this.healthController = healthController;
    
    // Define routes with path patterns and HTTP methods
    this.routes = [
      { 
        path: "/_health", 
        methods: ["GET"],
        handler: this.handleHealthCheck.bind(this)
      },
      { 
        path: "/", 
        methods: ["GET"],
        handler: this.handleRoot.bind(this)
      },
      { 
        path: "/_list", 
        methods: ["GET"], 
        handler: this.handleListObjects.bind(this)
      },
      { 
        // Default handler - must be last
        methods: ["GET"], 
        handler: this.handleObjectRequest.bind(this)
      }
    ];
  }

  /**
   * Handle health check requests
   */
  async handleHealthCheck(request) {
    return await this.healthController.handleHealthCheck();
  }

  /**
   * Handle root path
   */
  handleRoot() {
    return new Response("Object CDN", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  /**
   * Handle object listing
   */
  async handleListObjects(request, url) {
    return await this.objectController.handleListRequest(request, url);
  }

  /**
   * Handle object requests
   */
  async handleObjectRequest(request, url) {
    return await this.objectController.handleObjectRequest(request, url);
  }

  /**
   * Route the request to the appropriate handler
   */
  async route(request) {
    try {
      const url = new URL(request.url);
      
      // Validate request method
      if (!request.method) {
        throw new ValidationError("Invalid Request");
      }
      
      // Find matching route based on path and method
      for (const route of this.routes) {
        // Check if path matches (or route has no path for default handler)
        const pathMatches = !route.path || route.path === url.pathname;
        
        // Check if method is allowed
        const methodAllowed = route.methods.includes(request.method);
        
        if (pathMatches) {
          // If path matches but method is not allowed, return 405
          if (!methodAllowed) {
            throw new MethodNotAllowedError(route.methods.join(', '));
          }
          
          // If both path and method match, execute the handler
          return await route.handler(request, url);
        }
      }
      
      // If no routes match, this shouldn't happen due to the default handler
      throw new Error("No route matched");
    } catch (error) {
      return handleError(error);
    }
  }
}