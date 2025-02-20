import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { 
          configPath: "./wrangler.jsonc",
          // Force compatibility date to be recent enough
          configOverrides: {
            compatibility_date: "2022-10-31"
          }
        },
      },
    },
  },
});
