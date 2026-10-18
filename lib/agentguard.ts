/**
 * AgentGuard とつなぐところ。
 *
 * ■ 何をするか
 *   サイトに届いたアクセスを、サイトの処理より先に AgentGuard へ送って見てもらう。
 *   攻撃と判断されたものは 403 で止まり、こちらのコードまで届かない。
 *
 * ■ もとのファイルとの違いは一か所だけ
 *   配られたものは「通すときは NextResponse.next() を返す」形だったが、
 *   こちらにはもともと proxy.ts（ログインの維持と、URL の集約）がある。
 *   二つを一つにまとめるため、**通すときは null を返す**形にしてある。
 *   呼ぶ側は、null でなければそれをそのまま返し、null なら先へ進む。
 *   （配布元の手順書が、この変え方を認めている）
 *
 * ■ 鍵
 *   環境変数 AGENTGUARD_KEY があればそれを使う。
 *   無ければ .agentguard/.settings（git には入らない）から読む。
 *   どちらも無ければ、何もせず素通しにする。
 */
import { type NextRequest } from "next/server";

const AGENTGUARD_INGEST = process.env.AGENTGUARD_URL ?? "";
const AGENTGUARD_VERIFY_PATH = "/.well-known/agentguard-verify.txt";
// パスワードなどの欄は伏せて送る（攻撃の形をした値だけは、検査のためそのまま送る）
// code（認証アプリの6桁）と mail（メールアドレス）も伏せる。外のサービスへ送らなくてよいもの
const SECRET = /pass|pwd|token|secret|card|cvc|otp|code|mail|api[-_]?key/i;
const ATTACK = /['"\x60]\s*(or|and)\s|['"\x60]\s*(--|#)|<\s*script|\bunion\s+select\b|;\s*(drop|delete|insert|update)\s/i;
const mask = (v: unknown, k = ""): unknown =>
  Array.isArray(v) ? v.map((x) => mask(x, k))
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, mask(vv, kk)]))
  : SECRET.test(k) && !(typeof v === "string" && ATTACK.test(v)) ? "[伏せ字]" : v;

// 保存した鍵は、見ただけでは分からない形（固定の文字列との XOR を base64 にしたもの）
type Fs = { readFileSync(path: string, encoding: "utf8"): string };
function savedKey(): string | undefined {
  try {
    const fs = (process as unknown as { getBuiltinModule?: (id: string) => Fs }).getBuiltinModule?.("node:fs");
    const line = fs?.readFileSync(process.cwd() + "/.agentguard/.settings", "utf8").split("\n").find((l) => l.startsWith("v1:"));
    if (!line) return undefined;
    const pad = "agentguard";
    return Array.from(atob(line.slice(3).trim()), (c, i) => String.fromCharCode(c.charCodeAt(0) ^ pad.charCodeAt(i % pad.length))).join("");
  } catch {
    return undefined; // まだ置いていないときは、環境変数だけを使う
  }
}
const SAVED_KEY = savedKey();

async function hmac(key: BufferSource, message: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, new TextEncoder().encode(message));
}
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

// 同じ名前の値が複数あるときは、すべて送る
function queryOf(url: URL): unknown {
  const q: Record<string, unknown> = {};
  for (const [k, v] of url.searchParams) {
    const prev = q[k];
    q[k] = prev === undefined ? v : [...(Array.isArray(prev) ? prev : [prev]), v];
  }
  return mask(q);
}

// フォーム（ファイルといっしょに送るフォームも）と JSON の中身も検査する。ファイルの中身は送らない
async function bodyOf(request: NextRequest): Promise<{ body: string; type: string }> {
  const type = request.headers.get("content-type") ?? "";
  if (request.method === "GET" || request.method === "HEAD") return { body: "", type: "" };
  try {
    if (type.includes("application/json")) {
      const text = await request.clone().text();
      return { body: JSON.stringify(mask(JSON.parse(text))).slice(0, 60000), type: "application/json" };
    }
    if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
      const fields: [string, string][] = [];
      (await request.clone().formData()).forEach((v, k) => { if (typeof v === "string") fields.push([k, String(mask(v, k))]); });
      return { body: new URLSearchParams(fields).toString().slice(0, 60000), type: "application/x-www-form-urlencoded" };
    }
  } catch {
    // 読めない中身は送らない
  }
  return { body: "", type: "" }; // それ以外（画像など）は、読みこまずにそのまま通す
}

/**
 * 検査する。
 *
 * @returns 止めるとき・確認の答えを返すときは、その Response。
 *          そのまま通してよいときは null（呼んだ側が、もとの処理を続ける）。
 */
export async function agentguard(request: NextRequest): Promise<Response | null> {
  const url = request.nextUrl;
  // 鍵を保存したフォルダと、設定セットのフォルダは、見に来た人には絶対に見せない
  if (url.pathname.includes("/.agentguard") || url.pathname.includes("/agentguard-setup")) {
    return new Response("Not Found", { status: 404 });
  }
  const key = process.env.AGENTGUARD_KEY || SAVED_KEY;
  if (!key) return null;
  if (url.pathname === AGENTGUARD_VERIFY_PATH) {
    // このサイトの持ち主かの確認：鍵そのものは見せず、毎回ちがう問題への答えだけを返す
    const secret = await hmac(new TextEncoder().encode(key), "agentguard-verify");
    const answer = hex(await hmac(secret, url.searchParams.get("challenge") ?? ""));
    return new Response(answer, { headers: { "content-type": "text/plain" } });
  }
  try {
    const { body, type } = await bodyOf(request);
    const r = await fetch(AGENTGUARD_INGEST, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + key },
      body: JSON.stringify({
        method: request.method, path: url.pathname, query: queryOf(url), body,
        headers: { "user-agent": request.headers.get("user-agent") ?? "", referer: request.headers.get("referer") ?? "", "content-type": type },
        // 本当の接続元は X-Forwarded-For の最後（前の部分は偽装できる）
        ip: (request.headers.get("x-forwarded-for") ?? "").split(",").pop()?.trim() || null,
      }),
      signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) throw new Error("AgentGuard " + r.status);
    const d = await r.json();
    if (d.block) {
      return new Response("AgentGuard がこのアクセスを止めました（" + (d.reasonJa ?? "攻撃の疑い") + "）",
        { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
  } catch {
    // AgentGuard に確認できないとき：ふだんは通す（サイトを止めない）。
    // AGENTGUARD_FAIL_CLOSED=true なら、安全のため止める
    if (process.env.AGENTGUARD_FAIL_CLOSED === "true") {
      return new Response("安全のため、一時的にアクセスを止めています。しばらくしてからもう一度お試しください。",
        { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "30" } });
    }
  }
  return null; // 通してよい
}
