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
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient, supabaseReady } from "@/lib/supabase/client";
import { AdminHeader, AdminMenu } from "@/components/AdminNav";
import { useAdminT } from "@/lib/adminLang";
import { type Role } from "@/lib/auth";
import { shrinkPhoto } from "@/lib/photo";
import { noteError, noteEvent } from "@/lib/note";

type Mine = {
  id: number;
  image: string;
  url: string;
  title: string;
  from_date: string;
  to_date: string;
  state: "waiting" | "live" | "no" | "gone";
  reason: string;
  decided_mail: string;
  decided_at: string | null;
  created_at: string;
};

const STATE: Record<string, { label: string; cls: string }> = {
  waiting: { label: "承認待ち", cls: "bg-amber-100 text-amber-900" },
  live: { label: "出ています", cls: "bg-emerald-100 text-emerald-900" },
  no: { label: "断られました", cls: "bg-red-100 text-red-900" },
  gone: { label: "取り下げました", cls: "bg-slate-100 text-slate-500" },
};

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

  useEffect(() => {
    void load();
  }, [load]);

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
            ? `${e.message}（base/29_news.sql をまだ入れていない場合は、先に入れてください）`
            : String(e),
      });
      noteError("system", "ニュースを申請できませんでした", e);
    } finally {
      setBusy(false);
    }
  };

  const drop = async (n: Mine) => {
    if (!window.confirm(`「${n.title || n.url}」を取り下げます。よろしいですか？`)) return;
    setBusy(true);
    try {
      const { data, error } = await createClient().rpc("news_drop", { p_id: n.id });
      if (error) throw error;
      const v = data as { ok: boolean; reason: string };
      setMsg({ kind: v.ok ? "ok" : "err", text: v.reason });
      await load();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
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

      {/* 出したもの */}
      <div className="mt-5">
        <div className="text-[11px] font-bold text-slate-700">{T("出したもの")}</div>
        <ul className="mt-1.5 flex flex-col gap-1.5">
          {mine.map((n) => {
            const st = STATE[n.state] ?? { label: n.state, cls: "bg-slate-100 text-slate-600" };
            return (
              <li key={n.id} className="flex items-start gap-2 rounded-xl bg-slate-50 p-2">
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
                    <span className="truncate text-[11px] font-bold text-slate-800">
                      {n.title || n.url}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[10px] text-slate-500">
                    {md(n.from_date)} 〜 {md(n.to_date)}
                  </div>
                  {n.reason && (
                    <div className="mt-0.5 text-[10px] leading-relaxed text-red-700">
                      {n.reason}
                    </div>
                  )}
                </div>
                {(n.state === "waiting" || n.state === "live") && (
                  <button
                    onClick={() => void drop(n)}
                    disabled={busy}
                    className="shrink-0 rounded-lg px-2 py-1.5 text-[10px] font-bold text-red-600 transition hover:bg-red-50 active:scale-95 disabled:text-slate-300"
                  >
                    {T("取り下げる")}
                  </button>
                )}
              </li>
            );
          })}
          {mine.length === 0 && (
            <li className="rounded-xl bg-slate-50 px-3 py-6 text-center text-[11px] text-slate-500">
              {T("まだ出していません。")}
            </li>
          )}
        </ul>
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
