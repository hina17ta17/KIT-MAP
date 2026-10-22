"use client";

/**
 * サイトの緊急停止の関所（画面の側）。
 *
 * ■ 何をするか
 *   開いたとき・ときどき・ログインが変わったときに、データベースへ
 *   「いまサイトを止めているか」「この人は通れるか」を訊く（site_gate）。
 *   止めていて通れない人には、どの画面の代わりにも「メンテナンス中」を出す。
 *   通れるのは管理者（admin_l3）だけ。止める・再開するボタンは
 *   承認・権限の管理（app/admin/page.tsx）のいちばん下にある。
 *
 * ■ 守っているのはデータベース
 *   ここは画面を出し分けるだけ。止めているあいだは、データベースの入口の関所
 *   （base/01_core.sql の 01-9）が、管理者以外の問い合わせをすべて断る。
 *   ここを外して画面を出しても、データは何も返らない。
 *
 * ■ 訊けないときは止めない
 *   01-9 をまだ入れていない、電波が悪い、などで訊けなければ、
 *   止めていないものとして画面を出す。訊けないだけで全員を止めると、
 *   ふだんの不調がそのままサイトの停止になってしまう。
 *
 * ■ ログインの画面は開けておく
 *   止めているときに管理者が入れなくなると、再開できなくなる。
 *   ログインしていない人には、ログインの画面だけは出す（申請は出さない）。
 *   入った人が管理者でなければ、その場でログアウトさせる（app/login）。
 *
 * ■ 開きっぱなしの人も止める
 *   開いたときに一度訊くだけだと、止める前から開いている人は使い続けられる
 *   （データベースには断られるので、壊れたように見える）。
 *   見えているあいだは1分おきに訊き直し、止まっていればこの画面に切り替える。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createClient, supabaseReady } from "@/lib/supabase/client";
import { useAdminT } from "@/lib/adminLang";

export type SiteGateState = {
  /** いまサイトを止めているか */
  stopped: boolean;
  /** 止めていても通れるか（管理者だけ） */
  pass: boolean;
  /** ログインしているか */
  signedIn: boolean;
  /** 止めた・再開した時刻。管理者にだけ返る */
  since: string | null;
  /** 止めた・再開した人のメール。管理者にだけ返る */
  by: string | null;
};

/** ふだん訊き直す間（ミリ秒） */
const POLL_MS = 60_000;
/** メンテナンス中の画面で訊き直す間。再開したらすぐ戻れるように短くする */
const POLL_STOPPED_MS = 30_000;

type Read = {
  state: SiteGateState | null;
  /** 関数がまだ無い（01-9 を入れる前）。訊き直しても無駄なので止める */
  missing: boolean;
};

async function readGate(): Promise<Read> {
  if (!supabaseReady) return { state: null, missing: true };
  try {
    const { data, error } = await createClient().rpc("site_gate");
    if (error) return { state: null, missing: error.code === "PGRST202" };
    const d = (data ?? {}) as Record<string, unknown>;
    return {
      state: {
        stopped: d.stopped === true,
        pass: d.pass === true,
        signedIn: d.signed_in === true,
        since: typeof d.since === "string" ? d.since : null,
        by: typeof d.by === "string" && d.by ? d.by : null,
      },
      missing: false,
    };
  } catch {
    return { state: null, missing: false };
  }
}

/** いまの様子を一度だけ訊く。訊けなければ null（止めていないものとして扱う） */
export async function readSiteGate(): Promise<SiteGateState | null> {
  return (await readGate()).state;
}

type Ctx = {
  state: SiteGateState | null;
  /** 訊き直す。止めた・再開した直後に呼ぶ */
  recheck: () => Promise<SiteGateState | null>;
};

const SiteGateContext = createContext<Ctx>({ state: null, recheck: async () => null });

/** いまの様子。関所の外（テストなど）では null */
export function useSiteGate(): Ctx {
  return useContext(SiteGateContext);
}

export function SiteGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<SiteGateState | null>(null);
  const missing = useRef(false);
  const path = usePathname() ?? "/";

  const recheck = useCallback(async () => {
    const r = await readGate();
    missing.current = r.missing;
    setState(r.state);
    return r.state;
  }, []);

  const blocked = !!state && state.stopped && !state.pass;

  /* 開いた直後に一度訊く */
  useEffect(() => {
    let alive = true;
    void readGate().then((r) => {
      if (!alive) return;
      missing.current = r.missing;
      setState(r.state);
    });
    return () => {
      alive = false;
    };
  }, []);

  /* 見えているあいだは、ときどき訊き直す。隠れていた画面は、戻ったときに訊く */
  useEffect(() => {
    const tick = () => {
      if (missing.current || document.visibilityState !== "visible") return;
      void recheck();
    };
    const timer = window.setInterval(tick, blocked ? POLL_STOPPED_MS : POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [blocked, recheck]);

  /*
   * ログイン・ログアウトしたら訊き直す。通れる人かどうかが変わる。
   *
   * ログインの画面にいるあいだは訊き直さない。入った人が管理者でなければ、
   * あちらがその場でログアウトさせて理由を出す（app/login）。ここで先に
   * メンテナンス中へ切り替えると、ログインの画面が作り直されて、その理由が消える。
   * 管理者は入り終えると地図へ読み込み直すので、そこで改めて訊く。
   */
  const pathRef = useRef(path);
  useEffect(() => {
    pathRef.current = path;
  }, [path]);
  useEffect(() => {
    if (!supabaseReady) return;
    try {
      const { data } = createClient().auth.onAuthStateChange((event) => {
        if (pathRef.current === "/login") return;
        if (event === "SIGNED_IN" || event === "SIGNED_OUT") void recheck();
      });
      return () => data.subscription.unsubscribe();
    } catch {
      return;
    }
  }, [recheck]);

  /* ログインしていない人には、ログインの画面だけは出す（管理者が入れるように） */
  const loginOpen = path === "/login" && !state?.signedIn;
  /* 管理の画面とログインの画面には、見出しのほうで知らせる */
  const showBadge =
    !!state && state.stopped && state.pass && !path.startsWith("/admin") && path !== "/login";

  return (
    <SiteGateContext.Provider value={{ state, recheck }}>
      {blocked && !loginOpen ? (
        <Maintenance signedIn={state.signedIn} onRetry={recheck} />
      ) : (
        children
      )}
      {showBadge && <StoppedBadge />}
    </SiteGateContext.Provider>
  );
}

/**
 * 止めているあいだ、管理者以外に出す画面。
 *
 * どの画面の代わりにもこれを出す。先へ進む道は置かない。
 * 管理者が入るための入口だけを、小さく下に置く。
 */
function Maintenance({
  signedIn,
  onRetry,
}: {
  signedIn: boolean;
  onRetry: () => Promise<SiteGateState | null>;
}) {
  const T = useAdminT();
  const [busy, setBusy] = useState(false);

  const retry = async () => {
    setBusy(true);
    await onRetry();
    setBusy(false);
  };

  /* 管理者が別の席で入り直すとき。入っている席から出て、ログインの画面へ */
  const switchUser = async () => {
    try {
      await createClient().auth.signOut();
    } catch {
      // 出られなくても、ログインの画面へは行く
    }
    window.location.href = "/login";
  };

  return (
    <main className="flex h-[100dvh] items-center justify-center overflow-y-auto bg-slate-100 p-6">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-lg">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-amber-100 text-2xl">
          🛠️
        </div>
        <h1 className="mt-4 text-lg font-bold text-slate-900">{T("ただいまメンテナンス中です")}</h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          {T("KIT map は、いま一時的に止めています。しばらくしてから、もう一度開いてください。")}
        </p>
        <button
          onClick={() => void retry()}
          disabled={busy}
          className="mt-5 w-full rounded-xl bg-slate-900 px-4 py-3 text-sm font-bold text-white transition hover:bg-slate-800 active:scale-95 disabled:bg-slate-300"
        >
          {busy ? T("確かめています…") : T("もう一度読み込む")}
        </button>
        {signedIn ? (
          <button
            onClick={() => void switchUser()}
            className="mt-4 text-xs font-semibold text-slate-500 underline-offset-2 hover:underline"
          >
            {T("ログアウトして、管理者として入る")}
          </button>
        ) : (
          <Link
            href="/login"
            className="mt-4 inline-block text-xs font-semibold text-slate-500 underline-offset-2 hover:underline"
          >
            {T("管理者の方はこちら")}
          </Link>
        )}
      </div>
    </main>
  );
}

/**
 * 止めているあいだ、管理者の地図の上に出す小さな札。
 *
 * 止めたことを忘れて、そのままにしないため。押すと承認・権限の管理へ。
 * 地図のボタン（左上の列・右上の丸）より下の重なりに置き、ボタンを隠さない。
 * 下の端は地理院の出典の表示があるので使わない。
 */
function StoppedBadge() {
  const T = useAdminT();
  return (
    <Link
      href="/admin"
      className="fixed left-1/2 top-[max(env(safe-area-inset-top),0.5rem)] z-[6] -translate-x-1/2 whitespace-nowrap rounded-full bg-red-600 px-3 py-1.5 text-[11px] font-bold text-white shadow-md transition hover:bg-red-700 active:scale-95"
    >
      {T("サイトを止めています")}
    </Link>
  );
}
