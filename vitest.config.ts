import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["app/**/*.test.ts", "tests/**/*.test.ts", "prisma/**/*.test.ts"],
    fileParallelism: false,
    // Remote Supabase round-trips need more than the default 5s.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
