import { defineConfig } from "vitest/config";

// MiniMax requests bypass any local proxy in tests.
const noProxy = [process.env.NO_PROXY, "api.minimax.io", "api.minimaxi.com"].filter(Boolean).join(",");

export default defineConfig({ test: { include: ["src/**/*.test.ts", "test/**/*.test.ts"], environment: "node", testTimeout: 30_000, env: { NO_PROXY: noProxy, no_proxy: noProxy } } });
