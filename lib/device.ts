/**
 * 「この端末では本人確認を済ませた」という覚え。
 *
 * ■ 何のためか
 *   知らない端末から入ろうとした人には、認証アプリで確かめてもらう。
 *   一度確かめた端末では、次から求めない。
 *
 *   毎回求めると使ってもらえないが、一度きりだと、パスワードが漏れた
 *   時点でどこからでも入れてしまう。その間を取る。
 *
 * ■ 覚えるのはこの端末の中だけ
 *   誰かに送るものではない。ブラウザを変えたり、履歴を消したりすれば
 *   もう一度求められる。それは想定どおりの動き。
 *
 * ■ これは入口の手間を減らすためのもの
 *   本当の確かめは Supabase 側の認証アプリの照合で行われる。
 *   ここに印があっても、照合そのものを飛ばすわけではない。
 */

/** 覚えた端末の記録。版を上げるときにも消すので、外からも使えるようにする */
export const TRUSTED_KEY = "kitmap.trusted.v1";
const KEY = TRUSTED_KEY;

/** 期限。これを過ぎたら、同じ端末でももう一度確かめる */
const DAYS = 60;

type Store = Record<string, number>;

function read(): Store {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

/** その人が、この端末で本人確認を済ませているか */
export function isTrustedDevice(userId: string): boolean {
  if (!userId) return false;
  const at = read()[userId];
  if (!at) return false;
  const days = (Date.now() - at) / 86_400_000;
  return days >= 0 && days < DAYS;
}

/** この端末を「確かめ済み」として覚える */
export function trustDevice(userId: string) {
  if (typeof window === "undefined" || !userId) return;
  try {
    const s = read();
    s[userId] = Date.now();
    window.localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // 覚えられなくても動く。次に入るときまた確かめるだけ
  }
}
