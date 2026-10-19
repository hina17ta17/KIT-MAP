/**
 * パスワードを忘れた人の、入れ直し。
 *
 * ■ なぜサイトの内側でやるのか
 *
 *   パスワードを忘れた人は、ログインできない。
 *   ログインできないと、認証アプリの確認も呼べない
 *   （Supabase の本人確認は、入っている人にしか使えない）。
 *   画面の中だけでは、どうやっても輪が閉じない。
 *
 *   メールで再設定する道も使えない。このアプリはメールを
 *   一通も送らない決まりで、送る仕組みも用意していない。
 *
 *   そこで、ここ（サーバ側）が代わりに手続きをする。
 *   本人だと分かるまで、パスワードには触らない。
 *
 *
 * ■ 手順
 *
 *   ① まちがえすぎていないかを見る（pw_reset_gate）
 *   ② その人ぶんの入り口を、内側だけで作る
 *   ③ 認証アプリの6桁を確かめる  ← ここが本人確認
 *   ④ 合っていたら、新しいパスワードにする
 *   ⑤ 内側の入り口は、その場で閉じる
 *
 *   ③で合わなければ、④はしない。
 *   ②で作った入り口は外へ出さない。返すのは「できた／できない」だけ。
 *
 *
 * ■ 鍵について
 *
 *   ここは service_role の鍵を使う。ブラウザには決して降りない、
 *   サーバの中だけで動く場所（route handler）なので置いてよい。
 *
 *   置き場所
 *     手元  .env.local      SUPABASE_SERVICE_ROLE_KEY=...
 *     本番  Vercel の環境変数（NEXT_PUBLIC_ は付けない）
 *
 *   NEXT_PUBLIC_ を付けると画面に配られてしまう。絶対に付けない。
 *
 *
 * ■ 何回まで試せるか
 *
 *   同じアドレスで5回まちがえると、15分は何も受け付けない
 *   （数えているのは base/01_core.sql）。
 *   6桁は100万通りあるが、数えないと機械にはいつか当てられる。
 */

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { checkPassword } from "@/lib/auth";

/** 鍵を使うので、Node のほうで動かす */
export const runtime = "nodejs";
/** 毎回その場で動かす。結果を貯めない */
export const dynamic = "force-dynamic";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

/**
 * 断るときの文句は、いつも同じにする。
 *
 * 「そのアドレスは登録されていません」と返すと、
 * 打ち込むだけで誰が使っているかを調べられてしまう。
 * アドレスが違っても、6桁が違っても、同じ答えにする。
 */
const NG = "アドレスか、認証アプリの6桁が違います";

function bad(message: string, status = 400) {
  return NextResponse.json({ ok: false, message }, { status });
}

export async function POST(req: Request) {
  if (!URL || !ANON || !SERVICE) {
    return bad(
      "この機能はまだ使えません（サーバ側の設定が足りていません）。管理者にお知らせください。",
      503,
    );
  }

  let body: { email?: unknown; code?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("送られてきた内容が読めませんでした");
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const code = typeof body.code === "string" ? body.code.replace(/\D/g, "") : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!email.includes("@")) return bad("メールアドレスを入れてください");
  if (code.length !== 6) return bad("認証アプリの6桁を入れてください");
  const pwErr = checkPassword(password);
  if (pwErr) return bad(pwErr);

  /* 内側の鍵。ログイン状態は持たせない（ここは誰でもない） */
  const admin = createClient(URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  /* ---------- ① まちがえすぎていないか ---------- */
  const { data: gate, error: gateErr } = await admin.rpc("pw_reset_gate", { p_email: email });
  if (gateErr) {
    return bad(
      `${gateErr.message}（base/01_core.sql をまだ入れていない場合は、先に入れてください）`,
      500,
    );
  }
  const g = gate as { allowed?: boolean; wait_sec?: number } | null;
  if (!g?.allowed) {
    const min = Math.ceil((g?.wait_sec ?? 900) / 60);
    return bad(`何度もまちがえています。${min} 分ほど待ってから、もう一度お試しください`, 429);
  }

  /* ---------- ② その人ぶんの入り口を、内側だけで作る ---------- */
  /*
   * 「パスワードを忘れた人のための入り口」を作ってもらい、
   * その札（hashed_token）をそのままこちらで使う。
   * メールは送らない。作るだけで、外にも出さない。
   */
  let token = "";
  /** 札の種類。確かめるときも、作ったときと同じものを渡す */
  let kind: "recovery" | "magiclink" = "recovery";
  for (const type of ["recovery", "magiclink"] as const) {
    const { data, error } = await admin.auth.admin.generateLink({ type, email });
    if (!error && data?.properties?.hashed_token) {
      token = data.properties.hashed_token;
      kind = type;
      break;
    }
  }
  // その人がいない。あるかどうかは教えない
  if (!token) return bad(NG);

  /*
   * この入り口を使うための、別の鍵。
   * 内側の鍵（service_role）のままだと本人としては動けない。
   */
  const asUser = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error: inErr } = await asUser.auth.verifyOtp({ type: kind, token_hash: token });
  if (inErr) return bad(NG);

  /** 何があっても、この入り口は閉じてから返す */
  const close = async () => {
    await asUser.auth.signOut().catch(() => undefined);
  };

  try {
    /* ---------- ③ 認証アプリの6桁を確かめる ---------- */
    const { data: fl, error: flErr } = await asUser.auth.mfa.listFactors();
    if (flErr) return bad(NG);
    const factor = (fl?.totp ?? []).find((f) => f.status === "verified");
    if (!factor) {
      /*
       * 認証アプリを登録していない人。
       * ここで通すと、アドレスを知っているだけで
       * パスワードを変えられることになる。断る。
       */
      return bad(
        "この席には認証アプリが登録されていないため、ここからは入れ直せません。管理者にお知らせください。",
      );
    }

    const { error: mfaErr } = await asUser.auth.mfa.challengeAndVerify({
      factorId: factor.id,
      code,
    });
    if (mfaErr) return bad(NG);

    /* ---------- ④ ここではじめてパスワードに触る ---------- */
    const { error: pwSetErr } = await asUser.auth.updateUser({
      password,
      data: { pw_set: true },
    });
    if (pwSetErr) return bad(pwSetErr.message);

    /*
     * 合ったので、まちがえた回数を消す。
     * ここが失敗しても入れ直しは済んでいる。15分たてば
     * どのみち数え直されるので、伝えることはしない。
     */
    await admin.rpc("pw_reset_done", { p_email: email });

    return NextResponse.json({ ok: true });
  } finally {
    /* ---------- ⑤ 内側の入り口を閉じる ---------- */
    await close();
  }
}
