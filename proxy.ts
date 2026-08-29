/**
 * ログイン状態（セッション）の更新。
 *
 * Cookie のトークンは期限が来ると切れる。Server Component からは
 * Cookie を書けないため、ここで毎リクエスト更新しておく。
 * これが無いと、しばらく経つとログインが切れたように見える。
 *
 * この版の Next.js では `middleware` は非推奨で、`proxy` に改名された。
 */

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * 配る URL。ここ以外から来た人は、ここへ送り返す。
 *
 * Vercel はデプロイのたびに使い捨ての URL を作る（kit-map-xxxx-… など）。
 * それらは消せないので、Vercel の入場確認で守ったうえで、
 * 万一そこへ辿り着いた人もここへ集める。
 *
 * 学生に配る URL を一つに保つためのもの。二つ以上の入口があると、
 * 古い版を見ている人が出たり、ブラウザに詐欺サイトと疑われたりする。
 */
const CANONICAL_HOST = "kit-map.vercel.app";

/** 送り返さない相手。手元での開発と、Vercel の入場確認そのもの */
function isExempt(host: string): boolean {
  return (
    host.startsWith("localhost") ||
    host.startsWith("127.0.0.1") ||
    host.startsWith("192.168.") ||
    host.startsWith("172.") ||
    host.endsWith(".local")
  );
}

export async function proxy(request: NextRequest) {
  /*
   * 正しい URL へ集める。
   *
   * 手元での開発は素通しにする。ここで送り返すと、
   * localhost:3000 で開いた地図が公開サイトへ飛んでしまう。
   */
  const host = request.headers.get("host") ?? "";
  if (host && host !== CANONICAL_HOST && !isExempt(host)) {
    const to = new URL(request.url);
    to.host = CANONICAL_HOST;
    to.protocol = "https:";
    to.port = "";
    return NextResponse.redirect(to, 308);
  }

  let response = NextResponse.next({ request });

  // 環境変数が未設定の間は何もしない（フェーズ1はログイン無しで動く）
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(list) {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) response.cookies.set(name, value, options);
      },
    },
  });

  // 呼ぶだけでトークンが更新される
  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: [
    // 画像・静的ファイル・地図データは通さない（無駄な処理を避ける）
    "/((?!_next/static|_next/image|favicon.ico|data/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
