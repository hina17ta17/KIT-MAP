/**
 * 管理の画面を送る前に、サーバーで確かめる。
 *
 * ■ 何のためか
 *   前は、管理の画面（/admin/… の枠とプログラム）を誰にでも送り、
 *   ブラウザの中で「この人に見せてよいか」を決めていた。データは
 *   データベースが断るので漏れないが、URL を知っていれば画面の作りは手に入り、
 *   書き換えれば管理の画面の形まで出せた。
 *
 *   ここで先に確かめ、使えない人には画面そのものを送らない。
 *
 * ■ 確かめ方
 *   ログインの札は Supabase に訊いて確かめる（getUser）。権限は、データベースの
 *   my_role() に訊く。6桁を確かめていない管理者・サイトを止めているあいだの扱いも、
 *   データベースと同じ答えになる。どの画面を誰が使えるかは lib/adminAccess.ts。
 *
 * ■ 使えない人には
 *   ログインしていない        → ログインの画面へ
 *   管理者で、6桁がまだ        → ログインの画面へ（6桁を入れる段が出る）
 *   ログインしているが権限が無い → 「ページが見つかりません」（画面があること自体を教えない）
 *   訊けなかった（つながらない）→ 送らない側に倒す（見つかりません）
 *
 * ■ どこで呼ぶか
 *   各画面の layout.tsx（app/admin/○○/layout.tsx）。共通の app/admin/layout.tsx に
 *   置かないのは、管理の画面どうしを行き来するとき、共通の枠は作り直されず、
 *   確かめが走らないため。画面ごとの枠なら、開くたびに必ず走る。
 */

import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { createServerClient } from "@supabase/ssr";
import { ADMIN_ACCESS, type AdminArea } from "@/lib/adminAccess";
import { isAdminRole } from "@/lib/loginStep";
import type { Role } from "@/lib/auth";

export async function guardAdminPage(area: AdminArea): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  /* 接続先が無い組み立て（手元の試し）では、画面のほうが「接続できません」を出す */
  if (!url || !key) return;

  const store = await cookies();
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => store.getAll(),
      /* ここでは書かない。ログインの札の更新は proxy.ts がする */
      setAll: () => {},
    },
  });

  const { data: u } = await supabase.auth.getUser();
  if (!u.user) redirect("/login");

  const [eff, me] = await Promise.all([
    supabase.rpc("my_role"),
    supabase.from("profiles").select("role").eq("id", u.user.id).single(),
  ]);
  const effective = (eff.error ? null : (eff.data as Role | null)) ?? null;
  if (ADMIN_ACCESS[area](effective)) return;

  /* 管理の権限はあるのに、このログインで6桁をまだ確かめていない人 */
  const stored = ((me.data as { role?: string } | null)?.role ?? "") as Role;
  if (effective === "student" && isAdminRole(stored) && ADMIN_ACCESS[area](stored)) {
    redirect("/login");
  }

  notFound();
}
