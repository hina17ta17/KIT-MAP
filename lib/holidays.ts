/**
 * 日本の祝日。
 *
 * ■ なぜ表で持たないか
 *
 *   祝日は毎年ずれる。第2月曜のもの（成人の日など）は日付が動くし、
 *   春分・秋分は天文の計算で決まる。表に書いて配ると、
 *   年が変わるたびに直して配り直すことになり、必ず忘れる。
 *   決まりのほうを書いておけば、何年先でも自分で出せる。
 *
 * ■ どこまで正しいか
 *
 *   春分・秋分は近似の式で出している。1900年から2099年までは
 *   実際の暦と一致する（この式が使われる範囲）。
 *   構内の案内で使う年は、すべてこの中に入る。
 *
 *   国が臨時に決めた休日（即位の日など）は入っていない。
 *   決まりが無く、その年だけのものなので、計算では出せない。
 *   出す必要が出たら、下の EXTRA に書き足す。
 *
 * ■ 振替休日と国民の休日も出す
 *
 *   振替休日 … 祝日が日曜と重なったら、次の平日が休みになる
 *   国民の休日 … 祝日と祝日に挟まれた平日が休みになる
 *                （9月に敬老の日と秋分の日が並ぶ年に起きる）
 *
 *   どちらもカレンダーでは赤くなるので、ここで一緒に返す。
 */

/** "2026-09-05" の形 */
export type Ymd = string;

const pad = (n: number) => String(n).padStart(2, "0");
const key = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/**
 * その年その月の、n 回目の月曜。
 *
 * ハッピーマンデーの祝日（成人の日・海の日・敬老の日・スポーツの日）に使う。
 */
function nthMonday(y: number, m: number, n: number): number {
  // その月の1日の曜日（0=日）
  const first = new Date(y, m - 1, 1).getDay();
  // 1日から最初の月曜までの日数
  const offset = (8 - first) % 7;
  return 1 + offset + (n - 1) * 7;
}

/**
 * 春分の日・秋分の日。
 *
 * 1900〜2099 で使われる近似式。年ごとの誤差を、
 * うるう年の回数で戻している。
 */
function equinox(y: number, spring: boolean): number {
  const base = spring ? 20.8431 : 23.2488;
  return Math.floor(base + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
}

/**
 * その年だけの、臨時の休日。
 *
 * 決まりが無いので計算では出せない。要るときにここへ書き足す。
 * 例： "2019-05-01": "即位の日"
 */
const EXTRA: Record<Ymd, string> = {};

/** 一年ぶんの祝日を作る。振替休日と国民の休日も入れる */
function build(y: number): Map<Ymd, string> {
  const out = new Map<Ymd, string>();
  const put = (m: number, d: number, name: string) => out.set(key(y, m, d), name);

  put(1, 1, "元日");
  put(1, nthMonday(y, 1, 2), "成人の日");
  put(2, 11, "建国記念の日");
  // 天皇誕生日は 2020年から 2月23日（それ以前は12月23日）
  if (y >= 2020) put(2, 23, "天皇誕生日");
  else if (y >= 1989) put(12, 23, "天皇誕生日");
  put(3, equinox(y, true), "春分の日");
  put(4, 29, "昭和の日");
  put(5, 3, "憲法記念日");
  put(5, 4, "みどりの日");
  put(5, 5, "こどもの日");
  put(7, nthMonday(y, 7, 3), "海の日");
  if (y >= 2016) put(8, 11, "山の日");
  put(9, nthMonday(y, 9, 3), "敬老の日");
  put(9, equinox(y, false), "秋分の日");
  put(10, nthMonday(y, 10, 2), y >= 2020 ? "スポーツの日" : "体育の日");
  put(11, 3, "文化の日");
  put(11, 23, "勤労感謝の日");

  for (const [k, v] of Object.entries(EXTRA)) if (k.startsWith(`${y}-`)) out.set(k, v);

  /*
   * 振替休日。
   *
   * 祝日が日曜と重なったら、そのあとの「祝日でない日」が休みになる。
   * 続けて祝日が並ぶことがある（5月3日が日曜なら、4日も5日も祝日なので
   * 6日が振替になる）ので、空くまで進める。
   */
  const fixed: [Ymd, string][] = [];
  for (const [k] of out) {
    const [yy, mm, dd] = k.split("-").map(Number);
    if (new Date(yy, mm - 1, dd).getDay() !== 0) continue;
    const d = new Date(yy, mm - 1, dd);
    do {
      d.setDate(d.getDate() + 1);
    } while (out.has(key(d.getFullYear(), d.getMonth() + 1, d.getDate())));
    fixed.push([key(d.getFullYear(), d.getMonth() + 1, d.getDate()), "振替休日"]);
  }
  for (const [k, v] of fixed) out.set(k, v);

  /*
   * 国民の休日。
   *
   * 祝日と祝日に挟まれた平日は休みになる。
   * 9月に敬老の日と秋分の日が一日おきに並ぶ年に起きる。
   */
  const between: [Ymd, string][] = [];
  for (const [k] of out) {
    const [yy, mm, dd] = k.split("-").map(Number);
    const next = new Date(yy, mm - 1, dd + 2);
    const mid = new Date(yy, mm - 1, dd + 1);
    const midKey = key(mid.getFullYear(), mid.getMonth() + 1, mid.getDate());
    const nextKey = key(next.getFullYear(), next.getMonth() + 1, next.getDate());
    if (!out.has(nextKey) || out.has(midKey)) continue;
    // 日曜と土曜は、もともと休みなので入れない
    const w = mid.getDay();
    if (w === 0 || w === 6) continue;
    between.push([midKey, "国民の休日"]);
  }
  for (const [k, v] of between) out.set(k, v);

  return out;
}

/**
 * 年ごとの覚え書き。
 *
 * カレンダーは一つの月を描くのに何十回も訊いてくるので、
 * 毎回作り直すと無駄になる。一度作った年は取っておく。
 */
const cache = new Map<number, Map<Ymd, string>>();

function ofYear(y: number): Map<Ymd, string> {
  let m = cache.get(y);
  if (!m) {
    m = build(y);
    cache.set(y, m);
  }
  return m;
}

/**
 * その日が祝日なら名前を、そうでなければ null を返す。
 *
 *     holidayName("2026-01-01")  → "元日"
 *     holidayName("2026-01-05")  → null
 */
export function holidayName(d: Ymd): string | null {
  const y = Number(d.slice(0, 4));
  if (!Number.isFinite(y)) return null;
  return ofYear(y).get(d) ?? null;
}

/** 祝日か。名前が要らないときはこちら */
export function isHoliday(d: Ymd): boolean {
  return holidayName(d) !== null;
}

/**
 * カレンダーの文字の色。
 *
 * 祝日と日曜は赤、土曜は青。ふだんの日は黒のまま。
 * 「選ばれている」といった状態の色は、呼ぶ側が上から塗る。
 */
export function dayColor(d: Ymd): "holiday" | "sat" | "plain" {
  const [y, m, dd] = d.split("-").map(Number);
  if (isHoliday(d)) return "holiday";
  const w = new Date(y, m - 1, dd).getDay();
  if (w === 0) return "holiday";
  if (w === 6) return "sat";
  return "plain";
}
