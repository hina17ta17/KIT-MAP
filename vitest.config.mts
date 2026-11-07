import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * 試験の設定。`npm test` で走る。
 *
 * 試すのは、データベースも画面も要らない部分だけ
 * （道案内の計算・祝日・xlsx の読み書き・管理の画面に入れる権限）。
 * コードの中の `@/…` は、このフォルダを指す（tsconfig.json と同じ）。
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
