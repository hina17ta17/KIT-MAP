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
 * すでに使っている人の権限を変えるときは、操作している本人の
 * ログインパスワードを打ってもらう。押し間違いで一括降格させる事故を、
 * ひと手間で防ぐため。
 *
 * 以前は別に決めた共通の合言葉だった。覚えるものが増えるうえ、
 * 決めていないと権限がまったく変えられなくなる。いつも使っている
 * ログインのパスワードなら、そのどちらも起きない。
 * 合っているかはデータベース側で確かめる（check_my_password）。
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
import {
  AFFILIATIONS,
  AFFILIATION_LABEL,
  CLASS_CODES,
  GRADES,
  GROUPS,
  ROLE_LABEL,
  ROLE_SHORT,
  canManage,
  type Affiliation,
  type Role,
} from "@/lib/auth";

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
  /**
   * 申請のときに本人が選んだ身分。
   *
   * 自己申告であって権限ではない。何にするかを決めるのはこの画面。
   * 016 を流す前の人は空で返るので、そのときは学生として扱う。
   */
  affiliation: Affiliation | null;
};

/** ここから付けられる権限。いちばん上の権限は入れない */
const ASSIGNABLE: Role[] = [
  "pending",
  "student",
  "admin_l0",
  "admin_l1",
  "admin_l2",
  // 副管理者。2.1 は承認・権限の管理だけができない。2.2 はすべてできる
  "admin_l21",
  "admin_l22",
];

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
  /**
   * リセットの一式を開いているか。
   *
   * 取り返しのつかない操作なので、ふだんは畳んでおく。
   * 承認の作業をしているだけの人の指が、届く場所に無いようにする。
   */
  const [resetOpen, setResetOpen] = useState(false);
  /** チェックを入れた人 */
  const [picked, setPicked] = useState<string[]>([]);
  /** 既存を変えるときの本人確認。一度打てば、この画面にいる間は覚えておく */
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
    const target = listed.filter((r) => r.role === "pending" || r.role === "student").length;
    const first = window.confirm(
      [
        "全員を最初からやり直させます。",
        "",
        "次のものが、学生と申請者から消えます（管理者は全員残ります）。",
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

  /**
   * すべての席を消す。管理者も含む。
   *
   * さきの resetAll は管理者を残すが、こちらは残さない。
   * 押した本人も消えるので、その場でログアウトされる。
   *
   * 承認できる人が誰もいなくなるので、あとで
   * supabase/set_admin.sql を流して作り直す必要がある。
   * そのことを、二度の確認の両方で伝える。
   */
  const resetEverything = async () => {
    setMsg(null);
    const total = rows.length;
    const first = window.confirm(
      [
        "管理者も含めて、すべての席を消します。",
        "",
        "消えるもの",
        "  ・ログイン中の状態",
        "  ・パスワード",
        "  ・本人確認（認証アプリ）",
        "  ・氏名・学年・クラス・名列番号",
        "  ・権限（管理者を含む）",
        "",
        "残るのは、いちばん上の権限の人だけです。",
        "副管理者（2.1・2.2）も消えます。",
        "あなたがいちばん上でなければ、あなたも消えてログアウトされます。",
        "",
        "続けますか？",
      ].join("\n"),
    );
    if (!first) return;

    const second = window.confirm(
      [
        `本当に実行しますか？（${total} 名すべてが消えます）`,
        "",
        "これが最後の確認です。押すと元に戻せません。",
        "",
        "いちばん上の権限の人だけが残ります。",
        "その人がいなければ、set_admin.sql で作り直す必要があります。",
      ].join("\n"),
    );
    if (!second) return;

    setBusy(true);
    try {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("reset_everything");
      if (error) throw error;
      // 自分の席も消えている。控えを捨ててから入口へ戻す
      // 自分がいちばん上なら残っている。読み直して確かめる
      const { data: u } = await supabase.auth.getUser();
      if (u.user) {
        setPicked([]);
        setOpen(null);
        await load();
        setMsg({ kind: "ok", text: `${data ?? 0} 名を消しました。あなたの席は残っています。` });
        setBusy(false);
        return;
      }
      await supabase.auth.signOut().catch(() => undefined);
      window.alert(`${data ?? 0} 名を消しました。ログイン画面へ戻ります。`);
      window.location.href = "/login";
    } catch (e) {
      setMsg({
        kind: "err",
        text:
          e instanceof Error
            ? e.message +
              "（supabase/reset_all_including_admin.sql をまだ入れていない場合は、先に入れてください）"
            : String(e),
      });
      setBusy(false);
    }
  };

  /**
   * 身分を直す。
   *
   * 申請のときに本人が選んだものなので、選び間違いがある。
   * 権限とは別物で、ここを変えても権限は動かない。
   * 直接書き換えるだけ。RLS の「承認の権限を持つ人は書ける」に任せる。
   */
  const applyAffiliation = async (a: Affiliation, id: string) => {
    setMsg(null);
    setBusy(true);
    try {
      const { error } = await createClient()
        .from("profiles")
        .update({ affiliation: a })
        .eq("id", id);
      if (error) throw error;
      await load();
      const who = rows.find((x) => x.id === id);
      setMsg({
        kind: "ok",
        text: `${who?.full_name || who?.email || ""} の身分を「${AFFILIATION_LABEL[a]}」にしました`,
      });
    } catch (e) {
      setMsg({
        kind: "err",
        text:
          e instanceof Error
            ? e.message +
              "（supabase/migrations/016_affiliation.sql をまだ入れていない場合は、先に入れてください）"
            : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  /**
   * 選んだ身分の人を、まとめて消す。
   *
   * 身分は自己申告なので、管理者が「教授」を選んでいることもある。
   * 巻き込む人数を数えて、確認のときにそのまま見せる。
   */
  const resetAffiliation = async (a: Affiliation) => {
    setMsg(null);
    const targets = rows.filter(
      (r) => (r.affiliation ?? "student") === a && r.role !== "admin_l3",
    );
    if (targets.length === 0) {
      setMsg({ kind: "err", text: `「${AFFILIATION_LABEL[a]}」の人がいません` });
      return;
    }
    const admins = targets.filter((r) => r.role.startsWith("admin_"));

    const first = window.confirm(
      [
        `身分が「${AFFILIATION_LABEL[a]}」の ${targets.length} 名を消します。`,
        "",
        ...(admins.length > 0
          ? [
              `※ この中に管理者が ${admins.length} 名います。`,
              ...admins.slice(0, 8).map((r) => `    ・${r.full_name || r.email}（${ROLE_LABEL[r.role]}）`),
              "  身分は本人が選んだものなので、権限とは関わりなく消えます。",
              "",
            ]
          : []),
        "この人たちから、ログイン・パスワード・本人確認・大学の情報が",
        "すべて消え、申請の最初からやり直しになります。元には戻せません。",
        "",
        "いちばん上の権限の人と、あなた自身は残ります。",
        "",
        "続けますか？",
      ].join("\n"),
    );
    if (!first) return;

    const second = window.confirm(
      [
        `本当に実行しますか？（${targets.length} 名が消えます）`,
        "",
        "これが最後の確認です。押すと元に戻せません。",
      ].join("\n"),
    );
    if (!second) return;

    setBusy(true);
    try {
      const { data, error } = await createClient().rpc("reset_by_affiliation", {
        p_affiliation: a,
        p_password: password || null,
      });
      if (error) throw error;
      setPicked([]);
      setOpen(null);
      await load();
      setMsg({ kind: "ok", text: `${data ?? 0} 名を消しました。` });
    } catch (e) {
      setMsg({
        kind: "err",
        text:
          e instanceof Error
            ? e.message +
              "（supabase/migrations/017_reset_by_affiliation.sql をまだ入れていない場合は、先に入れてください）"
            : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  /**
   * 印を付けた人だけを消す。
   *
   * 上の二つは「全員」しか選べない。一人だけ入り直させたい場面のために、
   * 選んだ人だけを対象にできる道を作る。
   * 強さは全員リセットと変わらないので、確認は同じく二度たずねる。
   */
  const resetPicked = async () => {
    setMsg(null);
    if (picked.length === 0) return;

    const names = picked
      .map((id) => {
        const r = rows.find((x) => x.id === id);
        return r ? r.full_name || r.email : id;
      })
      .slice(0, 12);

    const first = window.confirm(
      [
        `印を付けた ${picked.length} 名を消します。`,
        "",
        ...names.map((n) => "  ・" + n),
        picked.length > names.length ? `  ほか ${picked.length - names.length} 名` : "",
        "",
        "この人たちから、次のものが消えます。",
        "  ・ログイン中の状態",
        "  ・パスワード",
        "  ・本人確認（認証アプリ）",
        "  ・氏名・学年・クラス・名列番号",
        "  ・承認した権限",
        "",
        "申請の最初からやり直しになります。元には戻せません。",
        "",
        "続けますか？",
      ]
        .filter((s) => s !== "")
        .join("\n"),
    );
    if (!first) return;

    const second = window.confirm(
      [
        `本当に実行しますか？（${picked.length} 名が消えます）`,
        "",
        "これが最後の確認です。押すと元に戻せません。",
      ].join("\n"),
    );
    if (!second) return;

    setBusy(true);
    try {
      const { data, error } = await createClient().rpc("reset_users", {
        p_ids: picked,
        p_password: password || null,
      });
      if (error) throw error;
      setPicked([]);
      setOpen(null);
      await load();
      setMsg({ kind: "ok", text: `${data ?? 0} 名を消しました。` });
    } catch (e) {
      setMsg({
        kind: "err",
        text:
          e instanceof Error
            ? e.message +
              "（supabase/migrations/015_feedback_and_pick_reset.sql をまだ入れていない場合は、先に入れてください）"
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
  /*
   * 学年・クラス・名列番号があるかを見るのは、学生のときだけ。
   *
   * 教授とその他の人には、そもそも訊いていない。全員に求めると、
   * その人たちは何を書いても申請の一覧に出てこないまま止まる。
   */
  const isApplied = (r: Row) =>
    r.verified &&
    ((r.affiliation ?? "student") !== "student" ||
      (!!r.grade && !!r.class_code && !!r.seat_no));

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
          /* すでに承認した人を触るときは、本人のログインパスワードが要る（データベース側の決まり） */
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
                    {r.verified &&
                      (r.affiliation ?? "student") === "student" &&
                      !(r.grade && r.class_code && r.seat_no) && (
                      <span className="ml-1.5 rounded bg-amber-100 px-1 py-0.5 text-[9px] font-bold text-amber-800">
                        所属まだ
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-[11px] text-slate-500">{r.email}</span>
                  <span className="mt-0.5 block text-[10px] text-slate-500">
                    {/*
                      本人が名乗った身分。学生以外はここで分かるようにしておく。
                      学生は学年とクラスが続くので、わざわざ書かない。
                    */}
                    {r.affiliation && r.affiliation !== "student" && (
                      <span className="mr-2 rounded bg-indigo-100 px-1 py-0.5 font-bold text-indigo-800">
                        {AFFILIATION_LABEL[r.affiliation]}
                      </span>
                    )}
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
                        placeholder="あなたのログインパスワード"
                        autoComplete="current-password"
                        className="mt-2 w-full rounded-lg bg-slate-800 px-3 py-2 text-sm text-white placeholder:text-slate-500 outline-none focus:ring-2 focus:ring-blue-500"
                      />
                      <p className="mt-1 text-[10px] text-slate-500">
                        一度承認した人を変えるには、ご自身のログインパスワードが要ります
                      </p>
                    </>
                  )}

                  {/*
                    身分を直す。

                    申請のときに本人が選んだものなので、選び間違いがある。
                    学生でない人が学生を選ぶと、学年・クラス・名列番号を
                    求められたままになる。ここで直せるようにしておく。

                    権限とは別物。ここを変えても権限は動かない。
                  */}
                  <div className="mt-3 border-t border-slate-700 pt-2">
                    <div className="mb-1.5 text-[10px] font-bold text-slate-400">
                      身分を直す
                      <span className="ml-1.5 font-normal text-slate-500">
                        いまは「{AFFILIATION_LABEL[r.affiliation ?? "student"]}」
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {AFFILIATIONS.map((a) => {
                        const current = a.id === (r.affiliation ?? "student");
                        return (
                          <button
                            key={a.id}
                            disabled={busy || current}
                            onClick={() => void applyAffiliation(a.id, r.id)}
                            className={`rounded-lg px-2.5 py-2 text-[11px] font-bold transition active:scale-95 ${
                              current
                                ? "bg-white text-slate-900"
                                : "bg-indigo-700 text-white hover:bg-indigo-600 disabled:opacity-40"
                            }`}
                          >
                            {a.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
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
        リセットは、ふだんは畳んでおく。

        取り返しのつかない操作が、一覧のすぐ下に赤く二つ並んでいた。
        承認の作業をしているだけの人が、指を滑らせて届く場所にある。
        一段はさんで、開いたときだけ出す。
      */}
      <button
        onClick={() => setResetOpen((v) => !v)}
        className={`mt-6 w-full rounded-xl border px-3 py-2.5 text-xs font-bold transition active:scale-95 ${
          resetOpen
            ? "border-red-300 bg-red-50 text-red-900"
            : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
        }`}
      >
        {resetOpen ? "リセットを閉じる" : "リセット（やり直させる）"}
      </button>

      {resetOpen && (
        <>
      {/*
        全員をやり直させる。取り返しがつかないので、
        一覧のいちばん下に置き、色でも他と区別する。
      */}
      <div className="mt-3 rounded-xl border border-red-300 bg-red-50 p-3">
        <div className="text-xs font-bold text-red-900">学生と申請者をやり直させる</div>
        <p className="mt-1 text-[11px] leading-relaxed text-red-800">
          学生と申請者から、ログイン・パスワード・本人確認・氏名・学年・クラス・
          名列番号が消えます。<b>管理者（食堂・課外活動・教授・副管理者・管理者）は全員残ります。</b>
          消された人は申請の最初からやり直しです。元には戻せません。
        </p>
        <button
          onClick={() => void resetAll()}
          disabled={busy}
          className="mt-2 w-full rounded-lg bg-red-600 px-2 py-2.5 text-xs font-bold text-white transition hover:bg-red-700 active:scale-95 disabled:bg-slate-300"
        >
          {busy
            ? "処理中…"
            : `学生・申請者（${listed.filter((r) => r.role === "pending" || r.role === "student").length} 名）をリセットする`}
        </button>
      </div>

      {/*
        こちらは管理者も含めて全部消す。上のものより強いので下に置き、
        色もさらに濃くしてある。押すと自分もログアウトされる。
      */}
      <div className="mt-3 rounded-xl border-2 border-red-700 bg-red-100 p-3">
        <div className="text-xs font-bold text-red-900">
          管理者も含めて、すべての席を消す
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-red-900">
          申請の途中の人も、承認済みの人も、<b>副管理者（2.1・2.2）も</b>消えます。
          パスワード・本人確認・大学の情報がすべて無くなり、ログインの最初から
          やり直しになります。
          <br />
          <b>残るのは、いちばん上の権限の人だけです。</b>
          あなたがいちばん上でなければ、あなたも消えてログアウトされます。
        </p>
        <button
          onClick={() => void resetEverything()}
          disabled={busy}
          className="mt-2 w-full rounded-lg bg-red-800 px-2 py-2.5 text-xs font-bold text-white transition hover:bg-red-900 active:scale-95 disabled:bg-slate-300"
        >
          {busy
            ? "処理中…"
            : `いちばん上を除く全員（${rows.filter((r) => r.role !== "admin_l3").length} 名）を消す`}
        </button>
      </div>

      {/*
        身分ごとに消す。

        身分は申請のときに本人が選んだもので、権限とは別物。
        管理者が「教授」を選んでいることもあるので、
        巻き込む人数はボタンの上に出し、確認のときにも名前を並べる。
      */}
      <div className="mt-3 rounded-xl border border-red-300 bg-red-50 p-3">
        <div className="text-xs font-bold text-red-900">身分ごとに消す</div>
        <p className="mt-1 text-[11px] leading-relaxed text-red-800">
          申請のときに<b>本人が選んだ身分</b>で選び出して消します。権限とは別のものなので、
          管理者が入っていることがあります。数はボタンに出しています。
          <br />
          いちばん上の権限の人と、あなた自身は残ります。
        </p>
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          placeholder="あなたのログインパスワード"
          autoComplete="current-password"
          className="mt-2 w-full rounded-xl bg-white px-4 py-2.5 text-sm outline-none ring-1 ring-red-200 focus:ring-2 focus:ring-blue-500"
        />
        <div className="mt-2 flex flex-col gap-1.5">
          {AFFILIATIONS.map((a) => {
            const targets = rows.filter(
              (r) => (r.affiliation ?? "student") === a.id && r.role !== "admin_l3",
            );
            const admins = targets.filter((r) => r.role.startsWith("admin_"));
            return (
              <button
                key={a.id}
                onClick={() => void resetAffiliation(a.id)}
                disabled={busy || targets.length === 0}
                className="w-full rounded-lg bg-red-600 px-2 py-2.5 text-xs font-bold text-white transition hover:bg-red-700 active:scale-95 disabled:bg-slate-200 disabled:text-slate-400"
              >
                {a.label}（{targets.length} 名
                {admins.length > 0 ? `・うち管理者 ${admins.length} 名` : ""}）を消す
              </button>
            );
          })}
        </div>
      </div>

      {/*
        選んだ人だけを消す。

        上の二つは「全員」しか選べない。一人だけ入り直させたいときに、
        関係のない人まで巻き込むことになっていた。
        印を付けてから、ここで消す。
      */}
      <div className="mt-3 rounded-xl border border-slate-300 bg-white p-3">
        <div className="text-xs font-bold text-slate-800">選んだ人だけを消す</div>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-600">
          一覧で名前の左の印を付けてから押します。その人だけが、ログイン・
          パスワード・本人確認・大学の情報を失い、申請の最初からやり直しになります。
          <br />
          いちばん上の権限の人と、あなた自身は選んでも消えません。
        </p>
        {picked.length > 0 && (
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            placeholder="あなたのログインパスワード"
            autoComplete="current-password"
            className="mt-2 w-full rounded-xl bg-slate-100 px-4 py-2.5 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
          />
        )}
        <button
          onClick={() => void resetPicked()}
          disabled={busy || picked.length === 0}
          className="mt-2 w-full rounded-lg bg-red-600 px-2 py-2.5 text-xs font-bold text-white transition hover:bg-red-700 active:scale-95 disabled:bg-slate-200 disabled:text-slate-400"
        >
          {busy
            ? "処理中…"
            : picked.length === 0
              ? "印を付けた人はいません"
              : `印を付けた ${picked.length} 名を消す`}
        </button>
      </div>
        </>
      )}

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
              placeholder="あなたのログインパスワード（承認済みの人を変えるとき）"
              autoComplete="current-password"
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
