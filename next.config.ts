import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 開発中にスマホ実機など LAN 上の端末から開けるようにする。
  // 指定しないと HMR がブロックされ、警告が出続ける。
  allowedDevOrigins: ["localhost"],
};

export default nextConfig;
