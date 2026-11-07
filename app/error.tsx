"use client";

/**
 * どこかで落ちたときに出す画面。
 *
 * ■ なぜ要るか
 *   これが無いと、描いている途中で例外が投げられた時点で
 *   画面が真っ白になる。使う人からは「壊れた」としか見えず、
 *   何をすればいいのかも分からない。
 *
 *   地図の読み込み・現在地・端末の覚え（localStorage）あたりは、
 *   端末や設定によって思わぬ形で失敗する。Safari のプライベートモードは
 *   その代表で、覚えを書こうとしただけで例外になることがある。
 *   一つ一つ手当てしても取りこぼすので、最後の受け皿を置いておく。
 *
 * ■ ここで何をするか
 *   ・何が起きたかを、ひとことで伝える
 *   ・まず「やり直す」を出す。多くはこれで戻る
 *   ・それでも駄目なときのために、覚えを捨てて開き直す道を出す
 *
 *   細かい中身は畳んでおく。使う人には要らないが、
 *   知らせてもらうときには要る。
 */

import { useEffect, useState } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [detail, setDetail] = useState(false);

  useEffect(() => {
    // 手元で見ているときは、中身をそのまま出す
    if (process.env.NODE_ENV === "development") console.error(error);
  }, [error]);

  /**
   * 覚えを捨てて開き直す。
   *
   * 途中まで書かれた設定が残っていると、開くたびに同じ所で落ちる。
   * 消してよいのは、この端末の中だけのもの（表示の設定・言葉・
   * お気に入り・端末の覚え）。ログインの状態は cookie なので消えない。
   */
  const clearAndReload = () => {
    try {
      for (const k of Object.keys(window.localStorage)) {
        if (k.startsWith("kitmap.")) window.localStorage.removeItem(k);
      }
    } catch {
      // 消せなくても開き直す。プライベートモードでは触れないことがある
    }
    window.location.reload();
  };

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-slate-100 p-6">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-lg">
        <h1 className="text-base font-bold tracking-tight text-slate-900">
          うまく開けませんでした
        </h1>
        <p className="mt-2 text-xs leading-relaxed text-slate-600">
          一時的なものかもしれません。まず「やり直す」を押してみてください。
          <br />
          何度も同じところで止まるときは、下の「設定を捨てて開き直す」をお試しください。
          ログインの状態はそのままです。
        </p>

        <button
          onClick={reset}
          className="mt-4 w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold text-white transition hover:bg-blue-700 active:scale-95"
        >
          やり直す
        </button>
        <button
          onClick={clearAndReload}
          className="mt-2 w-full rounded-xl bg-slate-100 px-4 py-2.5 text-xs font-bold text-slate-600 transition hover:bg-slate-200 active:scale-95"
        >
          設定を捨てて開き直す
        </button>
        {/* 読み込み直して戻る。画面の中だけで移ると、壊れた状態を持ち越すことがあるため */}
        <button
          type="button"
          onClick={() => window.location.assign("/")}
          className="mt-2 block w-full rounded-xl px-4 py-2 text-center text-xs font-semibold text-slate-500 hover:bg-slate-100"
        >
          地図へ戻る
        </button>

        <button
          onClick={() => setDetail((v) => !v)}
          className="mt-3 text-[10px] text-slate-400 underline"
        >
          {detail ? "詳しい内容を閉じる" : "詳しい内容"}
        </button>
        {detail && (
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-50 p-2 text-[10px] leading-relaxed text-slate-500">
            {error.message}
            {error.digest ? `\n(${error.digest})` : ""}
          </pre>
        )}
      </div>
    </main>
  );
}
