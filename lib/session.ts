/**
 * 全員をログインし直させる仕掛け。
 *
 * ■ 何のためか
 *   Supabase には「この人を強制ログアウト」という管理者向けの口が無い
 *   （/auth/v1/admin/users/{id}/logout は 404。実際に叩いて確かめた）。
 *   入ったままの人を切るには、パスワードを決め直すか席を消すしかなかった。
 *
 *   そこで、コード側に「版」を持たせる。下の数を1つ増やして配ると、
 *   次にサイトを開いた全員が一度ログアウトされ、入り直しになる。
 *
 * ■ どう効くか
 *   ログインの控えはブラウザの中にある。開いたときに、覚えている版と
 *   コードの版を見比べ、違っていれば控えを捨てる。
 *   捨てるときは Supabase にも伝えるので、その人の他の端末も切れる。
 *
 * ■ 気をつけること
 *   ・数を増やすと全員が対象になる。特定の一人だけは切れない
 *   ・入り直しには、その人がパスワードを覚えている必要がある
 *   ・覚えた端末（6桁を省く記録）も一緒に忘れる。
 *     入り直したとき、認証アプリを登録している人はもう一度6桁を求められる
 */

import { TRUSTED_KEY } from "@/lib/device";

/**
 * ログインの版。
 *
 * ★ 全員を入り直させたいときは、この数を1つ増やして配る。
 *
 *   1 … 最初
 *   2 … 2026-09-01 いったん全員を入り直しにした
 */
export const SESSION_EPOCH = 2;

const EPOCH_KEY = "kitmap.epoch";

/** このブラウザが覚えている版。読めなければ 0（＝まだ何も覚えていない） */
function storedEpoch(): number {
  try {
    return Number(window.localStorage.getItem(EPOCH_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

/**
 * 版がずれていれば控えを捨てる。合っていれば何もしない。
 *
 * 戻り値は「捨てたか」。捨てたときは画面を読み込み直す側で使う。
 */
export async function enforceEpoch(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (storedEpoch() === SESSION_EPOCH) return false;

  try {
    const { createClient, supabaseReady } = await import("@/lib/supabase/client");
    if (supabaseReady) {
      // 既定で全部の端末が対象になる。控えが既に切れていても失敗にしない
      await createClient().auth.signOut();
    }
  } catch {
    // 繋がらなくても、こちらの控えは捨てる
  }

  try {
    window.localStorage.removeItem(TRUSTED_KEY);
    window.localStorage.setItem(EPOCH_KEY, String(SESSION_EPOCH));
  } catch {
    // 書けない設定のブラウザでは、毎回ログアウトになる。
    // 入れないよりはよい
  }
  return true;
}
