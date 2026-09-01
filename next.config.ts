import type { NextConfig } from "next";

/** `next dev` で動いているか。`next build` のときは false になる */
const DEV = process.env.NODE_ENV === "development";

const nextConfig: NextConfig = {
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

  // 左下に出る開発用のインジケータ（N のボタン）を隠す。
  // 地図の操作の邪魔になるため。エラーは従来どおり表示される。
  devIndicators: false,
};

export default nextConfig;
