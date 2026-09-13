import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: { alias: { "pod-deliverable": path.resolve(process.env.POD_DELIVERABLE_DIR!, "src/app.ts") } },
  test: {
    root: __dirname,
    include: ["api.test.ts"],
    testTimeout: 5000,
    hookTimeout: 5000,
    pool: "forks",
    maxWorkers: 1,
    minWorkers: 1,
  },
});
