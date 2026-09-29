"use client";

/**
 * kit-agent の稼働状況。
 *
 * ■ 何のためか
 *   kit-agent は、申請が来たその場で判断している。
 *   ところが、うまく動いているのかを見る場所が無かった。
 *
 *     ・申請が溜まっているが、agent は見ているのか
 *     ・はじかれた人は、なぜはじかれたのか
 *     ・そもそも動いているのか、止まっているのか
 *
 *   分からないと、人が全部を手で確かめることになる。
 *
 * ■ 「稼働している」とは
 *   kit-agent の本体は、データベースの中の関数。常に立っている
 *   番組ではないので、「起動している／していない」では言い表せない。
 *   代わりに、最近の働きぶりで言う。
 *
 *     働いている   … いま見ている最中か、直近1時間に何かをさばいた
 *     待っている   … さばくものが無い（申請が溜まっていない）
 *     詰まっている … 申請が溜まっているのに、しばらく何もしていない
 *
 *   ★「詰まっている」を出せることが大事
 *     待っているのと詰まっているのは、見た目が同じ。
 *     溜まっているかどうかを一緒に見て、はじめて分かる。
 *
 * ■ 誰が見られるか
 *   レベル2.1・2.2・管理者。ログにはアドレスが並ぶ。
 *
 * ■ 絞りこみ
 *   「通した／はじいた」だけでは、見たいところに届かない。
 *   実際に見たいのは、たいてい人のかたまりのほうである。
 *     ・1年のCCで、はじかれた人は何人か
 *     ・教授の申請は、ちゃんと通っているか
 *   学年・学科（CC・KM …）・クラス（組）・身分、それに名前や
 *   アドレスの言葉で絞れるようにしてある。
 *
 *   ★ 選び手に並ぶのは、履歴に出てくるものだけ
 *     1〜4年をいつも並べると、居ない学年を押して空振りする。
 *     いま履歴にある学年・学科だけを並べる（agent_log_choices）。
 *
 *   ★ 絞りこみは「いまの名簿の値」で当たる
 *     履歴の行に、そのときの学年は残っていない。あとから学年を
 *     直した人は、直したあとの値で出る。席が消えた人は、学年が
 *     分からないので絞ると出てこない（アドレスでは探せる）。
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient, supabaseReady } from "@/lib/supabase/client";
import { AdminHeader, AdminMenu } from "@/components/AdminNav";
import { useAdminT } from "@/lib/adminLang";
import { canManageAll, type Role } from "@/lib/auth";

type Status = {
  state: "working" | "idle" | "stuck";
  waiting: number;
  claimed: number;
  last_at: string | null;
  in_hour: number;
  in_day: number;
  approved: number;
  reset: number;
  skipped: number;
};

type LogRow = {
  id: number;
  email: string;
  full_name: string;
  decision: "approved" | "reset" | "skipped";
  role_given: string;
  reason: string;
  worker: string;
  created_at: string;
  /* ここから下は 34 を入れてから返ってくる。無いこともある */
  grade?: number;
  class_code?: string;
  class_no?: number;
  affiliation?: string;
  total: number;
};

/** 何で絞っているか */
type Filter = {
  kind: string;
  grade: number;
  code: string;
  no: number;
  aff: string;
  q: string;
};

const NONE: Filter = { kind: "", grade: 0, code: "", no: 0, aff: "", q: "" };

/** 選び手に並べるもの。履歴に出てくるものだけ */
type Choices = {
  grades: number[];
  class_codes: string[];
  class_nos: number[];
  affs: string[];
};

/** 身分の言い方。profiles.affiliation は自己申告で、権限とは別のもの */
const AFF: Record<string, string> = {
  student: "学生",
  teacher: "教授",
  other: "その他",
};

/** どうしたか。言葉と色をここにまとめる */
const DECISION: Record<string, { label: string; cls: string; mark: string }> = {
  approved: { label: "通した", cls: "bg-emerald-500", mark: "✓" },
  reset: { label: "はじいた", cls: "bg-red-500", mark: "✕" },
  skipped: { label: "人に回した", cls: "bg-amber-500", mark: "→" },
};

/** 2026-09-08T01:23:45 → 9月8日 10:23:45 */
function when(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}:${p(
    d.getSeconds(),
  )}`;
}

export default function AgentPage() {
  const T = useAdminT();
  const [role, setRole] = useState<Role | null>(null);
  const [ready, setReady] = useState(false);
  const [st, setSt] = useState<Status | null>(null);
  const [rows, setRows] = useState<LogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [f, setF] = useState<Filter>(NONE);
  const [choices, setChoices] = useState<Choices | null>(null);
  /** 34 がまだ入っていない（絞りこみが使えない） */
  const [noFind, setNoFind] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  /** 一つだけ替える */
  const set = <K extends keyof Filter>(k: K, v: Filter[K]) => setF((p) => ({ ...p, [k]: v }));
  /** 何かで絞っているか */
  const filtering = f.grade > 0 || f.code !== "" || f.no > 0 || f.aff !== "" || f.q !== "";

  useEffect(() => {
    if (!supabaseReady) {
      setReady(true);
      return;
    }
    void (async () => {
      const supabase = createClient();
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) {
        setReady(true);
        return;
      }
      const { data } = await supabase.from("profiles").select("role").eq("id", u.user.id).single();
      setRole(((data as { role?: Role } | null)?.role ?? null) as Role | null);
      setReady(true);
    })();
  }, []);

  const load = useCallback(async (v: Filter) => {
    if (!supabaseReady) return;
    const supabase = createClient();
    try {
      const a = await supabase.rpc("agent_status");
      if (a.error) throw a.error;
      setSt(a.data as Status);

      let b = await supabase.rpc("agent_log", {
        p_limit: 200,
        p_offset: 0,
        p_kind: v.kind,
        p_grade: v.grade,
        p_class_code: v.code,
        p_class_no: v.no,
        p_aff: v.aff,
        p_q: v.q,
      });
      /*
       * 34 をまだ入れていないときは、引数の数が合わず PGRST202 になる。
       * ログ自体は 27 だけで出せるので、古い呼び方でやり直す。
       * 絞りこみの欄は出さず、何をすれば使えるかだけを出す。
       */
      if (b.error && (b.error as { code?: string }).code === "PGRST202") {
        setNoFind(true);
        b = await supabase.rpc("agent_log", { p_limit: 200, p_offset: 0, p_kind: v.kind });
      }
      if (b.error) throw b.error;
      const got = (b.data as LogRow[]) ?? [];
      setRows(got);
      setTotal(got.length > 0 ? Number(got[0].total) : 0);
      setMsg(null);
    } catch (e) {
      setMsg(
        e instanceof Error
          ? `${e.message}（base/27_agent_status.sql をまだ入れていない場合は、先に入れてください）`
          : String(e),
      );
    }
  }, []);

  /**
   * 選び手に並べるものを、一度だけ読む。
   *
   * 履歴が増えれば増えるが、開いている間に学年が増えることは無い。
   * 20秒ごとに数え直しても意味がないので、開いたときだけにする。
   */
  useEffect(() => {
    if (!supabaseReady || !canManageAll(role)) return;
    void createClient()
      .rpc("agent_log_choices")
      .then(({ data, error }) => {
        if (error || !data) return; // 34 がまだ。既定の並びで出す
        setChoices(data as Choices);
      });
  }, [role]);

  useEffect(() => {
    if (!canManageAll(role)) return;
    const now: Filter = { kind: f.kind, grade: f.grade, code: f.code, no: f.no, aff: f.aff, q: f.q };
    /*
     * 言葉は打っている途中に毎文字呼ばない。少し待ってから一度だけ。
     * 選び手を押したときは、待たずにすぐ読む。
     */
    const first = window.setTimeout(() => void load(now), now.q === "" ? 0 : 350);
    /*
     * 20秒ごとに見直す。
     *
     * 「いま働いているか」を見る画面なので、開いたときの一枚では足りない。
     * 短くしすぎると、見ているだけでデータベースを叩き続けることになる。
     */
    const id = window.setInterval(() => void load(now), 20_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [role, f.kind, f.grade, f.code, f.no, f.aff, f.q, load]);

  if (!ready) return null;

  if (!canManageAll(role)) {
    return (
      <Shell>
        <AdminHeader title={T("kit-agent の様子")} />
        <p className="rounded-xl bg-slate-100 p-4 text-sm text-slate-600">
          {T("この画面は、いまの権限では使えません。")}
          <br />
          {T("kit-agent の様子を見られるのは、レベル2.1・2.2・管理者だけです。")}
        </p>
        <Link
          href="/login"
          className="mt-3 block rounded-xl bg-slate-900 px-4 py-3 text-center text-xs font-bold text-white"
        >
          {T("ログインへ")}
        </Link>
      </Shell>
    );
  }

  const state = st?.state ?? "idle";
  const badge =
    state === "working"
      ? { text: "働いています", cls: "bg-emerald-500" }
      : state === "stuck"
        ? { text: "詰まっています", cls: "bg-red-500" }
        : { text: "待っています", cls: "bg-slate-400" };

  return (
    <Shell>
      <AdminHeader title={T("kit-agent の様子")} />
      <AdminMenu current="agent" role={role} />

      {msg && (
        <p className="mb-3 rounded-xl bg-red-50 p-3 text-xs leading-relaxed text-red-800">{msg}</p>
      )}

      {/*
        上に kit-agent、その下にログ。

        絵を出しているのは飾りではない。この画面は「誰が承認したのか」を
        確かめる所で、承認しているのが人ではないことが、ひと目で分かる
        ようにしておきたい。
      */}
      <div className="overflow-hidden rounded-2xl bg-slate-900">
        <div className="relative">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/img/kit-agent.jpg"
            alt="kit-agent"
            className="h-40 w-full object-cover object-right sm:h-52"
          />
          <div className="absolute left-3 top-3 flex items-center gap-2">
            <span className={`flex items-center gap-1.5 rounded-full ${badge.cls} px-3 py-1.5`}>
              <span
                className={`h-2 w-2 rounded-full bg-white ${
                  state === "working" ? "animate-pulse" : ""
                }`}
              />
              <span className="text-[11px] font-bold text-white">{T(badge.text)}</span>
            </span>
          </div>
        </div>

        {/* 数字。いま何を抱えていて、どれだけさばいたか */}
        <div className="grid grid-cols-2 gap-px bg-slate-800 sm:grid-cols-4">
          {[
            { label: "待っている人", v: st?.waiting ?? 0, hot: (st?.waiting ?? 0) > 0 },
            { label: "見ている最中", v: st?.claimed ?? 0, hot: false },
            { label: "この1時間", v: st?.in_hour ?? 0, hot: false },
            { label: "きょう", v: st?.in_day ?? 0, hot: false },
          ].map((x) => (
            <div key={x.label} className="bg-slate-900 px-3 py-2.5">
              <div className="text-[10px] text-slate-400">{T(x.label)}</div>
              <div
                className={`text-lg font-bold ${
                  x.hot && state === "stuck" ? "text-red-400" : "text-white"
                }`}
              >
                {x.v}
              </div>
            </div>
          ))}
        </div>

        {/*
          さばいた数の並びは外した。

          下に「ぜんぶ／通した／はじいた／人に回した」で選ぶ欄があり、
          そちらに件数も出る。同じ数を二か所に出すと、
          どちらを見ればよいのか迷う。

          最後に動いた時刻だけは残す。数ではなく、
          「止まっていないか」を見るためのもの。
        */}
        {st?.last_at && (
          <div className="px-3 py-2 text-[10px] text-slate-400">
            {T("最後に動いたのは")} {when(st.last_at)}
          </div>
        )}
      </div>

      {state === "stuck" && (
        <p className="mt-2 rounded-xl bg-red-50 p-3 text-[11px] leading-relaxed text-red-800">
          <b>{T("申請が溜まっているのに、しばらく何もしていません。")}</b>
          <br />
          {T("base/14_auto_assign.sql を入れているか、名簿とドメインが入っているかをお確かめください。")}
          {T("それでも動かないときは、下の欄から手で承認できます。")}
        </p>
      )}

      {/* 何を見るか */}
      <div className="mt-3 flex flex-wrap gap-1">
        {[
          ["", "ぜんぶ"],
          ["approved", "通した"],
          ["reset", "はじいた"],
          ["skipped", "人に回した"],
        ].map(([id, label]) => (
          <button
            key={id}
            onClick={() => set("kind", id)}
            className={`rounded-lg px-3 py-1.5 text-[11px] font-bold transition active:scale-95 ${
              f.kind === id
                ? "bg-slate-900 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            {T(label)}
          </button>
        ))}
        <span className="ml-auto self-center text-[10px] text-slate-500">
          {total} {T("件")}
        </span>
      </div>

      {/*
        誰を見るか。

        学年・学科・クラス・身分は、履歴に出てくるものだけを並べる。
        居ない学年を押して空振りさせない。
      */}
      {noFind ? (
        <p className="mt-2 rounded-xl bg-amber-50 px-2.5 py-2 text-[10px] leading-relaxed text-amber-900">
          {T("学年・学科・クラス・身分での絞りこみは、データベースに base/34_agent_find.sql を入れると使えるようになります。")}
        </p>
      ) : (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <input
            value={f.q}
            onChange={(e) => set("q", e.target.value)}
            autoComplete="off"
            placeholder={T("名前・アドレス・8桁の番号で探す")}
            className="min-w-[10rem] flex-1 rounded-lg bg-slate-100 px-3 py-2 text-[11px] outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
          />

          <Pick
            value={String(f.grade)}
            onChange={(v) => set("grade", Number(v))}
            all={T("どの学年も")}
            items={(choices?.grades?.length ? choices.grades : [1, 2, 3, 4]).map((g) => [
              String(g),
              `${g}${T("年")}`,
            ])}
          />

          {/* 学科の記号は大学ごとに違う。履歴にあるものだけ並べる */}
          {(choices?.class_codes?.length ?? 0) > 0 ? (
            <Pick
              value={f.code}
              onChange={(v) => set("code", v)}
              all={T("どの学科も")}
              items={(choices?.class_codes ?? []).map((c) => [c, c])}
            />
          ) : (
            <input
              value={f.code}
              onChange={(e) => set("code", e.target.value.toUpperCase().slice(0, 4))}
              autoComplete="off"
              placeholder="CC"
              className="w-[4.5rem] rounded-lg bg-slate-100 px-2 py-2 text-center font-mono text-[11px] outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
            />
          )}

          <Pick
            value={String(f.no)}
            onChange={(v) => set("no", Number(v))}
            all={T("どのクラスも")}
            items={(choices?.class_nos?.length
              ? choices.class_nos
              : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
            ).map((n) => [String(n), `${n}${T("組")}`])}
          />

          <Pick
            value={f.aff}
            onChange={(v) => set("aff", v)}
            all={T("どの身分も")}
            items={(choices?.affs?.length ? choices.affs : ["student", "teacher", "other"]).map(
              (a) => [a, T(AFF[a] ?? a)],
            )}
          />

          {filtering && (
            <button
              onClick={() => setF({ ...NONE, kind: f.kind })}
              className="rounded-lg bg-slate-900 px-2.5 py-2 text-[10px] font-bold text-white transition active:scale-95"
            >
              {T("絞りをやめる")}
            </button>
          )}
        </div>
      )}

      {/*
        ログ。左に印を縦に並べて、上から下へ流れていくように見せる。

        一件ずつが「誰を、どうしたか」。理由まで出すのは、
        はじかれた人に何と言えばよいかが、ここだけで分かるようにするため。
      */}
      <ol className="mt-2 border-l-2 border-slate-200 pl-3">
        {rows.map((r) => {
          const d = DECISION[r.decision] ?? { label: r.decision, cls: "bg-slate-400", mark: "?" };
          return (
            <li key={r.id} className="relative pb-3">
              <span
                className={`absolute -left-[1.28rem] top-0.5 flex h-4 w-4 items-center justify-center rounded-full ${d.cls} text-[9px] font-bold text-white`}
              >
                {d.mark}
              </span>
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-[11px] font-bold text-slate-900">
                  {r.full_name || r.email}
                </span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[9px] font-bold text-white ${d.cls}`}
                >
                  {T(d.label)}
                </span>
                {r.role_given && (
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold text-slate-600">
                    {r.role_given}
                  </span>
                )}
                <span className="ml-auto font-mono text-[10px] text-slate-400">
                  {when(r.created_at)}
                </span>
              </div>
              <div className="truncate font-mono text-[10px] text-slate-400">{r.email}</div>
              {/* 絞った結果が合っているかを、その場で確かめられるようにする */}
              {(Number(r.grade ?? 0) > 0 ||
                (r.class_code ?? "") !== "" ||
                (r.affiliation ?? "student") !== "student") && (
                <div className="mt-0.5 flex flex-wrap gap-1">
                  {Number(r.grade ?? 0) > 0 && (
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold text-slate-600">
                      {r.grade}
                      {T("年")}
                    </span>
                  )}
                  {(r.class_code ?? "") !== "" && (
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[9px] font-bold text-slate-600">
                      {r.class_code}
                    </span>
                  )}
                  {Number(r.class_no ?? 0) > 0 && (
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold text-slate-600">
                      {r.class_no}
                      {T("組")}
                    </span>
                  )}
                  {(r.affiliation ?? "student") !== "student" && r.affiliation && (
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold text-slate-600">
                      {T(AFF[r.affiliation] ?? r.affiliation)}
                    </span>
                  )}
                </div>
              )}
              {r.reason && (
                <div className="mt-0.5 text-[10px] leading-relaxed text-slate-600">{r.reason}</div>
              )}
            </li>
          );
        })}
        {rows.length === 0 && (
          <li className="py-6 text-center text-[11px] text-slate-500">
            {filtering ? (
              <>
                {T("この絞りこみに当たるものはありません。")}
                <br />
                {T("絞りを外すと、ぜんぶ出ます。")}
              </>
            ) : (
              <>
                {T("まだ何も残っていません。")}
                <br />
                {T("kit-agent が誰かを見ると、ここに出ます。")}
              </>
            )}
          </li>
        )}
      </ol>

      {filtering && (
        <p className="mt-2 text-[10px] leading-relaxed text-slate-400">
          {T("席が消えた人は、学年や学科では出てきません（アドレスでは探せます）。")}
        </p>
      )}

      <p className="mt-3 text-[10px] leading-relaxed text-slate-400">
        {T("20秒ごとに見直しています。")}
        {T("kit-agent の本体はデータベースの中にあるので、常に立っている番組ではありません。")}
        {T("最近の働きぶりで「働いている／待っている／詰まっている」を出しています。")}
      </p>
    </Shell>
  );
}

/**
 * 小さな選び手。
 *
 * 管理画面の select は形がそろっていないので、ここで一つにする。
 * 先頭は必ず「どれも」（絞らない）。値は文字で持ち、数は呼ぶ側で直す。
 */
function Pick({
  value,
  onChange,
  all,
  items,
}: {
  value: string;
  onChange: (v: string) => void;
  all: string;
  items: [string, string][];
}) {
  const on = value !== "" && value !== "0";
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`rounded-lg px-2 py-2 text-[11px] font-bold outline-none transition ${
        on ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
      }`}
    >
      <option value={typeof items[0]?.[0] === "string" && /^\d+$/.test(items[0][0]) ? "0" : ""}>
        {all}
      </option>
      {items.map(([v, label]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
    </select>
  );
}

/**
 * 画面の外枠。
 *
 * ★高さを決めてから、その中で流す
 *   body は overflow-hidden なので、min-height だけだと
 *   はみ出したぶんが body に切り落とされ、下まで見られない。
 *   高さを 100dvh に決めて、その中で流す。ほかの管理画面と同じ形。
 */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="h-[100dvh] overflow-y-auto bg-slate-100 p-4">
      <div className="mx-auto w-full max-w-sm rounded-2xl bg-white p-5 shadow-lg sm:max-w-2xl lg:max-w-4xl">{children}</div>
    </main>
  );
}
