"use client";

/**
 * 日にちをカレンダーから選ぶ。いくつでも選べる。
 *
 * ■ なぜ作ったか
 *   日付は <input type="date"> ひとつだった。授業は同じ組み合わせを
 *   前期のあいだ毎週入れるので、15回ぶん同じ操作をくり返すことになる。
 *   打ち込む形だと、何日を入れ終わったのかも見えない。
 *
 *   カレンダーなら、入れた日が塗られて残る。
 *   「毎週くり返す」を押せば、同じ曜日を先までまとめて足せる。
 *
 * ■ 日にちの持ち方
 *   "2026-09-03" の文字で持つ。Date で持つと、時刻や時差の分だけ
 *   前の日にずれることがある。画面でもデータベースでも
 *   使うのは日付だけなので、文字のまま扱うほうが崩れない。
 *
 * ■ 週のはじめ
 *   日曜から。大学の予定表がそう並んでいるため。
 */

import { useMemo, useState } from "react";

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

/** "2026-09-03" を作る。月と日は2桁に揃える */
function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function todayYmd(): string {
  const d = new Date();
  return ymd(d.getFullYear(), d.getMonth(), d.getDate());
}

/** "2026-09-03" → Date（その日の 0 時）。時差でずれないよう、数を渡して作る */
function toDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function fromDate(d: Date): string {
  return ymd(d.getFullYear(), d.getMonth(), d.getDate());
}

/** n 日ずらした日 */
function shift(s: string, days: number): string {
  const d = toDate(s);
  d.setDate(d.getDate() + days);
  return fromDate(d);
}

/** "2026-09-03" → "9月3日(木)" */
export function niceDate(s: string): string {
  const d = toDate(s);
  return `${d.getMonth() + 1}月${d.getDate()}日(${WEEK[d.getDay()]})`;
}

type Props = {
  /** 選んでいる日。並びは問わない（中で並べ替える） */
  value: string[];
  onChange: (next: string[]) => void;
  /** 一度に選べる上限。入れすぎを止める */
  max?: number;
};

/**
 * 「何週くり返すか」の選択肢。
 *
 * 学期の長さ（15週）と、その半分（8週）、月ぶん（4週）が
 * よく使われるが、13週や10週にしたいこともある。
 * よく使うものを飛ばさずに並べておく。
 */
const WEEKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 20, 24, 30];

export default function MultiDatePicker({ value, onChange, max = 60 }: Props) {
  const today = todayYmd();
  /** 何週ぶんくり返すか。授業は15週が多いので、そこを既定にする */
  const [weeks, setWeeks] = useState(15);
  /** 出している月。選んでいる日があればその月、無ければ今月 */
  const [cursor, setCursor] = useState(() => {
    const first = [...value].sort()[0] ?? today;
    const d = toDate(first);
    return { y: d.getFullYear(), m: d.getMonth() };
  });

  const chosen = useMemo(() => new Set(value), [value]);
  const sorted = useMemo(() => [...value].sort(), [value]);

  /** その月の升目。頭の空きぶんだけ null を置く */
  const cells = useMemo(() => {
    const first = new Date(cursor.y, cursor.m, 1);
    const days = new Date(cursor.y, cursor.m + 1, 0).getDate();
    const out: (string | null)[] = Array(first.getDay()).fill(null);
    for (let d = 1; d <= days; d++) out.push(ymd(cursor.y, cursor.m, d));
    // 最後の週を埋めて、升目の大きさを揃える
    while (out.length % 7 !== 0) out.push(null);
    return out;
  }, [cursor]);

  const set = (next: string[]) => {
    const uniq = [...new Set(next)].sort();
    onChange(uniq.slice(0, max));
  };

  const toggle = (day: string) => {
    if (chosen.has(day)) set(value.filter((x) => x !== day));
    else set([...value, day]);
  };

  /**
   * 選んでいる日と同じ曜日を、先の週にも足す。
   *
   * 授業は同じ曜日の同じ時限をくり返す。一日選んで「＋15週」を押せば
   * 前期ぶんが埋まる。すでに選んである日は増えない（重ならない）。
   */
  const repeat = (weeks: number) => {
    if (value.length === 0) return;
    const add: string[] = [];
    for (const base of value) {
      for (let i = 1; i <= weeks; i++) add.push(shift(base, i * 7));
    }
    set([...value, ...add]);
  };

  const move = (by: number) => {
    const d = new Date(cursor.y, cursor.m + by, 1);
    setCursor({ y: d.getFullYear(), m: d.getMonth() });
  };

  const full = value.length >= max;

  return (
    <div>
      {/* 月を送る */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => move(-1)}
          aria-label="前の月"
          className="h-8 w-8 rounded-lg bg-slate-100 text-sm font-bold text-slate-600 transition hover:bg-slate-200 active:scale-90"
        >
          ‹
        </button>
        <div className="text-sm font-bold text-slate-900">
          {cursor.y}年 {cursor.m + 1}月
        </div>
        <button
          onClick={() => move(1)}
          aria-label="次の月"
          className="h-8 w-8 rounded-lg bg-slate-100 text-sm font-bold text-slate-600 transition hover:bg-slate-200 active:scale-90"
        >
          ›
        </button>
      </div>

      {/* 曜日 */}
      <div className="mt-1.5 grid grid-cols-7 gap-1">
        {WEEK.map((w, i) => (
          <div
            key={w}
            className={`text-center text-[10px] font-bold ${
              i === 0 ? "text-red-400" : i === 6 ? "text-blue-400" : "text-slate-400"
            }`}
          >
            {w}
          </div>
        ))}
      </div>

      {/* 日にち */}
      <div className="mt-1 grid grid-cols-7 gap-1">
        {cells.map((day, i) => {
          if (!day) return <div key={`x${i}`} />;
          const on = chosen.has(day);
          const isToday = day === today;
          const dow = i % 7;
          return (
            <button
              key={day}
              onClick={() => toggle(day)}
              // 上限に達していても、選んである日は外せる
              disabled={full && !on}
              className={`relative h-9 rounded-lg text-xs font-bold transition active:scale-90 ${
                on
                  ? "bg-blue-600 text-white"
                  : full
                    ? "bg-slate-50 text-slate-300"
                    : dow === 0
                      ? "bg-slate-100 text-red-500 hover:bg-slate-200"
                      : dow === 6
                        ? "bg-slate-100 text-blue-600 hover:bg-slate-200"
                        : "bg-slate-100 text-slate-700 hover:bg-slate-200"
              }`}
            >
              {Number(day.slice(8))}
              {isToday && (
                <span
                  className={`absolute inset-x-0 bottom-1 mx-auto block h-1 w-1 rounded-full ${
                    on ? "bg-white" : "bg-slate-400"
                  }`}
                />
              )}
            </button>
          );
        })}
      </div>

      {/*
        まとめて足す・消す。

        前は ＋4週・＋8週・＋15週の三つに分かれていた。
        13週や10週にしたいときに手が無く、押す数だけ増えていた。
        いまは何週かを選んで、一度で足す。
      */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-bold text-slate-500">毎週くり返す</span>
        <select
          value={weeks}
          onChange={(e) => setWeeks(Number(e.target.value))}
          className="rounded-lg bg-slate-100 px-1.5 py-1 text-[10px] font-bold text-slate-700 outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
        >
          {WEEKS.map((n) => (
            <option key={n} value={n}>
              {n}週
            </option>
          ))}
        </select>
        <button
          onClick={() => repeat(weeks)}
          disabled={value.length === 0 || full}
          className="rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600 transition hover:bg-slate-200 active:scale-95 disabled:text-slate-300"
        >
          ＋{weeks}週ぶん足す
        </button>
        <button
          onClick={() => set([today])}
          className="ml-auto rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600 transition hover:bg-slate-200 active:scale-95"
        >
          今日だけ
        </button>
        <button
          onClick={() => onChange([])}
          disabled={value.length === 0}
          className="rounded-lg px-2 py-1 text-[10px] font-bold text-red-600 transition hover:bg-red-50 active:scale-95 disabled:text-slate-300"
        >
          すべて外す
        </button>
      </div>

      {/* 選んだ日。押すと外せる */}
      <div className="mt-2 rounded-xl bg-slate-50 p-2">
        <div className="text-[10px] font-bold text-slate-500">
          選んだ日：{value.length} 日
          {full && <span className="ml-1 text-amber-700">（一度に選べるのは{max}日までです）</span>}
        </div>
        {value.length === 0 ? (
          <p className="mt-1 text-[10px] text-slate-400">
            カレンダーの日にちを押して選んでください。いくつでも選べます。
          </p>
        ) : (
          <div className="mt-1 flex flex-wrap gap-1">
            {sorted.map((d) => (
              <button
                key={d}
                onClick={() => set(value.filter((x) => x !== d))}
                title="押すと外します"
                className="rounded-full bg-white px-2 py-0.5 text-[10px] font-bold text-slate-700 shadow-sm transition hover:bg-red-50 hover:text-red-700 active:scale-95"
              >
                {niceDate(d)} ×
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
