"use client";

/**
 * 画面で起きたエラーを、履歴に残す見張り。
 *
 * ■ 何のためか
 *   どこかで catch し忘れたものや、思いもよらない壊れ方は、
 *   その場で画面が止まるだけで、あとには何も残らない。
 *   使っている人は「動かなくなった」としか言えず、
 *   こちらは何が起きたのか確かめられなかった。
 *
 *   窓ぜんぶを見張って、起きたものをそのままの言葉で残す。
 *
 * ■ 二つを見る
 *   error             … その場で投げられたもの
 *   unhandledrejection … 待っている間に投げられて、誰も受け取らなかったもの
 *   後者のほうが多い。データベースへの問い合わせは、たいていこちら。
 *
 * ■ 出しすぎない
 *   こわれ方によっては、一秒に何十回も起きる。
 *   同じものは一度だけにして、この画面では 10 件までにしておく。
 *   （残す側でも、一人あたり十分で 60 件までに抑えてある）
 */

import { useEffect } from "react";
import { noteError } from "@/lib/note";

export default function ErrorNote() {
  useEffect(() => {
    /** もう残したもの。同じものを何度も残さない */
    const seen = new Set<string>();
    let n = 0;

    const put = (label: string, e: unknown) => {
      if (n >= 10) return;
      const key = `${label}|${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
      if (seen.has(key)) return;
      seen.add(key);
      n += 1;
      noteError("system", label, e);
    };

    const onError = (ev: ErrorEvent) => {
      put(
        `画面でエラーが起きました（${ev.message || "名前なし"}）`,
        ev.error ?? { message: ev.message, file: ev.filename, line: ev.lineno },
      );
    };
    const onReject = (ev: PromiseRejectionEvent) => {
      const r = ev.reason;
      const msg =
        r instanceof Error ? r.message : typeof r === "string" ? r : (r?.message ?? "名前なし");
      put(`受け取られなかったエラー（${String(msg).slice(0, 120)}）`, r);
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onReject);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onReject);
    };
  }, []);

  return null;
}
