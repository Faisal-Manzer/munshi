import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@munshi/core": path.resolve(__dirname, "packages/core/src/index.ts"),
      "@munshi/crypto": path.resolve(__dirname, "packages/crypto/src/index.ts"),
      "@munshi/store": path.resolve(__dirname, "packages/store/src/index.ts"),
      "@munshi/mcp": path.resolve(__dirname, "packages/mcp/src/index.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    environment: "node",
  },
});
