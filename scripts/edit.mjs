/**
 * 作図ツールだけを、手元で単独に立ち上げる。
 *
 *   npm run edit
 *
 * やること
 *   1. 経路をやり直すための土台データを作り直す
 *   2. 空いている番号を探して開発サーバーを起こす（3100番から順に）
 *   3. 用意ができたらブラウザで作図ツールを開く
 *
 * 作図ツールは公開サイトには入っていない（next.config.ts で外してある）。
 * ここで描いたものは、書き出しボタンでファイルに落とすまでブラウザの中だけに
 * 残る。公開サイトへ自動で送られることはない。
 *
 * 止めるときは Ctrl+C。
 */

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";

/** ここから順に空きを探す */
const FIRST_PORT = 3100;
/** 何番まで試すか */
const TRIES = 20;

/**
 * その番号が空いているか。
 *
 * 空きを確かめてから使う。決め打ちにすると、すでに別の作図ツールが
 * 動いているときにそちらへ繋がったまま「開きました」と出てしまい、
 * 直したはずの画面が出ないなど分かりにくい形になる。
 *
 * 確かめ方は Next と揃える。宛先を指定せずに待ち受ける（= `::` 全アドレス）。
 * `127.0.0.1` だけを見ると Windows では空いていると判定されてしまう。
 * 全アドレスで待ち受けている相手がいても、そこだけは別枠として
 * 結び付けられるため。Next は `::` を取りにいくので、
 * こちらも同じ取り方で試さないと衝突を見つけられない。
 */
function isFree(port) {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port);
  });
}

async function findPort() {
  for (let p = FIRST_PORT; p < FIRST_PORT + TRIES; p++) {
    if (await isFree(p)) return p;
  }
  return null;
}

/** ブラウザで開く */
function openBrowser(target) {
  const os = platform();
  if (os === "win32")
    spawn("cmd", ["/c", "start", "", target], { detached: true, stdio: "ignore" });
  else if (os === "darwin") spawn("open", [target], { detached: true, stdio: "ignore" });
  else spawn("xdg-open", [target], { detached: true, stdio: "ignore" });
}

/* ---------------- 1. 土台データ ---------------- */

const make = spawnSync(process.execPath, ["scripts/make-base-data.mjs"], { stdio: "inherit" });
if (make.status !== 0) {
  console.error("\n土台データを作れませんでした。ここで止めます。");
  process.exit(1);
}

/* ---------------- 2. すでに動いていないか ---------------- */

/**
 * 開発サーバーがもう動いていれば、それを開く。
 *
 * Next は同じフォルダで開発サーバーを2つ動かせない。番号を変えても
 * 「Another next dev server is already running」で止まる。
 * 起こし直すより、動いているものへ入ってもらうほうが早い。
 *
 * 動いているものの居場所は Next が .next/dev/lock に書いている。
 * ただし前回の残りかもしれないので、本当に応答するか確かめてから使う。
 */
async function findRunning() {
  const lockPath = join(process.cwd(), ".next", "dev", "lock");
  if (!existsSync(lockPath)) return null;
  let appUrl;
  try {
    appUrl = JSON.parse(readFileSync(lockPath, "utf8")).appUrl;
  } catch {
    return null;
  }
  if (!appUrl) return null;
  try {
    const res = await fetch(`${appUrl}/edit/base`);
    return res.ok ? appUrl : null;
  } catch {
    // 書いてあるだけで、もう動いていない
    return null;
  }
}

const running = await findRunning();
if (running) {
  const already = `${running}/edit/base`;
  console.log(`\nすでに ${running} で動いていたので、そちらを開きます。`);
  console.log("（Next は同じフォルダで開発サーバーを2つ動かせません）\n");
  console.log(`作図ツール → ${already}`);
  console.log("  公開中の地図を直したいときは、画面左上から移れます");
  console.log("  止めるときは、動かしている窓で Ctrl+C\n");
  openBrowser(already);
  process.exit(0);
}

/* ---------------- 3. 開発サーバーを起こす ---------------- */

const port = await findPort();
if (port === null) {
  console.error(
    `\n${FIRST_PORT}番から${FIRST_PORT + TRIES - 1}番まで、空いている番号がありませんでした。` +
      "\n動いたままの作図ツールがあれば、その窓で Ctrl+C を押して止めてください。",
  );
  process.exit(1);
}
if (port !== FIRST_PORT) {
  console.log(`\n${FIRST_PORT}番は使われていたので、${port}番を使います。`);
}

// next の中身を直接呼ぶ。Windows で .cmd を呼ぶには shell が要り、
// shell 経由だと引数がそのまま繋がる（Node が警告を出す）ため
const nextBin = join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
if (!existsSync(nextBin)) {
  console.error("\nnext が見つかりません。npm install を実行してください。");
  process.exit(1);
}

const url = `http://localhost:${port}/edit/base`;
console.log(`\n作図ツールを ${port}番で起こしています…\n`);

const dev = spawn(process.execPath, [nextBin, "dev", "-p", String(port)], { stdio: "inherit" });

/** 用意ができたと分かる前に落ちたら、それを伝える */
let ready = false;
dev.on("exit", (code) => {
  if (!ready) {
    console.error(
      `\n開発サーバーが立ち上がる前に終了しました（終了コード ${code}）。` +
        "\n上に出ているメッセージが原因です。",
    );
  }
  process.exit(code ?? 0);
});

/* Ctrl+C は開発サーバーへそのまま渡す */
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => dev.kill(sig));
}

/* ---------------- 4. 用意ができたらブラウザで開く ---------------- */

async function waitUntilReady() {
  // 立ち上がりに時間がかかることがある。60秒まで待つ
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (dev.exitCode !== null) return; // もう落ちている。exit 側で伝える
    try {
      const res = await fetch(url);
      if (res.ok) {
        ready = true;
        console.log(`\n作図ツールが開きました → ${url}`);
        console.log("  公開中の地図を直したいときは、画面左上から移れます");
        console.log("  止めるときは Ctrl+C\n");
        openBrowser(url);
        return;
      }
    } catch {
      // まだ上がっていない。待つ
    }
  }
  console.log(`\n自動で開けませんでした。ブラウザで ${url} を開いてください。\n`);
}

void waitUntilReady();
