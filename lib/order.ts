/**
 * 場所の並び順。
 *
 * 案内画面の建物一覧・お気に入り・カスタマイズの名前欄が、
 * すべて同じ順で並ぶようにここへまとめてある。
 * 画面ごとに書くと、同じものが違う順で出て探せなくなる。
 */

/** 号館のあとに並べる順番。実データの表記に合わせてある */
const TAIL_ORDER = [
  "自転車(北)",
  "自転車(北2)",
  "自転車(東)",
  "自転車(東2)",
  "自転車(西)",
  "自転車(南)",
  "テニスコート",
  "グラウンド",
  "学生駐車場",
];

/**
 * 「その他」としてまとめるもの。
 *
 * 構内の建物ではなく、行き帰りに使う場所。
 * 号館や施設に混ぜると探しにくいので、末尾に分けて置く。
 */
const OTHER_ORDER = ["金沢工業大学前バス停", "野々市工大前駅", "工業大学東バス停", "扇が丘東バス停"];

/** 全角半角の括弧ゆれを吸収して比べる */
const plain = (s: string) => s.replace(/[（）()\s]/g, "");
const TAIL_KEYS = TAIL_ORDER.map(plain);
const OTHER_KEYS = OTHER_ORDER.map(plain);

/** 一覧の区切り。数が小さいほど上に出る */
export const GROUP = { hall: 0, plain: 1, tail: 2, other: 3 } as const;

/** 区切りの見出し。号館には見出しを付けない（先頭なので要らない） */
export const GROUP_LABEL: Record<number, string> = {
  [GROUP.tail]: "施設",
  [GROUP.other]: "その他",
};

/**
 * 並び順のキー。
 * ① 号館を番号順（1, 2, 3, 5 …）
 *    名前に「6号館」を含むもの（LC(6号館) など）は 6 の直後に置く
 * ② それ以外の建物
 * ③ 自転車・テニスコート・グラウンドを指定の順
 * ④ その他（バス停・駅）を指定の順
 */
export function orderKey(name: string, code: string): [number, number, string] {
  if (code && /^\d+$/.test(code)) return [GROUP.hall, Number(code), ""];

  const o = OTHER_KEYS.indexOf(plain(name));
  if (o >= 0) return [GROUP.other, o, ""];

  const i = TAIL_KEYS.indexOf(plain(name));
  if (i >= 0) return [GROUP.tail, i, ""];

  // 番号は無いが「◯号館」と名乗るものは、その号館の直後に差し込む
  const m = /(\d+)\s*号館/.exec(name);
  if (m) return [GROUP.hall, Number(m[1]) + 0.5, ""];

  return [GROUP.plain, 0, name];
}

/** 二つの並び順キーを比べる */
export function compareOrder(
  a: [number, number, string],
  b: [number, number, string],
): number {
  return a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2], "ja");
}
