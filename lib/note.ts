/**
 * 起きたことを履歴に残す。
 *
 * ■ 何のためか
 *   画面で何かがうまくいかなかったとき、その場では
 *   「うまくいきませんでした」と出るだけで、あとには何も残らない。
 *   あとから「あのとき何が起きたのか」を確かめるすべが無かった。
 *
 *   ここを通したものは、管理の「履歴」に一行ずつ残る。
 *
 * ■ そのままの言葉も残す
 *   読みやすく言い換えたものだけを残すと、原因が分からなくなる。
 *   「うまくいきませんでした」では、どこを直せばよいか決まらない。
 *   だから両方を残す。
 *     label  … 人が読むための一行
 *     detail … 出た言葉、そのまま（名前・番号・出どころ）
 *
 * ■ 残せなくても、呼んだ側は止めない
 *   控えのために画面が止まっては本末転倒。
 *   ここは何が起きても投げない。ログインしていないときは黙って何もしない。
 */

import { createClient, supabaseReady } from "@/lib/supabase/client";

/** 履歴の分類。05_feedback_history.sql の 05-3 の area とそろえてある */
export type NoteArea =
  | "rooms"
  | "campus"
  | "schedule"
  | "cafeteria"
  | "roster"
  | "people"
  | "system";

/** エラーから、そのままの中身を取り出す */
function rawOf(e: unknown): Record<string, unknown> {
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    // Supabase（PostgREST）が返すもの
    for (const k of ["code", "message", "details", "hint", "status", "statusText"]) {
      if (o[k] !== undefined && o[k] !== null && o[k] !== "") out[k] = o[k];
    }
    // ふつうの Error
    if (e instanceof Error) {
      out.name = e.name;
      out.message = e.message;
      if (e.stack) out.stack = String(e.stack).slice(0, 1200);
    }
    if (Object.keys(out).length > 0) return out;
    try {
      return { raw: JSON.stringify(o).slice(0, 1200) };
    } catch {
      return { raw: String(e).slice(0, 1200) };
    }
  }
  return { raw: String(e).slice(0, 1200) };
}

/** いまの画面と、いつか。どこで起きたかを追えるように */
function whereOf(): Record<string, unknown> {
  if (typeof window === "undefined") return {};
  return {
    page: location.pathname,
    at: new Date().toISOString(),
    browser: navigator.userAgent.slice(0, 200),
  };
}

async function put(
  area: NoteArea,
  action: "event" | "error",
  label: string,
  detail: Record<string, unknown>,
): Promise<void> {
  if (!supabaseReady) return;
  try {
    const supabase = createClient();
    const { data } = await supabase.auth.getUser();
    // ログインしていない人は残せない（残す先の決まりがそうなっている）
    if (!data.user) return;
    await supabase.rpc("history_note", {
      p_area: area,
      p_action: action,
      p_label: label.slice(0, 500),
      p_detail: { ...whereOf(), ...detail },
    });
  } catch {
    /* 残せなくても、呼んだ側は止めない */
  }
}

/** うまくいかなかったことを残す。出た言葉もそのまま残る */
export function noteError(area: NoteArea, label: string, e: unknown): void {
  void put(area, "error", label, rawOf(e));
}

/** 起きたことを残す（うまくいったことも含む） */
export function noteEvent(
  area: NoteArea,
  label: string,
  detail: Record<string, unknown> = {},
): void {
  void put(area, "event", label, detail);
}
