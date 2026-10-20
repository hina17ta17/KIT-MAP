/**
 * 無いページを開いたときに出す画面。
 *
 * ■ なぜ要るか
 *   これが無いと、Next.js が用意した英語の画面
 *   （404 This page could not be found.）が出る。
 *   ほかの画面はすべて日本語なので、そこだけ英語だと迷う。
 *   戻る道（地図・ログイン）も無かった。
 *
 * 見た目は、落ちたときの画面（error.tsx）にそろえてある。
 */

import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-slate-100 p-6">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-lg">
        <p className="font-mono text-xs font-bold text-slate-400">404</p>
        <h1 className="mt-1 text-base font-bold tracking-tight text-slate-900">
          このページは見つかりませんでした
        </h1>
        <p className="mt-2 text-xs leading-relaxed text-slate-600">
          住所がまちがっているか、ページが移ったのかもしれません。
        </p>

        <Link
          href="/"
          className="mt-4 block w-full rounded-xl bg-blue-600 px-4 py-3 text-center text-sm font-bold text-white transition hover:bg-blue-700 active:scale-95"
        >
          地図へ戻る
        </Link>
        <Link
          href="/login"
          className="mt-2 block w-full rounded-xl px-4 py-2 text-center text-xs font-semibold text-slate-500 hover:bg-slate-100"
        >
          ログイン
        </Link>
      </div>
    </main>
  );
}
