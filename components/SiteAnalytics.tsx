"use client";

/**
 * アクセス解析の部品。見た目には出ない。
 *
 * 読み込むのは同じサイトの `/_vercel/insights/…` だけなので、
 * 読み込んでよい先の決まり（next.config.ts の CSP）は 'self' のままでよい。
 * バーセルの上でだけ出す（app/layout.tsx）。手元では読み込まない。
 * 何を送らないかは lib/analytics.ts。
 */
import { Analytics } from "@vercel/analytics/next";
import { beforeSend } from "@/lib/analytics";

export function SiteAnalytics() {
  return <Analytics beforeSend={beforeSend} />;
}
