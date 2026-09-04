"use client";

/**
 * 使っている人から届いた感想。
 *
 * ■ 二つに分けてある
 *   新規 … まだ読んでいないもの。押すと既読へ移る
 *   既読 … 読んだもの。ここでだけ、消したり、書いた人を出したりできる
 *
 *   一覧が一つだと、読んだものと読んでいないものが混ざり、
 *   どこまで見たか分からなくなる。押して既読へ移す形にすると、
 *   「新規が空になったら見終わり」という分かりやすい終わりができる。
 *
 * ■ 名前は、ふだんは出ない
 *   並んでいるのは本文と星と日付だけ。誰が書いたかは、
 *   別の場所（feedback_author）にしまってあり、画面の鍵では読めない。
 *   出るのは「良くないコメント」を押した一件だけで、
 *   押したことも、押した人も、記録に残る。
 *
 *   ログインせずに送られたものは、はじめから何も残っていないので、
 *   押しても誰かは分からない。
 *
 * ■ 読めるのは
 *   教授（レベル2）・副管理者（2.1・2.2）・いちばん上だけ。
 *   消せるのは副管理者と管理者だけ（教授は消せない）。
 *   画面での出し分けは親切であって、守っているのは RLS と
 *   データベース側の関数。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient, supabaseReady } from "@/lib/supabase/client";
import { AdminHeader, AdminMenu } from "@/components/AdminNav";
import { useAdminT } from "@/lib/adminLang";
import { canManageAll, canReadFeedback, type Role } from "@/lib/auth";

type Row = {
  id: number;
  body: string;
  rating: number | null;
  lang: string;
  created_at: string;
  handled: boolean;
  reported: boolean;
};

/** 「良くないコメント」を押して返ってきたもの */
type Who =
  | { known: true; email: string; name: string; user_id: string | null }
  | { known: false; why: string };

/** 確認の文を組み立てるときの改行。書き換えの途中で消えないよう、変数にしてある */
const BR = String.fromCharCode(10);

/** "2026-09-02T05:40:06Z" → "9月2日 14:40" */
function when(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

export default function FeedbackPage() {
  const T = useAdminT();
  const [role, setRole] = useState<Role | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  // 送り先が無いときは読み込むものも無い。最初から読み終わった扱いにする
  const [loading, setLoading] = useState(supabaseReady);
  const [msg, setMsg] = useState<string | null>(null);

  /** どちらの欄を見ているか */
  const [tab, setTab] = useState<"new" | "read">("new");

  /** まとめて消すために選んだもの。既読の欄でだけ使う */
  const [picked, setPicked] = useState<Set<number>>(new Set());

  /** 「良くないコメント」で出した人。押した一件ぶんだけ持つ */
  const [who, setWho] = useState<Record<number, Who>>({});

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
      /*
       * reported の列は 05_feedback.sql で足したもの。
       *
       * ★列を一つ並べただけで、届いた感想が全部消える
       *
       *   PostgREST は、知らない列が一つでもあると問い合わせ全部を断る。
       *   画面は data が空になり、感想は届いているのに
       *   「一件もありません」と出る。実際にそうなっていた
       *   （データベースには5件あったのに、画面には出ていなかった）。
       *
       *   感想が読めることのほうが大事なので、断られたら
       *   足したぶんの列を外して、もう一度訊く。
       */
      const base = "id, body, rating, lang, created_at, handled";
      const read = async (cols: string) =>
        supabase
          .from("feedback")
          .select(cols)
          .order("created_at", { ascending: false })
          .limit(500);

      let got = await read(`${base}, reported`);
      if (got.error) {
        got = await read(base);
        if (got.error) setMsg(got.error.message);
        else
          setMsg(
            "「良くないコメント」の欄はまだ使えません（base/05_feedback.sql を入れると使えます）。感想はそのまま読めます。",
          );
      }
      setRows((got.data as unknown as Row[]) ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const fresh = useMemo(() => rows.filter((r) => !r.handled), [rows]);
  const read = useMemo(() => rows.filter((r) => r.handled), [rows]);
  const shown = tab === "new" ? fresh : read;

  /** 平均の星。付けずに文章だけの人は数に入れない */
  const average = useMemo(() => {
    const withStar = rows.filter((r) => r.rating !== null);
    if (withStar.length === 0) return null;
    const sum = withStar.reduce((a, r) => a + (r.rating ?? 0), 0);
    return { value: sum / withStar.length, n: withStar.length };
  }, [rows]);

  /** 星ごとの数。平均だけだと、割れているのか揃っているのか分からない */
  const spread = useMemo(() => {
    const c = [0, 0, 0, 0, 0];
    for (const r of rows) if (r.rating) c[r.rating - 1] += 1;
    return c;
  }, [rows]);

  const canDelete = canManageAll(role);

  /* ---------------- 読んだ印 ---------------- */

  /**
   * 読んだ印を付け替える。画面はすぐ変え、失敗したら戻す。
   *
   * 新規の欄で押すと、その場から消えて既読へ移る。
   * 待ってから消すと、押したのに何も起きない時間ができる。
   */
  const mark = async (id: number, handled: boolean) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, handled } : r)));
    const { error } = await createClient().from("feedback").update({ handled }).eq("id", id);
    if (error) {
      setMsg(error.message);
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, handled: !handled } : r)));
    }
  };

  /** 新規をまとめて既読にする。数が多いときに一つずつ押させない */
  const markAll = async () => {
    if (fresh.length === 0) return;
    if (!window.confirm(`新規 ${fresh.length} 件を、まとめて既読にします。よろしいですか？`)) return;
    const ids = fresh.map((r) => r.id);
    setRows((prev) => prev.map((r) => (ids.includes(r.id) ? { ...r, handled: true } : r)));
    const { error } = await createClient().from("feedback").update({ handled: true }).in("id", ids);
    if (error) {
      setMsg(error.message);
      await load();
    } else {
      setTab("read");
    }
  };

  /* ---------------- 消す ---------------- */

  const remove = async (id: number) => {
    if (!window.confirm("この感想を消します。元には戻せません。よろしいですか？")) return;
    const { error } = await createClient().from("feedback").delete().eq("id", id);
    if (error) setMsg(error.message);
    else {
      setRows((prev) => prev.filter((r) => r.id !== id));
      setPicked((p) => {
        const n = new Set(p);
        n.delete(id);
        return n;
      });
    }
  };

  /**
   * 選んだものをまとめて消す。
   *
   * 一件ずつの delete を並べるのではなく、まとめて渡す関数を使う。
   * 途中で切れたときに「どこまで消えたか」が分からなくなるため。
   */
  const removePicked = async () => {
    const ids = [...picked];
    if (ids.length === 0) return;
    if (
      !window.confirm(
        [
          `選んだ ${ids.length} 件を消します。`,
          "",
          "元には戻せません。よろしいですか？",
        ].join(BR),
      )
    )
      return;

    const { data, error } = await createClient().rpc("feedback_purge", { p_ids: ids });
    if (error) {
      setMsg(`${error.message}（base/05_feedback.sql をまだ入れていない場合は、先に入れてください）`);
      return;
    }
    setRows((prev) => prev.filter((r) => !picked.has(r.id)));
    setPicked(new Set());
    setMsg(`${data as number} 件を消しました。`);
  };

  /** 既読をぜんぶ消す。二度たずねる */
  const removeAllRead = async () => {
    if (read.length === 0) return;
    if (!window.confirm(`既読 ${read.length} 件を、ぜんぶ消します。よろしいですか？`)) return;
    if (
      !window.confirm(
        [
          `本当に ${read.length} 件を消しますか？`,
          "",
          "これが最後の確認です。元には戻せません。",
        ].join(BR),
      )
    )
      return;

    const ids = read.map((r) => r.id);
    const { data, error } = await createClient().rpc("feedback_purge", { p_ids: ids });
    if (error) {
      setMsg(`${error.message}（base/05_feedback.sql をまだ入れていない場合は、先に入れてください）`);
      return;
    }
    setRows((prev) => prev.filter((r) => !r.handled));
    setPicked(new Set());
    setMsg(`${data as number} 件を消しました。`);
  };

  /* ---------------- 良くないコメント ---------------- */

  /**
   * 書いた人を出す。
   *
   * ふだんは名前を出さない作りなので、これは例外にあたる操作。
   * 押す前に、何が起きるかをはっきり書いて一度たずねる。
   * 押したことも、押した人も、データベースに残る。
   */
  const reveal = async (id: number) => {
    if (
      !window.confirm(
        [
          "この感想を「良くないコメント」として、書いた人を出します。",
          "",
          "・出せるのは、ログインしてこの画面を開いている人だけです",
          "・押したことと、押したのが誰かは記録に残ります",
          "・ログインせずに送られたものは、誰かは分かりません",
          "",
          "続けますか？",
        ].join(BR),
      )
    )
      return;

    const { data, error } = await createClient().rpc("report_feedback", { p_id: id });
    if (error) {
      setMsg(`${error.message}（base/05_feedback.sql をまだ入れていない場合は、先に入れてください）`);
      return;
    }
    setWho((w) => ({ ...w, [id]: data as Who }));
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, reported: true } : r)));
  };

  /* ---------------- 表示 ---------------- */

  if (loading) return <Shell>{T("読み込み中…")}</Shell>;

  if (!canReadFeedback(role))
    return (
      <Shell>
        <p className="text-sm text-slate-700">{T("この画面は、いまの権限では使えません。")}</p>
        <Link href="/login" className="mt-3 inline-block text-sm font-bold text-blue-600">
          {T("ログインへ")}
        </Link>
      </Shell>
    );

  return (
    <Shell wide>
      <AdminHeader title={T("みんなの感想")} />
      <AdminMenu current="feedback" role={role} />

      {msg && (
        <p className="mb-3 rounded-xl bg-slate-100 p-3 text-xs leading-relaxed text-slate-800">
          {msg}
        </p>
      )}

      {/* 数と、星の平均 */}
      <div className="rounded-xl bg-slate-50 p-3">
        <div className="flex flex-wrap items-center gap-3 text-[11px] font-bold text-slate-700">
          <span>ぜんぶで {rows.length} 件</span>
          <span className={fresh.length > 0 ? "text-blue-700" : "text-slate-400"}>
            新規 {fresh.length} 件
          </span>
          <span className="text-slate-500">既読 {read.length} 件</span>
        </div>

        {average ? (
          <div className="mt-2 rounded-lg bg-white p-2.5">
            <div className="flex items-baseline gap-2">
              <span className="text-lg font-bold text-amber-600">{average.value.toFixed(2)}</span>
              <span className="text-xs text-amber-500">
                {"★".repeat(Math.round(average.value))}
                <span className="text-slate-300">{"★".repeat(5 - Math.round(average.value))}</span>
              </span>
              <span className="text-[10px] text-slate-500">
                星を付けた {average.n} 件の平均
              </span>
            </div>

            {/* 星ごとの数。平均だけだと、割れているのか揃っているのか分からない */}
            <div className="mt-1.5 flex flex-col gap-0.5">
              {[5, 4, 3, 2, 1].map((n) => {
                const c = spread[n - 1];
                const pct = average.n > 0 ? (c / average.n) * 100 : 0;
                return (
                  <div key={n} className="flex items-center gap-1.5">
                    <span className="w-6 shrink-0 text-right text-[10px] text-slate-500">{n}★</span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                      <div className="h-full rounded-full bg-amber-400" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="w-6 shrink-0 text-[10px] text-slate-500">{c}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <p className="mt-2 text-[10px] text-slate-500">{T("まだ星が付いた感想はありません。")}</p>
        )}

        <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
          誰が書いたかは、ふだんは<b>{T("出しません")}</b>。
          {T("目にあまるものだけ、既読の欄の「良くないコメント」から確かめられます。")}
          {T("押したことと、押したのが誰かは記録に残ります。")}
        </p>
      </div>

      {/* 新規 / 既読 */}
      <div className="mt-3 flex gap-1.5">
        <button
          onClick={() => setTab("new")}
          className={`flex-1 rounded-xl px-3 py-2 text-xs font-bold transition active:scale-95 ${
            tab === "new" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"
          }`}
        >
          新規（{fresh.length}）
        </button>
        <button
          onClick={() => setTab("read")}
          className={`flex-1 rounded-xl px-3 py-2 text-xs font-bold transition active:scale-95 ${
            tab === "read" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"
          }`}
        >
          既読（{read.length}）
        </button>
      </div>

      {/* その欄でできること */}
      {tab === "new" ? (
        <div className="mt-2 flex items-center gap-2">
          <p className="flex-1 text-[10px] leading-relaxed text-slate-500">
            {T("感想を押すと、既読へ移ります。")}
          </p>
          {fresh.length > 0 && (
            <button
              onClick={() => void markAll()}
              className="shrink-0 rounded-lg bg-slate-100 px-2.5 py-1 text-[10px] font-bold text-slate-600 transition hover:bg-slate-200 active:scale-95"
            >
              {T("ぜんぶ既読にする")}
            </button>
          )}
        </div>
      ) : (
        canDelete &&
        read.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <p className="flex-1 text-[10px] leading-relaxed text-slate-500">
              {T("左の丸を押して選ぶと、まとめて消せます。")}
            </p>
            <button
              onClick={() =>
                setPicked((p) =>
                  p.size === read.length ? new Set() : new Set(read.map((r) => r.id)),
                )
              }
              className="shrink-0 rounded-lg bg-slate-100 px-2.5 py-1 text-[10px] font-bold text-slate-600 transition hover:bg-slate-200 active:scale-95"
            >
              {picked.size === read.length ? "選ぶのをやめる" : "ぜんぶ選ぶ"}
            </button>
            <button
              onClick={() => void removePicked()}
              disabled={picked.size === 0}
              className="shrink-0 rounded-lg bg-red-50 px-2.5 py-1 text-[10px] font-bold text-red-700 transition hover:bg-red-100 active:scale-95 disabled:bg-slate-100 disabled:text-slate-400"
            >
              選んだ {picked.size} 件を消す
            </button>
            <button
              onClick={() => void removeAllRead()}
              className="shrink-0 rounded-lg px-2 py-1 text-[10px] font-bold text-red-600 transition hover:bg-red-50 active:scale-95"
            >
              {T("既読をぜんぶ消す")}
            </button>
          </div>
        )
      )}

      <ul className="mt-3 flex flex-col gap-2">
        {shown.map((r) => {
          const found = who[r.id];
          const chosen = picked.has(r.id);
          return (
            <li
              key={r.id}
              className={`rounded-xl p-3 ring-1 transition ${
                tab === "new"
                  ? "cursor-pointer bg-blue-50/60 ring-blue-200 hover:bg-blue-100/60 active:scale-[0.99]"
                  : chosen
                    ? "bg-red-50/60 ring-red-200"
                    : "bg-white ring-slate-200"
              }`}
              /*
               * 新規の欄では、どこを押しても既読へ移す。
               * 小さなボタンを狙わせない。この欄には他に押すものが無いので、
               * 取り違えようがない。
               */
              onClick={tab === "new" ? () => void mark(r.id, true) : undefined}
            >
              <div className="flex items-center gap-2">
                {tab === "read" && canDelete && (
                  <button
                    onClick={() =>
                      setPicked((p) => {
                        const n = new Set(p);
                        if (n.has(r.id)) n.delete(r.id);
                        else n.add(r.id);
                        return n;
                      })
                    }
                    aria-label={chosen ? "選ぶのをやめる" : "選ぶ"}
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold transition active:scale-90 ${
                      chosen ? "bg-red-600 text-white" : "bg-slate-200 text-transparent"
                    }`}
                  >
                    ✓
                  </button>
                )}
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
                {r.reported && (
                  <span className="rounded-full bg-red-100 px-1.5 py-0.5 text-[9px] font-bold text-red-700">
                    {T("良くないコメント")}
                  </span>
                )}
                {tab === "new" && (
                  <span className="ml-auto shrink-0 text-[10px] font-bold text-blue-700">
                    {T("押すと既読 →")}
                  </span>
                )}
              </div>

              {/* 書かれたままの改行を残す。読みやすさが変わる */}
              <p className="mt-1.5 whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-800">
                {r.body}
              </p>

              {/* 出した名前。押した一件ぶんだけ、この場に出す */}
              {found && (
                <div className="mt-2 rounded-lg bg-slate-900 p-2.5 text-[11px] leading-relaxed text-white">
                  {found.known ? (
                    <>
                      <div className="text-[9px] font-bold text-slate-400">{T("これを書いた人")}</div>
                      <div className="mt-0.5 font-bold">{found.name || "（名前なし）"}</div>
                      <div className="break-all font-mono text-[10px] text-slate-300">
                        {found.email}
                      </div>
                    </>
                  ) : (
                    <div className="text-slate-300">{found.why}</div>
                  )}
                </div>
              )}

              {tab === "read" && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <button
                    onClick={() => void mark(r.id, false)}
                    className="rounded-lg bg-slate-100 px-2.5 py-1 text-[10px] font-bold text-slate-600 transition hover:bg-slate-200 active:scale-95"
                  >
                    {T("新規に戻す")}
                  </button>
                  <button
                    onClick={() => void reveal(r.id)}
                    className="rounded-lg bg-amber-50 px-2.5 py-1 text-[10px] font-bold text-amber-800 transition hover:bg-amber-100 active:scale-95"
                  >
                    {found ? "もう一度たしかめる" : "良くないコメント"}
                  </button>
                  {canDelete && (
                    <button
                      onClick={() => void remove(r.id)}
                      className="ml-auto rounded-lg px-2 py-1 text-[10px] font-bold text-red-600 transition hover:bg-red-50 active:scale-95"
                    >
                      {T("消す")}
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}

        {shown.length === 0 && (
          <li className="rounded-xl bg-slate-50 p-6 text-center text-xs text-slate-500">
            {tab === "new"
              ? rows.length === 0
                ? "まだ届いていません。"
                : "新規はありません。ぜんぶ読み終えています。"
              : "既読はまだありません。"}
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
