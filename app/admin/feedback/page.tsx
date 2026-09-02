"use client";

/**
 * 使っている人から届いた感想。
 *
 * ■ 誰が書いたかは分からない
 *   受け取るときに名前もアカウントも取っていない。
 *   ここで見えるのは、本文と星の数と届いた日だけ。
 *   気になる声があっても、本人に確かめる道は無い。
 *   そのぶん、思ったことをそのまま書いてもらえる。
 *
 * ■ 読めるのは
 *   教授（レベル2）・副管理者（2.1・2.2）・いちばん上だけ。
 *   画面での出し分けは親切であって、守っているのは RLS。
 *   権限の無い人が直接この住所を開いても、空が返る。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient, supabaseReady } from "@/lib/supabase/client";
import { AdminHeader, AdminMenu } from "@/components/AdminNav";
import { canManage, canReadFeedback, type Role } from "@/lib/auth";

type Row = {
  id: number;
  body: string;
  rating: number | null;
  lang: string;
  created_at: string;
  handled: boolean;
};

/** "2026-09-02T05:40:06Z" → "9月2日 14:40" */
function when(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

export default function FeedbackPage() {
  const [role, setRole] = useState<Role | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  // 送り先が無いときは読み込むものも無い。最初から読み終わった扱いにする
  const [loading, setLoading] = useState(supabaseReady);
  const [msg, setMsg] = useState<string | null>(null);
  /** 未読だけに絞るか */
  const [onlyNew, setOnlyNew] = useState(false);

  const load = useCallback(async () => {
    if (!supabaseReady) return;
    const supabase = createClient();
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) {
      setRole(null);
      setLoading(false);
      return;
    }
    const { data: me } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", u.user.id)
      .single();
    const r = (me?.role as Role) ?? null;
    setRole(r);

    if (canReadFeedback(r)) {
      const { data, error } = await supabase
        .from("feedback")
        .select("id, body, rating, lang, created_at, handled")
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) setMsg(error.message);
      setRows((data as Row[]) ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(
    () => (onlyNew ? rows.filter((r) => !r.handled) : rows),
    [rows, onlyNew],
  );

  const unread = useMemo(() => rows.filter((r) => !r.handled).length, [rows]);

  /** 平均の星。付けずに文章だけの人は数に入れない */
  const average = useMemo(() => {
    const withStar = rows.filter((r) => r.rating !== null);
    if (withStar.length === 0) return null;
    const sum = withStar.reduce((a, r) => a + (r.rating ?? 0), 0);
    return { value: sum / withStar.length, n: withStar.length };
  }, [rows]);

  /* 読んだ印を付け替える。画面はすぐ変え、失敗したら戻す */
  const mark = async (id: number, handled: boolean) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, handled } : r)));
    const { error } = await createClient().from("feedback").update({ handled }).eq("id", id);
    if (error) {
      setMsg(error.message);
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, handled: !handled } : r)));
    }
  };

  /* 消せるのは承認の権限を持つ人だけ。RLS でもそう決めてある */
  const remove = async (id: number) => {
    if (!window.confirm("この感想を消します。元には戻せません。よろしいですか？")) return;
    const { error } = await createClient().from("feedback").delete().eq("id", id);
    if (error) setMsg(error.message);
    else setRows((prev) => prev.filter((r) => r.id !== id));
  };

  if (loading) return <Shell>読み込み中…</Shell>;

  if (!canReadFeedback(role))
    return (
      <Shell>
        <p className="text-sm text-slate-700">この画面は、いまの権限では使えません。</p>
        <Link href="/login" className="mt-3 inline-block text-sm font-bold text-blue-600">
          ログインへ
        </Link>
      </Shell>
    );

  return (
    <Shell wide>
      <AdminHeader title="みんなの感想" />
      <AdminMenu current="feedback" role={role} />

      {msg && <p className="mb-3 rounded-xl bg-red-50 p-3 text-xs text-red-800">{msg}</p>}

      <div className="rounded-xl bg-slate-50 p-3">
        <p className="text-[11px] leading-relaxed text-slate-600">
          誰が書いたかは<b>記録していません</b>。名前もアカウントも受け取っていないので、
          本人に確かめることはできません。そのぶん、思ったことをそのまま
          書いてもらえるようにしてあります。
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] font-bold text-slate-700">
          <span>ぜんぶで {rows.length} 件</span>
          <span className={unread > 0 ? "text-blue-700" : "text-slate-400"}>
            未読 {unread} 件
          </span>
          {average && (
            <span className="text-amber-700">
              星の平均 {average.value.toFixed(1)}（{average.n} 件）
            </span>
          )}
        </div>
      </div>

      <div className="mt-3 flex gap-1.5">
        <button
          onClick={() => setOnlyNew(false)}
          className={`flex-1 rounded-xl px-3 py-2 text-xs font-bold transition active:scale-95 ${
            !onlyNew ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"
          }`}
        >
          すべて
        </button>
        <button
          onClick={() => setOnlyNew(true)}
          className={`flex-1 rounded-xl px-3 py-2 text-xs font-bold transition active:scale-95 ${
            onlyNew ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"
          }`}
        >
          未読だけ（{unread}）
        </button>
      </div>

      <ul className="mt-3 flex flex-col gap-2">
        {shown.map((r) => (
          <li
            key={r.id}
            className={`rounded-xl p-3 ring-1 ${
              r.handled ? "bg-white ring-slate-200" : "bg-blue-50/60 ring-blue-200"
            }`}
          >
            <div className="flex items-center gap-2">
              {r.rating !== null && (
                <span className="shrink-0 text-xs text-amber-500">
                  {"★".repeat(r.rating)}
                  <span className="text-slate-300">{"★".repeat(5 - r.rating)}</span>
                </span>
              )}
              <span className="text-[10px] text-slate-500">{when(r.created_at)}</span>
              {r.lang === "en" && (
                <span className="rounded-full bg-slate-200 px-1.5 py-0.5 text-[9px] font-bold text-slate-600">
                  EN
                </span>
              )}
              {!r.handled && (
                <span className="rounded-full bg-blue-600 px-1.5 py-0.5 text-[9px] font-bold text-white">
                  未読
                </span>
              )}
            </div>

            {/* 書かれたままの改行を残す。読みやすさが変わる */}
            <p className="mt-1.5 whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-800">
              {r.body}
            </p>

            <div className="mt-2 flex items-center gap-1.5">
              <button
                onClick={() => void mark(r.id, !r.handled)}
                className="rounded-lg bg-slate-100 px-2.5 py-1 text-[10px] font-bold text-slate-600 transition hover:bg-slate-200 active:scale-95"
              >
                {r.handled ? "未読に戻す" : "読んだ"}
              </button>
              {canManage(role) && (
                <button
                  onClick={() => void remove(r.id)}
                  className="ml-auto rounded-lg px-2 py-1 text-[10px] font-bold text-red-600 transition hover:bg-red-50 active:scale-95"
                >
                  消す
                </button>
              )}
            </div>
          </li>
        ))}
        {shown.length === 0 && (
          <li className="rounded-xl bg-slate-50 p-6 text-center text-xs text-slate-500">
            {rows.length === 0 ? "まだ届いていません。" : "未読はありません。"}
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
        className={`mx-auto ${wide ? "max-w-2xl" : "max-w-sm"} rounded-2xl bg-white p-5 shadow-lg`}
      >
        {children}
      </div>
    </main>
  );
}
