import { defineConfig } from "vitest/config";
import {
  defineWorkersConfig,
} from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        // Each test creates a unique session. The installed pool cannot snapshot
        // SQLite WAL sidecar files reliably, so avoid per-test storage snapshots.
        isolatedStorage: false,
        wrangler: { configPath: "./wrangler.jsonc" },
      },
    },
    include: ["worker/**/*.test.ts"],
  },
});
