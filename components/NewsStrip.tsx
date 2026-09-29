"use client";

/**
 * 学内の知らせ。学内の情報のいちばん上に出す。
 *
 * ■ 形
 *   写真が横に並び、ゆっくり流れ続ける。指で送ることもできる。
 *   最後まで来たら最初につながる（輪になっている）。
 *   押すと、その知らせの元の頁が開く。
 *
 * ■ どうやって輪にするか
 *   前後に同じ並びをもう一組ずつ置いて、真ん中を見せる。
 *   端に着いたら、見た目が同じ位置へそっと戻す。
 *   継ぎ目が見えないので、無限に続いているように見える。
 *
 * ■ 一組ぶんの幅は「測る」。割り算で出さない
 *   前は scrollWidth を 3 で割って一組ぶんとしていた。
 *   ところが札と札のあいだには隙間があり、その隙間は
 *   3n 個ではなく 3n-1 個しかない。割ると隙間ひとつぶんの
 *   三分の一だけ short になり、輪をつなぎ直すたびに
 *   少しずつ横へずれていく。送るほど狂いが溜まり、
 *   写真の切れ目で止まったり、飛んだりしていた。
 *
 *   二組目の先頭が、一組目の先頭から何点右にあるか。
 *   それが一組ぶんの幅そのもの。隙間の数を数えなくてよい。
 *
 * ■ 吸着（snap）はやめた
 *   ゆっくり流し続けるのと、札の中央へ吸い寄せるのは、
 *   互いに引っ張り合う。動かすたびに吸着が押し戻すので、
 *   かくついて見えていた。流すほうを取る。
 *
 * ■ 触っているあいだは動かさない
 *   指で送っている最中に位置を書き換えると、端末側の慣性と
 *   取り合いになって、飛んだり戻ったりする。
 *   指が触れているあいだは何もせず、離れてから整える。
 *   読んでいる人の邪魔をしないよう、離れたあとも少し待つ。
 *
 * ■ 何も無いときは、何も出さない
 *   空の枠が残っていると、地図を見に来た人の場所を削るだけ。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient, supabaseReady } from "@/lib/supabase/client";

type News = { id: number; image: string; url: string; title: string };

/** 1コマでどれだけ進むか（点）。60コマ/秒で、およそ 21点/秒 */
const SPEED = 0.35;
/** 指を離してから、また流れ出すまで（ミリ秒） */
const RESUME = 2500;

export default function NewsStrip({ t: T }: { t: (ja: string) => string }) {
  const [rows, setRows] = useState<News[]>([]);
  const box = useRef<HTMLDivElement>(null);
  /** 一組ぶんの幅（実測） */
  const one = useRef(0);
  /** いま指が触れているか */
  const touching = useRef(false);
  /** この時刻までは、自分からは動かさない */
  const waitUntil = useRef(0);

  useEffect(() => {
    if (!supabaseReady) return;
    void createClient()
      .rpc("news_live")
      .then(({ data }) => setRows((data as News[]) ?? []));
  }, []);

  /** 一組ぶんの幅を測る。写真が入ると変わるので、何度でも測り直せるようにする */
  const measure = useCallback(() => {
    const el = box.current;
    if (!el || rows.length === 0) return;
    const first = el.children[0] as HTMLElement | undefined;
    const second = el.children[rows.length] as HTMLElement | undefined;
    if (!first || !second) return;
    const w = second.offsetLeft - first.offsetLeft;
    if (w <= 0) return;
    const firstTime = one.current === 0;
    one.current = w;
    /* はじめて測れたときだけ、真ん中の組へ置く */
    if (firstTime) el.scrollLeft = w;
  }, [rows.length]);

  useEffect(() => {
    if (rows.length === 0) return;
    measure();
    const el = box.current;
    if (!el) return;
    /* 画面の幅が変わったら測り直す */
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    /* 写真が入ると高さも幅も決まるので、そのあとにも測り直す */
    const imgs = Array.from(el.querySelectorAll("img"));
    imgs.forEach((i) => i.addEventListener("load", measure));
    return () => {
      ro.disconnect();
      imgs.forEach((i) => i.removeEventListener("load", measure));
    };
  }, [rows.length, measure]);

  /* ゆっくり流し続ける */
  useEffect(() => {
    if (rows.length === 0) return;
    /* 動きを減らす設定の人には、流さない。指で送るのはそのまま使える */
    const still =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

    let raf = 0;
    const tick = () => {
      raf = window.requestAnimationFrame(tick);
      const el = box.current;
      const w = one.current;
      if (!el || w <= 0) return;

      /* 触っているあいだは、位置に触らない（端末の慣性と取り合わない） */
      if (touching.current) return;

      if (!still && Date.now() >= waitUntil.current) el.scrollLeft += SPEED;

      /* 輪をつなぎ直す。真ん中の一組ぶんだけ動かすので、目には何も起きない */
      if (el.scrollLeft >= w * 2) el.scrollLeft -= w;
      else if (el.scrollLeft < w * 0.5) el.scrollLeft += w;
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [rows.length]);

  if (rows.length === 0) return null;

  /** いつの知らせかが分かるように、今日の日付を添える */
  const today = new Date();
  const todayText = `${today.getMonth() + 1}月${today.getDate()}日`;

  /* 前後に同じ並びを置いて、輪にする */
  const three = [...rows, ...rows, ...rows];

  const hold = () => {
    touching.current = true;
  };
  const release = () => {
    touching.current = false;
    waitUntil.current = Date.now() + RESUME;
  };

  return (
    <section className="mb-3">
      <div className="mb-1 flex items-baseline gap-1.5">
        <span className="text-[11px] font-bold text-slate-700">{T("お知らせ")}</span>
        <span className="text-[10px] text-slate-400">
          {todayText}
          {rows.length > 1 ? `・${rows.length}件` : ""}
        </span>
      </div>

      <div
        ref={box}
        onPointerDown={hold}
        onPointerUp={release}
        onPointerCancel={release}
        onPointerLeave={release}
        onTouchStart={hold}
        onTouchEnd={release}
        onTouchCancel={release}
        /* ホイールや、読んでいるあいだは少し待つ */
        onWheel={() => {
          waitUntil.current = Date.now() + RESUME;
        }}
        onMouseEnter={() => {
          waitUntil.current = Date.now() + RESUME;
        }}
        onMouseMove={() => {
          waitUntil.current = Date.now() + RESUME;
        }}
        className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {three.map((n, i) => (
          <a
            key={`${n.id}-${i}`}
            href={n.url}
            target="_blank"
            rel="noreferrer noopener"
            className="block w-[15rem] shrink-0 overflow-hidden rounded-xl bg-slate-100 shadow-sm transition active:scale-[0.98]"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={n.image}
              alt={n.title || T("お知らせ")}
              /* 三組ぶん並ぶが、写真は同じものを指すので読み込みは一組ぶん */
              loading="lazy"
              draggable={false}
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
