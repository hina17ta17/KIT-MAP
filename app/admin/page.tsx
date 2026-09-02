"use client";

/**
 * 承認と権限の管理。
 *
 * ■ 二つの見方
 *   新規 … まだ承認していない人
 *   既存 … すでに使っている人。年・クラスで絞って見る
 *
 * ■ 権限はその人の欄で変える
 *   以前は画面の下に固定のボタンを置き、選んでから押す形だった。
 *   誰に何を付けているのか目で追えず、選び間違いに気づけない。
 *   いまは名前を押すとその人の欄が開き、そこで変える。
 *   一度決めたあとでも、同じ場所から何度でも変えられる。
 *
 *   まとめて変えたいときのために、印を付ける道も残してある。
 *   印を付けたときだけ、下にボタンが出る。
 *
 * すでに使っている人の権限を変えるときは操作パスワードが要る。
 * 押し間違いで一括降格させる事故を、ひと手間で防ぐため。
 *
 * ■ いちばん上の権限は、この画面には出さない
 *   一覧にも、付けられる権限の並びにも出さない。
 *   誰がそれを持っているのか、そもそも在るのかを画面から読み取れないようにする。
 *   設定はデータベースから行う。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient, supabaseReady } from "@/lib/supabase/client";
import { AdminHeader, AdminMenu } from "@/components/AdminNav";
import { CLASS_CODES, GRADES, GROUPS, ROLE_LABEL, ROLE_SHORT, canManage, type Role } from "@/lib/auth";

type Row = {
  id: string;
  email: string;
  role: Role;
  full_name: string;
  grade: number;
  class_code: string;
  group_no: number;
  seat_no: number;
  verified: boolean;
  created_at: string;
};

/** ここから付けられる権限。いちばん上の権限は入れない */
const ASSIGNABLE: Role[] = ["pending", "student", "admin_l0", "admin_l1", "admin_l2"];

/**
 * 画面に出さない権限。
 *
 * 一覧からも外す。ここに出ていると、その席が在ることが分かってしまう。
 */
const HIDDEN: Role = "admin_l3";

const SHORT = ROLE_SHORT;

export default function AdminPage() {
  const [myRole, setMyRole] = useState<Role | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [tab, setTab] = useState<"new" | "setup" | "existing">("new");
  /** チェックを入れた人 */
  const [picked, setPicked] = useState<string[]>([]);
  /** 既存を変えるときの合言葉。一度打てば、この画面にいる間は覚えておく */
  const [password, setPassword] = useState("");
  /**
   * いま権限の欄を開いている人。
   *
   * 一人ずつしか開かない。全員ぶん開いていると一覧が縦に伸びて、
   * 誰を触っているのか分からなくなる。
   */
  const [open, setOpen] = useState<string | null>(null);

  /* 既存の絞り込み */
  const [fGrade, setFGrade] = useState<number | null>(null);
  const [fClass, setFClass] = useState<string | null>(null);
  const [fGroup, setFGroup] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!supabaseReady) {
      setLoading(false);
      return;
    }
    const supabase = createClient();
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) {
      setMyRole(null);
      setLoading(false);
      return;
    }
    const { data: me } = await supabase.from("profiles").select("role").eq("id", u.user.id).single();
    const role = (me?.role as Role) ?? null;
    setMyRole(role);

    if (canManage(role)) {
      // 列を並べずに取る。010 を流す前でも落ちないようにするため
      const { data } = await supabase.from("profiles").select("*").order("created_at");
      setRows((data as Row[]) ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 全員を最初からやり直させる。
   *
   * ログイン・パスワード・本人確認・所属が消え、申請の最初に戻る。
   * 取り返しがつかないので、二度たずねてから実行する。
   * 一度目は何が消えるかを並べ、二度目は人数を出して念を押す。
   */
  const resetAll = async () => {
    setMsg(null);
    const target = listed.length;
    const first = window.confirm(
      [
        "全員を最初からやり直させます。",
        "",
        "次のものが、管理者以外のすべての人から消えます。",
        "  ・ログイン中の状態",
        "  ・パスワード",
        "  ・本人確認（認証アプリ）",
        "  ・氏名・学年・クラス・名列番号",
        "  ・承認した権限",
        "",
        "消された人は、申請の最初からやり直しになります。",
        "元には戻せません。",
        "",
        "続けますか？",
      ].join("\n"),
    );
    if (!first) return;

    const second = window.confirm(
      [
        `本当に実行しますか？（${target} 名が消えます）`,
        "",
        "これが最後の確認です。押すと元に戻せません。",
        "承認済みの人も、もう一度申請と承認が要ります。",
      ].join("\n"),
    );
    if (!second) return;

    setBusy(true);
    try {
      const { data, error } = await createClient().rpc("reset_everyone");
      if (error) throw error;
      setPicked([]);
      setOpen(null);
      await load();
      setMsg({ kind: "ok", text: `${data ?? 0} 名を消しました。全員が申請からやり直しになります。` });
    } catch (e) {
      setMsg({
        kind: "err",
        text:
          e instanceof Error
            ? e.message + "（supabase/reset_all.sql をまだ入れていない場合は、先に入れてください）"
            : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  /* いちばん上の権限の人は、そもそも一覧に載せない */
  const listed = useMemo(() => rows.filter((r) => r.role !== HIDDEN), [rows]);

  /**
   * 申請が出そろっているか。
   *
   * 席を作った時点（メールアドレスと氏名とパスワードを入れた直後）では、
   * まだ本人だと確かめていない。本人確認を済ませ、所属まで入れて
   * はじめて「申請」として管理者に届く。
   *
   * 途中の人まで承認の一覧に混ざると、確かめていない相手を
   * 承認してしまう。段を分けて、申請の一覧には出そろった人だけを出す。
   */
  const isApplied = (r: Row) =>
    r.verified && !!r.grade && !!r.class_code && !!r.seat_no;

  /** 本人確認と所属が済み、承認を待っている人 */
  const news = useMemo(
    () => listed.filter((r) => r.role === "pending" && isApplied(r)),
    [listed],
  );
  /** 席は作ったが、まだ手続きの途中の人。承認の対象にはしない */
  const setup = useMemo(
    () => listed.filter((r) => r.role === "pending" && !isApplied(r)),
    [listed],
  );
  const existing = useMemo(() => listed.filter((r) => r.role !== "pending"), [listed]);

  const shown = useMemo(() => {
    if (tab === "new") return news;
    if (tab === "setup") return setup;
    return existing.filter(
      (r) =>
        (fGrade === null || r.grade === fGrade) &&
        (fClass === null || r.class_code === fClass) &&
        (fGroup === null || r.group_no === fGroup),
    );
  }, [tab, news, setup, existing, fGrade, fClass, fGroup]);

  /**
   * 権限を付ける。
   *
   * その人の欄からは一人ぶん、下のボタンからは印を付けた人ぶんを渡す。
   * 手順は同じなので一本にしてある。
   */
  const apply = async (role: Role, ids: string[]) => {
    setMsg(null);
    if (ids.length === 0) {
      setMsg({ kind: "err", text: "誰も選ばれていません" });
      return;
    }
    setBusy(true);
    try {
      const { data, error } = await createClient().rpc("set_roles", {
        p_ids: ids,
        p_role: role,
        p_password: password || null,
      });
      if (error) throw error;

      const one = ids.length === 1 ? rows.find((r) => r.id === ids[0]) : null;
      setPicked((p) => p.filter((x) => !ids.includes(x)));
      setOpen(null);
      await load();
      setMsg({
        kind: "ok",
        text: one
          ? `${one.full_name || one.email} を「${ROLE_LABEL[role]}」にしました`
          : `${data ?? 0}名を「${ROLE_LABEL[role]}」にしました`,
      });
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "変更できませんでした" });
    } finally {
      setBusy(false);
    }
  };

  /* ---------------- 表示 ---------------- */

  if (loading) return <Shell>読み込み中…</Shell>;

  if (!supabaseReady)
    return <Shell><p className="text-sm text-red-700">サーバーに接続できません。</p></Shell>;

  if (!myRole)
    return (
      <Shell>
        <p className="text-sm text-slate-700">ログインしていません。</p>
        <Link href="/login" className="mt-3 inline-block text-sm font-bold text-blue-600">ログインへ</Link>
      </Shell>
    );

  if (!canManage(myRole))
    return (
      <Shell>
        {/* どの権限なら使えるのかは書かない。上に誰か居ることが分かってしまう */}
        <p className="text-sm text-slate-700">この画面は、いまの権限では使えません。</p>
        <p className="mt-1 text-xs text-slate-500">現在の権限：{ROLE_LABEL[myRole]}</p>
        <Link href="/" className="mt-3 inline-block text-sm font-bold text-blue-600">地図へ戻る</Link>
      </Shell>
    );

  /* 印を付けた中に、すでに承認した人が混ざっているか */
  const needPassword = picked.some((id) => rows.find((r) => r.id === id)?.role !== "pending");

  return (
    <Shell wide>
      <AdminHeader title="承認・権限の管理" />
      <AdminMenu current="approve" role={myRole} />

      {/* 申請 / 手続き中 / 既存 */}
      <div className="mb-3 flex gap-1 rounded-xl bg-slate-100 p-1">
        {([
          ["new", `申請（${news.length}）`],
          ["setup", `手続き中（${setup.length}）`],
          ["existing", `既存（${existing.length}）`],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            onClick={() => {
              setTab(id);
              setPicked([]);
              setMsg(null);
            }}
            className={`flex-1 rounded-lg py-2 text-xs font-bold transition ${
              tab === id ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 手続き中の説明。承認できないのが故障に見えないように */}
      {tab === "setup" && (
        <div className="mb-3 rounded-xl bg-amber-50 p-2.5 text-[11px] leading-relaxed text-amber-900 ring-1 ring-amber-200">
          メールアドレスと氏名は入れたものの、
          <b>まだ本人確認か所属の記入が済んでいない人</b>です。
          <br />
          本人だと確かめられていないので、ここからは権限を付けられません。
          本人が Microsoft Authenticator で本人確認を済ませ、所属を入れると、
          「申請」に移ります。
        </div>
      )}

      {/* 既存の絞り込み */}
      {tab === "existing" && (
        <div className="mb-3 rounded-xl bg-slate-50 p-2.5">
          <Filter label="学年" value={fGrade} onPick={setFGrade} options={GRADES.map((g) => [g, `${g}年`])} />
          <Filter
            label="クラス"
            value={fClass}
            onPick={setFClass}
            options={CLASS_CODES.map((c) => [c.code, c.code])}
          />
          {/* 名列番号は200通りあるので、並べて絞り込む形にはしない。
              学年とクラスで絞ったうえで、一覧から探す */}
        </div>
      )}

      <p className="mb-2 text-[11px] text-slate-500">
        {shown.length} 名
        <span className="ml-2 text-slate-400">
          {tab === "setup" ? "本人確認が済むと「申請」に移ります" : "名前を押すと権限を変えられます"}
        </span>
        {picked.length > 0 && <b className="ml-2 text-blue-700">{picked.length} 名に印</b>}
      </p>

      {/* 一覧 */}
      <ul className="space-y-1.5">
        {shown.map((r) => {
          const on = picked.includes(r.id);
          const here = open === r.id;
          /* すでに承認した人を触るときは合言葉が要る（データベース側の決まり） */
          const needsPw = r.role !== "pending";
          return (
            <li key={r.id}>
              <div
                className={`flex items-start gap-2 rounded-xl p-2.5 ring-1 transition ${
                  here
                    ? "bg-white ring-slate-900"
                    : on
                      ? "bg-blue-50 ring-blue-300"
                      : r.role === "pending"
                        ? "bg-amber-50 ring-amber-200"
                        : "bg-white ring-slate-200"
                }`}
              >
                {/* 印。まとめて変えたいときだけ使う。名前を押すのとは別の的にする。
                    手続き中の人は承認の対象にしないので出さない */}
                {tab !== "setup" && (
                <button
                  onClick={() => setPicked((p) => (on ? p.filter((x) => x !== r.id) : [...p, r.id]))}
                  aria-label={on ? "印を外す" : "印を付ける"}
                  className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[11px] font-bold transition active:scale-90 ${
                    on ? "bg-blue-600 text-white" : "bg-white text-transparent ring-1 ring-slate-300"
                  }`}
                >
                  ✓
                </button>
                )}

                {/* 名前を押すと、その人の権限の欄が開く */}
                <button
                  onClick={() => tab !== "setup" && setOpen(here ? null : r.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block truncate text-sm font-semibold text-slate-900">
                    {r.full_name || "（氏名未記入）"}
                    {/*
                      メール確認の印は出さない。このアプリはメールを一通も
                      送らないので、全員が「未確認」のままになり、意味を持たない。
                      本人確認は認証アプリのほうで見る。
                    */}
                    {!r.verified && (
                      <span className="ml-1.5 rounded bg-red-100 px-1 py-0.5 text-[9px] font-bold text-red-700">
                        本人確認まだ
                      </span>
                    )}
                    {r.verified && !(r.grade && r.class_code && r.seat_no) && (
                      <span className="ml-1.5 rounded bg-amber-100 px-1 py-0.5 text-[9px] font-bold text-amber-800">
                        所属まだ
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-[11px] text-slate-500">{r.email}</span>
                  <span className="mt-0.5 block text-[10px] text-slate-500">
                    {r.grade ? `${r.grade}年 ` : ""}
                    {r.class_code}
                    {r.seat_no ? ` ${r.seat_no}番` : r.group_no ? `-${r.group_no}` : ""}
                    <span className="ml-2 rounded bg-slate-200 px-1 py-0.5 font-bold text-slate-700">
                      {SHORT[r.role]}
                    </span>
                  </span>
                </button>

                {tab !== "setup" && (
                  <span
                    className={`mt-1 shrink-0 text-slate-400 transition ${here ? "rotate-90" : ""}`}
                  >
                    ›
                  </span>
                )}
              </div>

              {/* その人の権限を変える欄。本人確認が済んでいない人には出さない */}
              {here && tab !== "setup" && (
                <div className="mt-1 rounded-xl bg-slate-900 p-2.5">
                  <div className="mb-1.5 text-[10px] font-bold text-slate-400">
                    権限を変える
                    <span className="ml-1.5 font-normal text-slate-500">
                      いまは「{ROLE_LABEL[r.role]}」
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {ASSIGNABLE.map((role) => {
                      const current = role === r.role;
                      return (
                        <button
                          key={role}
                          disabled={busy || current}
                          onClick={() => void apply(role, [r.id])}
                          className={`rounded-lg px-2.5 py-2 text-[11px] font-bold transition active:scale-95 ${
                            current
                              ? "bg-white text-slate-900"
                              : "bg-slate-700 text-white hover:bg-slate-600 disabled:opacity-40"
                          }`}
                        >
                          {SHORT[role]}
                        </button>
                      );
                    })}
                  </div>

                  {needsPw && (
                    <>
                      <input
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        type="password"
                        placeholder="操作パスワード"
                        className="mt-2 w-full rounded-lg bg-slate-800 px-3 py-2 text-sm text-white placeholder:text-slate-500 outline-none focus:ring-2 focus:ring-blue-500"
                      />
                      <p className="mt-1 text-[10px] text-slate-500">
                        一度承認した人を変えるには必要です
                      </p>
                    </>
                  )}
                </div>
              )}

            </li>
          );
        })}
        {shown.length === 0 && (
          <li className="rounded-xl bg-slate-50 p-4 text-center text-xs text-slate-500">
            該当する人がいません
          </li>
        )}
      </ul>

      {/*
        全員をやり直させる。取り返しがつかないので、
        一覧のいちばん下に置き、色でも他と区別する。
      */}
      <div className="mt-6 rounded-xl border border-red-300 bg-red-50 p-3">
        <div className="text-xs font-bold text-red-900">全員を最初からやり直させる</div>
        <p className="mt-1 text-[11px] leading-relaxed text-red-800">
          管理者以外のすべての人から、ログイン・パスワード・本人確認・氏名・学年・クラス・
          名列番号・権限が消えます。消された人は申請の最初からやり直しです。
          <b>元には戻せません。</b>
        </p>
        <button
          onClick={() => void resetAll()}
          disabled={busy}
          className="mt-2 w-full rounded-lg bg-red-600 px-2 py-2.5 text-xs font-bold text-white transition hover:bg-red-700 active:scale-95 disabled:bg-slate-300"
        >
          {busy ? "処理中…" : `全員（${listed.length} 名）をリセットする`}
        </button>
      </div>

      {msg && (
        <p
          className={`mt-3 rounded-xl p-3 text-xs leading-relaxed ${
            msg.kind === "ok" ? "bg-emerald-50 text-emerald-900" : "bg-red-50 text-red-800"
          }`}
        >
          {msg.text}
        </p>
      )}

      {/*
        まとめて変える道。
        ふだんは出さない。印を付けたときだけ下から出す。
        常に置いておくと、誰に付けるのか目で追えないまま押せてしまう。
      */}
      {picked.length > 0 && (
        <div className="sticky bottom-0 mt-4 rounded-2xl bg-white/95 pb-1 pt-3 backdrop-blur">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-bold text-blue-700">
              印を付けた {picked.length} 名にまとめて付ける
            </span>
            <button
              onClick={() => setPicked([])}
              className="rounded-lg px-2 py-1 text-[11px] font-bold text-slate-500 hover:bg-slate-100"
            >
              印を外す
            </button>
          </div>
          {needPassword && (
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              placeholder="操作パスワード（承認済みの人を変えるとき）"
              className="mb-2 w-full rounded-xl bg-slate-100 px-4 py-2.5 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
            />
          )}
          <div className="grid grid-cols-5 gap-1.5">
            {ASSIGNABLE.map((role) => (
              <button
                key={role}
                disabled={busy}
                onClick={() => void apply(role, picked)}
                className="rounded-lg bg-slate-900 px-1 py-2.5 text-[11px] font-bold text-white transition hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400"
              >
                {SHORT[role]}
              </button>
            ))}
          </div>
        </div>
      )}
    </Shell>
  );
}

/* ---------------- 絞り込みの一行 ---------------- */

function Filter<T extends string | number>({
  label,
  value,
  onPick,
  options,
}: {
  label: string;
  value: T | null;
  onPick: (v: T | null) => void;
  options: [T, string][];
}) {
  return (
    <div className="mb-1.5 last:mb-0">
      <div className="mb-1 text-[10px] font-bold text-slate-500">{label}</div>
      <div className="flex flex-wrap gap-1">
        <Chip on={value === null} onClick={() => onPick(null)}>
          すべて
        </Chip>
        {options.map(([v, text]) => (
          <Chip key={String(v)} on={value === v} onClick={() => onPick(v)}>
            {text}
          </Chip>
        ))}
      </div>
    </div>
  );
}

function Chip({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg px-2 py-1 text-[11px] font-bold transition ${
        on ? "bg-slate-900 text-white" : "bg-white text-slate-600 shadow-sm hover:bg-slate-100"
      }`}
    >
      {children}
    </button>
  );
}

function Shell({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    // 本文は地図のために overflow-hidden。ここで送れるようにする
    <main className="h-[100dvh] overflow-y-auto bg-slate-100 p-4">
      <div className={`mx-auto ${wide ? "max-w-2xl" : "max-w-sm"} rounded-2xl bg-white p-5 shadow-lg`}>
        {children}
      </div>
    </main>
  );
}
