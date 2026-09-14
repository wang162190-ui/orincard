import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: {
    jsx: {
      runtime: "automatic",
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    // next-intl 的 ESM 产物里写的是 `import ... from "next/server"`（无扩展名）。
    // Node 原生 ESM 解析在 pnpm 的嵌套 store 里找不到它（"Did you mean next/server.js?"），
    // 所以让 vite 接管这个包的转换，走它自己的解析器。
    server: { deps: { inline: ["next-intl"] } },
    testTimeout: 15_000,
    hookTimeout: 15_000,
    restoreMocks: true,
  },
});
