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
/**
 * 許可するメールドメイン。
 *
 * ■ コードに書かない
 *   大学のドメインは、このファイルには置かない。GitHub に上げる所には
 *   学校の情報を残さない、という決まりにしてある。
 *   値は環境変数から読む。
 *
 *     手元    .env.local に NEXT_PUBLIC_ALLOWED_DOMAINS を書く
 *     本番    Vercel の Environment Variables に同じものを入れる
 *
 *   例: NEXT_PUBLIC_ALLOWED_DOMAINS=st.example.ac.jp,example.ac.jp
 *
 * ■ 入っていないときは「通す」
 *   入れ忘れたときに全員を弾くと、いま使えている人までログインできなくなる。
 *   ここは画面の親切であって、守っているのはデータベース側の
 *   check_email_domain（01_base.sql）。あちらは必ず効くので、
 *   ここが空でも大学以外のアドレスは通らない。
 */
export const ALLOWED_DOMAINS: string[] = (process.env.NEXT_PUBLIC_ALLOWED_DOMAINS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export function isAllowedEmail(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  // 決めていないなら、ここでは弾かない（守りはデータベース側）
  if (ALLOWED_DOMAINS.length === 0) return true;
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

/** 学年・学科・クラス・名列番号を訊く相手か */
export function needsClassInfo(a: Affiliation | null): boolean {
  return a === "student";
}

/** 担当学科を訊く相手か。教授だけ */
export function needsDepts(a: Affiliation | null): boolean {
  return a === "teacher";
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
 * クラス（1〜10）。
 *
 * 同じ学科・同じ学年の中で、さらに分かれている組のこと。
 * 名簿の F 列に入っている番号と同じものを指す。
 *
 * 学科（下の CLASS_CODES）とは別。以前はこの二つを
 * ひとまとめに「クラス」と呼んでいて、画面の表記も
 * そうなっていたが、名簿と突き合わせるときに区別が要る。
 */
export const CLASS_NOS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

/** クラスとして正しいか。合っていれば null、違えば理由を返す */
export function checkClassNo(n: number): string | null {
  if (!Number.isInteger(n) || n < 1 || n > 10) return "クラスは1から10までの数字です";
  return null;
}

/**
 * 教授が申請で入れられる、担当学科の数。
 *
 * 名簿の I〜N 列（6つ）と同じ数にしてある。
 * 画面でこれより多く入れられると、名簿へ写せなくなる。
 */
export const DEPT_MAX = 6;

/**
 * 学科の記号。
 *
 * departments.code と同じ並び。ここに直書きしているのは、
 * 申請の画面がログイン前に出るため。ログインしていないと
 * RLS で departments を読めず、選択肢が空になってしまう。
 *
 * 名前は CLASS_CODES のまま。データベースの列
 * （profiles.class_code、roster_students.class_code）と
 * 揃えてある。指しているのは学科で、クラス（1〜10）ではない。
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

/* ---------------- 予定に入れられる種類 ---------------- */

/** 予定の種類。授業・イベント・課外活動 */
export type SlotKind = "class" | "event" | "activity";

/**
 * 授業を入れられるか。教授（レベル2）と、2.1・2.2・管理者。
 *
 * 課外活動リーダー（Lv1）は入れられない。
 * 守っているのはデータベース側（register_slots）で、
 * ここは画面の出し分けのため。
 */
export function canRegisterClass(role: Role | null): boolean {
  return role === "admin_l2" || canManageAll(role);
}

/**
 * 登録されている予定を、日ごとに見られるか。
 *
 * 課外活動リーダー（Lv1）・教授（Lv2）・2.1・2.2・管理者。
 * 予定を入れられる人と同じ顔ぶれにしてある。
 * 自分が入れたものが、どの日のどの時限に入ったのかを
 * 確かめる欄なので、入れられる人には見せる。
 *
 * 学生には出さない。学生は地図の「学内の情報」から時間割を見る。
 */
export function canViewPlans(role: Role | null): boolean {
  return role === "admin_l1" || role === "admin_l2" || canManageAll(role);
}

/**
 * 教室を、まとめて選べるか。
 *
 * 「すべての号館」と「空いている教室をすべて選ぶ」の二つ。
 * 教授（レベル2）と、2.1・2.2・管理者だけ。
 *
 * 課外活動リーダー（Lv1）には出さない。一度押すだけで
 * 全号館ぶんの予定が立ってしまい、押し間違いの取り返しがつかない。
 * 一つずつ選ぶ道は、その人にも残してある。
 *
 * 中身は canRegisterClass と同じ顔ぶれだが、別の関数にしてある。
 * 「授業を入れられる人」と「まとめて選べる人」は別の決まりで、
 * 片方を変えたときにもう片方まで動くと困るため。
 */
export function canPickAllRooms(role: Role | null): boolean {
  return role === "admin_l2" || canManageAll(role);
}

/**
 * その人が選べる種類。押せないものは並べない。
 *
 * 押せないボタンを灰色で並べておくと「押せるはずのものが押せない」と
 * 受け取られる。できることだけを並べる。
 */
export function pickableKinds(role: Role | null): SlotKind[] {
  return canRegisterClass(role)
    ? ["class", "event", "activity"]
    : ["event", "activity"];
}

/**
 * いま実際に選ばれている種類。
 *
 * ■ なぜ「押した値」をそのまま使わないか
 *
 *   画面の既定は「授業」。権限が分かるのは profiles を読み終えたあとで、
 *   それまでのあいだ押した値は "class" のまま。そのまま描くと、
 *   授業を入れられない人の画面が「授業が選ばれているのに、
 *   授業のボタンは無い」形で始まる。
 *
 *   選べないものが選ばれていたら、選べるものの先頭へ読み替える。
 *   状態を書き戻す（useEffect で setKind）のではなく、描くときに決める。
 *   書き戻す形だと、一度おかしな姿で描いてから直すことになる。
 */
export function effectiveKind(role: Role | null, picked: SlotKind): SlotKind {
  const ok = pickableKinds(role);
  return ok.includes(picked) ? picked : ok[0];
}

/**
 * 名簿を見られるか。
 *
 * 教授（レベル2）は、学生の名簿だけ見られる。
 * 教職員の名簿には8桁の番号が並ぶので、そちらは見せない。
 * 入れる・変える・消すは canManageAll のほう（2.1・2.2・管理者だけ）。
 *
 * ここは画面を出し分けるためのもので、守っているのは
 * データベース側の can_read_roster / can_manage_roster。
 */
export function canReadRoster(role: Role | null): boolean {
  return role === "admin_l2" || canManageAll(role);
}
