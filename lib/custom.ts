/**
 * 見た目の好み。この端末にだけ覚える。
 *
 * 名前の色・名前の付け替え・夜の見え方を持つ。
 * どれも本人の画面の話なので、データベースには送らない。
 */

export const CUSTOM_KEY = "kitmap.custom.v1";

/**
 * 名前の色。
 *
 * 選ぶときは「赤」「青」と分かりやすく書くが、実際に塗るのは薄い色にする。
 * 濃い色を敷くと、その上の小さな文字が読みにくくなるうえ、
 * 航空写真の上で色だけが浮いて地図が見えなくなるため。
 *
 * bg  … 名前の背景
 * fg  … 文字の色（薄い背景に対して十分濃くする）
 * dot … 選ぶ画面に出す見本
 */
export type LabelColor = {
  id: string;
  label: string;
  bg: string;
  fg: string;
};

export const LABEL_COLORS: LabelColor[] = [
  { id: "white", label: "白", bg: "rgba(255,255,255,0.88)", fg: "#1e293b" },
  { id: "red", label: "赤", bg: "rgba(254,205,211,0.92)", fg: "#881337" },
  { id: "orange", label: "橙", bg: "rgba(254,215,170,0.92)", fg: "#7c2d12" },
  { id: "yellow", label: "黄", bg: "rgba(254,240,138,0.92)", fg: "#713f12" },
  { id: "green", label: "緑", bg: "rgba(187,247,208,0.92)", fg: "#14532d" },
  { id: "teal", label: "青緑", bg: "rgba(153,246,228,0.92)", fg: "#134e4a" },
  { id: "sky", label: "水色", bg: "rgba(186,230,253,0.92)", fg: "#0c4a6e" },
  { id: "blue", label: "青", bg: "rgba(199,210,254,0.92)", fg: "#1e3a8a" },
  { id: "purple", label: "紫", bg: "rgba(233,213,255,0.92)", fg: "#4c1d95" },
  { id: "pink", label: "桃", bg: "rgba(251,207,232,0.92)", fg: "#831843" },
];

export const DEFAULT_COLOR = LABEL_COLORS[0];

export function colorOf(id: string): LabelColor {
  return LABEL_COLORS.find((c) => c.id === id) ?? DEFAULT_COLOR;
}

export type Custom = {
  /** 名前の色 */
  color: string;
  /** 夜の見え方にするか */
  night: boolean;
  /** 名前の付け替え。建物の tempId → 付けた名前 */
  names: Record<string, string>;
};

export const EMPTY_CUSTOM: Custom = { color: DEFAULT_COLOR.id, night: false, names: {} };

export function loadCustom(): Custom {
  if (typeof window === "undefined") return EMPTY_CUSTOM;
  try {
    const raw = window.localStorage.getItem(CUSTOM_KEY);
    if (!raw) return EMPTY_CUSTOM;
    const v = JSON.parse(raw) as Partial<Custom>;
    return {
      color: typeof v.color === "string" ? v.color : DEFAULT_COLOR.id,
      night: v.night === true,
      names: v.names && typeof v.names === "object" ? v.names : {},
    };
  } catch {
    return EMPTY_CUSTOM;
  }
}

export function saveCustom(v: Custom) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CUSTOM_KEY, JSON.stringify(v));
  } catch {
    // 保存できなくても画面は動く（私用ブラウザなど）
  }
}
