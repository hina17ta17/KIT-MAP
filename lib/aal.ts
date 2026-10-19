/**
 * このログインで、認証アプリの6桁を確かめたか（aal2）。
 *
 * データベースは、6桁を確かめていない管理者を学生として扱う
 * （base/01_core.sql）。そのまま管理の操作をすると、何を押しても
 * 「権限がありません」になり、何が起きているのか分からない。
 * 画面の側でも先に見て、6桁を入れる所へ案内するために使う。
 */

import { createClient } from "@/lib/supabase/client";
import { isAdminRole } from "@/lib/loginStep";

/**
 * 管理の権限を持つのに、このログインで6桁を確かめていないか。
 *
 * 権限は自分の行（profiles.role）から読む。自分の行はいつでも読めるので、
 * 6桁の前でも本当の権限が分かる。確かめられないときは false
 * （案内を出さない。各画面の判断に任せる）。
 */
export async function needsCode(): Promise<boolean> {
  try {
    const supabase = createClient();
    const { data: lv } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (lv?.currentLevel === "aal2") return false;
    const { data: u } = await supabase.auth.getUser();
    const id = u.user?.id;
    if (!id) return false;
    const { data: me } = await supabase.from("profiles").select("role").eq("id", id).single();
    return isAdminRole((me as { role?: string } | null)?.role ?? "");
  } catch {
    return false;
  }
}
