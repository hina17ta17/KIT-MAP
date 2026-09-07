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
  { col: "kind", words: ["身分", "区分", "種別", "属性", "立場"] },
  { col: "email", words: ["メール", "アドレス", "mail", "address"] },
  { col: "name", words: ["氏名", "名前", "なまえ", "name", "姓名"] },
  { col: "grade", words: ["学年", "年次", "grade"] },
  { col: "seat_no", words: ["名列", "出席番号", "出席no", "席番", "座席", "seat"] },
  { col: "student_no", words: ["学籍", "学生番号", "studentno", "studentid"] },
  // 担当学科（I〜N）。「担当」が付いていれば、いくつでもここへ集める
  { col: "dept", words: ["担当"] },
  /*
   * 「教職員番号」は 8桁の番号のほう。「教職」を先に見ると
   * そちらへ取られてしまうので、番号のほうを先に置く。
   */
  { col: "number", words: ["8桁", "職員番号", "教職員番号", "職員"] },
  { col: "teaching", words: ["教職"] },
  // 学科は「担当」より後に見る（担当学科を先に拾わせるため）
  { col: "class_code", words: ["学科", "コース", "記号", "専攻"] },
  // ここだけは中身も見て決める
  { col: "class?", words: ["クラス", "組", "class"] },
];

/**
 * 見出しの言葉をそろえる。
 *
 * ★ 大文字・小文字と、全角・半角と、区切りの記号を無くしてから比べる
 *
 *   前は書いてあるとおりに比べていた。だから
 *     "E-mail" は "e-mail" と一致せず
 *     "Mail"   は "mail"   と一致せず
 *     "ﾒｰﾙ"    も外れる
 *   ——見出しがあるのに、メールの列だけ見つからないことがあった。
 *
 *   見つからないと、その列は空のまま送られる。すると全部の行が
 *   「B列（メールアドレス）が正しくありません」で弾かれる。
 *   手で入れたときは起きず、xlsx のときだけ起きるので、
 *   原因が分かりにくかった。
 */
function normHead(cell: string): string {
  return (cell ?? "")
    /*
     * NFKC で、全角の英数字は半角に、半角のカナは全角に そろう。
     *   "Ｅ－ｍａｉｌ" → "E-mail"
     *   "ﾒｰﾙ"        → "メール"
     * 見出しを見比べるためだけに使う。人の名前には掛けない
     * （㈱ のような字が別の字に変わってしまうため）。
     */
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s　()（）[\]［］{}｛｝_＿・･.,、。:：;；\-ー―‐/／|｜#＃*＊"'`]/g, "");
}

/** その升目が、どの列の見出しに当たるか */
export function headOf(cell: string): Col | "dept" | "class?" | null {
  const t = normHead(cell ?? "");
  if (t === "") return null;
  for (const h of HEAD_WORDS) {
    if (h.words.some((w) => t.includes(normHead(w)))) return h.col;
  }
  return null;
}

export type Head = {
  at: number;
  map: Map<number, string>;
  /** 見出しでなく、中身を見て決めた列。画面に印を出すため */
  guessed: Set<number>;
};

/* ================= 中身から見つける ================= */

/**
 * その升目が、その欄らしいか。
 *
 * 見出しが無い・見出しの言葉が知らないものだった、というときに、
 * 列の中身そのものから当てるために使う。
 *
 * ここに置いてあるのは、見間違えようのないものだけ。
 *   アドレス   … @ がある
 *   身分       … 学生／教授／その他 のどれか
 *   学籍番号   … 7桁の数字が取り出せる
 *   8桁の番号  … ちょうど8文字
 *   学科       … 英字だけ（KM・CC など）
 * 学年・クラス・名列番号は、どれも小さい数で見分けがつかないので、
 * 数の大きさで当てる（下の fitNumbers）。
 */
const LOOKS: Record<string, (v: string) => boolean> = {
  kind: (v) => /^(学生|教授|その他)$/.test(v.trim()),
  email: (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(toHalf(v)),
  student_no: (v) => !/@/.test(v) && studentNoOf(toHalf(v)) !== "",
  number: (v) => /^[0-9A-Za-z]{8}$/.test(toHalf(v)),
  class_code: (v) => /^[A-Za-z]{1,6}$/.test(toHalf(v)),
  teaching: (v) => /^[tT]$/.test(toHalf(v).trim()),
  name: (v) => v.trim() !== "" && !/@/.test(v) && !/^[0-9]+$/.test(toHalf(v).trim()),
};

/** その列の、空でない升目のうち、当てはまる割合 */
function fitOf(raw: Row[], from: number, col: number, test: (v: string) => boolean): number {
  let all = 0;
  let hit = 0;
  for (let i = from; i < Math.min(raw.length, from + 60); i++) {
    const v = (raw[i]?.[col] ?? "").trim();
    if (v === "") continue;
    all += 1;
    if (test(v)) hit += 1;
  }
  return all === 0 ? 0 : hit / all;
}

/** その列に入っている数の、いちばん大きいもの（数でなければ null） */
function maxNumOf(raw: Row[], from: number, col: number): number | null {
  let max = 0;
  let all = 0;
  let num = 0;
  for (let i = from; i < Math.min(raw.length, from + 60); i++) {
    const v = (raw[i]?.[col] ?? "").trim();
    if (v === "") continue;
    all += 1;
    const s = numOf(v);
    if (s === "") continue;
    num += 1;
    max = Math.max(max, Number(s));
  }
  if (all === 0 || num / all < 0.9) return null;
  return max;
}

/**
 * 見つからなかった欄を、中身から埋める。
 *
 * ■ なぜ要るか
 *   見出しの言葉は、作る人によって違う。「アカウント」「学校メール」
 *   のように、こちらが知らない言い方をされると、その列は空のまま
 *   送られ、全部の行が弾かれる。
 *
 *   ただ、中身を見れば分かることも多い。@ が入っていればアドレスだし、
 *   「学生／教授／その他」しか入っていなければ身分。
 *   見出しで分からなかったぶんだけ、中身から埋める。
 *
 * ■ 見間違えようのないものだけ
 *   当てずっぽうで埋めると、間違ったまま静かに入ってしまう。
 *   はっきり言えるものだけにして、埋めたところには印を付け、
 *   画面で「中身から」と分かるようにしてある。
 */
function rescue(raw: Row[], head: Head): Head {
  const from = head.at + 1;
  const used = new Set(head.map.keys());
  /** その表にある列の数 */
  let width = 0;
  for (let i = from; i < Math.min(raw.length, from + 60); i++)
    width = Math.max(width, raw[i]?.length ?? 0);

  const have = new Set(head.map.values());

  // ① 見間違えようのないものから埋める
  for (const col of ["email", "kind", "student_no", "number", "class_code", "teaching"]) {
    if (have.has(col)) continue;
    let best = -1;
    let bestFit = 0;
    for (let n = 0; n < width; n++) {
      if (used.has(n)) continue;
      const fit = fitOf(raw, from, n, LOOKS[col]);
      if (fit > bestFit) {
        bestFit = fit;
        best = n;
      }
    }
    if (best >= 0 && bestFit >= 0.7) {
      head.map.set(best, col);
      head.guessed.add(best);
      used.add(best);
      have.add(col);
    }
  }

  // ② 数の欄は、入っている数の大きさで当てる
  const nums: { n: number; max: number }[] = [];
  for (let n = 0; n < width; n++) {
    if (used.has(n)) continue;
    const m = maxNumOf(raw, from, n);
    if (m !== null && m >= 1) nums.push({ n, max: m });
  }
  for (const [col, cap] of [
    ["grade", 4],
    ["class_no", 10],
    ["seat_no", 200],
  ] as const) {
    if (have.has(col)) continue;
    // その欄に収まるもののうち、いちばん左のもの
    const i = nums.findIndex((x) => x.max <= cap);
    if (i < 0) continue;
    head.map.set(nums[i].n, col);
    head.guessed.add(nums[i].n);
    used.add(nums[i].n);
    have.add(col);
    nums.splice(i, 1);
  }

  // ③ 氏名は、残った文字の列
  if (!have.has("name")) {
    let best = -1;
    let bestFit = 0;
    for (let n = 0; n < width; n++) {
      if (used.has(n)) continue;
      const fit = fitOf(raw, from, n, LOOKS.name);
      if (fit > bestFit) {
        bestFit = fit;
        best = n;
      }
    }
    if (best >= 0 && bestFit >= 0.9) {
      head.map.set(best, "name");
      head.guessed.add(best);
    }
  }

  return head;
}

/**
 * 見出しが無い表の、ずれを直す。
 *
 * ■ なぜ要るか
 *   見出しが無ければ A列から順に当てるしかない。
 *   ところが表の左に空の列が一つあるだけで、全部が一つずつずれる。
 *   すると身分は空、学籍番号のところに名列番号……と、
 *   何もかもが噛み合わなくなる。
 *
 * ■ どう直すか
 *   ずらし方を -3〜+3 まで試して、いちばん当てはまるものを選ぶ。
 *   当てはまり具合は、見間違えようのない欄
 *   （身分・アドレス・学籍番号・学科・8桁の番号）で測る。
 *
 *   ずらすかどうかは、ずらしたほうがはっきり良いときだけ。
 *   同じくらいなら、元のまま（ずらさない）にする。
 */
function bestShift(raw: Row[], head: Head): Head {
  const from = head.at + 1;
  const test = ["kind", "email", "student_no", "class_code", "number"] as const;

  const scoreOf = (d: number): number => {
    let sum = 0;
    for (const [n, c] of head.map) {
      if (!(test as readonly string[]).includes(c)) continue;
      const at = n + d;
      if (at < 0) continue;
      sum += fitOf(raw, from, at, LOOKS[c]);
    }
    return sum;
  };

  const base = scoreOf(0);
  let bestD = 0;
  let best = base;
  for (const d of [1, 2, 3, -1, -2, -3]) {
    const s = scoreOf(d);
    if (s > best) {
      best = s;
      bestD = d;
    }
  }
  // はっきり良くなるときだけ動かす
  if (bestD === 0 || best < base + 0.8) return head;

  const moved = new Map<number, string>();
  for (const [n, c] of head.map) {
    const at = n + bestD;
    if (at >= 0) moved.set(at, c);
  }
  return { at: head.at, map: moved, guessed: new Set([...moved.keys()]) };
}

/**
 * アドレスの列が、本当にアドレスかを確かめる。
 *
 * 見出しどおりに読んでも、表そのものが一列ずれていることがある。
 * そのときは全部の行が「アドレスが正しくありません」で弾かれる。
 * ここで、@ がいちばん多く入っている列へ付け替える。
 */
function fixEmail(raw: Row[], head: Head): Head {
  const from = head.at + 1;
  let now = -1;
  for (const [n, c] of head.map) if (c === "email") now = n;
  const nowFit = now >= 0 ? fitOf(raw, from, now, LOOKS.email) : 0;
  if (nowFit >= 0.5) return head;

  let width = 0;
  for (let i = from; i < Math.min(raw.length, from + 60); i++)
    width = Math.max(width, raw[i]?.length ?? 0);

  let best = -1;
  let bestFit = 0;
  for (let n = 0; n < width; n++) {
    const fit = fitOf(raw, from, n, LOOKS.email);
    if (fit > bestFit) {
      bestFit = fit;
      best = n;
    }
  }
  if (best < 0 || bestFit < 0.8 || best === now) return head;

  // いま入っている割り当てを外して、こちらへ移す
  if (now >= 0) head.map.delete(now);
  head.map.set(best, "email");
  head.guessed.add(best);
  return head;
}

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
    return { at: i, map, guessed: new Set<number>() };
  }
  return null;
}

/** 見出しが無いときの当て方。A列から順に */
function byOrder(): Head {
  const map = new Map<number, string>();
  COLS.forEach((c, n) => map.set(n, c === "dept1" || isDeptCol(c) ? "dept" : c));
  return { at: -1, map, guessed: new Set<number>() };
}

/**
 * 読み取った行を、データベースへ渡す形にする。
 *
 * 見出しがあればそれに従い、無ければ A列から順に当てる。
 * 数の欄と、突き合わせに使う欄は、ここで整えておく。
 */
export function toSending(raw: Row[]): {
  rows: Sending[];
  head: Head | null;
  /** 見出しから読めたか。false なら A列から順に当てた */
  named: boolean;
} {
  const named = readHead(raw);
  /*
   * 見出しが無ければ A列から順に当てる。そのうえで、どちらの場合も
   * 中身を見て埋め直す。見出しがあっても知らない言い方だと拾えないし、
   * 見出しが無い表は一列ずれていることがあるため。
   */
  const head = fixEmail(
    raw,
    // 見出しが無いときだけ、表そのもののずれを直してから中身で埋める
    rescue(raw, named ?? bestShift(raw, byOrder())),
  );

  const cellOf = (cells: Row, want: string): string => {
    for (const [n, c] of head.map) if (c === want) return cells[n] ?? "";
    return "";
  };

  const deptsOf = (cells: Row): string[] => {
    const out: string[] = [];
    for (const [n, c] of [...head.map.entries()].sort((a, b) => a[0] - b[0])) {
      if (c !== "dept") continue;
      const v = toHalf(cells[n] ?? "");
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
  const body = all.filter((_, i) => i !== head.at);
  // まったくの空行も送らない
  const rows = body.filter(
    (s) => s.depts.length > 0 || COLS.some((c) => !isDeptCol(c) && s[c as PlainCol] !== ""),
  );
  return { rows, head, named: named !== null };
}

/**
 * 「A=身分　B=メール　…」。何をどう読んだかを、画面に出すため。
 *
 * 中身から当てた列には ＊ を付ける。見出しから読めたものと
 * 見分けが付かないと、当てずっぽうを信じてしまう。
 */
export function headNoteOf(head: Head | null): string {
  if (!head) return "";
  return [...head.map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([n, c]) => `${colName(n)}=${LABEL[c] ?? c}${head.guessed.has(n) ? "＊" : ""}`)
    .join("　");
}
