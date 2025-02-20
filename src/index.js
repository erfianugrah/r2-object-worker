import { createApp } from "./app.js";

export default {
  async fetch(request, env) {
    const app = createApp(env);
    return app.route(request);
  },
};
