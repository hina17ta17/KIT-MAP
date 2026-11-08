/**
 * アクセス解析（バーセルの Web Analytics）に送る前の、ふるい。
 *
 * ■ 送るもの
 *   開いたページの道（`/` や `/login`）だけ。
 *   解析そのものはクッキーを使わず、個人を特定しない（バーセルの仕組み）。
 *
 * ■ 送らないもの
 *   - `?` から後ろと `#` から後ろ。ログインの戻りの番号などが入ることがあるため
 *   - 管理の画面（`/admin…`）。使う人が限られていて、数える意味がない
 */
import type { BeforeSendEvent } from "@vercel/analytics/next";

const HIDDEN = /^\/admin(\/|$)/;

export function beforeSend(event: BeforeSendEvent): BeforeSendEvent | null {
  let url: URL;
  try {
    url = new URL(event.url);
  } catch {
    return null; // 読めない住所は送らない
  }
  if (HIDDEN.test(url.pathname)) return null;
  url.search = "";
  url.hash = "";
  return { ...event, url: url.toString() };
}
