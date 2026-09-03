"use client";

/**
 * 管理画面の言葉。
 *
 * ■ なぜ別に用意したか
 *   地図の画面は Guide.tsx が言葉を持ち、下の部品へ配っている。
 *   管理画面はページごとに独立していて、上から配る場所が無い。
 *   同じ切り替えを七つの画面それぞれに書くと、直すときに七か所になる。
 *
 *   覚えている場所（localStorage の kitmap.lang）は地図と同じなので、
 *   地図で「あ」を押して英語にすると、管理画面も英語になる。
 *   逆も同じ。二つの設定を持たせない。
 *
 * ■ 読み方
 *   localStorage は React の外にあるものなので、useSyncExternalStore で読む。
 *
 *   useEffect で読んで setState する形も動くが、
 *     ・サーバで描いたもの（必ず日本語）と食い違い、一度描き直しになる
 *     ・同じ画面をいくつも開いていると、片方だけ古いままになる
 *   この形なら、描くときに読むので描き直しが起きず、
 *   別の画面で切り替えたときも storage の合図で揃う。
 *
 * ■ 使い方
 *     const T = useAdminT();
 *     <h1>{T("承認・権限の管理")}</h1>
 *
 *   対応表（lib/i18n.ts）に無い言葉は、日本語のまま出る。
 *   消えるより読めるほうがよいので、そうしてある。
 */

import { useCallback, useSyncExternalStore } from "react";
import { LANG_KEY, t, type Lang } from "@/lib/i18n";

/** 同じ画面の中で切り替えたことを知らせる合図。storage は他の画面にしか届かない */
const EVENT = "kitmap-lang";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(EVENT, onChange);
  };
}

/** ブラウザで読んだ値。読めない設定のときは日本語 */
function readLang(): Lang {
  try {
    return window.localStorage.getItem(LANG_KEY) === "en" ? "en" : "ja";
  } catch {
    return "ja";
  }
}

/** サーバで描くときの値。localStorage が無いので必ず日本語 */
function serverLang(): Lang {
  return "ja";
}

/** いまの言葉と、切り替える口 */
export function useAdminLang(): [Lang, (next: Lang) => void] {
  const lang = useSyncExternalStore(subscribe, readLang, serverLang);

  const change = useCallback((next: Lang) => {
    try {
      window.localStorage.setItem(LANG_KEY, next);
    } catch {
      // 書けない設定のブラウザでは、開くたびに日本語に戻る。読めないよりはよい
    }
    window.dispatchEvent(new Event(EVENT));
  }, []);

  return [lang, change];
}

/** その画面で使う翻訳 */
export function useAdminT(): (ja: string) => string {
  const [lang] = useAdminLang();
  return useCallback((ja: string) => t(lang, ja), [lang]);
}
