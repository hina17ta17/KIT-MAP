/**
 * 名簿の xlsx を、どう読むか。
 *
 * ■ なぜ画面から出したか
 *   ここは「どの列が何か」を決めているだけの、入れたものだけで
 *   答えが決まる部分。画面の中に置いておくと、
 *   ブラウザを立ち上げないと確かめられない。
 *   ずれの直し方を入れたので、そこは机の上で試せるようにしておきたい。
 */

import type { Row } from "@/lib/xlsx";

/**
 * xlsx の列。A列から順に。
 *
 *   A 身分（学生・教授・その他）
 *   B メールアドレス
 *   C 氏名
 *   D 学年            学生だけ
 *   E 学科            学生だけ。KM・CC など
 *   F クラス（1〜10）  学生だけ
 *   G 名列番号        学生だけ
 *   H 学籍番号        学生だけ。アドレスの7桁と同じもの
 *   I〜N 担当学科     教授だけ。いくつでも（空けてよい）
 *   O 8桁の番号       教授とその他
 *   P 教職            学生と教授。履修していれば T
 *
 * 身分ごとに使う列
 *   学生    A B C D E F G H        P
 *   教授    A B C  I〜N O          P
 *   その他  A B C      O
 *
 * ★E列は以前「クラス」と書いていたが、指しているのは学科。
 *   クラス（1〜10）は新しく F 列に分けた。
 *
 * ★この並びは「見出しが無いとき」の当て方。
 *   見出しの行があれば、そちらから読み取る（下の readHead）。
 */
export const COLS = [
  "kind",
  "email",
  "name",
  "grade",
  "class_code",
  "class_no",
  "seat_no",
  "student_no",
  "dept1",
  "dept2",
  "dept3",
  "dept4",
  "dept5",
  "dept6",
  "number",
  "teaching",
] as const;

/** そのうち担当学科の列（I〜N）。まとめて一つの並びにして送る */
export const DEPT_COLS = ["dept1", "dept2", "dept3", "dept4", "dept5", "dept6"] as const;

export type Col = (typeof COLS)[number];
export type DeptCol = (typeof DEPT_COLS)[number];
/** 担当学科以外の列。こちらは一つずつそのまま送る */
export type PlainCol = Exclude<Col, DeptCol>;

export const isDeptCol = (c: Col): c is DeptCol =>
  (DEPT_COLS as readonly string[]).includes(c);

/** データベースへ渡す一行。担当学科だけは並びにまとめる */
export type Sending = { row: number; depts: string[] } & Record<PlainCol, string>;

/** 数の欄。読むときに整える */
export const NUM_COLS: readonly string[] = ["grade", "class_no", "seat_no"];
/** 全角のままだと突き合わせで落ちる欄。半角にそろえる */
export const HALF_COLS: readonly string[] = ["email", "student_no", "number", "class_code"];

/**
 * 学籍番号として使う7桁の数字を取り出す。
 *
 * 学籍番号は「アドレスに書いてある7桁の数字」。
 *   c1234567@st.example.ac.jp → 1234567
 *   c1234567                  → 1234567
 *   1234567                   → 1234567
 *   7桁にならないもの          → 空
 *
 * 通す・弾くを決めるのはデータベース側（student_no_of）。
 * ここは、押す前に画面で気づけるようにするための同じ計算。
 */
export function studentNoOf(text: string): string {
  const local = (text ?? "").split("@")[0];
  const digits = local.replace(/\D/g, "");
  return digits.length === 7 ? digits : "";
}

/** 「１３」「13番」「13.0」→ "13"。数として読めなければ空 */
export function numOf(text: string): string {
  const s = (text ?? "")
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s　,]/g, "");
  const m = /\d+/.exec(s);
  return m ? String(Number(m[0])) : "";
}

/** 全角の英数字と記号を半角に直す。アドレスや番号がこれで落ちないように */
export function toHalf(text: string): string {
  return (text ?? "")
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ")
    .trim();
}

/** 0 → "A"、26 → "AA" */
export function colName(n: number): string {
  let s = "";
  let i = n;
  do {
    s = String.fromCharCode(65 + (i % 26)) + s;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return s;
}

/** 画面に出すときの呼び名 */
export const LABEL: Record<string, string> = {
  kind: "身分",
  email: "メール",
  name: "氏名",
  grade: "学年",
  class_code: "学科",
  class_no: "クラス",
  seat_no: "名列番号",
  student_no: "学籍番号",
  number: "8桁の番号",
  teaching: "教職",
  dept: "担当学科",
};

/**
 * 見出しの言葉から、その列が何かを決める。
 *
 * ■ なぜ要るか
 *
 *   A列から順に決め打つと、表の作り方が少しでも違えば全部ずれる。
 *   実際に困ったのが、クラス（F）を足す前に作られた表。
 *
 *     いまの決まり  … D学年 E学科 F クラス G名列番号 H学籍番号
 *     前の表        … D学年 E学科 F 名列番号 G学籍番号
 *
 *   一つずれるので、名列番号のところに学籍番号（c1234567）が入る。
 *   数に直せず、その行——どころか取り込みまるごと——が落ちていた。
 *   「名列番号が入らない」の正体はこれ。
 *
 *   見出しの行があるなら、そちらを信じる。列を足しても、順を
 *   入れ替えても、間に別の列があっても、名前で拾える。
 *
 * ■ 「クラス」だけは、言葉では決められない
 *
 *   前の表では、学科の列の見出しが「クラス」だった。
 *   同じ言葉が、いまは 1〜10 の組を指す。
 *   だから、その列に何が入っているかを見て決める。
 *     ほとんどが 1〜10 の数 → クラス
 *     そうでない            → 学科
 */
const HEAD_WORDS: { col: Col | "dept" | "class?"; words: string[] }[] = [
  { col: "kind", words: ["身分", "区分", "種別"] },
  { col: "email", words: ["メール", "アドレス", "mail", "e-mail"] },
  { col: "name", words: ["氏名", "名前", "なまえ"] },
  { col: "grade", words: ["学年"] },
  { col: "seat_no", words: ["名列", "出席番号", "席番", "座席"] },
  { col: "student_no", words: ["学籍"] },
  { col: "teaching", words: ["教職"] },
  // 担当学科（I〜N）。「担当」が付いていれば、いくつでもここへ集める
  { col: "dept", words: ["担当"] },
  { col: "number", words: ["8桁", "８桁", "職員番号", "教職員番号", "職員"] },
  // 学科は「担当」より後に見る（担当学科を先に拾わせるため）
  { col: "class_code", words: ["学科", "コース", "記号"] },
  // ここだけは中身も見て決める
  { col: "class?", words: ["クラス", "組"] },
];

/** その升目が、どの列の見出しに当たるか */
export function headOf(cell: string): Col | "dept" | "class?" | null {
  const t = (cell ?? "").replace(/[\s　]/g, "");
  if (t === "") return null;
  for (const h of HEAD_WORDS) {
    if (h.words.some((w) => t.includes(w))) return h.col;
  }
  return null;
}

export type Head = { at: number; map: Map<number, string> };

/**
 * 見出しの行を探して、列の当て方を作る。
 *
 * 見つからなければ null。そのときは今までどおり A列から順に当てる。
 * 見出しらしいと言えるのは、知っている言葉が三つ以上あるとき。
 * 一つ二つでは、たまたま人の名前が当たっただけかもしれない。
 */
export function readHead(raw: Row[]): Head | null {
  for (let i = 0; i < Math.min(raw.length, 10); i++) {
    const cells = raw[i] ?? [];
    const map = new Map<number, string>();
    let hit = 0;
    for (let n = 0; n < cells.length; n++) {
      const c = headOf(cells[n] ?? "");
      if (!c) continue;
      // 同じ列が二度出たら、先に出たほうを残す（担当学科は別）
      if (c !== "dept" && [...map.values()].includes(c)) continue;
      map.set(n, c);
      hit += 1;
    }
    if (hit < 3) continue;

    /*
     * 「クラス」の列を、中身で決める。
     * 下の行を20行ぶんのぞいて、1〜10 の数がほとんどならクラス、
     * そうでなければ学科とみなす。
     */
    for (const [n, c] of map) {
      if (c !== "class?") continue;
      let num = 0;
      let all = 0;
      for (let k = i + 1; k < Math.min(raw.length, i + 21); k++) {
        const v = (raw[k]?.[n] ?? "").trim();
        if (v === "") continue;
        all += 1;
        const x = Number(numOf(v));
        if (numOf(v) !== "" && x >= 1 && x <= 10) num += 1;
      }
      const isNo = all > 0 && num / all > 0.5;
      // すでに学科の列があるなら、こちらはクラスに回す
      const hasCode = [...map.values()].includes("class_code");
      map.set(n, isNo || hasCode ? "class_no" : "class_code");
    }
    return { at: i, map };
  }
  return null;
}

/**
 * 読み取った行を、データベースへ渡す形にする。
 *
 * 見出しがあればそれに従い、無ければ A列から順に当てる。
 * 数の欄と、突き合わせに使う欄は、ここで整えておく。
 */
export function toSending(raw: Row[]): { rows: Sending[]; head: Head | null } {
  const head = readHead(raw);

  const cellOf = (cells: Row, want: string): string => {
    if (head) {
      for (const [n, c] of head.map) if (c === want) return cells[n] ?? "";
      return "";
    }
    const n = (COLS as readonly string[]).indexOf(want);
    return n < 0 ? "" : (cells[n] ?? "");
  };

  const deptsOf = (cells: Row): string[] => {
    const out: string[] = [];
    if (head) {
      for (const [n, c] of [...head.map.entries()].sort((a, b) => a[0] - b[0])) {
        if (c !== "dept") continue;
        const v = toHalf(cells[n] ?? "");
        if (v !== "") out.push(v);
      }
      return out;
    }
    for (const c of DEPT_COLS) {
      const v = toHalf(cells[(COLS as readonly string[]).indexOf(c)] ?? "");
      if (v !== "") out.push(v);
    }
    return out;
  };

  /*
   * 何行目かを添えて渡す。弾かれたときに
   * 「xlsx の何行目を直せばよいか」を言えるようにするため。
   */
  const all: Sending[] = raw.map((cells, i) => {
    const o = { row: i + 1, depts: deptsOf(cells) } as Sending;
    for (const c of COLS) {
      if (isDeptCol(c)) continue;
      const v = cellOf(cells, c).trim();
      /*
       * 数の欄は、ここで整えておく。
       *   「１３」「13番」「13.0」→ "13"
       * アドレスや番号は、全角のまま送ると突き合わせで落ちるので半角に。
       */
      o[c] = NUM_COLS.includes(c) ? numOf(v) : HALF_COLS.includes(c) ? toHalf(v) : v;
    }
    return o;
  });

  // 見出しの行そのものは送らない
  const body = head ? all.filter((_, i) => i !== head.at) : all;
  // まったくの空行も送らない
  const rows = body.filter(
    (s) => s.depts.length > 0 || COLS.some((c) => !isDeptCol(c) && s[c as PlainCol] !== ""),
  );
  return { rows, head };
}

/** 「A=身分　B=メール　…」。何をどう読んだかを、画面に出すため */
export function headNoteOf(head: Head | null): string {
  if (!head) return "";
  return [...head.map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([n, c]) => `${colName(n)}=${LABEL[c] ?? c}`)
    .join("　");
}
