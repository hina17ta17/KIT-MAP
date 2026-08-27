"use client";

/**
 * ログインと利用の申請。
 *
 * ■ 申請の流れ
 *   ① メールアドレスと氏名を入れて［START］
 *      → 大学のドメインでないと押せない
 *   ② そのアドレスへ送った6桁を入れる
 *      → ここで「そのアドレスの持ち主である」ことが分かる
 *   ③ 認証アプリ（Authenticator）で本人確認
 *      → その端末と結び付ける
 *   ④ 学年・クラス・組・パスワードを入れて申請完了
 *      → 管理者が承認するまでは学内情報を見られない
 *
 * ②と③は申請のときだけ。以後のログインはメールとパスワードで入る。
 *
 * ■ メールが届かないとき
 *   ・60秒おきに送り直せる
 *   ・それでも駄目なら、管理者が承認画面から代わりに確認済みにできる
 *
 * ■ 送信の上限に注意
 *   Supabase の標準の送信は1時間に数通しか出せない。
 *   一斉に申請する場面があるなら、送信サービスの設定が要る。
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient, supabaseReady } from "@/lib/supabase/client";
import { AdminMenu } from "@/components/AdminNav";
import { LANG_KEY, t as tr, type Lang } from "@/lib/i18n";
import {
  CLASS_CODES,
  GRADES,
  GROUPS,
  PASSWORD_LENGTH,
  ROLE_LABEL,
  checkPassword,
  isAllowedEmail,
  type Role,
} from "@/lib/auth";

/** 申請のどこまで進んだか */
type Step = "start" | "mail" | "mfa" | "detail" | "done";

type Me = {
  email: string;
  role: Role;
  full_name: string;
  grade: number;
  class_code: string;
  group_no: number;
  verified: boolean;
  mail_verified: boolean;
};

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

  /** 6桁を最後に送った時刻。送り直しの間隔を測る */
  const [sentAt, setSentAt] = useState<number | null>(null);
  /** メールに届いた6桁 */
  const [mailCode, setMailCode] = useState("");

  /* ログイン */
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");

  /* 申請 */
  const [step, setStep] = useState<Step>("start");
  const [name, setName] = useState("");
  const [grade, setGrade] = useState<number>(0);
  const [classCode, setClassCode] = useState("");
  const [groupNo, setGroupNo] = useState<number>(0);
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
          .select("email, role, full_name, grade, class_code, group_no, verified, mail_verified")
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

    if (p) {
      setMe(p);
      // 途中で閉じた人が続きから進められるようにする
      setName(p.full_name);
      setGrade(p.grade);
      setClassCode(p.class_code);
      setGroupNo(p.group_no);

      // 申請の続きを求めるのは、まだ承認待ちの人だけ。
      // すでに権限がある人（管理者など）を所属の記入で止めない
      if (p.role !== "pending") setStep("done");
      // メールの持ち主だと分かっていない人は、まずそこから
      else if (!p.mail_verified) setStep("mail");
      else if (!p.verified) setStep("mfa");
      else if (!p.grade || !p.class_code || !p.group_no) setStep("detail");
      else setStep("done");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /* ---------------- ① START：6桁をメールで送る ---------------- */

  const domainOk = isAllowedEmail(email);
  const canStart = domainOk && name.trim().length > 0;

  const start = async () => {
    setMsg(null);
    if (!canStart) return;
    setBusy(true);
    try {
      const supabase = createClient();
      /*
       * そのアドレスへ6桁の数字を送る。
       *
       * ここで席も一緒に作られる。パスワードはまだ決めない。
       * 6桁を入れられた時点で「そのアドレスの持ち主」と分かるので、
       * そのあとで本人にパスワードを決めてもらう。
       */
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: { shouldCreateUser: true, data: { full_name: name.trim() } },
      });
      if (error) throw error;

      setSentAt(Date.now());
      setStep("mail");
      setMsg({ kind: "info", text: T("メールに届いた6桁を入れてください。") });
    } catch (e) {
      setMsg({ kind: "err", text: T(translate(e)) });
    } finally {
      setBusy(false);
    }
  };

  /* ---------------- ② メールの6桁を確かめる ---------------- */

  /**
   * 送り直しは60秒あける。
   *
   * 続けて押されると送信の上限に当たり、本当に必要な人にも
   * 届かなくなる。届いていないと思って何度も押しがちなので、
   * あと何秒かを画面に出す。
   */
  const RESEND_WAIT = 60_000;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (step !== "mail") return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [step]);
  const waitLeft = sentAt ? Math.max(0, Math.ceil((sentAt + RESEND_WAIT - now) / 1000)) : 0;

  const resendMail = async () => {
    setMsg(null);
    if (waitLeft > 0) return;
    setBusy(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: { shouldCreateUser: true, data: { full_name: name.trim() } },
      });
      if (error) throw error;
      setSentAt(Date.now());
      setMsg({ kind: "ok", text: T("送り直しました。メールを確かめてください。") });
    } catch (e) {
      setMsg({ kind: "err", text: T(translate(e)) });
    } finally {
      setBusy(false);
    }
  };

  const verifyMail = async () => {
    setMsg(null);
    if (!/^d{6}$/.test(mailCode)) {
      setMsg({ kind: "err", text: T("6桁の数字を入れてください") });
      return;
    }
    setBusy(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.verifyOtp({
        email: email.trim(),
        token: mailCode,
        type: "email",
      });
      if (error) throw error;

      // 席はできているが、情報の行がまだ無いことがある
      await supabase.rpc("ensure_profile");
      const { data: u } = await supabase.auth.getUser();
      const { error: e2 } = await supabase
        .from("profiles")
        .update({ mail_verified: true, full_name: name.trim() })
        .eq("id", u.user?.id ?? "");
      if (e2) throw e2;

      setMailCode("");
      setStep("mfa");
      setMsg({ kind: "info", text: T("続けて、認証アプリで本人確認をしてください。") });
    } catch (e) {
      setMsg({ kind: "err", text: T(translate(e)) });
    } finally {
      setBusy(false);
    }
  };

  /* ---------------- ③ 認証アプリを登録する ---------------- */

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

      const { error: e3 } = await supabase
        .from("profiles")
        .update({ verified: true })
        .eq("email", email || me?.email || "");
      if (e3) throw e3;

      setCode("");
      setStep("detail");
      setMsg({ kind: "ok", text: T("本人確認ができました。最後に所属を入れてください。") });
    } catch (e) {
      setMsg({ kind: "err", text: T(translate(e)) });
    } finally {
      setBusy(false);
    }
  };

  /* ---------------- ④ 所属とパスワード ---------------- */

  const finish = async () => {
    setMsg(null);
    if (!grade || !classCode || !groupNo) {
      setMsg({ kind: "err", text: T("学年・クラス・組をすべて選んでください") });
      return;
    }
    const pwErr = checkPassword(pw);
    if (pwErr) {
      setMsg({ kind: "err", text: T(pwErr) });
      return;
    }
    setBusy(true);
    try {
      const supabase = createClient();
      // 以降ふつうに入れるよう、ここでパスワードを決める
      const { error: e1 } = await supabase.auth.updateUser({ password: pw });
      if (e1) throw e1;

      const { data: u } = await supabase.auth.getUser();
      const { error: e2 } = await supabase
        .from("profiles")
        .update({
          full_name: name.trim(),
          grade,
          class_code: classCode,
          group_no: groupNo,
        })
        .eq("id", u.user?.id ?? "");
      if (e2) throw e2;

      setPw("");
      setStep("done");
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

  /* 申請の途中、またはログイン済み */
  if (me) {
    return (
      <Shell lang={lang} onToggleLang={toggleLang}>
        <Title />
        <p className="mt-4 text-sm text-slate-700">
          <b>{me.email}</b> {T("でログイン中")}
        </p>
        <p className="mt-1 text-xs text-slate-500">{ROLE_LABEL[me.role]}</p>

        {/* 権限がある人には、まずどこへ行けるかを見せる */}
        {me.role !== "pending" && (
          <p className="mt-3 rounded-xl bg-emerald-50 p-3 text-xs leading-relaxed text-emerald-900">
            {T("承認済みです。下のボタンから使えます。")}
          </p>
        )}

        {step !== "done" ? (
          <Wizard
            t={T}
            lang={lang}
            step={step}
            me={me}
            {...{
              mailCode,
              setMailCode,
              verifyMail,
              resendMail,
              waitLeft,
              mfa,
              code,
              setCode,
              enroll,
              verifyMfa,
              grade,
              setGrade,
              classCode,
              setClassCode,
              groupNo,
              setGroupNo,
              pw,
              setPw,
              name,
              setName,
              finish,
              busy,
            }}
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
            placeholder={`${T("パスワード")}（${PASSWORD_LENGTH}）`}
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
          {/* ① メールと氏名 → START */}
          <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
            {T("大学から配られたメールアドレスと氏名を入れて［START］を押すと、本人確認のメールが届きます。")}
          </p>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={T("メールアドレス")}
            autoComplete="email"
            className={`${inputCls} mt-2`}
          />
          {/* どのドメインなら通るかは書かない。
              書くと、大学の関係者でない人にも当てはめ先を教えることになる。
              条件に合わない、とだけ伝える */}
          {email.length > 0 && !domainOk && (
            <p className="mt-1 pl-1 text-[10px] font-bold text-red-600">
              {T("このメールアドレスでは申請できません")}
            </p>
          )}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={T("氏名")}
            autoComplete="name"
            className={`${inputCls} mt-2`}
          />
          <button
            onClick={start}
            disabled={!canStart || busy}
            className="mt-3 w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold tracking-widest text-white transition hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400"
          >
            {busy ? T("送信中…") : "START"}
          </button>
          {!canStart && (
            <p className="mt-1 text-center text-[10px] text-slate-400">
              {T("メールアドレスと氏名の両方が要ります")}
            </p>
          )}
          <p className="mt-3 rounded-xl bg-slate-50 p-3 text-[10px] leading-relaxed text-slate-500">
            {T("［START］のあと、認証アプリ（Authenticator）で本人確認をします。")}
            <br />
            {T("スマートフォンに Google Authenticator などを入れておいてください。")}
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
  /** いまの言葉。年の書き方など、言い換えだけでは足りないところに使う */
  lang: Lang;
  step: Step;
  mailCode: string;
  setMailCode: (v: string) => void;
  verifyMail: () => Promise<void>;
  resendMail: () => Promise<void>;
  /** 送り直せるまでの残り秒。0 なら押せる */
  waitLeft: number;
  me: Me;
  mfa: { id: string; qr: string; secret: string } | null;
  code: string;
  setCode: (v: string) => void;
  enroll: () => Promise<void>;
  verifyMfa: () => Promise<void>;
  grade: number;
  setGrade: (v: number) => void;
  classCode: string;
  setClassCode: (v: string) => void;
  groupNo: number;
  setGroupNo: (v: number) => void;
  pw: string;
  setPw: (v: string) => void;
  name: string;
  setName: (v: string) => void;
  finish: () => Promise<void>;
  busy: boolean;
}) {
  const { t: T, lang, step, mfa, code, setCode, enroll, verifyMfa, busy } = props;
  const { mailCode, setMailCode, verifyMail, resendMail, waitLeft } = props;

  /* ---------------- ② メールに届いた6桁 ---------------- */
  if (step === "mail") {
    return (
      <div className="mt-4">
        <Head n={1} total={4} text={T("メールで本人確認")} />
        <p className="mt-1 text-[11px] leading-relaxed text-slate-600">
          {T("入力したメールアドレスへ6桁の数字を送りました。届いた数字を入れてください。")}
        </p>

        <input
          value={mailCode}
          onChange={(e) => setMailCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder={T("メールに届いた6桁")}
          className={`${inputCls} mt-3 text-center text-lg tracking-[0.4em]`}
        />
        <button
          onClick={() => void verifyMail()}
          disabled={busy || mailCode.length !== 6}
          className="mt-2 w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold text-white disabled:bg-slate-200 disabled:text-slate-400"
        >
          {busy ? T("確認中…") : T("本人確認をする")}
        </button>

        {/* 届かないときの手立て。続けて押されると送信の上限に当たるので間隔を置く */}
        <button
          onClick={() => void resendMail()}
          disabled={busy || waitLeft > 0}
          className="mt-2 w-full rounded-xl bg-slate-100 px-4 py-2.5 text-xs font-bold text-slate-700 disabled:text-slate-400"
        >
          {waitLeft > 0 ? `${T("送り直す")}（${waitLeft}）` : T("送り直す")}
        </button>

        <p className="mt-2 rounded-xl bg-slate-50 p-3 text-[10px] leading-relaxed text-slate-500">
          {T("届かないときは、迷惑メールに入っていないか確かめてください。数分かかることもあります。")}
          <br />
          {T("それでも届かない場合は、管理者に連絡してください。管理者の側で確認済みにできます。")}
        </p>
      </div>
    );
  }

  if (step === "mfa") {
    return (
      <div className="mt-4">
        <Head n={2} total={3} text={T("認証アプリで本人確認")} />
        <p className="mt-1 text-[11px] leading-relaxed text-slate-600">
          {T("スマートフォンの認証アプリでQRを読み取り、出てきた6桁を入れてください。Google Authenticator や Microsoft Authenticator が使えます。")}
          <br />
          {T("これができたら、所属の記入に進めます。")}
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

  /* 所属とパスワード */
  const { grade, setGrade, classCode, setClassCode, groupNo, setGroupNo, pw, setPw, name, setName, finish } =
    props;

  return (
    <div className="mt-4">
      <Head n={3} total={3} text={T("所属を入れてください")} />

      <Label>{T("氏名")}</Label>
      <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />

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
          <Pick key={c.code} on={classCode === c.code} onClick={() => setClassCode(c.code)} title={c.name}>
            {c.code}
          </Pick>
        ))}
      </div>
      {classCode && (
        <p className="mt-1 text-[10px] text-slate-500">
          {CLASS_CODES.find((c) => c.code === classCode)?.name}
        </p>
      )}

      <Label>{T("組")}</Label>
      <div className="grid grid-cols-7 gap-1.5">
        {GROUPS.map((g) => (
          <Pick key={g} on={groupNo === g} onClick={() => setGroupNo(g)}>
            {g}
          </Pick>
        ))}
      </div>

      <Label>{T("パスワード")}（{PASSWORD_LENGTH}）</Label>
      <input
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        type="password"
        autoComplete="new-password"
        className={inputCls}
      />
      <p className="mt-1 pl-1 text-[10px] text-slate-400">
        {pw.length} / {PASSWORD_LENGTH} 桁
      </p>

      <button
        onClick={() => void finish()}
        disabled={busy}
        className="mt-3 w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold text-white disabled:bg-slate-300"
      >
        {busy ? T("送信中…") : T("申請を完了する")}
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

function Head({ n, total, text }: { n: number; total: number; text: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-bold text-white">
        {n} / {total}
      </span>
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

function Title() {
  return (
    <Link href="/" className="text-xl font-light tracking-[0.18em] text-slate-900">
      KIT<span className="ml-1.5 font-semibold">map</span>
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
    return "メールの送信上限に達しています。しばらく待ってからお試しください";
  if (/invalid totp|invalid code|challenge/i.test(m))
    return "6桁の数字が合いません。アプリの表示を確かめて、もう一度入れてください";
  if (/factor.*already|already enrolled/i.test(m))
    return "すでに登録済みです。アプリに出ている6桁を入れてください";
  if (/mfa|totp/i.test(m)) return "認証アプリの登録に失敗しました。もう一度お試しください";
  if (/password/i.test(m)) return "パスワードの条件を満たしていません";
  return m;
}
