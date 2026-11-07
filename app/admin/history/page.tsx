"use client";

/**
 * 履歴。いつ・誰が・何を変えたか。
 *
 * ■ 何のためか
 *   「誰かが消したらしいが、何が消えたのか分からない」を無くす。
 *   消した中身をそのまま控えてあるので、その場で戻せる。
 *
 *   実際に二度困っている。
 *     ・1号館の教室を一つ消して、何が消えたか分からなくなった
 *     ・profiles の行だけを消して、その人がどこからも直せなくなった
 *   どちらも、消える前の中身が残っていれば、押すだけで戻せた。
 *
 * ■ 六つに分ける
 *   教室／学科・学部／予定／食堂／名簿／席と権限。
 *   ぜんぶ混ぜて並べると、探しているものに届かない。
 *   「教室のことだけ見たい」が、いちばん多い探し方になる。
 *
 * ■ 誰が
 *   見る・戻す … レベル2.1・2.2・管理者
 *   消す       … 管理者だけ
 *
 *   履歴は「あとから確かめるためのもの」なので、
 *   誰でも消せると、都合の悪いものを消してしまえる。
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient, supabaseReady } from "@/lib/supabase/client";
import { AdminHeader, AdminMenu } from "@/components/AdminNav";
import { useAdminT } from "@/lib/adminLang";
import { canManageAll, type Role } from "@/lib/auth";
import { soon } from "@/lib/soon";

/** 履歴の一行 */
type Row = {
  id: number;
  area: string;
  table_name: string;
  action: "insert" | "update" | "delete" | "event" | "error";
  row_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  /** できごと・エラーの一行の説明 */
  label: string | null;
  /** そのままの中身。エラー名や番号など */
  detail: Record<string, unknown> | null;
  actor_mail: string;
  at: string;
  restored_at: string | null;
  total: number;
};

/**
 * 六つの分類。
 *
 * id は 05_feedback_history.sql の 05-3 の area とそろえてある。
 * ここを変えるときは、あちらの引き金の掛け方も一緒に変える。
 */
const AREAS: { id: string; label: string; sub: string; icon: string }[] = [
  { id: "rooms", label: "教室", sub: "教室の登録・削除", icon: "🏫" },
  { id: "campus", label: "学科・学部", sub: "学科と学部の登録・削除", icon: "🎓" },
  { id: "schedule", label: "予定", sub: "授業・イベント・課外活動と科目", icon: "📘" },
  { id: "cafeteria", label: "食堂", sub: "メニュー・提供状況・控え", icon: "🍚" },
  { id: "roster", label: "名簿", sub: "学生・教職員の名簿", icon: "📒" },
  { id: "people", label: "席と権限", sub: "利用者の情報と権限", icon: "👤" },
  /*
   * 表の中身が変わらなかったことも残す。
   * 困るのは、たいてい変わらなかったときのほうにある。
   *   ・xlsx を読ませたが、一行も入らなかった
   *   ・申請したのに通らなかった
   *   ・画面が急に止まった
   * どれも今までは、履歴に何も残らなかった。
   */
  { id: "system", label: "そのほか", sub: "取り込み・申請・画面のできごと", icon: "📣" },
  /*
   * エラーだけは、分類をまたいで集める。
   * 「何かおかしい」ときに最初に見る所なので、探し回らせない。
   */
  { id: "error", label: "エラー", sub: "うまくいかなかったこと（すべての分類から）", icon: "⚠" },
];

const ACTION_LABEL: Record<string, string> = {
  insert: "足した",
  update: "変えた",
  delete: "消した",
  event: "できごと",
  error: "エラー",
};

const ACTION_CLS: Record<string, string> = {
  insert: "bg-emerald-100 text-emerald-900",
  update: "bg-amber-100 text-amber-900",
  delete: "bg-red-100 text-red-900",
  event: "bg-slate-200 text-slate-800",
  error: "bg-red-600 text-white",
};

/** 確かめの文で使う改行 */
const BR = String.fromCharCode(10);

/** 2026-09-06T10:23:45+00:00 → 9月6日 19:23 */
function when(iso: string): string {
  const d = new Date(iso);
  const w = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日（${w}）${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

/**
 * その行が何だったのかを、一行で言う。
 *
 * 表ごとに「見れば分かる欄」が違う。
 * ぜんぶの列を並べても読めないので、名前になるものだけを拾う。
 */
function summarize(table: string, v: Record<string, unknown> | null): string {
  if (!v) return "";
  const s = (k: string) => (typeof v[k] === "string" ? (v[k] as string) : "");
  const n = (k: string) => (typeof v[k] === "number" ? String(v[k]) : "");
  switch (table) {
    case "rooms":
      return [s("building_code") ? `${s("building_code")}号館` : "", s("code"), s("name")]
        .filter(Boolean)
        .join(" ");
    case "departments":
      return [s("name"), s("code") ? `（${s("code")}）` : ""].join("");
    case "faculties":
      return s("name");
    case "courses":
      return [s("name"), s("class_name")].filter(Boolean).join(" ");
    case "timetable":
      return [s("on_date"), s("starts_at")?.slice(0, 5), s("title")].filter(Boolean).join(" ");
    case "menu_days":
      return [s("on_date"), s("name"), n("price") ? `${n("price")}円` : ""]
        .filter(Boolean)
        .join(" ");
    case "menu_presets":
      return [s("name"), n("price") ? `${n("price")}円` : ""].filter(Boolean).join(" ");
    case "counter_days":
      return [s("on_date"), s("state")].filter(Boolean).join(" ");
    case "cafeteria_items":
      return s("name");
    case "roster_students":
      return [s("student_no"), s("full_name")].filter(Boolean).join(" ");
    case "roster_staff":
      return [s("email"), s("full_name")].filter(Boolean).join(" ");
    case "profiles":
      return [s("email"), s("full_name"), s("role")].filter(Boolean).join(" ");
    default:
      return s("name") || s("title") || s("email") || "";
  }
}

/** 変わった欄だけを並べる。ぜんぶ出すと読めない */
function changed(
  b: Record<string, unknown> | null,
  a: Record<string, unknown> | null,
): { key: string; from: string; to: string }[] {
  if (!b || !a) return [];
  const out: { key: string; from: string; to: string }[] = [];
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
    // 時刻の欄は、変えるたびに動くので出さない（読む邪魔になる）
    if (k === "updated_at" || k === "created_at" || k === "teaching_at") continue;
    const x = JSON.stringify(b[k] ?? null);
    const y = JSON.stringify(a[k] ?? null);
    if (x !== y) out.push({ key: k, from: x, to: y });
  }
  return out;
}

export default function HistoryPage() {
  const T = useAdminT();
  const [role, setRole] = useState<Role | null>(null);
  const [loading, setLoading] = useState(true);

  /** どの分類を見ているか。null なら六つのボタンを出す */
  const [area, setArea] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  /** 中身を開いている履歴 */
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    if (!supabaseReady) return soon(() => setLoading(false));
    void (async () => {
      const supabase = createClient();
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) {
        setLoading(false);
        return;
      }
      const { data: me } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", u.user.id)
        .single();
      setRole((me?.role as Role) ?? null);
      setLoading(false);
    })();
  }, []);

  const load = useCallback(async (a: string) => {
    if (!supabaseReady) return;
    setBusy(true);
    setMsg(null);
    try {
      const { data, error } = await createClient().rpc("history_list", {
        p_area: a,
        p_limit: 300,
        p_offset: 0,
      });
      if (error) throw error;
      const got = (data as Row[]) ?? [];
      setRows(got);
      setTotal(got.length > 0 ? Number(got[0].total) : 0);
    } catch (e) {
      setRows([]);
      setTotal(0);
      setMsg({
        kind: "err",
        text:
          e instanceof Error
            ? `${e.message}（base/05_feedback_history.sql をまだ入れていない場合は、先に入れてください）`
            : String(e),
      });
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (area === null) return;
    return soon(() => load(area));
  }, [area, load]);

  /** 消したものを戻す */
  const restore = async (r: Row) => {
    const what = summarize(r.table_name, r.before) || r.row_id;
    if (
      !window.confirm(
        [
          `消したものを戻します。`,
          "",
          `  ${when(r.at)}  ${r.actor_mail || "（誰か分かりません）"}`,
          `  ${what}`,
          "",
          "消える前の中身を、そのまま入れ直します。",
          "同じ番号で戻るので、これを指していたものはまた繋がります。",
          "",
          "よろしいですか？",
        ].join(BR),
      )
    )
      return;

    setBusy(true);
    try {
      const { data, error } = await createClient().rpc("history_restore", { p_id: r.id });
      if (error) throw error;
      const v = data as { ok: boolean; reason: string };
      setMsg({ kind: v.ok ? "ok" : "err", text: v.ok ? `戻しました（${what}）` : v.reason });
      if (area) await load(area);
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  /** 履歴を消す。管理者だけ */
  const purge = async (ids: number[], label: string) => {
    if (
      !window.confirm(
        [
          `履歴を${label}消します。`,
          "",
          "履歴は、あとから「何が起きたか」を確かめるためのものです。",
          "消すと、そのぶんは二度と確かめられません。",
          "消したものを戻す道も、一緒に無くなります。",
          "",
          "続けますか？",
        ].join(BR),
      )
    )
      return;
    if (!window.confirm(`本当に消しますか？（${label}）${BR}${BR}これが最後の確認です。`)) return;

    setBusy(true);
    try {
      const { data, error } = await createClient().rpc("history_purge", {
        p_ids: ids.length > 0 ? ids : null,
        p_before: null,
      });
      if (error) throw error;
      setMsg({ kind: "ok", text: `${data ?? 0} 件の履歴を消しました。` });
      if (area) await load(area);
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Shell>{T("読み込み中…")}</Shell>;

  if (!canManageAll(role))
    return (
      <Shell>
        <p className="text-sm text-slate-700">{T("この画面は、いまの権限では使えません。")}</p>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
          {T("履歴を見られるのは、レベル2.1・2.2・管理者だけです。")}
        </p>
        <Link href="/login" className="mt-3 inline-block text-sm font-bold text-blue-600">
          {T("ログインへ")}
        </Link>
      </Shell>
    );

  /* 六つのボタン */
  if (area === null)
    return (
      <Shell wide>
        <AdminHeader title={T("履歴")} />
        <AdminMenu current="history" role={role} />

        <p className="mt-3 rounded-xl bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-600">
          {T("いつ・誰が・何を変えたかが残っています。")}
          <br />
          {T("消したものは、ここから戻せます。")}
          {role === "admin_l3" && T("履歴そのものを消せるのは、管理者だけです。")}
        </p>

        <div className="mt-3 grid gap-2">
          {AREAS.map((a) => (
            <button
              key={a.id}
              onClick={() => setArea(a.id)}
              className="flex items-center gap-3 rounded-xl bg-slate-100 px-4 py-3.5 text-left transition hover:bg-slate-200 active:scale-95"
            >
              <span className="text-lg">{a.icon}</span>
              <span className="min-w-0">
                <span className="block text-sm font-bold text-slate-900">{T(a.label)}</span>
                <span className="block text-[10px] text-slate-500">{T(a.sub)}</span>
              </span>
              <span className="ml-auto shrink-0 text-slate-400">›</span>
            </button>
          ))}
        </div>

        <Link
          href="/"
          className="mt-4 block rounded-xl bg-slate-100 px-4 py-3 text-center text-xs font-bold text-slate-700 transition hover:bg-slate-200"
        >
          {T("地図へ戻る")}
        </Link>
      </Shell>
    );

  const here = AREAS.find((a) => a.id === area);

  return (
    <Shell wide>
      <AdminHeader title={`${T("履歴")}｜${T(here?.label ?? "")}`} />
      <AdminMenu current="history" role={role} />

      <button
        onClick={() => {
          setArea(null);
          setOpen(null);
          setMsg(null);
        }}
        className="mb-3 inline-flex items-center gap-1 text-xs font-bold text-blue-600 hover:underline"
      >
        ← {T("ほかの履歴を見る")}
      </button>

      {msg && (
        <p
          className={`mb-3 rounded-xl p-3 text-xs leading-relaxed ${
            msg.kind === "ok" ? "bg-emerald-50 text-emerald-900" : "bg-red-50 text-red-800"
          }`}
        >
          {msg.text}
        </p>
      )}

      <div className="mb-2 flex items-center gap-2">
        <span className="text-[11px] font-bold text-slate-600">
          {busy ? T("読み込み中…") : `${total} ${T("件")}`}
        </span>
        {role === "admin_l3" && rows.length > 0 && (
          <button
            onClick={() => void purge(rows.map((r) => r.id), `${here?.label} の ${rows.length} 件を`)}
            disabled={busy}
            className="ml-auto rounded-lg bg-white px-2.5 py-1.5 text-[10px] font-bold text-red-600 shadow-sm transition hover:bg-red-50 active:scale-95 disabled:text-slate-300"
          >
            {T("この分類の履歴を消す")}
          </button>
        )}
      </div>

      <ul className="space-y-1.5">
        {rows.map((r) => {
          const opened = open === r.id;
          /*
           * できごと・エラーは label に一行が入っている。
           * 表の中身が変わっていないので、summarize では何も出せない。
           */
          const what =
            r.label && r.label !== ""
              ? r.label
              : summarize(r.table_name, r.before ?? r.after) || r.row_id;
          const diff = changed(r.before, r.after);
          return (
            <li
              key={r.id}
              className={`rounded-xl p-2.5 ring-1 ${
                r.action === "error"
                  ? "bg-red-50 ring-red-300"
                  : r.action === "delete"
                    ? "bg-red-50 ring-red-200"
                    : "bg-white ring-slate-200"
              }`}
            >
              <button
                onClick={() => setOpen(opened ? null : r.id)}
                className="flex w-full items-start gap-2 text-left"
              >
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold ${
                    ACTION_CLS[r.action] ?? "bg-slate-100 text-slate-700"
                  }`}
                >
                  {T(ACTION_LABEL[r.action] ?? r.action)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-bold text-slate-800">
                    {what || "（中身なし）"}
                  </span>
                  <span className="mt-0.5 block text-[10px] text-slate-500">
                    {when(r.at)}
                    <span className="ml-2">{r.actor_mail || "（誰か分かりません）"}</span>
                  </span>
                </span>
                {r.restored_at && (
                  <span className="shrink-0 rounded bg-emerald-100 px-1.5 py-0.5 text-[9px] font-bold text-emerald-800">
                    {T("戻しました")}
                  </span>
                )}
                <span className={`shrink-0 text-slate-400 transition ${opened ? "rotate-90" : ""}`}>
                  ›
                </span>
              </button>

              {opened && (
                <div className="mt-2 rounded-lg bg-slate-900 p-2.5 text-[10px] leading-relaxed text-slate-200">
                  <div className="text-slate-400">
                    {r.table_name || T("表なし")}
                    {r.row_id ? ` ／ ${T("番号")} ${r.row_id}` : ""}
                  </div>

                  {/*
                    そのままの中身。

                    読みやすく言い換えたものだけを残すと、原因が分からなくなる。
                    「うまくいきませんでした」では、どこを直せばよいか決まらない。
                    出た言葉を、そのまま出す。
                  */}
                  {r.detail && (
                    <div className="mt-1.5">
                      <div className="text-[9px] font-bold text-amber-300">
                        {T("出た言葉、そのまま")}
                      </div>
                      <pre className="mt-0.5 max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-[9px] text-slate-300">
                        {JSON.stringify(r.detail, null, 1)}
                      </pre>
                    </div>
                  )}

                  {r.action === "update" && diff.length > 0 && (
                    <ul className="mt-1.5 space-y-0.5">
                      {diff.map((d) => (
                        <li key={d.key} className="font-mono">
                          <span className="text-slate-400">{d.key}</span>{" "}
                          <span className="text-red-300">{d.from}</span>
                          <span className="text-slate-500"> → </span>
                          <span className="text-emerald-300">{d.to}</span>
                        </li>
                      ))}
                    </ul>
                  )}

                  {r.action === "delete" && r.before && (
                    <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[9px] text-slate-300">
                      {JSON.stringify(r.before, null, 1)}
                    </pre>
                  )}
                  {r.action === "insert" && r.after && (
                    <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[9px] text-slate-300">
                      {JSON.stringify(r.after, null, 1)}
                    </pre>
                  )}

                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {r.action === "delete" && !r.restored_at && (
                      <button
                        onClick={() => void restore(r)}
                        disabled={busy}
                        className="rounded-lg bg-emerald-600 px-2.5 py-1.5 text-[10px] font-bold text-white transition hover:bg-emerald-700 active:scale-95 disabled:bg-slate-600"
                      >
                        {T("これを戻す")}
                      </button>
                    )}
                    {role === "admin_l3" && (
                      <button
                        onClick={() => void purge([r.id], "この1件を")}
                        disabled={busy}
                        className="rounded-lg bg-slate-800 px-2.5 py-1.5 text-[10px] font-bold text-red-300 transition hover:bg-slate-700 active:scale-95"
                      >
                        {T("この履歴を消す")}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </li>
          );
        })}

        {!busy && rows.length === 0 && (
          <li className="rounded-xl bg-slate-50 p-6 text-center text-xs text-slate-500">
            {T("まだ何も残っていません。")}
          </li>
        )}
      </ul>
    </Shell>
  );
}

/**
 * 本文は地図のために overflow-hidden にしてある。
 * そのままだと管理画面が画面より高くなったときに送れないので、
 * この中で送れるようにする。
 */
function Shell({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <main className="h-[100dvh] overflow-y-auto bg-slate-100 p-4">
      <div
        className={`mx-auto w-full ${wide ? "max-w-2xl lg:max-w-5xl" : "max-w-sm sm:max-w-2xl lg:max-w-4xl"} rounded-2xl bg-white p-5 shadow-lg`}
      >
        {children}
      </div>
    </main>
  );
}
