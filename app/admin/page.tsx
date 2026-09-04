"use client";

/**
 * 承認と権限の管理。
 *
 * ■ 二つの見方
 *   申請してきた人 … まだ権限が付いていない人。全員ここに出る
 *   既存           … すでに使っている人。学年・学科で絞って見る
 *
 *   まだ本人確認や所属の記入が済んでいない人も、申請の一覧に出す。
 *   以前は別の欄に分けていたが、申請したはずの人が見当たらず、
 *   届いていないように見えた。出したうえで、その人には権限を
 *   付けられないようにしてある（一覧の ready）。
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
import { useAdminT } from "@/lib/adminLang";
import {
  AFFILIATIONS,
  AFFILIATION_LABEL,
  CLASS_CODES,
  CLASS_NOS,
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
  /** 学科の記号。列の名前は昔のまま */
  class_code: string;
  /** クラス（1〜10）。まだ入れていない人は 0 */
  class_no: number;
  group_no: number;
  seat_no: number;
  /** 教授が申請で入れた担当学科 */
  dept_codes: string[] | null;
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

/** 確かめの文で使う改行 */
const BR = String.fromCharCode(10);

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

/**
 * 消せない権限。
 *
 * 副管理者（2.1・2.2）と、いちばん上。
 * リセットの選択肢にも並べないし、選ばれても消さない。
 *
 * 承認できる人がいなくなると、誰も入れないままアプリが止まる。
 * この三つを消したいときは、先に権限を下げてから。
 * 二手かかるが、押し間違いで戻せなくなるほうが困る。
 * 守っているのはデータベース側（reset_by_roles）で、
 * ここは並べないためのもの。
 */
const PROTECTED: Role[] = ["admin_l21", "admin_l22", "admin_l3"];

/** リセットで選べる身分。上から、弱いものの順に並べる */
const RESETTABLE: Role[] = ["pending", "student", "admin_l0", "admin_l1", "admin_l2"];

const SHORT = ROLE_SHORT;

export default function AdminPage() {
  const T = useAdminT();
  const [myRole, setMyRole] = useState<Role | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * どちらの一覧を見ているか。
   *
   * 以前は「申請」と「手続き中」を分けていた。分ける理由はあったが、
   * 申請した人が「申請」に出てこないことがあり、届いていないように見えた。
   * いまは申請してきた人をひとまとめに出し、
   * まだ手続きの途中の人には印を付けて見分ける。
   */
  const [tab, setTab] = useState<"new" | "existing">("new");
  /**
   * リセットの一式を開いているか。
   *
   * 取り返しのつかない操作なので、ふだんは畳んでおく。
   * 承認の作業をしているだけの人の指が、届く場所に無いようにする。
   */
  const [resetOpen, setResetOpen] = useState(false);
  /** チェックを入れた人 */
  const [picked, setPicked] = useState<string[]>([]);
  /** リセット選択で印を付けた身分。ここに入っている身分の人をまとめて消す */
  const [pickedRoles, setPickedRoles] = useState<Role[]>([]);
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
  /** 身分で絞る（学生・教授・その他）。null なら絞らない */
  const [fAff, setFAff] = useState<Affiliation | null>(null);
  /** クラス（1〜10）で絞る */
  const [fClassNo, setFClassNo] = useState<number | null>(null);

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

  /*
   * 以前ここにあった三つの消し方（学生と申請者／管理者も含めて全部／
   * 身分ごと）は、一つの「リセット選択」にまとめた。
   * どれがどこまで消すのかを押す前に読み解く必要があり、
   * 取り違えると戻せなかったため。いまは印を付けて消す（下の resetRoles）。
   *
   * データベース側の関数（reset_everyone / reset_everything /
   * reset_by_affiliation）は消していない。画面からは呼ばないが、
   * どうしようもなくなったときに SQL から使える道は残しておく。
   */

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
   * 選んだ身分の人を、まとめて消す（リセット選択）。
   *
   * 以前は「学生と申請者」「いちばん上を除く全員」「身分ごと」と
   * 別々のボタンに分かれていた。どれがどこまで消すのかを
   * 押す前に読み解かないと分からず、取り違えると戻せない。
   * いまは消したい身分に印を付けて、一度に消す。
   *
   * ★副管理者（2.1・2.2）と管理者は、そもそも選べない。
   *   消したいときは、先に権限を下げてから。二手かかるが、
   *   押し間違いで承認できる人がいなくなるほうが困る。
   */
  const resetRoles = async () => {
    setMsg(null);
    if (pickedRoles.length === 0) return;

    const targets = rows.filter(
      (r) => pickedRoles.includes(r.role) && !PROTECTED.includes(r.role),
    );
    if (targets.length === 0) {
      setMsg({ kind: "err", text: T("その身分の人がいません") });
      return;
    }

    const names = targets.map((r) => r.full_name || r.email).slice(0, 12);
    const first = window.confirm(
      [
        `選んだ身分の ${targets.length} 名を消します。`,
        "",
        ...pickedRoles.map(
          (r) => `  ・${ROLE_LABEL[r]}（${targets.filter((x) => x.role === r).length} 名）`,
        ),
        "",
        "この人たちから、次のものが消えます。",
        "  ・ログイン中の状態",
        "  ・パスワード",
        "  ・本人確認（認証アプリ）",
        "  ・氏名・学年・学科・クラス・名列番号",
        "  ・承認した権限",
        "",
        ...names.map((n) => "  " + n),
        targets.length > names.length ? `  ほか ${targets.length - names.length} 名` : "",
        "",
        "副管理者（2.1・2.2）と管理者、そしてあなた自身は残ります。",
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
        `本当に実行しますか？（${targets.length} 名が消えます）`,
        "",
        "これが最後の確認です。押すと元に戻せません。",
      ].join("\n"),
    );
    if (!second) return;

    setBusy(true);
    try {
      const { data, error } = await createClient().rpc("reset_by_roles", {
        p_roles: pickedRoles,
        p_password: password || null,
      });
      if (error) throw error;
      setPicked([]);
      setPickedRoles([]);
      setOpen(null);
      await load();
      setMsg({ kind: "ok", text: `${data ?? 0} 名を消しました。` });
    } catch (e) {
      setMsg({
        kind: "err",
        text:
          e instanceof Error
            ? e.message + "（base/06_admin.sql をまだ入れ直していない場合は、先に入れてください）"
            : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  /**
   * その人ひとりだけを消す。
   *
   * 中身は印を付けて消すのと同じ（reset_users）。
   * 申請してきた一人を入り直させたいだけのときに、
   * 印を付けて画面の下まで送るのが遠かったので、
   * その人の欄から直に押せるようにした。
   */
  const resetOne = async (r: Row) => {
    setMsg(null);
    const who = r.full_name || r.email;

    if (
      !window.confirm(
        [
          `${who} を消します。`,
          "",
          "この人から、次のものが消えます。",
          "  ・ログイン中の状態",
          "  ・パスワード",
          "  ・本人確認（認証アプリ）",
          "  ・氏名・学年・学科・クラス・名列番号",
          "  ・承認した権限",
          "",
          "申請の最初からやり直しになります。元には戻せません。",
          "",
          "続けますか？",
        ].join(BR),
      )
    )
      return;
    if (!window.confirm(`本当に ${who} を消しますか？${BR}${BR}これが最後の確認です。`)) return;

    setBusy(true);
    try {
      const { data, error } = await createClient().rpc("reset_users", {
        p_ids: [r.id],
        p_password: password || null,
      });
      if (error) throw error;
      setPicked((p) => p.filter((x) => x !== r.id));
      setOpen(null);
      await load();
      setMsg(
        (data as number) > 0
          ? { kind: "ok", text: `${who} を消しました。申請からやり直しになります。` }
          : { kind: "err", text: `${who} は消せませんでした（いちばん上の権限の人か、あなた自身です）` },
      );
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  /**
   * 印を付けた人だけを消す。
   *
   * 上のものは身分でまとめて選ぶ。一人だけ入り直させたい場面のために、
   * 選んだ人だけを対象にできる道も残してある。
   * 強さは変わらないので、確認は同じく二度たずねる。
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

  /**
   * 申請してきた人。まだ権限が付いていない人を、全員ここに出す。
   *
   * 以前は「本人確認と所属が済んだ人」だけを出し、途中の人は別の欄にしていた。
   * 申請したはずの人が見当たらず、届いていないように見えるので一つにした。
   * 承認できるかどうかは、その人の行で見分ける（isApplied）。
   *
   * 出そろった人を上に置く。下へ行くほど、まだ待つ人になる。
   */
  const news = useMemo(() => {
    const p = listed.filter((r) => r.role === "pending");
    return [...p].sort((a, b) => Number(isApplied(b)) - Number(isApplied(a)));
  }, [listed]);
  /** そのうち、まだ手続きの途中の人。数を出すのに使う */
  const waiting = useMemo(() => news.filter((r) => !isApplied(r)), [news]);
  const existing = useMemo(() => listed.filter((r) => r.role !== "pending"), [listed]);

  const shown = useMemo(() => {
    if (tab === "new") return news;
    return existing.filter(
      (r) =>
        (fGrade === null || r.grade === fGrade) &&
        (fClass === null || r.class_code === fClass) &&
        (fGroup === null || r.group_no === fGroup),
    );
  }, [tab, news, existing, fGrade, fClass, fGroup]);

  /**
   * 権限を付ける。
   *
   * その人の欄からは一人ぶん、下のボタンからは印を付けた人ぶんを渡す。
   * 手順は同じなので一本にしてある。
   */
  const apply = async (role: Role, ids: string[]) => {
    setMsg(null);
    if (ids.length === 0) {
      setMsg({ kind: "err", text: T("誰も選ばれていません") });
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

  if (loading) return <Shell>{T("読み込み中…")}</Shell>;

  if (!supabaseReady)
    return <Shell><p className="text-sm text-red-700">{T("サーバーに接続できません。")}</p></Shell>;

  if (!myRole)
    return (
      <Shell>
        <p className="text-sm text-slate-700">{T("ログインしていません。")}</p>
        <Link href="/login" className="mt-3 inline-block text-sm font-bold text-blue-600">{T("ログインへ")}</Link>
      </Shell>
    );

  if (!canManage(myRole))
    return (
      <Shell>
        {/* どの権限なら使えるのかは書かない。上に誰か居ることが分かってしまう */}
        <p className="text-sm text-slate-700">{T("この画面は、いまの権限では使えません。")}</p>
        <p className="mt-1 text-xs text-slate-500">現在の権限：{ROLE_LABEL[myRole]}</p>
        <Link href="/" className="mt-3 inline-block text-sm font-bold text-blue-600">{T("地図へ戻る")}</Link>
      </Shell>
    );

  /* 印を付けた中に、すでに承認した人が混ざっているか */
  const needPassword = picked.some((id) => rows.find((r) => r.id === id)?.role !== "pending");

  return (
    <Shell wide>
      <AdminHeader title={T("承認・権限の管理")} />
      <AdminMenu current="approve" role={myRole} />

      {/* 申請してきた人 / 既存 */}
      <div className="mb-3 flex gap-1 rounded-xl bg-slate-100 p-1">
        {([
          ["new", `${T("申請してきた人")}（${news.length}）`],
          ["existing", `${T("既存")}（${existing.length}）`],
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

      {/* まだ手続きの途中の人がいるときだけ、なぜ承認できないかを書く */}
      {tab === "new" && waiting.length > 0 && (
        <div className="mb-3 rounded-xl bg-amber-50 p-2.5 text-[11px] leading-relaxed text-amber-900 ring-1 ring-amber-200">
          {T("この中の")}
          <b>
            {waiting.length}
            {T("名は、まだ本人確認か所属の記入が済んでいません")}
          </b>
          。
          <br />
          {T("本人だと確かめられていないので、その人には権限を付けられません。")}
          {T("本人が Microsoft Authenticator で本人確認を済ませ、所属を入れると承認できるようになります。")}
        </div>
      )}

      {/* 既存の絞り込み */}
      {tab === "existing" && (
        <div className="mb-3 rounded-xl bg-slate-50 p-2.5">
          <Filter
            label="身分"
            value={fAff}
            onPick={setFAff}
            options={AFFILIATIONS.map((a) => [a.id, a.label])}
          />
          <Filter label="学年" value={fGrade} onPick={setFGrade} options={GRADES.map((g) => [g, `${g}年`])} />
          <Filter
            label="学科"
            value={fClass}
            onPick={setFClass}
            options={CLASS_CODES.map((c) => [c.code, c.code])}
          />
          <Filter
            label="クラス"
            value={fClassNo}
            onPick={setFClassNo}
            options={CLASS_NOS.map((n) => [n, String(n)])}
          />
          {/* 名列番号は200通りあるので、並べて絞り込む形にはしない。
              身分・学年・学科・クラスで絞ったうえで、一覧から探す */}
        </div>
      )}

      <p className="mb-2 text-[11px] text-slate-500">
        {shown.length} {T("名")}
        <span className="ml-2 text-slate-400">{T("名前を押すと権限を変えられます")}</span>
        {picked.length > 0 && (
          <b className="ml-2 text-blue-700">
            {picked.length} {T("名に印")}
          </b>
        )}
      </p>

      {/* 一覧 */}
      <ul className="space-y-1.5">
        {shown.map((r) => {
          const on = picked.includes(r.id);
          const here = open === r.id;
          /* すでに承認した人を触るときは、本人のログインパスワードが要る（データベース側の決まり） */
          const needsPw = r.role !== "pending";
          /*
           * 権限を触れる相手か。
           *
           * 申請が出そろっていない人には触らせない。本人だと
           * 確かめられていないので、承認してはいけない相手。
           * 一覧には出す。届いていることは見えたほうがよい。
           */
          const ready = r.role !== "pending" || isApplied(r);
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
                    手続きの途中の人は承認の対象にしないので出さない */}
                {ready && (
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
                  onClick={() => ready && setOpen(here ? null : r.id)}
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
                        {T("本人確認まだ")}
                      </span>
                    )}
                    {r.verified &&
                      (r.affiliation ?? "student") === "student" &&
                      !(r.grade && r.class_code && r.seat_no) && (
                      <span className="ml-1.5 rounded bg-amber-100 px-1 py-0.5 text-[9px] font-bold text-amber-800">
                        {T("所属まだ")}
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
                    {/* クラス（1〜10）。入れていない人には出さない */}
                    {r.class_no ? `-${r.class_no}` : ""}
                    {r.seat_no ? ` ${r.seat_no}番` : r.group_no ? `-${r.group_no}` : ""}
                    {/* 教授の担当学科。学生には無い */}
                    {(r.dept_codes ?? []).length > 0 && (
                      <span className="ml-2 text-slate-500">
                        {T("担当")} {(r.dept_codes ?? []).join("・")}
                      </span>
                    )}
                    <span className="ml-2 rounded bg-slate-200 px-1 py-0.5 font-bold text-slate-700">
                      {SHORT[r.role]}
                    </span>
                  </span>
                </button>

                {ready && (
                  <span
                    className={`mt-1 shrink-0 text-slate-400 transition ${here ? "rotate-90" : ""}`}
                  >
                    ›
                  </span>
                )}
              </div>

              {/* その人の権限を変える欄。本人確認が済んでいない人には出さない */}
              {here && ready && (
                <div className="mt-1 rounded-xl bg-slate-900 p-2.5">
                  <div className="mb-1.5 text-[10px] font-bold text-slate-400">
                    {T("権限を変える")}
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
                        placeholder={T("あなたのログインパスワード")}
                        autoComplete="current-password"
                        className="mt-2 w-full rounded-lg bg-slate-800 px-3 py-2 text-sm text-white placeholder:text-slate-500 outline-none focus:ring-2 focus:ring-blue-500"
                      />
                      <p className="mt-1 text-[10px] text-slate-500">
                        {T("一度承認した人を変えるには、ご自身のログインパスワードが要ります")}
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
                      {T("身分を直す")}
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

                  {/*
                    この人だけをリセットする。

                    印を付けて下のボタンから消す道もあるが、
                    申請してきた一人を入り直させたいだけのときに、
                    印を付けて画面の下まで送るのは遠い。
                    開いているこの欄から、その場でできるようにする。
                  */}
                  <div className="mt-3 border-t border-slate-700 pt-2">
                    <div className="mb-1.5 text-[10px] font-bold text-slate-400">
                      {T("この人をリセットする")}
                      <span className="ml-1.5 font-normal text-slate-500">
                        {T("申請の最初からやり直しになります")}
                      </span>
                    </div>
                    <input
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      type="password"
                      placeholder={T("あなたのログインパスワード")}
                      autoComplete="current-password"
                      className="w-full rounded-lg bg-slate-800 px-3 py-2 text-xs text-white outline-none ring-1 ring-slate-700 focus:ring-2 focus:ring-red-400"
                    />
                    <button
                      onClick={() => void resetOne(r)}
                      disabled={busy}
                      className="mt-1.5 w-full rounded-lg bg-red-600 px-2 py-2 text-[11px] font-bold text-white transition hover:bg-red-700 active:scale-95 disabled:bg-slate-700 disabled:text-slate-500"
                    >
                      {busy ? T("処理中…") : T("この人を消して、申請からやり直させる")}
                    </button>
                  </div>
                </div>
              )}

            </li>
          );
        })}
        {shown.length === 0 && (
          <li className="rounded-xl bg-slate-50 p-4 text-center text-xs text-slate-500">
            {T("該当する人がいません")}
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
        リセット選択。

        消したい身分に印を付けて、まとめて消す。
        以前は「学生と申請者」「いちばん上を除く全員」「身分ごと」と
        ボタンが分かれていて、どれがどこまで消すのかを
        押す前に読み解かないと分からなかった。

        副管理者（2.1・2.2）と管理者は、そもそも並べない。
        消したいときは、先に権限を下げてから。
      */}
      <div className="mt-3 rounded-xl border border-red-300 bg-red-50 p-3">
        <div className="text-xs font-bold text-red-900">{T("リセット選択")}</div>
        <p className="mt-1 text-[11px] leading-relaxed text-red-800">
          {T("消したい身分に印を付けてください。印を付けたものは、まとめて消えます。")}
          <br />
          {T("その人たちから、ログイン・パスワード・本人確認・大学の情報がすべて消え、申請の最初からやり直しになります。元には戻せません。")}
          <br />
          <b>{T("副管理者（2.1・2.2）と管理者、そしてあなた自身は消えません。")}</b>
          {T("この人たちを消すときは、先に権限を下げてください。")}
        </p>

        <div className="mt-2 flex flex-col gap-1.5">
          {RESETTABLE.map((r) => {
            const targets = listed.filter((x) => x.role === r);
            const on = pickedRoles.includes(r);
            return (
              <button
                key={r}
                onClick={() =>
                  setPickedRoles((prev) =>
                    on ? prev.filter((x) => x !== r) : [...prev, r],
                  )
                }
                disabled={busy || targets.length === 0}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2.5 text-left text-xs font-bold transition active:scale-95 disabled:opacity-40 ${
                  on ? "bg-red-600 text-white" : "bg-white text-slate-700 ring-1 ring-red-200"
                }`}
              >
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] ${
                    on ? "bg-white text-red-600" : "bg-white text-transparent ring-1 ring-slate-300"
                  }`}
                >
                  ✓
                </span>
                <span className="flex-1">{T(ROLE_LABEL[r])}</span>
                <span className={on ? "text-red-100" : "text-slate-400"}>
                  {targets.length} {T("名")}
                </span>
              </button>
            );
          })}
        </div>

        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          placeholder={T("あなたのログインパスワード")}
          autoComplete="current-password"
          className="mt-2 w-full rounded-xl bg-white px-4 py-2.5 text-sm outline-none ring-1 ring-red-200 focus:ring-2 focus:ring-blue-500"
        />

        <button
          onClick={() => void resetRoles()}
          disabled={busy || pickedRoles.length === 0}
          className="mt-2 w-full rounded-lg bg-red-700 px-2 py-2.5 text-xs font-bold text-white transition hover:bg-red-800 active:scale-95 disabled:bg-slate-200 disabled:text-slate-400"
        >
          {busy
            ? T("処理中…")
            : pickedRoles.length === 0
              ? T("消す身分を選んでください")
              : `${T("選んだ")} ${listed.filter((x) => pickedRoles.includes(x.role)).length} ${T("名を消す")}`}
        </button>
      </div>

      {/*
        選んだ人だけを消す。

        上の二つは「全員」しか選べない。一人だけ入り直させたいときに、
        関係のない人まで巻き込むことになっていた。
        印を付けてから、ここで消す。
      */}
      <div className="mt-3 rounded-xl border border-slate-300 bg-white p-3">
        <div className="text-xs font-bold text-slate-800">{T("選んだ人だけを消す")}</div>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-600">
          {T("一覧で名前の左の印を付けてから押します。その人だけが、ログイン・")}
          {T("パスワード・本人確認・大学の情報を失い、申請の最初からやり直しになります。")}
          <br />
          {T("いちばん上の権限の人と、あなた自身は選んでも消えません。")}
        </p>
        {picked.length > 0 && (
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            placeholder={T("あなたのログインパスワード")}
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
              {T("印を外す")}
            </button>
          </div>
          {needPassword && (
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              placeholder={T("あなたのログインパスワード（承認済みの人を変えるとき）")}
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

// 型の名前は V。T は翻訳の関数に使っているので、ぶつからないようにする
function Filter<V extends string | number>({
  label,
  value,
  onPick,
  options,
}: {
  label: string;
  value: V | null;
  onPick: (v: V | null) => void;
  options: [V, string][];
}) {
  const T = useAdminT();
  return (
    <div className="mb-1.5 last:mb-0">
      <div className="mb-1 text-[10px] font-bold text-slate-500">{label}</div>
      <div className="flex flex-wrap gap-1">
        <Chip on={value === null} onClick={() => onPick(null)}>
          {T("すべて")}
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
