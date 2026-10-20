/**
 * MapLibre の「別スレッドで動く部分」を、配れる場所へ置き直す。
 *
 * ■ なぜ要るか
 *
 *   MapLibre は、地図を組み立てる重い処理を別スレッド（Worker）でやる。
 *   そのファイルの場所を、自分のコードの中でこうやって決めている。
 *
 *     let e = import.meta.url;
 *     if (!/^https?:/.test(e)) return "";      ← ここ
 *     return new URL("./maplibre-gl-worker.mjs", e).href;
 *
 *   ところが Next.js（Turbopack）がひとまとめにすると、
 *   import.meta.url は http で始まる住所ではなくなる。
 *   すると空の文字列が返り、
 *
 *     new Worker("", { type: "module" })
 *
 *   になる。空の住所はページ自身を指すので、ブラウザは HTML を
 *   JavaScript として読もうとして失敗する。
 *
 *     Failed to load module script:
 *     The server responded with a non-JavaScript MIME type of "text/html".
 *
 *   別スレッドが立ち上がらないので、地図は最後まで読み込まれない。
 *   タイルも名前も出ず、ボタンだけが浮いた「白い地図」になる。
 *   ★これが「たまに白い画面になる」の正体だった。
 *
 * ■ 直し方
 *
 *   場所を当てにさせず、こちらから渡す。
 *   node_modules にある本物を public/maplibre/ に写して、
 *   Guide.tsx から setWorkerUrl("/maplibre/maplibre-gl-worker.mjs") と教える。
 *
 *   worker のファイルは、隣の maplibre-gl-shared.mjs を読みに行く。
 *   二つとも同じ場所へ写す。
 *
 * ■ なぜ写すのか（GitHub に置かないのか）
 *
 *   node_modules の中身をそのまま持つと、MapLibre を上げたときに
 *   古いものが残る。組み立てるたびに写せば、必ず今のものになる。
 *   package.json の prebuild / predev から呼ばれる。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const from = path.join(root, "node_modules", "maplibre-gl", "dist");
const to = path.join(root, "public", "maplibre");

/** 写すもの。worker は shared を読むので、二つで一組 */
// 6.15 からは worker が一つで完結し、shared は空のファイルになった。
// 前の版に戻したときにも動くよう、二つとも写しておく
const FILES = ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"];

if (!fs.existsSync(from)) {
  console.error("★ maplibre-gl が見つかりません:", from);
  console.error("  npm install のあとに実行してください。");
  process.exit(1);
}

fs.mkdirSync(to, { recursive: true });

for (const name of FILES) {
  const src = path.join(from, name);
  if (!fs.existsSync(src)) {
    console.error("★ 見つかりません:", src);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(to, name));
  const kb = (fs.statSync(src).size / 1024).toFixed(0);
  console.log(`  写しました ${name}（${kb}KB）`);
}

const ver = JSON.parse(
  fs.readFileSync(path.join(root, "node_modules", "maplibre-gl", "package.json"), "utf8"),
).version;
console.log(`MapLibre ${ver} の worker を public/maplibre/ に置きました`);
