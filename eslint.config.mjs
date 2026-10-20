import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // node_modules から写した MapLibre の別スレッドの部分（scripts/copy-maplibre-worker.mjs）。
    // 自分のコードではなく、縮めてあるので見ても意味がない
    "public/maplibre/**",
  ]),
]);

export default eslintConfig;
