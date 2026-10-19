/**
 * ログインの画面が「次にどの段を出すか」を決めるところ。
 *
 * ■ なぜ画面から出したか
 *   ここは入れたものだけで答えが決まる部分なのに、
 *   2,000行の画面の真ん中にあった。組み合わせが多いので
 *   （身分3つ × 認証アプリ × 情報 × パスワード × 権限 × 端末）、
 *   画面を開かずに机の上で確かめられるようにしておきたい。
 *
 *   実際、ここの取り違えで「済ませたのに、また最初から」が
 *   何度か起きている。直したら、そのたびに全部の組み合わせを
 *   通して確かめられるようにする。
 */

export type Aff = "student" | "teacher" | "other";

/** ログインの画面で出す段 */
export type Step = "mfa" | "info" | "password" | "verify" | "done";

/** profiles の行のうち、ここで使うぶんだけ */
export type Row = {
  role?: string;
  affiliation?: string | null;
  grade?: number | null;
  class_code?: string | null;
  /** あとから足した列。古いデータベースには無い */
  class_no?: number | null;
  seat_no?: number | null;
  staff_no?: string | null;
  /** あとから足した列。古いデータベースには無い */
  dept_codes?: string[] | null;
};

/**
 * 身分をどこから取るか。
 *
 * 情報（profiles）を先に見る。席の控え（user_metadata）は席を作った
 * ときのままで、あとから直しても変わらないため。控えを先に見ていた
 * ころは、教授として入れたのに学生として扱われ、学年や名列番号を
 * 求められて先へ進めなくなっていた。
 */
export function pickAff(row: Row, metaAff?: unknown): Aff {
  const a = (row.affiliation || "") || (typeof metaAff === "string" ? metaAff : "") || "student";
  return a === "teacher" || a === "other" ? a : "student";
}

/**
 * 大学の情報が埋まっているか。身分によって要るものが違う。
 *
 *   学生   学年・学科・クラス・名列番号
 *   教授   8桁の番号・担当学科
 *   その他  8桁の番号
 *
 * ★ 列そのものが無いときは、訊きようがないので「足りている」とする。
 *   クラス（class_no）と担当学科（dept_codes）はあとから足した列で、
 *   その SQL をまだ流していないデータベースがある。足りないと見なすと、
 *   埋めても先へ進めない画面になってしまう。
 */
export function infoState(row: Row, aff: Aff): { done: boolean; missing: string[] } {
  const staff = row.staff_no ?? "";
  const hasClassNo = "class_no" in row;
  const hasDepts = "dept_codes" in row;

  if (aff === "student") {
    const missing = [
      !row.grade ? "学年" : "",
      !row.class_code ? "学科" : "",
      hasClassNo && !row.class_no ? "クラス" : "",
      !row.seat_no ? "名列番号" : "",
    ].filter((x) => x !== "");
    return { done: missing.length === 0, missing };
  }

  const missing = [
    staff.length !== 8 ? "8桁の番号" : "",
    aff === "teacher" && hasDepts && (row.dept_codes ?? []).length === 0 ? "担当学科" : "",
  ].filter((x) => x !== "");
  return { done: missing.length === 0, missing };
}

export type StepInput = {
  /** profiles.role。承認前は "pending" */
  role: string;
  /** 認証アプリが登録され、確認まで済んでいるか */
  hasFactor: boolean;
  /** 大学の情報が埋まっているか */
  infoDone: boolean;
  /** 本人がパスワードを決めたか */
  pwSet: boolean;
  /** この端末で、前に本人確認を済ませているか */
  trusted: boolean;
  /**
   * このログインで、認証アプリの6桁を確かめたか（aal2）。
   *
   * データベースは、6桁を確かめていない管理者を学生として扱う
   * （base/01_core.sql）。確かめないまま管理画面へ行かせると、
   * 何を押しても「権限がありません」になる。
   */
  aal2: boolean;
};

/** 管理の権限。これを持つ人は、ログインのたびに6桁を確かめる */
const ADMIN_ROLES = new Set(["admin_l0", "admin_l1", "admin_l2", "admin_l21", "admin_l22", "admin_l3"]);

/** 管理の権限を持っているか */
export function isAdminRole(role: string): boolean {
  return ADMIN_ROLES.has(role);
}

/**
 * 次にどの段を出すか。
 *
 * ★ 認証アプリをいちばん先に見る
 *   前は「承認済みなら done」を先に決めていたので、承認済みなのに
 *   認証アプリが未登録の人（データベースから直に権限を付けた
 *   最初の管理者など）がどの枝にも入らず、6桁を入れる画面が
 *   どこにも出なかった。登録し直す道が無くなっていた。
 */
export function decideStep(i: StepInput): Step {
  if (!i.hasFactor) return "mfa";
  if (i.role === "pending" && !i.infoDone) return "info";
  if (i.role === "pending" && !i.pwSet) return "password";
  /*
   * 承認済みの人は、知らない端末なら認証アプリで確かめてもらう。
   * 毎回だと使ってもらえず、一度きりだと、パスワードが漏れた時点で
   * どこからでも入れてしまう。その間を取っている。
   */
  if (i.role !== "pending") {
    /*
     * 管理の権限を持つ人は、覚えた端末でも、このログインで6桁を
     * 確かめるまでは先へ進めない。
     *
     * パスワードだけで管理者の操作ができると、パスワードを盗まれた
     * ときに二要素が何も守らない。データベース（36）も同じ決まりで
     * 見ているので、ここで省くと管理画面が使えなくなるだけになる。
     *
     * 一度確かめれば、ログインが続くあいだ（トークンを更新しても）保たれる。
     * 求められるのは、ログインし直したときだけ。
     */
    if (isAdminRole(i.role) && !i.aal2) return "verify";
    return i.trusted ? "done" : "verify";
  }
  /* 承認待ちだが、出すものは全部出した。あとは待つだけ */
  return "done";
}
