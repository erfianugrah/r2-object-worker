import { router } from "./router.js";

export default {
  async fetch(request, env) {
    return router(request, env);
  },
};
