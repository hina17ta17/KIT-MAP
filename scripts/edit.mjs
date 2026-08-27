/**
 * 作図ツールだけを、手元で単独に立ち上げる。
 *
 *   npm run edit
 *
 * やること
 *   1. 経路をやり直すための土台データを作り直す
 *   2. 3100番で開発サーバーを起こす（案内画面の 3000番とぶつからない）
 *   3. 用意ができたらブラウザで作図ツールを開く
 *
 * 作図ツールは公開サイトには入っていない（next.config.ts で外してある）。
 * ここで描いたものは、書き出しボタンでファイルに落とすまでブラウザの中だけに
 * 残る。公開サイトへ自動で送られることはない。
 *
 * 止めるときは Ctrl+C。
 */

import { spawn, spawnSync } from "node:child_process";
import { platform } from "node:os";

const PORT = 3100;
/*
 * 開いた時点で「経路なしの土台」の作業台に入る。
 * 通過点と接続を外した状態から、道すじを引き直すための場所。
 * 公開中の地図をそのまま直したいときは、画面右上の「公開中の地図へ」で移れる。
 */
const URL = `http://localhost:${PORT}/edit/base`;

/* 1. 土台データを作り直す。元の public/data/ には触らない */
const make = spawnSync(process.execPath, ["scripts/make-base-data.mjs"], {
  stdio: "inherit",
});
if (make.status !== 0) {
  console.error("土台データを作れませんでした。ここで止めます。");
  process.exit(1);
}

/* 2. 開発サーバー。ログはそのまま出す */
console.log(`\n作図ツールを ${PORT} 番で起こしています…\n`);
const dev = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["next", "dev", "-p", String(PORT)],
  { stdio: "inherit", shell: process.platform === "win32" },
);

dev.on("exit", (code) => process.exit(code ?? 0));

/* Ctrl+C は開発サーバーへそのまま渡す */
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    dev.kill(sig);
  });
}

/* 3. 応答するようになったらブラウザで開く */
const openBrowser = () => {
  const os = platform();
  if (os === "win32") spawn("cmd", ["/c", "start", "", URL], { detached: true, stdio: "ignore" });
  else if (os === "darwin") spawn("open", [URL], { detached: true, stdio: "ignore" });
  else spawn("xdg-open", [URL], { detached: true, stdio: "ignore" });
};

const waitUntilReady = async () => {
  // 立ち上がりに時間がかかることがある。60秒まで待つ
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(URL);
      if (res.ok) {
        console.log(`\n作図ツールが開きました → ${URL}`);
        console.log("止めるときは Ctrl+C\n");
        openBrowser();
        return;
      }
    } catch {
      // まだ上がっていない。待つ
    }
  }
  console.log(`\n自動で開けませんでした。ブラウザで ${URL} を開いてください。\n`);
};

void waitUntilReady();
