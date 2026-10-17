import type { NextConfig } from "next";

/** `next dev` で動いているか。`next build` のときは false になる */
const DEV = process.env.NODE_ENV === "development";

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
   * ■ 中身を細かく決める指定（CSP）は、ここでは入れていない
   *   地図の部品・タイル・データベースへの通信を全部書き出す必要があり、
   *   書き漏らすと地図が出なくなる。埋め込み防止（frame-ancestors）だけは
   *   壊れる心配が無いので入れてある。
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
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
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
