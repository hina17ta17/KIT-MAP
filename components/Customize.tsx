"use client";

/**
 * 表示のカスタマイズ。
 *
 * 名前の色・名前の付け替え・夜の見え方を、この端末にだけ覚える。
 * 誰かに送るものではないので、データベースには触らない。
 */

import { Fragment, useMemo, useState } from "react";
import type { AppData } from "@/lib/appdata";
import { createClient, supabaseReady } from "@/lib/supabase/client";
import type { Lang } from "@/lib/i18n";
import { LABEL_COLORS, colorOf, type Custom } from "@/lib/custom";
import { GROUP_LABEL, compareOrder, orderKey } from "@/lib/order";

type Props = {
  open: boolean;
  /** 言葉の言い換え。英語に切り替えているときはこの画面も英語にする */
  t: (ja: string) => string;
  /** いまの言葉。感想と一緒に預けて、読むときの手がかりにする */
  lang: Lang;
  onClose: () => void;
  data: AppData | null;
  value: Custom;
  onChange: (next: Custom) => void;
};

export default function Customize({ open, onClose, data, value, onChange, t, lang }: Props) {
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

            {/*
              建物の一覧は、この中だけで送る。

              そのまま並べると40件以上が縦に伸び、この画面の下に置いたものへ
              指が届かなくなる（感想の欄が、実際にそうなっていた）。
              高さを決めて、中で送るようにする。
            */}
            <ul className="mt-2 max-h-72 space-y-1.5 overflow-y-auto pb-2">
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

          {/* ---------------- 感想 ---------------- */}
          <section className="mt-4 border-t border-slate-200 pt-3">
            <Feedback t={t} lang={lang} />
          </section>
        </div>
      </div>
    </div>
  );
}

/**
 * 感想を送る。
 *
 * ■ 名前を取らない
 *   誰が書いたかを残さない。ログインしているかどうかも見ない。
 *   残すと「誰が何を書いたか」が分かってしまい、思ったことを
 *   そのまま書けなくなる。書いてもらうことが目的なので、
 *   たどれないことを決まりとして先に置く。
 *
 * ■ ここに置いた理由
 *   カスタマイズは「この人自身の設定」を触る場所で、
 *   地図の操作を邪魔しない。感想もその並びに置くのが自然だった。
 *   案内の途中に出すと、急いでいる人の邪魔になる。
 */
function Feedback({ t, lang }: { t: (ja: string) => string; lang: Lang }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [rating, setRating] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const MAX = 2000;
  const left = MAX - body.length;

  // 送り先が無いときは、書かせてから捨てることになる。出さない
  if (!supabaseReady) return null;

  const send = async () => {
    const text = body.trim();
    if (!text) return;
    setBusy(true);
    setErr(null);
    try {
      const { error } = await createClient().from("feedback").insert({
        body: text,
        rating,
        lang,
      });
      if (error) throw error;
      setDone(true);
      setBody("");
      setRating(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("送れませんでした"));
    } finally {
      setBusy(false);
    }
  };

  if (done)
    return (
      <div className="rounded-xl bg-emerald-50 p-3">
        <p className="text-xs font-bold text-emerald-900">{t("ありがとうございました")}</p>
        <p className="mt-1 text-[10px] leading-relaxed text-emerald-800">
          {t("いただいた内容は、名前が分からない形で届いています。")}
        </p>
        <button
          onClick={() => setDone(false)}
          className="mt-2 text-[10px] font-bold text-emerald-700 underline"
        >
          {t("もう一つ送る")}
        </button>
      </div>
    );

  if (!open)
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full rounded-xl bg-slate-100 px-3 py-2.5 text-xs font-bold text-slate-700 transition hover:bg-slate-200 active:scale-95"
      >
        {t("感想を送る（名前は伝わりません）")}
      </button>
    );

  return (
    <div>
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold text-slate-900">{t("感想を送る")}</h3>
        <button
          onClick={() => setOpen(false)}
          className="rounded-lg px-2 py-1 text-[10px] font-bold text-slate-500 hover:bg-slate-100"
        >
          {t("閉じる")}
        </button>
      </div>
      <p className="mt-0.5 text-[10px] leading-relaxed text-slate-500">
        {t("名前もアカウントも伝わりません。よかった所も、使いにくい所も、そのまま書いてください。")}
      </p>

      {/* 星。付けなくても送れる */}
      <div className="mt-2 flex items-center gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            onClick={() => setRating(rating === n ? null : n)}
            aria-label={`${n}`}
            className={`h-8 w-8 rounded-lg text-sm transition active:scale-90 ${
              rating !== null && n <= rating
                ? "bg-amber-100 text-amber-600"
                : "bg-slate-100 text-slate-300"
            }`}
          >
            ★
          </button>
        ))}
        {rating !== null && (
          <span className="ml-1 text-[10px] font-bold text-slate-500">{rating} / 5</span>
        )}
      </div>

      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value.slice(0, MAX))}
        rows={4}
        placeholder={t("例：目的の教室まで迷わず行けました。夜は地図が見づらいです。")}
        className="mt-2 w-full rounded-xl bg-slate-100 px-3 py-2.5 text-xs leading-relaxed outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
      />
      <div className="mt-0.5 text-right text-[10px] text-slate-400">
        {t("残り")} {left}
      </div>

      {err && <p className="mt-1 rounded-lg bg-red-50 p-2 text-[10px] text-red-800">{err}</p>}

      <button
        onClick={() => void send()}
        disabled={busy || body.trim().length === 0}
        className="mt-1 w-full rounded-xl bg-slate-900 px-3 py-2.5 text-xs font-bold text-white transition hover:bg-slate-800 active:scale-95 disabled:bg-slate-200 disabled:text-slate-400"
      >
        {busy ? t("送っています…") : t("送る")}
      </button>
    </div>
  );
}
