"use client";

/**
 * 動きの重さを、その端末の画面に出す。
 *
 * ■ なぜ要るか
 *   手元で測るかぎり、この地図はスマホ相当の条件でも滑らかに動く。
 *   それでも実機で引っかかるなら、手元では起きていないことが
 *   その端末で起きている。推測を重ねるより、端末が何に詰まっているかを
 *   その場で読めたほうが早い。
 *
 * ■ 出し方
 *   URL の後ろに ?perf=1 を付けて開く。
 *     https://kit-map.vercel.app/?perf=1
 *   付けなければ何も出ないし、何も測らない。ふだんの動きには影響しない。
 *
 * ■ 読み方
 *   fps        1秒に何コマ描けているか。60に近いほど滑らか
 *   9割点      遅いほうから1割のコマにかかった時間。引っかかりの目安
 *   重い       33ms（30コマ/秒）を超えたコマの数
 *   細かさ     画面の細かさ / 地図が実際に描いている細かさ
 *   長い処理   16ms以上、画面を止めた処理の合計
 */

import { useEffect, useState } from "react";
import { soon } from "@/lib/soon";

type Stat = {
  fps: number;
  p90: number;
  heavy: number;
  frames: number;
  dpr: number;
  draw: number;
  blocked: number;
};

export function PerfHud() {
  const [on, setOn] = useState(false);
  const [s, setS] = useState<Stat | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!new URLSearchParams(window.location.search).has("perf")) return;
    const stopOn = soon(() => setOn(true));

    const gaps: number[] = [];
    let last = performance.now();
    let raf = 0;
    let blocked = 0;

    let po: PerformanceObserver | null = null;
    try {
      po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) blocked += e.duration;
      });
      po.observe({ entryTypes: ["longtask"] });
    } catch {
      // 対応していない端末（Safari など）では、長い処理は測れない
    }

    const tick = () => {
      const now = performance.now();
      gaps.push(now - last);
      last = now;
      // 直近の 240 コマだけ見る。ずっと足すと、良くなっても数字が動かない
      if (gaps.length > 240) gaps.shift();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const timer = window.setInterval(() => {
      if (gaps.length < 10) return;
      const sorted = [...gaps].sort((a, b) => a - b);
      // 0 で割らない。画面の更新が速すぎて 0ms と出る端末がある
      const mid = Math.max(sorted[Math.floor(sorted.length / 2)], 0.5);
      const cv = document.querySelector<HTMLCanvasElement>(".maplibregl-canvas");
      setS({
        // 画面の上限を超えては出ない。60 で頭打ちにする
        fps: Math.min(60, Math.round(1000 / mid)),
        p90: Math.round(sorted[Math.floor(sorted.length * 0.9)]),
        heavy: sorted.filter((x) => x > 33).length,
        frames: sorted.length,
        dpr: Math.round((window.devicePixelRatio || 1) * 10) / 10,
        draw: cv && cv.clientWidth ? Math.round((cv.width / cv.clientWidth) * 10) / 10 : 0,
        blocked: Math.round(blocked),
      });
      blocked = 0;
    }, 1000);

    return () => {
      stopOn();
      cancelAnimationFrame(raf);
      window.clearInterval(timer);
      po?.disconnect();
    };
  }, []);

  if (!on) return null;

  return (
    <div className="pointer-events-none absolute bottom-24 left-3 z-30 rounded-lg bg-slate-900/85 px-2.5 py-2 font-mono text-[11px] leading-tight text-white shadow-lg">
      {s ? (
        <>
          <div>
            fps <b className={s.fps >= 50 ? "text-emerald-300" : s.fps >= 30 ? "text-amber-300" : "text-rose-300"}>{s.fps}</b>
            {"  "}9割点 <b className={s.p90 <= 25 ? "text-emerald-300" : s.p90 <= 50 ? "text-amber-300" : "text-rose-300"}>{s.p90}</b>ms
          </div>
          <div>
            重い {s.heavy}/{s.frames}コマ　長い処理 {s.blocked}ms
          </div>
          <div>
            細かさ 画面{s.dpr} / 地図{s.draw}
          </div>
        </>
      ) : (
        <div>測っています…</div>
      )}
    </div>
  );
}
