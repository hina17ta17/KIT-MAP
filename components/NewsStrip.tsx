"use client";

/**
 * 学内の知らせ。学内の情報のいちばん上に出す。
 *
 * ■ 形
 *   写真が横に並んでいて、指で横に送って見る。
 *   最後まで来たら最初につながる（輪になっている）。
 *   押すと、その知らせの元の頁が開く。
 *
 * ■ なぜ輪にするか
 *   端まで来て止まると、そこで「終わり」に見える。
 *   けれど知らせは数枚しかないので、止まる意味がない。
 *   つながっていれば、どちらへ送っても next が出る。
 *
 * ■ どうやって輪にするか
 *   前後に同じ並びをもう一組ずつ置いて、真ん中を見せる。
 *   端に着いたら、見た目が同じ位置へそっと戻す。
 *   継ぎ目が見えないので、無限に続いているように見える。
 *
 *   絵を三組ぶん持つことになるが、知らせは多くて数枚。
 *   写真は同じものを指しているので、読み込みは一組ぶんで済む。
 *
 * ■ 何も無いときは、何も出さない
 *   空の枠が残っていると、地図を見に来た人の場所を削るだけ。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient, supabaseReady } from "@/lib/supabase/client";

type News = { id: number; image: string; url: string; title: string };

export default function NewsStrip({ t: T }: { t: (ja: string) => string }) {
  const [rows, setRows] = useState<News[]>([]);
  const box = useRef<HTMLDivElement>(null);
  /** いま真ん中の組を見ているか。輪を作り直している最中は触らない */
  const fixing = useRef(false);

  useEffect(() => {
    if (!supabaseReady) return;
    void createClient()
      .rpc("news_live")
      .then(({ data }) => setRows((data as News[]) ?? []));
  }, []);

  /**
   * 端に着いたら、見た目の同じ位置へ戻す。
   *
   * 三組ぶん並べてあるので、真ん中の一組ぶんだけ動かせば、
   * 目には何も起きていないように見える。
   */
  const wrap = useCallback(() => {
    const el = box.current;
    if (!el || rows.length === 0 || fixing.current) return;
    const one = el.scrollWidth / 3;
    if (one <= 0) return;
    if (el.scrollLeft < one * 0.5) {
      fixing.current = true;
      el.scrollLeft += one;
      fixing.current = false;
    } else if (el.scrollLeft > one * 1.5) {
      fixing.current = true;
      el.scrollLeft -= one;
      fixing.current = false;
    }
  }, [rows.length]);

  /* はじめは真ん中の組から見せる */
  useEffect(() => {
    const el = box.current;
    if (!el || rows.length === 0) return;
    const id = window.setTimeout(() => {
      el.scrollLeft = el.scrollWidth / 3;
    }, 0);
    return () => window.clearTimeout(id);
  }, [rows.length]);

  if (rows.length === 0) return null;

  /* 前後に同じ並びを置いて、輪にする */
  const three = [...rows, ...rows, ...rows];

  return (
    <section className="mb-3">
      <div className="mb-1 flex items-baseline gap-1.5">
        <span className="text-[11px] font-bold text-slate-700">{T("お知らせ")}</span>
        <span className="text-[10px] text-slate-400">
          {T("横に送って見られます")}
          {rows.length > 1 ? `（${rows.length}）` : ""}
        </span>
      </div>

      <div
        ref={box}
        onScroll={wrap}
        className="flex snap-x snap-mandatory gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {three.map((n, i) => (
          <a
            key={`${n.id}-${i}`}
            href={n.url}
            target="_blank"
            rel="noreferrer noopener"
            className="block w-[15rem] shrink-0 snap-center overflow-hidden rounded-xl bg-slate-100 shadow-sm transition active:scale-[0.98]"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={n.image}
              alt={n.title || T("お知らせ")}
              loading="lazy"
              className="h-32 w-full object-cover"
            />
            {n.title && (
              <div className="truncate px-2.5 py-1.5 text-[11px] font-bold text-slate-700">
                {n.title}
              </div>
            )}
          </a>
        ))}
      </div>
    </section>
  );
}
