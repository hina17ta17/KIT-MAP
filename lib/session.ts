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
 * このブラウザに、ログインの控えが残っているか。
 *
 * 控えは Supabase のクッキー（`sb-…-auth-token`。長いと `.0` `.1` に分かれる）。
 * 古い形でブラウザの保存場所に置いた控えも、念のため見る。
 */
export function hasSavedLogin(): boolean {
  const NAME = /^sb-[^=;]*-auth-token(\.\d+)?$/;
  try {
    if (document.cookie.split(";").some((c) => NAME.test(c.split("=")[0].trim()))) return true;
  } catch {
    // 読めないときは、次の場所を見る
  }
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      if (NAME.test(window.localStorage.key(i) ?? "")) return true;
    }
  } catch {
    // 読めない設定のブラウザ
  }
  return false;
}

/**
 * 版がずれていれば控えを捨てる。合っていれば何もしない。
 *
 * 戻り値は「画面を読み込み直すべきか」。
 * 読み込み直すのは、ログインの控えを実際に捨てられたときだけ。
 * 初めて開いた人には捨てるものが無いので、版を覚えるだけにする
 * （前は初めての人も毎回2回読み込んでいて、アクセス解析の数も2倍になっていた）。
 */
export async function enforceEpoch(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (storedEpoch() === SESSION_EPOCH) return false;

  const hadLogin = hasSavedLogin();
  if (hadLogin) {
    try {
      const { createClient, supabaseReady } = await import("@/lib/supabase/client");
      if (supabaseReady) {
        // 既定で全部の端末が対象になる。控えが既に切れていても失敗にしない
        await createClient().auth.signOut();
      }
    } catch {
      // 繋がらなくても先へ進む（下で、控えが残ったかを見る）
    }
  }
  const left = hasSavedLogin();

  try {
    window.localStorage.removeItem(TRUSTED_KEY);
    // 控えを捨てられなかった（繋がらない など）ときは、版を覚えない。次に開いたときにもう一度捨てる
    if (!left) window.localStorage.setItem(EPOCH_KEY, String(SESSION_EPOCH));
  } catch {
    // 書けない設定のブラウザでは、ログインしていると毎回ログアウトになる。
    // 入れないよりはよい
  }
  // 控えが消えたときだけ読み込み直す。消せなかったときに読み込み直すと、
  // 同じことを繰り返して読み込みが止まらなくなるため
  return hadLogin && !left;
}
