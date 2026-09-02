/**
 * 認証まわりの共通処理。
 *
 * ログインできるのは大学のアカウントだけ。
 * ただし「弾く」のは画面側の親切であって、守っているのは RLS。
 */

/**
 * 権限。
 *
 * admin_l0 は上下の段ではなく、役目で分けたもの。
 * 大学の情報と食堂のメニューを預かる係で、予約や承認には関わらない。
 */
export type Role =
  | "pending"
  | "student"
  | "admin_l0"
  | "admin_l1"
  | "admin_l2"
  /** レベル2.1。承認・権限の管理**以外**は、すべてできる */
  | "admin_l21"
  /** レベル2.2。すべてできるが、「管理者も消す」では自分も消える */
  | "admin_l22"
  | "admin_l3";

/** 許可するメールドメイン。教職員のドメインが分かったらここに足す */
export const ALLOWED_DOMAINS = ["st.example.ac.jp", "example.ac.jp"];

export function isAllowedEmail(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase().trim();
  return ALLOWED_DOMAINS.includes(domain);
}

/**
 * パスワードの決まり。半角の英数字で 8〜20 字、数字を1文字以上。
 *
 * 記号は入れさせない。打てる端末とそうでない端末があり、
 * 打ち間違いも増える。そのぶん長さの下限を8に上げてある。
 * 数字を1文字求めるのは、英字だけの短い言葉を避けるため。
 */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 20;

export function checkPassword(pw: string): string | null {
  if (pw.length < PASSWORD_MIN || pw.length > PASSWORD_MAX)
    return `パスワードは半角${PASSWORD_MIN}〜${PASSWORD_MAX}字にしてください`;
  if (!/^[0-9A-Za-z]+$/.test(pw)) return "半角の英数字だけで入力してください";
  if (!/[0-9]/.test(pw)) return "数字を1文字以上入れてください";
  return null;
}

/**
 * 身分。申請のいちばん最初に、本人が選ぶ。
 *
 * これは自己申告であって、権限ではない。ここで「教授」を選んでも
 * それだけで教授の権限は付かない。権限を決めるのは承認する人で、
 * これは「この人は教授だと言っている」という手がかりにすぎない。
 * だから Role とは別のものにしてある。
 *
 * 学年・クラス・名列番号は学生にしか無いので、
 * ここで student を選んだ人にだけ訊く。
 */
export type Affiliation = "student" | "teacher" | "other";

export const AFFILIATIONS: { id: Affiliation; label: string; sub: string }[] = [
  { id: "student", label: "学生", sub: "学年・クラス・名列番号があります" },
  { id: "teacher", label: "教授・教員", sub: "授業を受け持っています" },
  { id: "other", label: "その他", sub: "職員・関係者など" },
];

export const AFFILIATION_LABEL: Record<Affiliation, string> = {
  student: "学生",
  teacher: "教授・教員",
  other: "その他",
};

/** 学年・クラス・名列番号を訊く相手か */
export function needsClassInfo(a: Affiliation | null): boolean {
  return a === "student";
}

/** 学年。申請のときに選ぶ */
export const GRADES = [1, 2, 3, 4] as const;

/** 組。申請のときに選ぶ */
/**
 * 名列番号の範囲。
 *
 * クラスの中で一人ずつに振られた番号。1から200まで。
 * ボタンで選ばせるには多すぎるので、数字を打ち込む形にする。
 */
export const SEAT_MIN = 1;
export const SEAT_MAX = 200;

/** 名列番号として正しいか。合っていれば null、違えば理由を返す */
export function checkSeat(n: number): string | null {
  if (!Number.isInteger(n) || n < SEAT_MIN || n > SEAT_MAX)
    return `名列番号は${SEAT_MIN}から${SEAT_MAX}までの数字です`;
  return null;
}

/** 以前の「組」。名列番号に変えたので、もう画面では使わない */
export const GROUPS = [1, 2, 3, 4, 5, 6, 7] as const;

/**
 * クラス記号。学科ごとに決まっている。
 *
 * departments.code と同じ並び。ここに直書きしているのは、
 * 申請の画面がログイン前に出るため。ログインしていないと
 * RLS で departments を読めず、選択肢が空になってしまう。
 */
export const CLASS_CODES = [
  { code: "KM", name: "機械工学科" },
  { code: "KS", name: "先進機械システム工学科" },
  { code: "KA", name: "航空宇宙工学科" },
  { code: "KE", name: "電気エネルギーシステム工学科" },
  { code: "KI", name: "電子情報システム工学科" },
  { code: "KC", name: "環境土木工学科" },
  { code: "CC", name: "情報工学科" },
  { code: "CA", name: "知能情報システム学科" },
  { code: "CR", name: "ロボティクス学科" },
  { code: "DM", name: "経営情報学科" },
  { code: "DE", name: "環境デザイン創成学科" },
  { code: "MM", name: "メディア情報学科" },
  { code: "MP", name: "心理情報デザイン学科" },
  { code: "AE", name: "建築学科" },
  { code: "AD", name: "建築デザイン学科" },
  { code: "BE", name: "環境・応用化学科" },
  { code: "BS", name: "生命・応用バイオ学科" },
] as const;

/**
 * 権限の呼び名。
 *
 * 段の番号ではなく、その人が何をする人かで呼ぶ。
 * 「Lv1」では何ができるのか伝わらないため。
 * いちばん強い権限だけは番号も段も出さず「管理者」とだけ書く。
 */
export const ROLE_LABEL: Record<Role, string> = {
  pending: "承認待ち",
  student: "学生・教職員",
  admin_l0: "食堂の担当",
  admin_l1: "課外活動リーダー",
  admin_l2: "教授",
  admin_l21: "副管理者（承認なし）",
  admin_l22: "副管理者",
  admin_l3: "管理者",
};

/** 狭い場所に出す用。長さを揃えたいときに使う */
export const ROLE_SHORT: Record<Role, string> = {
  pending: "承認待ち",
  student: "学生",
  admin_l0: "食堂",
  admin_l1: "課外活動",
  admin_l2: "教授",
  admin_l21: "副（承認なし）",
  admin_l22: "副",
  admin_l3: "管理者",
};

/** 学内情報を見られるか */
export function canViewCampusInfo(role: Role | null): boolean {
  return role !== null && role !== "pending";
}

/**
 * 承認・昇降格ができるか。
 *
 * レベル2.1 はここだけができない。人の権限に触れるのは 2.2 と 3 だけ。
 */
export function canManage(role: Role | null): boolean {
  return role === "admin_l3" || role === "admin_l22";
}

/**
 * 情報について、いちばん上と同じことができるか。
 *
 * 予定・食堂・教室の登録と、他人が立てたものの削除。
 * 承認・権限の管理はここには含まない（canManage のほう）。
 */
export function canManageAll(role: Role | null): boolean {
  return role === "admin_l3" || role === "admin_l22" || role === "admin_l21";
}

/**
 * 「管理者も消す」を実行したときに、その人が残るか。
 *
 * いちばん上だけが残る。2.2 は「すべてできるが消える」権限。
 * 誰も残らないと承認できる人がいなくなるので、必ず一人は残す。
 */
export function survivesFullReset(role: Role | null): boolean {
  return role === "admin_l3";
}

/**
 * 食堂と大学の情報を預かれるか。
 *
 * 上下の段ではなく役目で決まるので、rank の大小では判定しない。
 * 守っているのは RLS のほうで、ここは画面を出し分けるためだけのもの。
 */
export function canManageCafeteria(role: Role | null): boolean {
  return role === "admin_l0" || canManageAll(role);
}

/**
 * 使っている人からの感想を読めるか。
 *
 * 教授（レベル2）・副管理者（2.1・2.2）・いちばん上だけ。
 * 学生にも、食堂の担当にも見せない。
 *
 * 段（rank）では分けられない。食堂の担当と学生は同じ段1で、
 * 段3以上にすると 2.1・2.2 の扱いが名前まかせになる。
 * 誰に見せるかをそのまま書くほうが、あとから読んで間違えない。
 * ここは画面を出し分けるためのもので、守っているのは RLS。
 */
export function canReadFeedback(role: Role | null): boolean {
  return role === "admin_l2" || canManageAll(role);
}
