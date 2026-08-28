"use client";

/**
 * 表示のカスタマイズ。
 *
 * 名前の色・名前の付け替え・夜の見え方を、この端末にだけ覚える。
 * 誰かに送るものではないので、データベースには触らない。
 */

import { Fragment, useMemo, useState } from "react";
import type { AppData } from "@/lib/appdata";
import { LABEL_COLORS, colorOf, type Custom } from "@/lib/custom";
import { GROUP_LABEL, compareOrder, orderKey } from "@/lib/order";

type Props = {
  open: boolean;
  /** 言葉の言い換え。英語に切り替えているときはこの画面も英語にする */
  t: (ja: string) => string;
  onClose: () => void;
  data: AppData | null;
  value: Custom;
  onChange: (next: Custom) => void;
};

export default function Customize({ open, onClose, data, value, onChange, t }: Props) {
  const [q, setQ] = useState("");

  /**
   * 建物の一覧。
   *
   * 並び順は建物一覧・お気に入りと同じものを使う。
   * 画面ごとに違う順だと、同じ場所を探すのに毎回並びを覚え直すことになる。
   */
  const places = useMemo(() => {
    const list = (data?.buildings.features ?? [])
      .map((f) => ({
        id: f.properties.tempId,
        original: f.properties.name || (f.properties.code ? `${f.properties.code}号館` : ""),
        key: orderKey(f.properties.name ?? "", f.properties.code ?? ""),
      }))
      .filter((p) => p.original);
    return list.sort((a, b) => compareOrder(a.key, b.key));
  }, [data]);

  const changed = useMemo(
    () => places.filter((p) => (value.names[p.id] ?? "").trim() !== ""),
    [places, value.names],
  );

  const shown = useMemo(() => {
    const k = q.trim();
    if (!k) return places;
    return places.filter(
      (p) => p.original.includes(k) || (value.names[p.id] ?? "").includes(k),
    );
  }, [places, q, value.names]);

  if (!open) return null;

  const setName = (id: string, name: string) => {
    const names = { ...value.names };
    if (name.trim()) names[id] = name;
    else delete names[id];
    onChange({ ...value, names });
  };

  const cur = colorOf(value.color);

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-slate-900/40" onClick={onClose}>
      <div
        className="mt-auto flex max-h-[85dvh] flex-col rounded-t-3xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 見出し */}
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-bold text-slate-900">{t("表示のカスタマイズ")}</h2>
          <button
            onClick={onClose}
            className="rounded-full bg-slate-900 px-4 py-1.5 text-xs font-bold text-white active:scale-95"
          >
            {t("閉じる")}
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {/* ---------------- 名前の色 ---------------- */}
          <section>
            <h3 className="text-xs font-bold text-slate-900">{t("名前の色")}</h3>
            <p className="mt-0.5 text-[10px] leading-relaxed text-slate-500">
              {t(
                "地図に出る名前の色です。どれも薄い色にしてあります。航空写真の上でも文字が読めるようにするためです。",
              )}
            </p>
            <div className="mt-2 grid grid-cols-5 gap-1.5">
              {LABEL_COLORS.map((c) => {
                const on = c.id === value.color;
                return (
                  <button
                    key={c.id}
                    onClick={() => onChange({ ...value, color: c.id })}
                    className={`flex flex-col items-center gap-1 rounded-lg py-2 transition active:scale-95 ${
                      on ? "bg-slate-900" : "bg-slate-100 hover:bg-slate-200"
                    }`}
                  >
                    <span
                      className="flex h-6 w-12 items-center justify-center rounded-full text-[9px] font-bold shadow-sm"
                      style={{ backgroundColor: c.bg, color: c.fg }}
                    >
                      {t("1号館")}
                    </span>
                    <span
                      className={`text-[10px] font-bold ${on ? "text-white" : "text-slate-600"}`}
                    >
                      {t(c.label)}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="mt-1.5 text-[10px] text-slate-400">
              {t("いま選んでいるのは")}
              <span
                className="mx-1 rounded-full px-1.5 py-0.5 font-bold"
                style={{ backgroundColor: cur.bg, color: cur.fg }}
              >
                {t(cur.label)}
              </span>
              {t("です。お気に入りは色に関わらず黄色く光ります。")}
            </p>
          </section>

          {/* ---------------- 夜の見え方 ---------------- */}
          <section className="mt-4 border-t border-slate-200 pt-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-xs font-bold text-slate-900">{t("ダークモード")}</h3>
                <p className="mt-0.5 text-[10px] leading-relaxed text-slate-500">
                  {t("ボタンや一覧など、地図の上に重ねている部分を黒くします。")}
                  <span className="block text-slate-400">
                    {t(
                      "地図（航空写真）はそのままです。写真を暗くすると何が写っているか分からなくなり、地図として使えなくなるためです。",
                    )}
                  </span>
                </p>
              </div>
              <button
                onClick={() => onChange({ ...value, dark: !value.dark })}
                aria-pressed={value.dark}
                className={`relative h-7 w-12 shrink-0 rounded-full transition ${
                  value.dark ? "bg-indigo-600" : "bg-slate-300"
                }`}
              >
                <span
                  className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all ${
                    value.dark ? "left-6" : "left-1"
                  }`}
                />
              </button>
            </div>
          </section>

          {/* ---------------- 名前の付け替え ---------------- */}
          <section className="mt-4 border-t border-slate-200 pt-3">
            <h3 className="text-xs font-bold text-slate-900">{t("名前の付け替え")}</h3>
            <p className="mt-0.5 text-[10px] leading-relaxed text-slate-500">
              {t(
                "自分に分かりやすい呼び方に変えられます。地図にはその名前だけが出ます。もとの名前はこの画面で確かめられます。",
              )}
            </p>

            {changed.length > 0 && (
              <div className="mt-2 rounded-lg bg-amber-50 px-2.5 py-2 ring-1 ring-amber-200">
                <div className="text-[10px] font-bold text-amber-900">
                  {t("変えたもの")} {changed.length} {t("件")}
                </div>
                <ul className="mt-1 space-y-0.5">
                  {changed.map((p) => (
                    <li key={p.id} className="flex items-center gap-1 text-[10px] text-amber-900">
                      <span className="truncate text-amber-700 line-through">{p.original}</span>
                      <span className="shrink-0 text-amber-500">→</span>
                      <span className="truncate font-bold">{value.names[p.id]}</span>
                    </li>
                  ))}
                </ul>
                <button
                  onClick={() => onChange({ ...value, names: {} })}
                  className="mt-1.5 text-[10px] text-amber-700 underline active:scale-95"
                >
                  {t("すべてもとの名前に戻す")}
                </button>
              </div>
            )}

            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("名前で絞り込む")}
              className="mt-2 w-full rounded-lg bg-slate-100 px-3 py-2 text-xs outline-none placeholder:text-slate-400"
            />

            <ul className="mt-2 space-y-1.5 pb-2">
              {shown.map((p, i) => {
                const v = value.names[p.id] ?? "";
                // 区切りが変わったところに見出しを出す（建物一覧と同じ形）
                const head =
                  p.key[0] !== shown[i - 1]?.key[0] ? GROUP_LABEL[p.key[0]] : undefined;
                return (
                  <Fragment key={p.id}>
                    {head && (
                      <li className="pt-1.5">
                        <div className="border-t border-slate-200 pb-0.5 pt-1.5 text-[10px] font-bold text-slate-400">
                          {t(head)}
                        </div>
                      </li>
                    )}
                    <li className="flex items-center gap-2">
                      <span
                        className="w-24 shrink-0 truncate text-[11px] text-slate-500"
                        title={p.original}
                      >
                        {p.original}
                      </span>
                      <input
                        value={v}
                        onChange={(e) => setName(p.id, e.target.value)}
                        placeholder={p.original}
                        className={`min-w-0 flex-1 rounded-lg px-2.5 py-1.5 text-xs outline-none ${
                          v
                            ? "bg-amber-50 font-bold text-amber-950 ring-1 ring-amber-300"
                            : "bg-slate-100"
                        }`}
                      />
                      {v && (
                        <button
                          onClick={() => setName(p.id, "")}
                          aria-label={t("もとに戻す")}
                          title={t("もとに戻す")}
                          className="shrink-0 rounded-full px-2 py-1 text-[11px] font-bold text-slate-400 hover:bg-slate-100 hover:text-slate-700 active:scale-90"
                        >
                          ×
                        </button>
                      )}
                    </li>
                  </Fragment>
                );
              })}
              {shown.length === 0 && (
                <li className="py-4 text-center text-[11px] text-slate-400">
                  {t("見つかりませんでした")}
                </li>
              )}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
