import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(() => ({
  plugins: [react()],

  // TAURI_ENV_PLATFORM tells the frontend which OS the Tauri CLI builds for.
  envPrefix: ["VITE_", "TAURI_ENV_"],

  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/dev/**",
        "src/test/**",
        "src/**/*.test.*",
        "src/main.tsx",
        "src/vite-env.d.ts",
      ],
      reporter: ["text-summary", "json-summary"],
      reportsDirectory: "coverage",
    },
  },

  build: {
    // Safari 18 is the WebKit that shipped with macOS 15, the minimum system version set by the
    // bundled poppler libraries.
    target: "safari18",
  },

  // Keeps Vite from hiding Rust errors.
  clearScreen: false,
  // Tauri expects a fixed port.
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // The Rust sources are not part of the frontend.
      ignored: ["**/src-tauri/**"],
    },
  },
}));
