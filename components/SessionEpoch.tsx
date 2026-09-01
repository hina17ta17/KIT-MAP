"use client";

/**
 * ログインの版を見張る。
 *
 * どの画面でも、開いた直後に一度だけ働く。版がずれていれば
 * ログインの控えを捨て、画面を読み込み直す。
 *
 * 見た目は何も出さない。出すものが無いので、置き場所は
 * どこでもよい（app/layout.tsx の body 直下に置いてある）。
 */

import { useEffect } from "react";
import { enforceEpoch } from "@/lib/session";

export function SessionEpoch() {
  useEffect(() => {
    let alive = true;
    void enforceEpoch().then((cleared) => {
      // 捨てたときだけ読み込み直す。捨てていないのに直すと、
      // 開くたびに読み込みが2回走ることになる
      if (alive && cleared) window.location.reload();
    });
    return () => {
      alive = false;
    };
  }, []);
  return null;
}
