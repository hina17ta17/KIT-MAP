"use client";

/**
 * ログインと利用の申請。
 *
 * ■ 申請の流れ
 *   ① メールアドレスと氏名 →［次へ］
 *      → 大学のドメインでないと通らない
 *   ② 学年・クラス・名列番号 →［次へ］
 *      → ここで席を作る。①②のあいだは何も書き込まない
 *   ③ Microsoft Authenticator で本人確認
 *      → QRを読ませ、出てきた6桁を入れる。その端末と結び付く
 *   ④ パスワードを決めて［申請する］
 *   ⑤ 管理者が承認するまでは学内情報を見られない
 *
 * 席を作るのは②の終わりまで待つ。認証アプリの登録は入った人にしか
 * できないので、それより前には作れない。逆に、それより早く作ると
 * 途中でやめた人の席が増える。
 *
 * パスワードを最後に置くため、席を作るときは仮のものを入れておく。
 * 本人には見せず、④で本人が決めたものへ置き換える。決めたかどうかは
 * 席の控え（pw_set）に残すので、途中で閉じても続きから戻れる。
 *
 * ③は申請のときだけ。以後のログインはメールとパスワードで入る。
 *
 * ■ メールは一通も送らない
 *   確認も、パスワードの再設定も、メールは使わない。
 *   忘れた人は、管理者が supabase/set_password.sql で決め直す。
 *
 * ■ なぜメールでの確認をしないか
 *   学生は全員この認証アプリを持っているので、そちらで確かめる。
 *   メールに頼ると、送信の上限（標準の送信サービスは非常に少ない）と
 *   文面を変えられない制限に当たり、一斉の申請に耐えられない。
 *
 * ■ そのぶん守れないこと
 *   「そのアドレスの持ち主か」までは分からない。大学のドメインで
 *   ありさえすれば、他人のアドレスでも申請できてしまう。
 *   最後の関門は管理者の承認。承認画面に氏名・学年・クラス・
 *   名列番号が出るので、名簿と突き合わせて判断する。
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient, supabaseReady } from "@/lib/supabase/client";
import { AdminMenu } from "@/components/AdminNav";
import { LANG_KEY, t as tr, type Lang } from "@/lib/i18n";
import { isTrustedDevice, trustDevice } from "@/lib/device";
import {
  CLASS_CODES,
  GRADES,
  SEAT_MAX,
  SEAT_MIN,
  checkSeat,
  PASSWORD_MAX,
  PASSWORD_MIN,
  ROLE_LABEL,
  checkPassword,
  isAllowedEmail,
  type Role,
} from "@/lib/auth";

/**
 * 席を作ったあとの段。
 *
 * 席を作る前（メールアドレス・氏名と、学年・クラス・名列番号）は
 * まだログインしていないので、ここには入らない。SignupStep のほう。
 */
type Step = "mfa" | "password" | "verify" | "done";

/** 席を作る前の段。この間はまだ何もデータベースに書かない */
type SignupStep = 1 | 2;

type Me = {
  email: string;
  role: Role;
  full_name: string;
  grade: number;
  class_code: string;
  group_no: number;
  /** 名列番号。組から置き換えた */
  seat_no: number;
  verified: boolean;
};

/**
 * 席を作るときだけ使う、仮のパスワード。
 *
 * 本人は知らないし、本人が決めたものにすぐ置き換わる。
 * 推測されないよう、端末の乱数から作る。
 */
function tempPassword(): string {
  const a = new Uint8Array(24);
  crypto.getRandomValues(a);
  return "T" + Array.from(a, (b) => b.toString(36)).join("").slice(0, 30) + "9";
}

export default function LoginPage() {
  /*
   * 表示の言葉。案内画面で切り替えたものを引き継ぐ。
   * 英語にしている人が、ログインだけ日本語に戻るのは分かりにくいため。
   */
  const [lang, setLang] = useState<Lang>("ja");
  useEffect(() => {
    try {
      if (window.localStorage.getItem(LANG_KEY) === "en") setLang("en");
    } catch {
      // 読めなくても日本語で動く
    }
  }, []);
  const T = useCallback((ja: string) => tr(lang, ja), [lang]);

  /**
   * 言葉を切り替える。
   *
   * 案内画面を通らずにこの画面へ来る人がいる（共有された URL など）。
   * その人が日本語のまま動けなくならないよう、ここにも口を置く。
   * 選んだ言葉は案内画面と同じ場所に覚えるので、行き来しても揃う。
   */
  const toggleLang = useCallback(() => {
    setLang((prev) => {
      const next = prev === "ja" ? "en" : "ja";
      try {
        localStorage.setItem(LANG_KEY, next);
      } catch {
        // 保存できなくても、この画面では切り替わる
      }
      return next;
    });
  }, []);

  const [mode, setMode] = useState<"login" | "signup">("login");
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err" | "info"; text: string } | null>(null);

  /* ログイン */
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");

  /* 申請 */
  const [step, setStep] = useState<Step>("mfa");
  /** 席を作る前の段。① メールと氏名 → ② 学年・クラス・名列番号 */
  const [signupStep, setSignupStep] = useState<SignupStep>(1);
  const [name, setName] = useState("");
  const [grade, setGrade] = useState<number>(0);
  const [classCode, setClassCode] = useState("");
  /** 名列番号（1〜200）。入力中は文字で持つ。空にできるようにするため */
  const [seat, setSeat] = useState("");
  /** いま入っている人の席のID。端末を覚えるときの目印にする */
  const [uid, setUid] = useState("");
  /** 知らない端末から入ったときに使う、確認用の6桁 */
  const [loginCode, setLoginCode] = useState("");

  /** 認証アプリに読ませるQRと、手で入れる用の文字列 */
  const [mfa, setMfa] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState("");

  const reload = useCallback(async () => {
    if (!supabaseReady) {
      setLoading(false);
      return;
    }
    const supabase = createClient();
    const { data } = await supabase.auth.getUser();
    if (!data.user) {
      setMe(null);
      setLoading(false);
      return;
    }

    const read = async () =>
      (
        await supabase
          .from("profiles")
          // 列を並べずに取る。新しい列を足す SQL を流す前でも落ちないようにするため。
          // 並べて書くと、無い列を1つ指したとたん問い合わせ全体が失敗し、
          // ログインできているのに「誰でもない」扱いになってしまう
          .select("*")
          .eq("id", data.user!.id)
          .single()
      ).data as Me | null;

    let p = await read();

    /*
     * 席はあるのに情報が無いことがある。
     * その状態だと、ログインできているのに画面では「誰でもない」扱いになり、
     * ログインの画面が出たままになってしまう。
     * 自分の行を作り直してから読み直す。作れるのは自分の行だけで、
     * 権限は承認待ちから始まる。
     */
    if (!p) {
      await supabase.rpc("ensure_profile");
      p = await read();
    }

    setUid(data.user.id);

    if (p) {
      setMe(p);
      // 途中で閉じた人が続きから進められるようにする
      setName(p.full_name);
      setGrade(p.grade);
      setClassCode(p.class_code);
      setSeat(p.seat_no ? String(p.seat_no) : "");

      /*
       * 認証アプリが登録されているかは、席の情報の列ではなく
       * 認証の仕組みそのものに訊く。
       *
       * profiles.verified は、申請の画面を通ったときだけ立つ。
       * データベースから直に権限を付けた人（最初の管理者など）は
       * 立っていないので、列だけを見ると「登録済みかどうか」を
       * 取り違える。実際に登録されている factor を数える。
       */
      let hasFactor = false;
      try {
        const { data: fl } = await supabase.auth.mfa.listFactors();
        hasFactor = (fl?.totp ?? []).some((x) => x.status === "verified");
      } catch {
        // 訊けないときは「未登録」として扱う。登録をうながす側に倒す
      }

      /*
       * パスワードを決めたか。
       *
       * 申請では、本人確認が済んでからパスワードを決める。それまでは
       * こちらで作った仮のものが入っていて、本人は知らない。
       * 決めたときに印を付けておき、途中で閉じても続きから戻れるようにする。
       */
      const meta = (data.user.user_metadata ?? {}) as Record<string, unknown>;
      const pwSet = meta.pw_set === true;

      // 席を作るときに預けた記入内容。読み込み直しても消えないように
      if (!name && typeof meta.full_name === "string") setName(meta.full_name);
      if (!grade && typeof meta.grade === "number") setGrade(meta.grade);
      if (!classCode && typeof meta.class_code === "string") setClassCode(meta.class_code);
      if (!seat && typeof meta.seat_no === "number") setSeat(String(meta.seat_no));

      /*
       * どこへ進ませるかを、ここで一本にまとめる。
       *
       * 以前は「承認済みなら done」と先に決めていたため、
       * 承認済みで認証アプリが未登録の人が、どの枝にも入らないまま
       * done に落ちていた。6桁を入れる画面がどこにも出ず、
       * 登録し直す道もない状態になっていた（最初の管理者がこれ）。
       */
      if (!hasFactor) {
        // まだ認証アプリが無い人は、承認済みでも登録から。
        // 下の管理メニューは出たままなので、締め出しにはならない
        setStep("mfa");
      } else if (p.role === "pending" && !pwSet) {
        // 本人確認は済んだ。あとはパスワードを決めれば申請が出る
        setStep("password");
      } else if (p.role !== "pending") {
        /*
         * 知らない端末から入ったときは、認証アプリで確かめてもらう。
         * 一度確かめた端末では次から求めない。毎回だと使ってもらえず、
         * 一度きりだと、パスワードが漏れた時点でどこからでも入れてしまう。
         */
        setStep(isTrustedDevice(data.user.id) ? "done" : "verify");
      } else {
        setStep("done");
      }
    } else {
      /*
       * 席はあるのに情報が作れなかった。
       *
       * ここで黙るとログインの画面が出たままになり、
       * 入っているのに入れないように見える。何が起きたかを出す。
       */
      setMsg({
        kind: "err",
        text: "利用者の情報を読み込めませんでした。一度ログアウトして、入り直してください。",
      });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /* ---------------- ①② 記入 → ③ 席を作って本人確認へ ---------------- */

  const domainOk = isAllowedEmail(email);
  /** ① メールアドレスと氏名 */
  const canStep1 = domainOk && name.trim().length > 0;
  /** ② 学年・クラス・名列番号 */
  const seatNum = Number(seat);
  const canStep2 =
    !!grade && !!classCode && seat.length > 0 && checkSeat(seatNum) === null;

  /**
   * 席を作り、本人確認へ進む。
   *
   * パスワードは本人確認のあとに決めてもらうので、ここでは
   * こちらで作った仮のものを入れておく。本人には見せないし、
   * 最後に本人が決めたものへ置き換える。
   *
   * 席を作らないと認証アプリを登録できない（登録は入った人にしか
   * できない仕組み）ので、記入が済むここまで待ってから作る。
   * 途中でやめた人の席が残らないよう、作るのは最後の最後にしてある。
   *
   * 記入した内容は席の控えに預けておく。読み込み直しても消えず、
   * 最後にまとめて情報として書き込む。
   */
  const beginVerify = async () => {
    setMsg(null);
    if (!canStep1 || !canStep2) return;
    setBusy(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signUp({
        email: email.trim(),
        password: tempPassword(),
        options: {
          data: {
            full_name: name.trim(),
            grade,
            class_code: classCode,
            seat_no: seatNum,
          },
        },
      });
      if (error) throw error;

      await reload();
      setStep("mfa");
      setMsg({ kind: "info", text: T("続けて、認証アプリで本人確認をしてください。") });
    } catch (e) {
      setMsg({ kind: "err", text: T(translate(e)) });
    } finally {
      setBusy(false);
    }
  };

  /* ---------------- ② 認証アプリで本人確認 ---------------- */

  const enroll = async () => {
    setMsg(null);
    setBusy(true);
    try {
      const supabase = createClient();
      // 途中でやめた登録が残っていると新しく作れない。片づけてから始める
      const { data: list } = await supabase.auth.mfa.listFactors();
      for (const f of list?.all ?? []) {
        if (f.factor_type === "totp" && f.status !== "verified") {
          await supabase.auth.mfa.unenroll({ factorId: f.id });
        }
      }

      const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp" });
      if (error) throw error;
      setMfa({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
    } catch (e) {
      setMsg({ kind: "err", text: T(translate(e)) });
    } finally {
      setBusy(false);
    }
  };

  const verifyMfa = async () => {
    setMsg(null);
    if (!mfa) return;
    if (!/^\d{6}$/.test(code)) {
      setMsg({ kind: "err", text: T("6桁の数字を入れてください") });
      return;
    }
    setBusy(true);
    try {
      const supabase = createClient();
      const { data: ch, error: e1 } = await supabase.auth.mfa.challenge({ factorId: mfa.id });
      if (e1) throw e1;
      const { error: e2 } = await supabase.auth.mfa.verify({
        factorId: mfa.id,
        challengeId: ch.id,
        code,
      });
      if (e2) throw e2;

      /*
       * ここを通れた＝この端末の認証アプリが、この席と結び付いた。
       * 申請の最後の関門で、通れば認証完了とする。
       *
       * 相手はメールアドレスではなく席のIDで指す。アドレスは画面の
       * 入力欄から来るので、書き換えられていると別の人の行を直してしまう。
       */
      const { data: u } = await supabase.auth.getUser();
      const { error: e3 } = await supabase
        .from("profiles")
        .update({ verified: true })
        .eq("id", u.user?.id ?? "");
      if (e3) throw e3;

      setCode("");
      // いま確かめたので、この端末は覚えてよい
      if (u.user?.id) trustDevice(u.user.id);
      /*
       * 次にどこへ行くかは reload に決めさせる。
       * ここで "detail" と決め打つと、すでに権限のある人まで
       * 所属の記入へ押し込んでしまう。
       */
      await reload();
      setMsg({ kind: "ok", text: T("本人確認ができました。") });
    } catch (e) {
      setMsg({ kind: "err", text: T(translate(e)) });
    } finally {
      setBusy(false);
    }
  };

  /* ---------------- ④ パスワードを決めて申請 ---------------- */

  /**
   * 本人が決めたパスワードに置き換え、記入した情報を書いて申請を出す。
   *
   * ここまで来てはじめて、管理者の「申請」に並ぶ。
   * 順番をこうしているのは、本人だと確かめられていない記入を
   * 承認の一覧に混ぜないため。
   */
  const finish = async () => {
    setMsg(null);
    const err = checkPassword(pw);
    if (err) {
      setMsg({ kind: "err", text: T(err) });
      return;
    }
    setBusy(true);
    try {
      const supabase = createClient();
      const { data: u } = await supabase.auth.getUser();
      const meta = (u.user?.user_metadata ?? {}) as Record<string, unknown>;

      // 仮のものから、本人が決めたものへ。決めた印もここで付ける
      const { error: e1 } = await supabase.auth.updateUser({
        password: pw,
        data: { pw_set: true },
      });
      if (e1) throw e1;

      // 記入した内容。読み込み直したあとでも困らないよう、控えからも拾う
      const gradeV = grade || (typeof meta.grade === "number" ? meta.grade : 0);
      const classV =
        classCode || (typeof meta.class_code === "string" ? meta.class_code : "");
      const seatV =
        Number(seat) || (typeof meta.seat_no === "number" ? meta.seat_no : 0);
      const nameV =
        name.trim() || (typeof meta.full_name === "string" ? meta.full_name : "");

      const { error: e2 } = await supabase
        .from("profiles")
        .update({
          full_name: nameV,
          grade: gradeV,
          class_code: classV,
          seat_no: seatV,
        })
        .eq("id", u.user?.id ?? "");
      if (e2) throw e2;

      setPw("");
      await reload();
      setMsg({ kind: "ok", text: T("申請しました。管理者の承認をお待ちください。") });
    } catch (e) {
      setMsg({ kind: "err", text: T(translate(e)) });
    } finally {
      setBusy(false);
    }
  };

  /* ---------------- ログイン ---------------- */

  const signIn = async () => {
    setMsg(null);
    if (!isAllowedEmail(email)) {
      setMsg({ kind: "err", text: T("メールアドレスかパスワードが違います") });
      return;
    }
    setBusy(true);
    try {
      const { error } = await createClient().auth.signInWithPassword({ email, password: pw });
      if (error) throw error;
      location.href = "/";
    } catch (e) {
      setMsg({ kind: "err", text: T(translate(e)) });
    } finally {
      setBusy(false);
    }
  };

  /**
   * 知らない端末から入った人を、認証アプリで確かめる。
   *
   * 申請のときに登録した認証アプリと同じものを使う。
   * 通れば、この端末を覚えて次からは求めない。
   */
  const verifyDevice = async () => {
    setMsg(null);
    if (!/^\d{6}$/.test(loginCode)) {
      setMsg({ kind: "err", text: T("6桁の数字を入れてください") });
      return;
    }
    setBusy(true);
    try {
      const supabase = createClient();
      const { data: list, error: e0 } = await supabase.auth.mfa.listFactors();
      if (e0) throw e0;
      const f = (list?.totp ?? []).find((x) => x.status === "verified");
      if (!f) {
        // 認証アプリが登録されていない。確かめようがないので通す
        trustDevice(uid);
        setLoginCode("");
        await reload();
        return;
      }

      const { data: ch, error: e1 } = await supabase.auth.mfa.challenge({ factorId: f.id });
      if (e1) throw e1;
      const { error: e2 } = await supabase.auth.mfa.verify({
        factorId: f.id,
        challengeId: ch.id,
        code: loginCode,
      });
      if (e2) throw e2;

      trustDevice(uid);
      setLoginCode("");
      setMsg({ kind: "ok", text: T("この端末を確かめました。次からは求めません。") });
      await reload();
    } catch (e) {
      setMsg({ kind: "err", text: T(translate(e)) });
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    await createClient().auth.signOut();
    location.reload();
  };

  /* ---------------- 表示 ---------------- */

  if (loading) return <Shell lang={lang} onToggleLang={toggleLang}>{T("読み込み中…")}</Shell>;

  if (!supabaseReady)
    return (
      <Shell lang={lang} onToggleLang={toggleLang}>
        <p className="rounded-xl bg-red-50 p-3 text-xs leading-relaxed text-red-800">
          <b>{T("サーバーに接続できません。")}</b>
          <br />
          {T("接続先が設定されていないため、ログインと申請を受け付けられません。")}
        </p>
        <Back t={T} />
      </Shell>
    );

  /* 知らない端末から入った人。ここを通るまで先へ進ませない */
  if (me && step === "verify") {
    return (
      <Shell lang={lang} onToggleLang={toggleLang}>
        <Link
          href="/"
          className="mb-3 inline-flex items-center gap-1 text-xs font-bold text-blue-600 hover:underline"
        >
          ← {T("地図へ戻る")}
        </Link>
        <Title />
        <p className="mt-4 text-sm text-slate-700">
          <b>{me.email}</b> {T("でログイン中")}
        </p>

        <div className="mt-4 rounded-xl bg-amber-50 p-3 ring-1 ring-amber-200">
          <p className="text-xs font-bold text-amber-900">{T("この端末ははじめてです")}</p>
          <p className="mt-1 text-[11px] leading-relaxed text-amber-900">
            {T("Microsoft Authenticator に出ている6桁を入れてください。次からは求めません。")}
          </p>
        </div>

        <input
          value={loginCode}
          onChange={(e) => setLoginCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder={T("アプリに出た6桁")}
          className={`${inputCls} mt-3 text-center text-lg tracking-[0.4em]`}
        />
        <button
          onClick={() => void verifyDevice()}
          disabled={busy || loginCode.length !== 6}
          className="mt-2 w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold text-white disabled:bg-slate-200 disabled:text-slate-400"
        >
          {busy ? T("確認中…") : T("本人確認をする")}
        </button>

        {msg && <Msg msg={msg} />}
        <button
          onClick={signOut}
          className="mt-3 w-full rounded-xl bg-slate-100 px-4 py-2.5 text-xs font-bold text-slate-700"
        >
          {T("ログアウト")}
        </button>
      </Shell>
    );
  }

  /* 申請の途中、またはログイン済み */
  if (me) {
    return (
      <Shell lang={lang} onToggleLang={toggleLang}>
        {/* 戻る道は上にも置く。下だけだと管理メニューの下に埋もれて見つからない */}
        <Link
          href="/"
          className="mb-3 inline-flex items-center gap-1 text-xs font-bold text-blue-600 hover:underline"
        >
          ← {T("地図へ戻る")}
        </Link>
        <Title />
        <p className="mt-4 text-sm text-slate-700">
          <b>{me.email}</b> {T("でログイン中")}
        </p>
        {/*
          いちばん上の権限だけは書かない。
          肩越しに覗かれただけで、そういう席が在ることが分かってしまう。
          何ができるかは、下に並ぶボタンを見れば足りる。
        */}
        {me.role !== "admin_l3" && (
          <p className="mt-1 text-xs text-slate-500">{ROLE_LABEL[me.role]}</p>
        )}

        {/* 権限がある人には、まずどこへ行けるかを見せる */}
        {me.role !== "pending" && (
          <p className="mt-3 rounded-xl bg-emerald-50 p-3 text-xs leading-relaxed text-emerald-900">
            {T("承認済みです。下のボタンから使えます。")}
          </p>
        )}

        {step !== "done" ? (
          <Wizard
            t={T}
            step={step}
            me={me}
            {...{ mfa, code, setCode, enroll, verifyMfa, pw, setPw, finish, busy }}
          />
        ) : (
          me.role === "pending" && (
            <p className="mt-3 rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-900">
              {T("申請は受け付けています。管理者が承認すると学内情報が見られるようになります。")}
            </p>
          )
        )}

        {msg && <Msg msg={msg} />}

        <div className="mt-4">
          <AdminMenu role={me.role} />
        </div>
        <Back t={T} />
        <button
          onClick={signOut}
          className="mt-2 w-full rounded-xl px-4 py-2 text-xs font-semibold text-slate-500 hover:bg-slate-100"
        >
          {T("ログアウト")}
        </button>
      </Shell>
    );
  }

  /* 未ログイン */
  return (
    <Shell lang={lang} onToggleLang={toggleLang}>
      <Title />

      <div className="mt-4 flex gap-1 rounded-xl bg-slate-100 p-1">
        {(["login", "signup"] as const).map((m) => (
          <button
            key={m}
            onClick={() => {
              setMode(m);
              setMsg(null);
              // 行き来したときに、途中の段が残らないように
              setSignupStep(1);
              setPw("");
            }}
            className={`flex-1 rounded-lg py-2 text-xs font-bold transition ${
              mode === m ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
            }`}
          >
            {m === "login" ? T("ログイン") : T("利用を申請")}
          </button>
        ))}
      </div>

      {mode === "login" ? (
        <>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={T("メールアドレス")}
            autoComplete="email"
            className={inputCls}
          />
          <input
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            type="password"
            placeholder={`${T("パスワード")}（${PASSWORD_MIN}〜${PASSWORD_MAX}）`}
            autoComplete="current-password"
            className={`${inputCls} mt-2`}
          />
          <button
            onClick={signIn}
            disabled={busy}
            className="mt-3 w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold text-white transition hover:bg-blue-700 disabled:bg-slate-300"
          >
            {busy ? T("処理中…") : T("ログイン")}
          </button>
        </>
      ) : (
        <>
          {/* 申請の段どり。何をどの順で出すかは下の signupStep で分ける */}
          <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
            {T("申請は4つの段どりで進みます。")}
          </p>
          <ol className="mt-1.5 space-y-0.5 text-[11px] leading-relaxed text-slate-600">
            {[
              T("メールアドレスと氏名"),
              T("学年・クラス・名列番号"),
              T("Microsoft Authenticator で本人確認"),
              T("パスワードを決めて申請"),
            ].map((label, i) => (
              <li key={label} className={signupStep === i + 1 ? "font-bold text-slate-900" : ""}>
                <span className={signupStep === i + 1 ? "text-blue-600" : "text-slate-400"}>
                  {i + 1}.
                </span>{" "}
                {label}
              </li>
            ))}
          </ol>

          {signupStep === 1 ? (
            <>
              <Label>{T("メールアドレス")}</Label>
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={T("メールアドレス")}
                autoComplete="email"
                className={inputCls}
              />
              {/* どのドメインなら通るかは書かない。
                  書くと、大学の関係者でない人にも当てはめ先を教えることになる */}
              {email.length > 0 && !domainOk && (
                <p className="mt-1 pl-1 text-[10px] font-bold text-red-600">
                  {T("このメールアドレスでは申請できません")}
                </p>
              )}

              <Label>{T("氏名")}</Label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={T("氏名")}
                autoComplete="name"
                className={inputCls}
              />

              <button
                onClick={() => {
                  setMsg(null);
                  setSignupStep(2);
                }}
                disabled={!canStep1}
                className="mt-4 w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold text-white transition hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400"
              >
                {T("次へ")}
              </button>
            </>
          ) : (
            <>
              <Label>{T("学年")}</Label>
              <div className="grid grid-cols-4 gap-1.5">
                {GRADES.map((g) => (
                  <Pick key={g} on={grade === g} onClick={() => setGrade(g)}>
                    {lang === "en" ? `Y${g}` : `${g}年`}
                  </Pick>
                ))}
              </div>

              <Label>{T("クラス")}</Label>
              <div className="grid grid-cols-4 gap-1.5">
                {CLASS_CODES.map((c) => (
                  <Pick
                    key={c.code}
                    on={classCode === c.code}
                    onClick={() => setClassCode(c.code)}
                    title={c.name}
                  >
                    {c.code}
                  </Pick>
                ))}
              </div>
              {classCode && (
                <p className="mt-1 text-[10px] text-slate-500">
                  {CLASS_CODES.find((c) => c.code === classCode)?.name}
                </p>
              )}

              <Label>{T("名列番号")}</Label>
              <input
                value={seat}
                onChange={(e) => setSeat(e.target.value.replace(/\D/g, "").slice(0, 3))}
                inputMode="numeric"
                placeholder={SEAT_MIN + " 〜 " + SEAT_MAX}
                className={inputCls}
              />

              <button
                onClick={() => void beginVerify()}
                disabled={!canStep2 || busy}
                className="mt-4 w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold text-white transition hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400"
              >
                {busy ? T("処理中…") : T("次へ")}
              </button>
              <button
                onClick={() => {
                  setMsg(null);
                  setSignupStep(1);
                }}
                className="mt-2 w-full rounded-xl px-4 py-2 text-xs font-semibold text-slate-500 hover:bg-slate-100"
              >
                {T("戻る")}
              </button>
            </>
          )}

          <p className="mt-3 rounded-xl bg-slate-50 p-3 text-[10px] leading-relaxed text-slate-500">
            {T("スマートフォンに Microsoft Authenticator を入れておいてください。")}
          </p>
        </>
      )}

      {msg && <Msg msg={msg} />}
      <Back t={T} />
    </Shell>
  );
}

/* ================= 申請の続き ================= */

function Wizard(props: {
  /** 言葉の言い換え */
  t: (ja: string) => string;
  step: Step;
  me: Me;
  mfa: { id: string; qr: string; secret: string } | null;
  code: string;
  setCode: (v: string) => void;
  enroll: () => Promise<void>;
  verifyMfa: () => Promise<void>;
  pw: string;
  setPw: (v: string) => void;
  finish: () => Promise<void>;
  busy: boolean;
}) {
  const { t: T, step, me, mfa, code, setCode, enroll, verifyMfa, busy } = props;
  /* 申請の途中の人には段の番号を出す。すでに権限のある人には意味が無い */
  const applying = me.role === "pending";

  if (step === "mfa") {
    return (
      <div className="mt-4">
        {applying ? (
          <Head n={3} total={4} text={T("認証アプリで本人確認")} />
        ) : (
          <Head text={T("認証アプリで本人確認")} />
        )}
        <p className="mt-1 text-[11px] leading-relaxed text-slate-600">
          {T("Microsoft Authenticator でQRを読み取り、出てきた6桁を入れてください。")}
          <br />
          {applying
            ? T("これができたら、パスワードを決めて申請します。")
            : T("この端末を、次から確かめるのに使います。")}
          <br />
        </p>

        {!mfa ? (
          <button
            onClick={() => void enroll()}
            disabled={busy}
            className="mt-3 w-full rounded-xl bg-slate-900 px-4 py-3 text-sm font-bold text-white disabled:bg-slate-300"
          >
            {busy ? T("準備中…") : T("認証アプリを登録する")}
          </button>
        ) : (
          <>
            <div className="mt-3 flex justify-center rounded-xl bg-white p-3 ring-1 ring-slate-200">
              {/* Supabase が返す QR は画像そのもの */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={mfa.qr} alt={T("認証アプリで読み取るQR")} className="h-44 w-44" />
            </div>
            <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
              {T("読み取れない場合は、この文字列を手で入れてください")}
              <br />
              <code className="mt-1 block break-all rounded bg-slate-100 p-2 font-mono text-[10px]">
                {mfa.secret}
              </code>
            </p>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              placeholder={T("アプリに出た6桁")}
              className={`${inputCls} mt-3 text-center text-lg tracking-[0.4em]`}
            />
            <button
              onClick={() => void verifyMfa()}
              disabled={busy || code.length !== 6}
              className="mt-2 w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold text-white disabled:bg-slate-200 disabled:text-slate-400"
            >
              {busy ? T("確認中…") : T("本人確認をする")}
            </button>
          </>
        )}
      </div>
    );
  }

  /* パスワードを決める。ここまで来たら本人確認は済んでいる */
  const { pw, setPw, finish } = props;
  const pwErr = pw.length > 0 ? checkPassword(pw) : null;

  return (
    <div className="mt-4">
      {applying ? (
        <Head n={4} total={4} text={T("パスワードを決めてください")} />
      ) : (
        <Head text={T("パスワードを決めてください")} />
      )}
      <p className="mt-1 text-[11px] leading-relaxed text-slate-600">
        {T("次からのログインに使います。")}
      </p>

      <input
        value={pw}
        onChange={(e) => setPw(e.target.value.slice(0, PASSWORD_MAX))}
        type="password"
        autoComplete="new-password"
        placeholder={T("パスワード")}
        className={`${inputCls} mt-3`}
      />
      <p className="mt-1 pl-1 text-[10px] leading-relaxed text-slate-500">
        {T("半角の英数字で8〜20字。数字を1文字以上入れてください。")}
      </p>
      {pwErr && <p className="mt-1 pl-1 text-[10px] font-bold text-red-600">{T(pwErr)}</p>}

      <button
        onClick={() => void finish()}
        disabled={busy || checkPassword(pw) !== null}
        className="mt-3 w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold text-white disabled:bg-slate-200 disabled:text-slate-400"
      >
        {busy ? T("送信中…") : applying ? T("申請する") : T("決める")}
      </button>
    </div>
  );
}

/* ================= 小さな部品 ================= */

const inputCls =
  "w-full rounded-xl bg-slate-100 px-4 py-3 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500";

function Label({ children }: { children: React.ReactNode }) {
  return <div className="mb-1 mt-3 text-[11px] font-bold text-slate-500">{children}</div>;
}

function Pick({
  on,
  onClick,
  title,
  children,
}: {
  on: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`rounded-lg py-2 text-xs font-bold transition active:scale-95 ${
        on ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"
      }`}
    >
      {children}
    </button>
  );
}

/** 見出し。段の番号は、申請の途中の人にだけ出す */
function Head({ n, total, text }: { n?: number; total?: number; text: string }) {
  return (
    <div className="flex items-center gap-2">
      {n != null && total != null && (
        <span className="rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-bold text-white">
          {n} / {total}
        </span>
      )}
      <span className="text-sm font-bold text-slate-900">{text}</span>
    </div>
  );
}

function Msg({ msg }: { msg: { kind: "ok" | "err" | "info"; text: string } }) {
  return (
    <p
      className={`mt-3 rounded-xl p-3 text-xs leading-relaxed ${
        msg.kind === "ok"
          ? "bg-emerald-50 text-emerald-900"
          : msg.kind === "info"
            ? "bg-blue-50 text-blue-900"
            : "bg-red-50 text-red-800"
      }`}
    >
      {msg.text}
    </p>
  );
}

/**
 * 見出し。
 *
 * 字の太さは「KIT」と「map」で揃える。以前は細字と太字が混ざっていて、
 * 一つの名前に見えなかった。
 *
 * 真ん中に置く。字間を空けてあるぶん、最後の字の右にも同じだけ空きが付く。
 * そのままだと左に寄って見えるので、同じ幅を左に足して釣り合わせる。
 */
function Title() {
  return (
    <Link
      href="/"
      className="block pl-[0.18em] text-center text-xl font-semibold tracking-[0.18em] text-slate-900"
    >
      KIT<span className="ml-1.5">map</span>
    </Link>
  );
}

function Back({ t: T }: { t: (ja: string) => string }) {
  return (
    <Link
      href="/"
      className="mt-2 block w-full rounded-xl bg-slate-100 px-4 py-3 text-center text-sm font-bold text-slate-700"
    >
      {T("地図へ戻る")}
    </Link>
  );
}

function Shell({
  children,
  lang,
  onToggleLang,
}: {
  children: React.ReactNode;
  lang?: Lang;
  onToggleLang?: () => void;
}) {
  return (
    <main className="relative flex h-[100dvh] items-center justify-center overflow-y-auto bg-slate-950 p-4">
      {onToggleLang && (
        <button
          onClick={onToggleLang}
          aria-label={lang === "ja" ? "Switch to English" : "日本語に切り替え"}
          className={`absolute right-4 top-4 z-10 flex h-10 w-10 items-center justify-center rounded-xl text-[11px] font-bold shadow-md transition active:scale-95 ${
            lang === "en"
              ? "bg-blue-600 text-white ring-2 ring-blue-300"
              : "bg-white/95 text-slate-700 hover:bg-white"
          }`}
        >
          {lang === "en" ? "EN" : "あ"}
        </button>
      )}
      <div className="my-auto w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">{children}</div>
    </main>
  );
}

/** Supabase の英語メッセージを、利用者に伝わる日本語にする */
function translate(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/invalid login credentials/i.test(m)) return "メールアドレスかパスワードが違います";
  if (/already registered|already been registered/i.test(m))
    return "このメールアドレスは登録済みです。［ログイン］から入ってください";
  if (/rate limit|too many requests/i.test(m))
    // メールは送らないので、送信上限の話は出さない。
    // 短い間に何度も押したときに出る
    return "しばらく待ってから、もう一度お試しください";
  if (/invalid totp|invalid code|challenge/i.test(m))
    return "6桁の数字が合いません。アプリの表示を確かめて、もう一度入れてください";
  if (/factor.*already|already enrolled/i.test(m))
    return "すでに登録済みです。アプリに出ている6桁を入れてください";
  if (/mfa|totp/i.test(m)) return "認証アプリの登録に失敗しました。もう一度お試しください";
  if (/password/i.test(m)) return "パスワードの条件を満たしていません";
  return m;
}
