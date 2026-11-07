"use client";

/**
 * ニュースを入れる。
 *
 * ■ 何をするところか
 *   写真を一枚と、押したときに開く先、そしていつからいつまで出すか。
 *   それだけを決めて、申請する。通ると地図の入口に出る。
 *
 *   文章の欄は置いていない。学内の知らせには、たいてい元になる
 *   貼り紙や頁がある。そちらへ送るほうが確かで、ここで書き写すと、
 *   直したときに食い違う。一言だけは、一覧で見分けるために入れられる。
 *
 * ■ 誰が入れられるか
 *   学生と承認待ち以外のぜんぶ。
 *   地図の入口に出るので、見る人を選べない。出せる人のほうを絞る。
 *
 * ■ 誰が通すか
 *   レベル2.2 と管理者。承認・権限の画面のほうで決める。
 *   出す人と通す人を分けておかないと、自分で出して自分で通せる。
 *
 * ■ 出したあとでも、写真は替えられる
 *   出ているものは、通るまで今の写真のまま出続ける。
 *   地図の入口に出る一枚なので、差し替えももう一度見てもらう。
 *
 * ■ 一言は、出ている間でも自分で直せる（承認は要らない）
 *   打ち間違いを直すたびに承認を待たせるほどのものではない。
 *   直すとそのまま地図の入口に出る（base/04_news.sql）。
 *
 * ■ 期間は自分で変えられる。終わりの日を延ばすときだけ承認が要る
 *   早く終える・始まりを動かすのは、その場で変わる。
 *   終わりの日を延ばす（終了したものをまた出すのも同じ）と申請になり、
 *   通るまでは今の期間のまま出続ける。一度通れば、いつまでも
 *   出し続けられる、ということにならないように。
 *
 * ■ 取り下げたものは「終了」
 *   取り下げると、地図からすぐに消え「終了」になる。管理者が取り下げた
 *   ときも同じで、その訳が出る。また出すときは、期間を決めて申請する。
 *   取り下げと控えを消すときは、二回たしかめてから行う。
 *
 * ■ 出したものは「いま」と「今までのもの」に分ける
 *   いま動いているもの（申請中・開始前・進行中、延長の申請中）は
 *   「出したもの」に並べる。終わったもの（終了・断られた）は
 *   「今までのもの」にまとめ、釦を押したときだけ開く。
 *
 *   どれが「いま出ているか」はデータベースが決める（news_mine の phase）。
 *   地図に出す決まり（news_live）と同じ「今日」で決めるので、
 *   地図に出ているのに「終了」と出る、といった食い違いが起きない。
 *
 * ■ 仕組みが、まだ入っていないとき
 *   この画面の元になる SQL（base/33・35・37）は、手で入れる。
 *   入っていない関数を呼ぶと PGRST202 になるので、そのときは
 *   何を入れれば使えるようになるかを出す。
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient, supabaseReady } from "@/lib/supabase/client";
import { AdminHeader, AdminMenu } from "@/components/AdminNav";
import { useAdminT } from "@/lib/adminLang";
import { type Role } from "@/lib/auth";
import { shrinkPhoto } from "@/lib/photo";
import { noteError, noteEvent } from "@/lib/note";
import { soon } from "@/lib/soon";

type Mine = {
  id: number;
  image: string;
  url: string;
  title: string;
  from_date: string;
  to_date: string;
  state: "waiting" | "live" | "no" | "gone";
  reason: string;
  /** 差し替えを待っている写真。空なら差し替え中ではない */
  next_image: string;
  swap_at: string | null;
  /** いまの段。35 を入れる前は返ってこない（下の phaseOf が控えで決める） */
  phase?: Phase;
  /** 本人が最後に期間を変えた時刻 */
  period_at?: string | null;
  /** 延長の申請で出したい期間。空なら申請していない（37） */
  next_from?: string | null;
  next_to?: string | null;
  /** 管理者など、出した本人でない人が取り下げたか（37） */
  dropped_by_other?: boolean;
  decided_mail: string;
  decided_at: string | null;
  created_at: string;
};

/** いまの段。データベースの news_mine が返す */
type Phase = "waiting" | "upcoming" | "running" | "ended" | "no" | "gone";

const PHASE: Record<Phase, { label: string; cls: string }> = {
  waiting: { label: "申請中", cls: "bg-amber-100 text-amber-900" },
  upcoming: { label: "開始前", cls: "bg-sky-100 text-sky-900" },
  running: { label: "進行中", cls: "bg-emerald-100 text-emerald-900" },
  ended: { label: "終了", cls: "bg-slate-200 text-slate-700" },
  no: { label: "断られました", cls: "bg-red-100 text-red-900" },
  /* 取り下げたものは「終了」と同じに見せる（phaseOf が ended にする） */
  gone: { label: "終了", cls: "bg-slate-200 text-slate-700" },
};

/** 「出したもの」に並べる段。ほかは「今までのもの」へ */
const NOW: Phase[] = ["waiting", "upcoming", "running"];

/** 期間を変えられる段（断られたものは、写真を替えて出し直す） */
const CAN_PERIOD: Phase[] = ["waiting", "upcoming", "running", "ended"];

/**
 * いまの段を決める。
 *
 * ふだんはデータベースが返す phase をそのまま使う。
 * 35 をまだ入れていないと返ってこないので、そのときだけここで決める。
 * データベースの「今日」は UTC なので、こちらも UTC の日付で比べる
 * （日本の日付で比べると、朝9時まで一日ずれる）。
 *
 * 取り下げたもの（gone）は「終了」として扱う（37 と同じ）。
 */
function phaseOf(n: Mine): Phase {
  if (n.phase) return n.phase === "gone" ? "ended" : n.phase;
  if (n.state === "waiting") return "waiting";
  if (n.state === "no") return "no";
  if (n.state === "gone") return "ended";
  const d = new Date().toISOString().slice(0, 10);
  if (d < n.from_date) return "upcoming";
  if (d > n.to_date) return "ended";
  return "running";
}

/** 延長の申請を出していて、まだ決まっていないか */
const pendingPeriod = (n: Mine) => !!n.next_to;

/** 期間の変更の仕組み（base/04_news.sql）が、まだ入っていないとき */
const NO_PERIOD =
  "期間の変更は、まだ使えません。データベースに base/04_news.sql を入れると使えるようになります。";

/** 一言の修正・延長の申請（base/04_news.sql）が、まだ入っていないとき */
const NO_RULES =
  "この操作は、まだ使えません。データベースに base/04_news.sql を入れると使えるようになります。";

/**
 * 差し替えの仕組み（base/04_news.sql）が、まだ入っていないときの断り書き。
 * 画面だけ先に出ても、データベースに関数が無ければ何も起きない。
 */
const NO_SWAP =
  "写真の差し替えは、まだ使えません。データベースに base/04_news.sql を入れると使えるようになります。";

/** 2026-09-09 → 9月9日 */
function md(d: string): string {
  const x = new Date(d);
  return `${x.getMonth() + 1}月${x.getDate()}日`;
}

/** きょうを "2026-09-09" の形で */
function today(plus = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + plus);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** PGRST202（データベースにその関数が無い）か */
const missing = (e: unknown) => (e as { code?: string })?.code === "PGRST202";

/** 二回たしかめる操作。いま何回目の確かめを出しているか */
type Ask = { id: number | "all"; kind: "drop" | "forget"; step: 1 | 2 };

export default function NewsPage() {
  const T = useAdminT();
  const [role, setRole] = useState<Role | null>(null);
  const [can, setCan] = useState(false);
  const [ready, setReady] = useState(false);

  const [image, setImage] = useState("");
  const [imgBusy, setImgBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today(14));

  const [mine, setMine] = useState<Mine[]>([]);
  /** いま写真を差し替えている一枚（送っている間だけ） */
  const [swapId, setSwapId] = useState<number | null>(null);
  /** その一枚の下に出す断り書き（上の報せは、下まで来ると見えないため） */
  const [swapErr, setSwapErr] = useState<{ id: number; text: string } | null>(null);
  /** 差し替えの仕組み（33）が、まだ入っていない */
  const [noSwap, setNoSwap] = useState(false);
  /** 「今までのもの」を開いているか */
  const [showPast, setShowPast] = useState(false);
  /** いま期間を書き換えている一枚と、その入力 */
  const [editId, setEditId] = useState<number | null>(null);
  const [editFrom, setEditFrom] = useState("");
  const [editTo, setEditTo] = useState("");
  /** いま一言を書き換えている一枚と、その入力 */
  const [titleId, setTitleId] = useState<number | null>(null);
  const [titleText, setTitleText] = useState("");
  /** 一枚ごとの結果。その一枚のすぐ下に出す（期間・一言・取り下げ・延長） */
  const [rowMsg, setRowMsg] = useState<{ id: number | "all"; kind: "ok" | "err"; text: string } | null>(
    null,
  );
  /** 二回たしかめる操作の、いまの段 */
  const [ask, setAsk] = useState<Ask | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!supabaseReady) return;
    const supabase = createClient();
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) {
      setReady(true);
      return;
    }
    const { data: p } = await supabase.from("profiles").select("role").eq("id", u.user.id).single();
    setRole(((p as { role?: Role } | null)?.role ?? null) as Role | null);
    try {
      const a = await supabase.rpc("can_post_news");
      setCan(a.data === true);
      const b = await supabase.rpc("news_mine");
      if (!b.error) setMine((b.data as Mine[]) ?? []);
    } catch {
      /* まだ SQL を入れていないとき。下で知らせる */
    }
    setReady(true);
  }, []);

  useEffect(() => soon(load), [load]);

  /** 一つの操作を送って、返事を一枚の下に出す */
  const runRow = async (
    id: number | "all",
    call: () => PromiseLike<{ data: unknown; error: unknown }>,
    onMissing = NO_RULES,
  ): Promise<boolean> => {
    setBusy(true);
    setRowMsg(null);
    try {
      const { data, error } = await call();
      if (error) throw error;
      const v = data as { ok: boolean; reason: string };
      setRowMsg({ id, kind: v.ok ? "ok" : "err", text: v.reason });
      if (v.ok) await load();
      return v.ok;
    } catch (e) {
      setRowMsg({
        id,
        kind: "err",
        text: missing(e) ? onMissing : e instanceof Error ? e.message : String(e),
      });
      return false;
    } finally {
      setBusy(false);
    }
  };

  /**
   * 写真を選ぶ。
   *
   * 送る前に、この端末で小さくする。地図の入口に出るものなので、
   * 開いた人みんながその通信量を引き受けることになる。
   */
  const pickPhoto = async (file: File | null) => {
    if (!file) return;
    setImgBusy(true);
    setMsg(null);
    try {
      const r = await shrinkPhoto(file);
      if (!r.ok) {
        setMsg({ kind: "err", text: r.why });
        return;
      }
      setImage(r.data);
      setMsg({ kind: "ok", text: `写真を入れました（${Math.round(r.bytes / 1024)}KB）` });
    } finally {
      setImgBusy(false);
    }
  };

  const send = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const { data, error } = await createClient().rpc("news_apply", {
        p_image: image,
        p_url: url.trim(),
        p_from: from,
        p_to: to,
        p_title: title.trim(),
      });
      if (error) throw error;
      const v = data as { ok: boolean; reason: string };
      setMsg({ kind: v.ok ? "ok" : "err", text: v.reason });
      if (v.ok) {
        setImage("");
        setUrl("");
        setTitle("");
        noteEvent("system", "ニュースを申請しました", { url, from, to });
        await load();
      }
    } catch (e) {
      setMsg({
        kind: "err",
        text:
          e instanceof Error
            ? `${e.message}（base/04_news.sql をまだ入れていない場合は、先に入れてください）`
            : String(e),
      });
      noteError("system", "ニュースを申請できませんでした", e);
    } finally {
      setBusy(false);
    }
  };

  /**
   * 取り下げる（二回たしかめたあと）。
   *
   * 出ているものは、地図からすぐに消えて「終了」になる。
   * 申請中のものは、申請をやめて「終了」になる。
   */
  const drop = async (n: Mine) => {
    setAsk(null);
    const ok = await runRow(n.id, () => createClient().rpc("news_drop", { p_id: n.id }));
    if (ok) {
      /* 取り下げた一枚は「今までのもの」へ移る。結果が見えるよう開いておく */
      setShowPast(true);
      noteEvent("system", "ニュースを取り下げました", { id: n.id });
    }
  };

  /**
   * 控えを消す（二回たしかめたあと）。
   * 消せるのは、終了したもの（取り下げを含む）と断られたものだけ（SQL 側でも見ている）。
   */
  const forget = async (n: Mine) => {
    setAsk(null);
    const ok = await runRow(n.id, () => createClient().rpc("news_forget", { p_id: n.id }));
    /* 消えた一枚の下には出せないので、上に出す */
    if (ok) setMsg({ kind: "ok", text: "控えを消しました。" });
  };

  /** 終了・断られたものを、まとめて消す（二回たしかめたあと） */
  const forgetAll = async () => {
    setAsk(null);
    await runRow("all", () => createClient().rpc("news_forget_done"));
  };

  /**
   * 出したものの写真を、あとから差し替える。
   *
   * 出ているものは、通るまで今の写真のまま出続ける（SQL 側でそうしている）。
   * 承認待ちのものは、その場で入れ替わる。断られたものは、替えるとまた承認へ回る。
   */
  const swapPhoto = async (n: Mine, file: File | null) => {
    if (!file) return;
    setSwapId(n.id);
    setMsg(null);
    setSwapErr(null);
    try {
      const r = await shrinkPhoto(file);
      if (!r.ok) {
        setSwapErr({ id: n.id, text: r.why });
        return;
      }
      const { data, error } = await createClient().rpc("news_photo", {
        p_id: n.id,
        p_image: r.data,
      });
      if (error) throw error;
      const v = data as { ok: boolean; reason: string };
      if (v.ok) {
        setMsg({ kind: "ok", text: v.reason });
        noteEvent("system", "ニュースの写真を差し替えました", { id: n.id, state: n.state });
        await load();
      } else {
        /* 断られた訳は、押した一枚のすぐ下に出す */
        setSwapErr({ id: n.id, text: v.reason });
      }
    } catch (e) {
      /*
       * PGRST202 … データベースにその関数が無い。
       * 33 をまだ入れていないときに、必ずこれになる。
       */
      if (missing(e)) {
        setNoSwap(true);
        setSwapErr({ id: n.id, text: NO_SWAP });
      } else {
        setSwapErr({ id: n.id, text: e instanceof Error ? e.message : String(e) });
      }
      noteError("system", "ニュースの写真を差し替えられませんでした", e);
    } finally {
      setSwapId(null);
    }
  };

  /** 差し替えをやめる。出ているものは、いまの写真のままになる */
  const cancelSwap = async (n: Mine) => {
    setBusy(true);
    setSwapErr(null);
    try {
      const { data, error } = await createClient().rpc("news_photo_cancel", { p_id: n.id });
      if (error) throw error;
      const v = data as { ok: boolean; reason: string };
      setMsg({ kind: v.ok ? "ok" : "err", text: v.reason });
      await load();
    } catch (e) {
      if (missing(e)) setNoSwap(true);
      setSwapErr({
        id: n.id,
        text: missing(e) ? NO_SWAP : e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  /**
   * 期間を書き換える欄を開く。
   *
   * 終わったものは、今日から二週間を最初に入れておく。
   * 「また出す」ために開くことがほとんどで、昔の期間のままだと
   * 毎回打ち直すことになるため。
   */
  const openPeriod = (n: Mine) => {
    setRowMsg(null);
    setTitleId(null);
    setEditId(n.id);
    if (phaseOf(n) === "ended") {
      setEditFrom(today());
      setEditTo(today(14));
    } else {
      setEditFrom(n.from_date);
      setEditTo(n.to_date);
    }
  };

  /**
   * 期間を変える。
   *
   * 終わりの日を延ばすときは申請になり、通るまで今の期間のまま（37）。
   * 返事の pending で分かるので、そのまま一枚の下に出す。
   */
  const savePeriod = async (n: Mine) => {
    if (!editFrom || !editTo) {
      setRowMsg({ id: n.id, kind: "err", text: "いつからいつまで出すかを決めてください。" });
      return;
    }
    if (editTo < editFrom) {
      setRowMsg({ id: n.id, kind: "err", text: "終わりの日が、始まりより前になっています。" });
      return;
    }
    const ok = await runRow(
      n.id,
      () => createClient().rpc("news_period", { p_id: n.id, p_from: editFrom, p_to: editTo }),
      NO_PERIOD,
    );
    if (ok) {
      setEditId(null);
      noteEvent("system", "ニュースの期間を変えました", { id: n.id, from: editFrom, to: editTo });
    }
  };

  /** 延長の申請をやめる。いまの期間のまま */
  const cancelPeriod = async (n: Mine) => {
    await runRow(n.id, () => createClient().rpc("news_period_cancel", { p_id: n.id }));
  };

  /** 一言を書き換える欄を開く */
  const openTitle = (n: Mine) => {
    setRowMsg(null);
    setEditId(null);
    setTitleId(n.id);
    setTitleText(n.title);
  };

  /** 一言を直す。承認は要らない。出ているものは、そのまま地図の入口に出る */
  const saveTitle = async (n: Mine) => {
    const ok = await runRow(n.id, () =>
      createClient().rpc("news_title", { p_id: n.id, p_title: titleText.trim() }),
    );
    if (ok) {
      setTitleId(null);
      noteEvent("system", "ニュースの一言を直しました", { id: n.id });
    }
  };

  if (!ready) return null;

  if (!can) {
    return (
      <Shell>
        <AdminHeader title={T("ニュースを入れる")} />
        <p className="rounded-xl bg-slate-100 p-4 text-sm leading-relaxed text-slate-600">
          {T("この画面は、いまの権限では使えません。")}
          <br />
          {T("ニュースを入れられるのは、学生と承認待ち以外の人です。")}
        </p>
        <Link
          href="/login"
          className="mt-3 block rounded-xl bg-slate-900 px-4 py-3 text-center text-xs font-bold text-white"
        >
          {T("ログインへ")}
        </Link>
      </Shell>
    );
  }

  const canSend = image !== "" && url.trim() !== "" && from !== "" && to !== "" && to >= from;

  /* いま動いているもの（延長の申請中を含む）と、終わったものに分ける */
  const isNow = (n: Mine) => NOW.includes(phaseOf(n)) || pendingPeriod(n);
  const current = mine.filter(isNow);
  const past = mine.filter((n) => !isNow(n));
  /** 控えを消せるか（終了・断られた、で待っているものが無い） */
  const canForget = (n: Mine) =>
    (phaseOf(n) === "ended" || phaseOf(n) === "no") && !pendingPeriod(n) && !n.next_image;

  /**
   * 差し替えが使えるか。
   *
   * news_mine が next_image を返していれば、33 が入っている。
   * 一度でも「その関数が無い」と言われたときも、使えないとして扱う。
   */
  const swapReady = !noSwap && mine.some((n) => "next_image" in n);

  /** 二回たしかめる欄。一回目と二回目で言葉を変える */
  const confirmBox = (
    key: number | "all",
    kind: Ask["kind"],
    first: string,
    second: string,
    action: string,
    run: () => void,
  ) => {
    if (!ask || ask.id !== key || ask.kind !== kind) return null;
    const last = ask.step === 2;
    return (
      <div
        className={`mt-1.5 rounded-lg p-2 text-[10px] leading-relaxed ring-1 ${
          last ? "bg-red-50 text-red-900 ring-red-300" : "bg-amber-50 text-amber-900 ring-amber-200"
        }`}
      >
        <p className="font-bold">
          {last ? T("最後の確認（2/2）") : T("確認（1/2）")}
        </p>
        <p className="mt-0.5">{T(last ? second : first)}</p>
        <div className="mt-1.5 flex justify-end gap-1.5">
          <button
            onClick={() => setAsk(null)}
            disabled={busy}
            className="rounded-lg px-2.5 py-1 font-bold text-slate-500 transition hover:bg-white active:scale-95"
          >
            {T("やめる")}
          </button>
          <button
            onClick={() => (last ? run() : setAsk({ id: key, kind, step: 2 }))}
            disabled={busy}
            className={`rounded-lg px-3 py-1 font-bold text-white transition active:scale-95 disabled:bg-slate-300 ${
              last ? "bg-red-600 hover:bg-red-700" : "bg-amber-600 hover:bg-amber-700"
            }`}
          >
            {last ? T(action) : T("次へ")}
          </button>
        </div>
      </div>
    );
  };

  /**
   * 一枚ぶん。「出したもの」と「今までのもの」の両方で使う。
   *
   * 写真の差し替え・期間の変更・一言・取り下げ・消す、の釦は、
   * その一枚の段によって出し分ける。
   */
  const renderRow = (n: Mine) => {
    const ph = phaseOf(n);
    const st = PHASE[ph];
    const editing = editId === n.id;
    const titling = titleId === n.id;
    const shown = n.state === "live" && ph !== "ended";
    return (
      <li key={n.id} className="rounded-xl bg-slate-50 p-2">
        <div className="flex items-start gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={n.image}
            alt=""
            className="h-14 w-20 shrink-0 rounded-lg object-cover ring-1 ring-slate-200"
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-1.5">
              <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${st.cls}`}>
                {T(st.label)}
              </span>
              {pendingPeriod(n) && (
                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold text-amber-900">
                  {T("延長の申請中")}
                </span>
              )}
              <span className="min-w-0 truncate text-[11px] font-bold text-slate-800">
                {n.title || n.url}
              </span>
              {!titling && n.state !== "no" && (
                <button
                  onClick={() => openTitle(n)}
                  disabled={busy}
                  className="rounded px-1 py-0.5 text-[10px] font-bold text-blue-700 transition hover:bg-blue-50 active:scale-95 disabled:text-slate-300"
                >
                  {T("一言を直す")}
                </button>
              )}
            </div>

            {/* 一言を書き換える欄。承認は要らない */}
            {titling && (
              <div className="mt-1.5 rounded-lg bg-white p-2 ring-1 ring-blue-200">
                <input
                  value={titleText}
                  onChange={(e) => setTitleText(e.target.value.slice(0, 100))}
                  autoComplete="off"
                  placeholder={T("工大祭のお知らせ")}
                  className="w-full rounded-lg bg-slate-100 px-2 py-1.5 text-[11px] outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
                />
                <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
                  {shown
                    ? T("承認は要りません。保存すると、そのまま地図の入口に出ます。")
                    : T("承認は要りません。")}
                </p>
                <div className="mt-1.5 flex justify-end gap-1.5">
                  <button
                    onClick={() => setTitleId(null)}
                    disabled={busy}
                    className="rounded-lg px-2.5 py-1 text-[10px] font-bold text-slate-500 transition hover:bg-slate-100 active:scale-95"
                  >
                    {T("やめる")}
                  </button>
                  <button
                    onClick={() => void saveTitle(n)}
                    disabled={busy || titleText.trim() === n.title}
                    className="rounded-lg bg-blue-600 px-3 py-1 text-[10px] font-bold text-white transition hover:bg-blue-700 active:scale-95 disabled:bg-slate-200 disabled:text-slate-400"
                  >
                    {busy ? T("送っています…") : T("保存する")}
                  </button>
                </div>
              </div>
            )}

            {/* 期間。変えられる段なら、横に「期間を変える」 */}
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] text-slate-500">
              <span>
                {md(n.from_date)} 〜 {md(n.to_date)}
              </span>
              {CAN_PERIOD.includes(ph) && !editing && !pendingPeriod(n) && (
                <button
                  onClick={() => openPeriod(n)}
                  disabled={busy}
                  className="rounded px-1.5 py-0.5 font-bold text-blue-700 transition hover:bg-blue-50 active:scale-95 disabled:text-slate-300"
                >
                  {ph === "ended" ? T("期間を決めて、また出す") : T("期間を変える")}
                </button>
              )}
            </div>

            {/* 延長の申請中。通るまでは今の期間のまま */}
            {pendingPeriod(n) && (
              <div className="mt-1.5 flex items-center gap-1.5 rounded-lg bg-white p-1.5 ring-1 ring-amber-200">
                <div className="min-w-0 flex-1 text-[10px] leading-relaxed text-amber-900">
                  {T("申請した期間")}：{md(n.next_from ?? "")} 〜 {md(n.next_to ?? "")}
                  <br />
                  {ph === "ended"
                    ? T("通ると、この期間で地図に出ます。")
                    : T("通るまでは、いまの期間のまま出ます。")}
                </div>
                <button
                  onClick={() => void cancelPeriod(n)}
                  disabled={busy}
                  className="shrink-0 rounded-lg px-2 py-1 text-[10px] font-bold text-slate-500 transition hover:bg-slate-100 active:scale-95 disabled:text-slate-300"
                >
                  {T("申請をやめる")}
                </button>
              </div>
            )}

            {/* 期間を書き換える欄 */}
            {editing && (
              <div className="mt-1.5 rounded-lg bg-white p-2 ring-1 ring-blue-200">
                <div className="flex items-center gap-1.5">
                  <input
                    type="date"
                    value={editFrom}
                    onChange={(e) => setEditFrom(e.target.value)}
                    className="min-w-0 flex-1 rounded-lg bg-slate-100 px-2 py-1.5 text-[11px] outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
                  />
                  <span className="shrink-0 text-[10px] text-slate-500">〜</span>
                  <input
                    type="date"
                    value={editTo}
                    onChange={(e) => setEditTo(e.target.value)}
                    className="min-w-0 flex-1 rounded-lg bg-slate-100 px-2 py-1.5 text-[11px] outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                {editTo !== "" && editFrom !== "" && editTo < editFrom && (
                  <p className="mt-1 text-[10px] font-bold text-red-600">
                    {T("終わりの日が、始まりより前になっています。")}
                  </p>
                )}
                <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
                  {n.state === "waiting"
                    ? T("申請中なので、その場で変わります。")
                    : ph === "ended"
                      ? T("また出すには承認が要ります。通ると、決めた期間で地図に出ます。")
                      : editTo > n.to_date
                        ? T("終わりの日を延ばすので、承認が要ります。通るまでは、いまの期間のまま出ます。")
                        : T("早く終える・始まりを動かすのは、その場で変わります。")}
                </p>
                <div className="mt-1.5 flex justify-end gap-1.5">
                  <button
                    onClick={() => setEditId(null)}
                    disabled={busy}
                    className="rounded-lg px-2.5 py-1 text-[10px] font-bold text-slate-500 transition hover:bg-slate-100 active:scale-95"
                  >
                    {T("やめる")}
                  </button>
                  <button
                    onClick={() => void savePeriod(n)}
                    disabled={busy || editFrom === "" || editTo === "" || editTo < editFrom}
                    className="rounded-lg bg-blue-600 px-3 py-1 text-[10px] font-bold text-white transition hover:bg-blue-700 active:scale-95 disabled:bg-slate-200 disabled:text-slate-400"
                  >
                    {busy
                      ? T("送っています…")
                      : n.state !== "waiting" && (ph === "ended" || editTo > n.to_date)
                        ? T("申請する")
                        : T("保存する")}
                  </button>
                </div>
              </div>
            )}

            {n.reason && (
              <div className="mt-0.5 text-[10px] leading-relaxed text-red-700">{n.reason}</div>
            )}

            {/*
              写真の差し替え。出ているもの（開始前・進行中・終了）は、
              通す人が見てから入れ替わる。取り下げたもの（申請をやめたもの）は替えない。
            */}
            {n.state !== "gone" && swapReady && (
              <div className="mt-1.5">
                {n.next_image ? (
                  <div className="flex items-center gap-1.5 rounded-lg bg-white p-1.5 ring-1 ring-amber-200">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={n.next_image}
                      alt=""
                      className="h-10 w-14 shrink-0 rounded object-cover ring-1 ring-slate-200"
                    />
                    <div className="min-w-0 flex-1 text-[10px] leading-relaxed text-amber-900">
                      {T("この写真に差し替えるところです。通るまでは、いまの写真が出ます。")}
                    </div>
                    <button
                      onClick={() => void cancelSwap(n)}
                      disabled={busy}
                      className="shrink-0 rounded-lg px-2 py-1 text-[10px] font-bold text-slate-500 transition hover:bg-slate-100 active:scale-95 disabled:text-slate-300"
                    >
                      {T("やめる")}
                    </button>
                  </div>
                ) : (
                  <label
                    htmlFor={`swap-${n.id}`}
                    className="inline-flex cursor-pointer items-center rounded-lg bg-white px-2 py-1 text-[10px] font-bold text-slate-600 shadow-sm transition hover:bg-slate-50 active:scale-95"
                  >
                    {/*
                      hidden（display:none）にすると、端末によっては
                      名札を押しても写真を選ぶ窓が開かない。
                      見えないが「ある」状態にしておく。
                    */}
                    <input
                      id={`swap-${n.id}`}
                      type="file"
                      accept="image/*"
                      className="sr-only"
                      onChange={(e) => {
                        void swapPhoto(n, e.target.files?.[0] ?? null);
                        e.target.value = "";
                      }}
                      disabled={busy || swapId === n.id}
                    />
                    {swapId === n.id
                      ? T("小さくしています…")
                      : n.state === "no"
                        ? T("写真を替えて出し直す")
                        : n.state === "waiting"
                          ? T("写真を替える")
                          : T("写真を差し替える")}
                  </label>
                )}

                {/* 断られた訳は、ここに出す。上まで戻らなくても読める */}
                {swapErr?.id === n.id && (
                  <p className="mt-1 rounded-lg bg-red-50 px-2 py-1.5 text-[10px] leading-relaxed text-red-800">
                    {T(swapErr.text)}
                  </p>
                )}
              </div>
            )}

            {/* この一枚への操作の結果。上まで戻らなくても読める */}
            {rowMsg?.id === n.id && (
              <p
                className={`mt-1 rounded-lg px-2 py-1.5 text-[10px] leading-relaxed ${
                  rowMsg.kind === "ok" ? "bg-emerald-50 text-emerald-900" : "bg-red-50 text-red-800"
                }`}
              >
                {T(rowMsg.text)}
              </p>
            )}
          </div>

          {/* 確かめている間は隠す（どれを押せば決まるのか、迷わせないため） */}
          {(n.state === "waiting" || shown) && ask?.id !== n.id && (
            <button
              onClick={() => setAsk({ id: n.id, kind: "drop", step: 1 })}
              disabled={busy}
              className="shrink-0 rounded-lg px-2 py-1.5 text-[10px] font-bold text-red-600 transition hover:bg-red-50 active:scale-95 disabled:text-slate-300"
            >
              {T("取り下げる")}
            </button>
          )}
          {canForget(n) && ask?.id !== n.id && (
            <button
              onClick={() => setAsk({ id: n.id, kind: "forget", step: 1 })}
              disabled={busy}
              className="shrink-0 rounded-lg px-2 py-1.5 text-[10px] font-bold text-slate-500 transition hover:bg-slate-200 active:scale-95 disabled:text-slate-300"
            >
              {T("消す")}
            </button>
          )}
        </div>

        {confirmBox(
          n.id,
          "drop",
          n.state === "waiting"
            ? "この申請を取り下げます。取り下げたものは「終了」になります。"
            : "このニュースを取り下げます。地図からすぐに消え、「終了」になります。",
          "本当に取り下げますか？ また出すには、期間を決めて申請し、通してもらう必要があります。",
          "取り下げる",
          () => void drop(n),
        )}
        {confirmBox(
          n.id,
          "forget",
          "この控えを消します。",
          "本当に消しますか？ 消した控えは元に戻せません。",
          "消す",
          () => void forget(n),
        )}
      </li>
    );
  };

  return (
    <Shell>
      <AdminHeader title={T("ニュースを入れる")} />
      <AdminMenu current="news" role={role} />

      {msg && (
        <p
          className={`mb-3 rounded-xl p-3 text-xs leading-relaxed ${
            msg.kind === "ok" ? "bg-emerald-50 text-emerald-900" : "bg-red-50 text-red-800"
          }`}
        >
          {msg.text}
        </p>
      )}

      <p className="mb-3 rounded-xl bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-600">
        {T("写真を一枚と、押したときに開く先を決めて申請します。")}
        <br />
        {T("通ると、学内の情報のいちばん上に出ます。通すのは副管理者（2.2）と管理者です。")}
      </p>

      {/* 写真 */}
      <div className="rounded-xl bg-slate-50 p-3">
        <div className="text-[11px] font-bold text-slate-700">{T("写真")}</div>
        <div className="mt-1.5 flex items-start gap-2.5">
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={image}
              alt=""
              className="h-24 w-40 shrink-0 rounded-lg object-cover ring-1 ring-slate-200"
            />
          ) : (
            <div className="flex h-24 w-40 shrink-0 items-center justify-center rounded-lg bg-white text-[10px] font-bold text-slate-400 ring-1 ring-slate-200">
              {T("なし")}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <input
              type="file"
              accept="image/*"
              onChange={(e) => {
                void pickPhoto(e.target.files?.[0] ?? null);
                e.target.value = "";
              }}
              disabled={imgBusy}
              className="w-full text-[10px] file:mr-2 file:rounded-md file:border-0 file:bg-slate-900 file:px-2.5 file:py-1 file:text-[10px] file:font-bold file:text-white"
            />
            <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
              {imgBusy
                ? T("小さくしています…")
                : T("この端末で小さくしてから送ります。地図を開いた人みんなが読み込むので、軽くしておきます。")}
            </p>
            {image && (
              <button
                onClick={() => setImage("")}
                className="mt-1 rounded-lg bg-white px-2 py-1 text-[10px] font-bold text-red-600 shadow-sm transition hover:bg-red-50 active:scale-95"
              >
                {T("外す")}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 開く先 */}
      <label className="mt-3 block text-[11px] font-bold text-slate-700">
        {T("押したときに開く先")}
      </label>
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        autoComplete="off"
        inputMode="url"
        placeholder="https://…"
        className="mt-1 w-full rounded-xl bg-slate-100 px-4 py-3 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
      />
      <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
        {T("元の頁がある知らせは、そちらへ送ってください。ここで書き写すと、直したときに食い違います。")}
      </p>

      {/* 一言 */}
      <label className="mt-3 block text-[11px] font-bold text-slate-700">
        {T("一言（無くてもよい）")}
      </label>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value.slice(0, 100))}
        autoComplete="off"
        placeholder={T("工大祭のお知らせ")}
        className="mt-1 w-full rounded-xl bg-slate-100 px-4 py-3 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
      />

      {/* いつからいつまで */}
      <label className="mt-3 block text-[11px] font-bold text-slate-700">
        {T("いつからいつまで出すか")}
      </label>
      <div className="mt-1 flex items-center gap-1.5">
        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="min-w-0 flex-1 rounded-xl bg-slate-100 px-3 py-2.5 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
        />
        <span className="shrink-0 text-xs text-slate-500">〜</span>
        <input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="min-w-0 flex-1 rounded-xl bg-slate-100 px-3 py-2.5 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
        />
      </div>
      {to < from && (
        <p className="mt-1 text-[10px] font-bold text-red-600">
          {T("終わりの日が、始まりより前になっています。")}
        </p>
      )}

      <button
        onClick={() => void send()}
        disabled={busy || !canSend}
        className="mt-4 w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold text-white transition hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400"
      >
        {busy ? T("送っています…") : T("申請する")}
      </button>

      {/*
        出したもの。いま動いているもの（申請中・開始前・進行中・延長の申請中）を並べる。
        終わったものは、下の「今までのもの」にまとめる。
      */}
      <div className="mt-5">
        <div className="text-[11px] font-bold text-slate-700">{T("出したもの")}</div>
        {mine.length > 0 &&
          (swapReady ? (
            <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
              {T("写真は、出したあとでも差し替えられます。出ているものは、通るまで今の写真のままです。")}
              {T("一言は、いつでも自分で直せます。")}
              {T("期間は自分で変えられます。終わりの日を延ばすときだけ、承認が要ります。")}
            </p>
          ) : (
            /* 釦を出しても押せないので、代わりに何をすれば使えるかを出す */
            <p className="mt-1 rounded-lg bg-amber-50 px-2 py-1.5 text-[10px] leading-relaxed text-amber-900">
              {T(NO_SWAP)}
            </p>
          ))}
        <ul className="mt-1.5 flex flex-col gap-1.5">
          {current.map(renderRow)}
          {current.length === 0 && (
            <li className="rounded-xl bg-slate-50 px-3 py-6 text-center text-[11px] text-slate-500">
              {mine.length === 0 ? T("まだ出していません。") : T("いま出ているもの・申請中のものはありません。")}
            </li>
          )}
        </ul>

        {/*
          今までのもの。釦を押したときだけ開く。
          終わったもの（取り下げたものを含む）も、期間を決めて申請すれば、また出せる。
        */}
        {past.length > 0 && (
          <div className="mt-3">
            <button
              onClick={() => setShowPast((v) => !v)}
              aria-expanded={showPast}
              className="flex w-full items-center justify-between rounded-xl bg-slate-100 px-3 py-2.5 text-[11px] font-bold text-slate-700 transition hover:bg-slate-200 active:scale-[0.99]"
            >
              <span>
                {T("今までのもの")}
                <span className="ml-1.5 font-normal text-slate-500">
                  {past.length}
                  {T("件")}
                </span>
              </span>
              <span className="text-slate-400">{showPast ? "▲" : "▼"}</span>
            </button>

            {showPast && (
              <>
                <div className="mt-1.5 flex items-baseline justify-between gap-2">
                  <p className="text-[10px] leading-relaxed text-slate-400">
                    {T("終わったもの（取り下げたものを含む）は、期間を決めて申請すれば、また出せます。")}
                  </p>
                  {past.some(canForget) && (
                    <button
                      onClick={() => setAsk({ id: "all", kind: "forget", step: 1 })}
                      disabled={busy}
                      className="shrink-0 rounded-lg px-2 py-1 text-[10px] font-bold text-slate-500 transition hover:bg-slate-100 active:scale-95 disabled:text-slate-300"
                    >
                      {T("終了・断られたものを消す")}
                    </button>
                  )}
                </div>
                {confirmBox(
                  "all",
                  "forget",
                  "終了したものと断られたものの控えを、まとめて消します。",
                  "本当に消しますか？ 消した控えは元に戻せません。",
                  "まとめて消す",
                  () => void forgetAll(),
                )}
                {rowMsg?.id === "all" && (
                  <p
                    className={`mt-1.5 rounded-lg px-2 py-1.5 text-[10px] leading-relaxed ${
                      rowMsg.kind === "ok" ? "bg-emerald-50 text-emerald-900" : "bg-red-50 text-red-800"
                    }`}
                  >
                    {T(rowMsg.text)}
                  </p>
                )}
                <ul className="mt-1.5 flex flex-col gap-1.5">{past.map(renderRow)}</ul>
              </>
            )}
          </div>
        )}
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="h-[100dvh] overflow-y-auto bg-slate-100 p-4">
      <div className="mx-auto w-full max-w-sm rounded-2xl bg-white p-5 shadow-lg sm:max-w-2xl lg:max-w-4xl">
        {children}
      </div>
    </main>
  );
}
