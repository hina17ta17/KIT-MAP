/**
 * サイトの処理より先に動くところ。二つの役目がある。
 *
 * ■ ① AgentGuard の検査（いちばん先）
 *   届いたアクセスを AgentGuard に見てもらい、攻撃と判断されたものは
 *   403 で止める。止まったものは、この下の処理にもページにも届かない。
 *   中身は lib/agentguard.ts。
 *
 * ■ ② ログイン状態（セッション）の更新
 *   Cookie のトークンは期限が来ると切れる。Server Component からは
 *   Cookie を書けないため、ここで毎リクエスト更新しておく。
 *   これが無いと、しばらく経つとログインが切れたように見える。
 *
 * ■ 順番が大事
 *   検査を先にする。あとに回すと、攻撃であってもセッションの更新までは
 *   走ってしまう。
 *
 * ■ 通す範囲（matcher）
 *   AgentGuard は「組み立て済みのファイル以外ぜんぶ」を見る決まりなので、
 *   範囲をそちらに合わせて広げた。ただし②のセッション更新は、もとのとおり
 *   地図データや画像では動かさない（無駄に重くしないため）。
 *
 * この版の Next.js では `middleware` は非推奨で、`proxy` に改名された。
 */

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { agentguard } from "@/lib/agentguard";

/**
 * セッションの更新をしない道。
 *
 * 地図データ（/data/…）と画像は、ログインに関係がない。
 * もとの matcher がここを外していたので、同じものをここで見る。
 */
const SKIP_SESSION = new RegExp("^/(data/|.*\.(?:svg|png|jpg|jpeg|gif|webp)$)");

/**
 * 配る URL。ここ以外から来た人は、ここへ送り返す。
 *
 * Vercel はデプロイのたびに使い捨ての URL を作る（kit-map-xxxx-… など）。
 * それらは消せないので、Vercel の入場確認で守ったうえで、
 * 万一そこへ辿り着いた人もここへ集める。
 *
 * 学生に配る URL を一つに保つためのもの。二つ以上の入口があると、
 * 古い版を見ている人が出たり、ブラウザに詐欺サイトと疑われたりする。
 *
 * 値はコードに書かず、環境変数から読む（.env.local と Vercel の設定）。
 * 決めていなければ、送り返しはしない。入れ忘れで全部の入口を
 * 塞いでしまうより、そのまま通すほうが安全なため。
 */
const CANONICAL_HOST = process.env.NEXT_PUBLIC_CANONICAL_HOST ?? "";

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
   * ① AgentGuard の検査。
   *
   * null 以外が返ってきたら、それが答え（403・503・404・確認の答え）。
   * そのまま返して、ここで終わる。
   */
  const guard = await agentguard(request);
  if (guard) return guard;

  /*
   * 正しい URL へ集める。
   *
   * 手元での開発は素通しにする。ここで送り返すと、
   * localhost:3000 で開いた地図が公開サイトへ飛んでしまう。
   */
  const host = request.headers.get("host") ?? "";
  /*
   * CANONICAL_HOST を先に見るのが要。
   *
   * 決めていない（空の）ときに host との比較だけで判断すると、
   * すべての行き先が「空のホスト」へ送り返され、どこも開けなくなる。
   * 決めていないなら、送り返しそのものをしない。
   */
  if (CANONICAL_HOST && host && host !== CANONICAL_HOST && !isExempt(host)) {
    const to = new URL(request.url);
    to.host = CANONICAL_HOST;
    to.protocol = "https:";
    to.port = "";
    return NextResponse.redirect(to, 308);
  }

  let response = NextResponse.next({ request });

  /*
   * 地図データと画像は、ここで終わり。
   *
   * AgentGuard の検査は受けるが、セッションの更新は要らない。
   * 一回の表示で地図データだけで4つ飛ぶので、ここで毎回 Supabase に
   * 問い合わせると、開くのが目に見えて遅くなる。
   */
  if (SKIP_SESSION.test(request.nextUrl.pathname)) return response;

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
    /*
     * AgentGuard の範囲に合わせてある（組み立て済みのファイルと favicon だけ除く）。
     *
     * もとは地図データと画像も外していたが、検査はそこにも要る。
     * 代わりに、重いセッションの更新のほうを上の SKIP_SESSION で外した。
     *
     * /_vercel/ はバーセルそのものの受け口（アクセス解析の数え口など）で、
     * こちらのコードは無い。ページを開くたびに届くので、検査とセッションの更新から外す。
     */
    "/((?!_next/static|_next/image|_vercel/|favicon.ico).*)",
  ],
};
