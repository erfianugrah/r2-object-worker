import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globals: true,
    setupFiles: ['./test/setup.js'],
    poolOptions: {
      workers: {
        wrangler: { 
          configPath: "./wrangler.jsonc",
          // Force compatibility date to be recent enough
          configOverrides: {
            compatibility_date: "2023-03-01",
            compatibility_flags: ["export_commonjs_default"]
          }
        },
      },
    },
  },
});
