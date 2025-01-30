/// <reference types="vitest" />
import * as dotenv from "dotenv";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

dotenv.config();

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    coverage: {
      include: ["**/src/**/*.ts"],
      exclude: ["**/src/**/*.d.ts", "**/node_modules", "**/test"],
      provider: "istanbul",
      reportsDirectory: "./coverage"
    }
  }
});
