import type { NextConfig } from "next";

/** `next dev` で動いているか。`next build` のときは false になる */
const DEV = process.env.NODE_ENV === "development";

/** データベース（Supabase）の置き場所。画面はここへだけ問い合わせる */
const SUPABASE = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").origin;
  } catch {
    return "";
  }
})();

/** 地図の航空写真（国土地理院のタイル）。地図の部品が直接取りに行く */
const TILES = "https://cyberjapandata.gsi.go.jp";

/**
 * 読み込んでよい先の決まり（Content-Security-Policy）。
 *
 * ■ 何を止めるか
 *   万一、画面に他人のスクリプトを差し込まれても（XSS）、
 *     ・よそのサイトからスクリプトを読み込む
 *     ・ログインの鍵を、よそのサイトへ fetch で送り出す
 *     ・<base> を書き換えて、読み込む先をすり替える
 *     ・フォームの送り先を、よそのサイトにする
 *   を、ブラウザの側で止める。
 *
 * ■ 許している先（これで全部）
 *   自分のサイト・データベース（Supabase）・国土地理院のタイル。
 *   画面の fetch は、どれも自分のサイトあて（/data・/api）。
 *
 * ■ 甘くしてあるところ
 *   script-src の 'unsafe-inline' … ページを前もって作っておく形
 *     （静的なページ）では、毎回変わる合言葉（nonce）を付けられない。
 *     Next.js が埋め込む起動用のスクリプトのために要る。
 *   img-src の https: … 食堂の写真は https の置き場所も入れられる（23）。
 *     ニュースの写真は、画面からは写真そのもの（data:）しか送らない。
 *   開発中（next dev）だけ 'unsafe-eval' を足す。書き換えの即時反映に要る。
 */
const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${DEV ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  ["connect-src 'self'", SUPABASE, SUPABASE.replace(/^http/, "ws"), TILES].filter(Boolean).join(" "),
  // 地図の部品は、自分のサイトに置いた worker（/maplibre）を使う
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "manifest-src 'self'",
  // 本番（https のデータベース）では、http の読み込みを https に上げる
  ...(SUPABASE.startsWith("https:") ? ["upgrade-insecure-requests"] : []),
].join("; ");

const nextConfig: NextConfig = {
  /*
   * 作業の根っこを、このフォルダに固定する。
   *
   * ■ 何が起きたか
   *   Next.js は package-lock.json を探して「作業の根っこ」を決める。
   *   ホームフォルダ（C:\Users\…）に中身の無い package-lock.json が
   *   一つできていると、そちらを根っこだと判断してしまう。
   *
   *   すると内部の名前に、途中のフォルダ名「プログラミング」が入る。
   *   Turbopack はその名前をバイト数で切るので、日本語の途中で切れて
   *   組み立てが落ちる（start byte index 8 is not a char boundary）。
   *   実際に、これで手元の `next build` が通らなくなった。
   *
   * ■ なぜここで直すか
   *   よそのフォルダに置かれたファイルに、こちらの組み立てが
   *   左右されないようにするため。置き場所を片づけて直すこともできるが、
   *   また誰かが npm を別の場所で動かせば同じことが起きる。
   */
  outputFileTracingRoot: __dirname,

  /*
   * 作図ツール（/edit）は手元でだけ動かす。
   *
   * ページとして認めるファイルの種類を、開発中だけ増やす。
   * 作図ツールは page.dev.tsx という名前にしてあるので、
   * `next build` では「ページではないただのファイル」になり、
   * 経路も、まとめられる JavaScript も、公開ビルドには一切入らない。
   *
   * 画面の中で隠すだけでは、URL を直に叩けば開けてしまう。
   * 作図は地図データを作る作業で、公開サイトで行うものではない。
   *
   * dev.ts も入れる。画面は page.dev.tsx だが、下書きを公開データへ
   * 書き込む口は route.dev.ts で拡張子が違う。片方だけだと、その口は
   * 開発中でも見つからない（実際に 404 になった）。
   */
  pageExtensions: DEV
    ? ["tsx", "ts", "jsx", "js", "dev.tsx", "dev.ts"]
    : ["tsx", "ts", "jsx", "js"],

  // 開発中にスマホ実機など LAN 上の端末から開けるようにする。
  // 指定しないと HMR がブロックされ、警告が出続ける。
  allowedDevOrigins: ["localhost"],

  /*
   * 守りのための見出し（HTTP ヘッダ）。
   *
   * ■ なぜ要るか
   *   外から試したところ、二つ足りなかった。
   *     ・ほかのサイトに枠として埋め込まれるのを止める指定が無い
   *       → 透明にして重ねられると、ログイン中の管理者が
   *         「見えない承認ボタン」を押させられる（クリックジャック）
   *     ・中身の種類を勝手に推測させない指定が無い
   *       → 画像のつもりのものを、本文として実行されることがある
   *
   * ■ 読み込んでよい先の決まり（CSP）
   *   上の CSP にまとめてある。地図の部品・タイル・データベースへの
   *   通信を全部書き出してあり、書き漏らすと地図が出なくなるので、
   *   通信先を足したときは CSP にも足すこと。
   *
   * ■ 現在地は止めない
   *   Permissions-Policy で geolocation=(self) を明示している。
   *   ここを空にすると、現在地が取れなくなる。
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // 枠として埋め込ませない（古い言い方と新しい言い方の両方）
          { key: "X-Frame-Options", value: "DENY" },
          // 読み込んでよい先（埋め込み防止の frame-ancestors も、この中にある）
          { key: "Content-Security-Policy", value: CSP },
          // 中身の種類を推測させない
          { key: "X-Content-Type-Options", value: "nosniff" },
          // よそへ行くときに、どの画面から来たかを渡しすぎない
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // この画面だけが現在地を使える。カメラとマイクは誰にも使わせない
          { key: "Permissions-Policy", value: "geolocation=(self), camera=(), microphone=()" },
        ],
      },
    ];
  },

  // 左下に出る開発用のインジケータ（N のボタン）を隠す。
  // 地図の操作の邪魔になるため。エラーは従来どおり表示される。
  devIndicators: false,
};

export default nextConfig;
