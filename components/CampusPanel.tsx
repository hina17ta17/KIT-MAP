"use client";

/**
 * 学内の情報（食堂・時間割・空き教室）。
 *
 * まず日を選ぶところから始める。どの画面も「その日のこと」を出すので、
 * 先に日が決まっていないと何も表示できないため。
 *
 * 中身はすべてデータベースから読む。承認されていない人には
 * RLS が空を返すので、ここでは権限の分岐を最小限にしている。
 *
 * ■ 言葉の切り替え
 *   この中は部品が六つに分かれている（暦・食堂・時間割・学科別・
 *   課外活動・空き教室）。言葉を props で回すと、six 段ぶん
 *   同じものを渡し続けることになる。小さな入れ物（LangCtx）に
 *   置いて、要る所で取り出す形にしてある。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createClient, supabaseReady } from "@/lib/supabase/client";
import { CLASS_CODES, canViewCampusInfo, type Role } from "@/lib/auth";
import { t, type Lang } from "@/lib/i18n";
import { dayColor, holidayName } from "@/lib/holidays";
import { rankOf } from "@/lib/appdata";
import NewsStrip from "./NewsStrip";
import { needsCode } from "@/lib/aal";

type Step = "calendar" | "home" | "cafeteria" | "timetable" | "free" | "clubs" | "apply";

/** いまの言葉。上から配って、部品の中で取り出す */
const LangCtx = createContext<Lang>("ja");

/** その部品で使う翻訳。対応表に無ければ日本語のまま返る */
function useT(): (ja: string) => string {
  const lang = useContext(LangCtx);
  return useCallback((ja: string) => t(lang, ja), [lang]);
}

const WEEK_JA = ["日", "月", "火", "水", "木", "金", "土"];
const WEEK_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** 曜日。英語では三文字にする（一文字だと読めないため） */
function useWeek(): string[] {
  return useContext(LangCtx) === "en" ? WEEK_EN : WEEK_JA;
}

/**
 * 日付の書き方。言葉で並びが変わる。
 *   日本語  2026年9月3日（木）
 *   英語    Thu, Sep 3, 2026
 */
function useDateText(): (d: Date) => string {
  const lang = useContext(LangCtx);
  return useCallback(
    (d: Date) =>
      lang === "en"
        ? `${WEEK_EN[d.getDay()]}, ${
            ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][
              d.getMonth()
            ]
          } ${d.getDate()}, ${d.getFullYear()}`
        : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${WEEK_JA[d.getDay()]}）`,
    [lang],
  );
}

/** 「2026年 9月」／「September 2026」 */
function useMonthText(): (d: Date) => string {
  const lang = useContext(LangCtx);
  return useCallback(
    (d: Date) =>
      lang === "en"
        ? `${
            ["January","February","March","April","May","June",
             "July","August","September","October","November","December"][d.getMonth()]
          } ${d.getFullYear()}`
        : `${d.getFullYear()}年 ${d.getMonth() + 1}月`,
    [lang],
  );
}

/** その日を "2026-08-05" の形にする。時差でずれないよう自前で組む */
function ymd(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function sameDay(a: Date, b: Date): boolean {
  return ymd(a) === ymd(b);
}

/** "08:40:00" → "8:40" */
function hhmm(t: string | null): string {
  if (!t) return "";
  const [h, m] = t.split(":");
  return `${Number(h)}:${m}`;
}

type Period = { id: number; label: string; starts_at: string; ends_at: string };

export default function CampusPanel({
  role,
  onNeedLogin,
  lang = "ja",
}: {
  role: Role | null;
  onNeedLogin: () => void;
  /** 地図と同じ言葉を受け取る。中の部品へは LangCtx で配る */
  lang?: Lang;
}) {
  return (
    <LangCtx.Provider value={lang}>
      <Panel role={role} onNeedLogin={onNeedLogin} />
    </LangCtx.Provider>
  );
}

function Panel({
  role,
  onNeedLogin,
}: {
  role: Role | null;
  onNeedLogin: () => void;
}) {
  const T = useT();
  const dateText = useDateText();
  const [step, setStep] = useState<Step>("calendar");
  const [date, setDate] = useState(() => new Date());
  const [periods, setPeriods] = useState<Period[]>([]);

  const allowed = canViewCampusInfo(role);

  useEffect(() => {
    if (!supabaseReady || !allowed) return;
    void createClient()
      .from("periods")
      .select("id, label, starts_at, ends_at")
      .order("id")
      .then(({ data }) => setPeriods((data as Period[]) ?? []));
  }, [allowed]);

  if (!supabaseReady) {
    return <Note>{T("サーバーに接続できていません。しばらくしてから開き直してください。")}</Note>;
  }

  if (!allowed) {
    return (
      <div className="p-1">
        <Note>{T("学内の情報は、管理者の承認を受けた学生・教職員だけが見られます。")}</Note>
        <button
          onClick={onNeedLogin}
          className="mt-2 w-full rounded-xl bg-slate-900 px-3 py-2.5 text-xs font-bold text-white transition hover:bg-slate-800"
        >
          {T("ログイン / 利用を申請")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {step !== "calendar" && (
        <div className="mb-2 flex items-center gap-2">
          <button
            onClick={() => setStep(step === "home" ? "calendar" : "home")}
            className="rounded-lg bg-slate-100 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 transition hover:bg-slate-200"
          >
            {T("← 戻る")}
          </button>
          <button
            onClick={() => setStep("calendar")}
            className="truncate text-xs font-bold text-slate-800 underline decoration-slate-300 underline-offset-2"
          >
            {dateText(date)}
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {step === "calendar" && (
          <>
            {/*
              お知らせは、日を選ぶ前から見せる。

              ★なぜここにも置くか
                知らせは「いま出ているもの」で、暦で選んだ日とは関係がない
                （出す期間はデータベース側が今日の日付で絞っている）。
                それなのに、日を選ばないと辿りつけなかった。
                学内の情報を開いて最初に目に入る場所に置く。

                暦はこのすぐ下に残す。毎日使うのはそちらなので、
                知らせが無い日は今までと同じ見え方になる
                （出すものが無いときは、枠ごと出ない）。
            */}
            <NewsStrip t={T} />

            <Calendar
              date={date}
              onPick={(d) => {
                setDate(d);
                setStep("home");
              }}
            />

            {/*
              申請は、日を選ぶ前から見えるようにする。

              ★なぜここにも置くか
                申請は「その日のこと」ではない。教職課程やリーダーの
                申し込みに、日は関係ない。それなのに、暦で日を選ばないと
                辿りつけなかった。関係のない一手を挟ませていた。

                日を選ぶ画面のいちばん下に置く。上の暦は毎日使うものなので、
                そこは動かさない。
            */}
            <div className="mt-3 border-t border-slate-200 pt-3">
              <Big
                onClick={() => setStep("apply")}
                icon="📝"
                label={T("申請")}
                sub={T("教職課程・課外活動リーダー")}
              />
            </div>
          </>
        )}

        {step === "home" && (
          <div className="flex flex-col gap-2">
            {/*
              お知らせ。いちばん上。

              地図を開いた人がまず目にする場所。
              何も出ていないときは、枠ごと出さない
              （空の枠は、見に来た人の場所を削るだけ）。
            */}
            <NewsStrip t={T} />

            <Big onClick={() => setStep("cafeteria")} icon="🍚"
              label={T("食堂のメニュー")} sub={T("その日の提供状況")} />
            <Big onClick={() => setStep("timetable")} icon="📘"
              label={T("時間割")} sub={T("授業と課外活動")} />
            <Big onClick={() => setStep("free")} icon="🚪"
              label={T("空き教室")} sub={T("号館と時限から探す")} />
            {/*
              課外活動。名前で探して、どこでやっているかを見る。

              時間割の中にも団体の一覧はあるが、あちらは
              「その日・その時間に何があるか」を見るためのもの。
              「あの部活はどこ？」から入りたいときに辿りつけない。
            */}
            <Big onClick={() => setStep("clubs")} icon="🏳"
              label={T("課外活動")} sub={T("名前で探して、どこでやっているかを見る")} />
            {/*
              申請。いちばん下に置く。

              使う人は限られているので、上に置くと
              毎日使う三つを押しにくくする。

              中に二つある（教職課程・課外活動リーダー）。
              どちらも同じ「もう一段の申請」なので、一つにまとめてある。
            */}
            <Big onClick={() => setStep("apply")} icon="📝"
              label={T("申請")} sub={T("教職課程・課外活動リーダー")} />
          </div>
        )}

        {step === "cafeteria" && <Cafeteria date={date} />}
        {step === "timetable" && <Timetable date={date} periods={periods} role={role} />}
        {step === "free" && <FreeRooms date={date} periods={periods} />}
        {step === "clubs" && <Clubs date={date} />}
        {step === "apply" && <Apply />}
      </div>
    </div>
  );
}

/* ================= カレンダー ================= */

function Calendar({ date, onPick }: { date: Date; onPick: (d: Date) => void }) {
  const T = useT();
  const week = useWeek();
  const monthText = useMonthText();
  const today = useMemo(() => new Date(), []);
  const [shown, setShown] = useState(() => new Date(date.getFullYear(), date.getMonth(), 1));
  /** 月の一覧を開いているか。年と月をまとめて選べる */
  const [pick, setPick] = useState(false);

  const move = (n: number) =>
    setShown((s) => new Date(s.getFullYear(), s.getMonth() + n, 1));

  // 1日の曜日ぶん空白を置いてから並べる
  const cells = useMemo(() => {
    const first = new Date(shown.getFullYear(), shown.getMonth(), 1);
    const last = new Date(shown.getFullYear(), shown.getMonth() + 1, 0);
    const out: (Date | null)[] = [];
    for (let i = 0; i < first.getDay(); i++) out.push(null);
    for (let d = 1; d <= last.getDate(); d++)
      out.push(new Date(shown.getFullYear(), shown.getMonth(), d));
    return out;
  }, [shown]);

  return (
    <div>
      <div className="mb-2 flex items-center gap-1">
        <button
          onClick={() => move(-1)}
          aria-label={T("前の月")}
          className="h-8 w-8 shrink-0 rounded-lg bg-slate-100 text-sm font-bold text-slate-600 transition hover:bg-slate-200"
        >
          ‹
        </button>
        {/* 見出しを押すと、年と月をまとめて選べる。
            何か月も先を見るときに ‹ › を連打しなくて済む */}
        <button
          onClick={() => setPick((v) => !v)}
          className={`flex-1 rounded-lg py-1.5 text-sm font-bold transition ${
            pick ? "bg-slate-900 text-white" : "text-slate-800 hover:bg-slate-100"
          }`}
        >
          {monthText(shown)} ▾
        </button>
        <button
          onClick={() => move(1)}
          aria-label={T("次の月")}
          className="h-8 w-8 shrink-0 rounded-lg bg-slate-100 text-sm font-bold text-slate-600 transition hover:bg-slate-200"
        >
          ›
        </button>
      </div>

      {pick ? (
        <div className="rounded-xl bg-slate-50 p-2">
          <div className="mb-2 flex items-center justify-between">
            <button
              onClick={() => setShown((s) => new Date(s.getFullYear() - 1, s.getMonth(), 1))}
              className="h-7 w-7 rounded-lg bg-white text-xs font-bold text-slate-600 shadow-sm"
            >
              ‹
            </button>
            <span className="text-sm font-bold text-slate-800">{shown.getFullYear()}</span>
            <button
              onClick={() => setShown((s) => new Date(s.getFullYear() + 1, s.getMonth(), 1))}
              className="h-7 w-7 rounded-lg bg-white text-xs font-bold text-slate-600 shadow-sm"
            >
              ›
            </button>
          </div>
          <div className="grid grid-cols-4 gap-1">
            {Array.from({ length: 12 }, (_, i) => (
              <button
                key={i}
                onClick={() => {
                  setShown(new Date(shown.getFullYear(), i, 1));
                  setPick(false);
                }}
                className={`rounded-lg py-2 text-xs font-bold transition ${
                  i === shown.getMonth()
                    ? "bg-slate-900 text-white"
                    : "bg-white text-slate-600 shadow-sm hover:bg-slate-100"
                }`}
              >
                {T("{n}月").replace("{n}", String(i + 1))}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-7 gap-0.5 text-center">
            {week.map((w, i) => (
              <div
                key={w}
                className={`py-1 text-[10px] font-bold ${
                  i === 0 ? "text-red-400" : i === 6 ? "text-blue-400" : "text-slate-400"
                }`}
              >
                {w}
              </div>
            ))}
            {cells.map((d, i) => {
              if (!d) return <div key={`e${i}`} />;
              const isToday = sameDay(d, today);
              const isPicked = sameDay(d, date);
              /*
               * 日曜と祝日は赤、土曜は青。
               * 祝日は曜日では分からないので、暦から出す（lib/holidays.ts）。
               * 授業のある日を探すときに、休みの日がひと目で分かる。
               */
              const tone = dayColor(ymd(d));
              const hol = holidayName(ymd(d));
              return (
                <button
                  key={ymd(d)}
                  onClick={() => onPick(d)}
                  title={hol ?? undefined}
                  className={`relative aspect-square rounded-lg text-xs font-bold transition active:scale-90 ${
                    isPicked
                      ? "bg-slate-900 text-white"
                      : isToday
                        ? "bg-amber-100 text-amber-900 ring-2 ring-amber-400"
                        : tone === "holiday"
                          ? "text-red-500 hover:bg-slate-100"
                          : tone === "sat"
                            ? "text-blue-500 hover:bg-slate-100"
                            : "text-slate-700 hover:bg-slate-100"
                  }`}
                >
                  {d.getDate()}
                  {/* 祝日は、上に小さな点を置く。名前は入らないので */}
                  {hol && !isPicked && (
                    <span className="absolute inset-x-0 top-0.5 mx-auto block h-1 w-1 rounded-full bg-red-400" />
                  )}
                  {/* 今日はひと目で分かるように、下に点を置く */}
                  {isToday && !isPicked && (
                    <span className="absolute inset-x-0 bottom-1 mx-auto block h-1 w-1 rounded-full bg-amber-500" />
                  )}
                </button>
              );
            })}
          </div>

          <button
            onClick={() => {
              setShown(new Date(today.getFullYear(), today.getMonth(), 1));
              onPick(new Date());
            }}
            className="mt-2 w-full rounded-xl bg-amber-500 px-3 py-2.5 text-xs font-bold text-white transition hover:bg-amber-600 active:scale-95"
          >
            {T("今日から始める")}（{today.getMonth() + 1}/{today.getDate()}）
          </button>
          <p className="mt-1.5 text-center text-[10px] text-slate-400">
            {T("日にちを押すと、その日の情報が開きます")}
          </p>
        </>
      )}
    </div>
  );
}

/* ================= 食堂 ================= */

type ItemRow = { id: number; kind: string; parent_id: number | null; name: string; sort_order: number };

const STATE_LABEL: Record<string, { text: string; cls: string }> = {
  open: { text: "活動中", cls: "bg-emerald-100 text-emerald-800" },
  closed: { text: "活動休止", cls: "bg-slate-200 text-slate-600" },
  soldout: { text: "売り切れ", cls: "bg-red-100 text-red-700" },
  // text は日本語のまま持ち、出すときに翻訳する（対応表の見出しにするため）
};

function Cafeteria({ date }: { date: Date }) {
  const T = useT();

  const [items, setItems] = useState<ItemRow[]>([]);
  const [states, setStates] = useState<Map<number, { state: string; note: string }>>(new Map());
  const [menus, setMenus] = useState<
    Map<number, { name: string; price: number | null; image: string }>
  >(new Map());
  const [loading, setLoading] = useState(true);
  /**
   * 大きく見ている写真。null なら開いていない。
   *
   * 一覧の写真は 44点角しかない。何が出るのかを確かめたいときに、
   * その大きさでは分からない。押したら画面いっぱいに出す。
   */
  const [zoom, setZoom] = useState<{ src: string; name: string } | null>(null);

  useEffect(() => {
    const d = ymd(date);
    setLoading(true);
    void (async () => {
      const supabase = createClient();
      const [a, b, c] = await Promise.all([
        supabase.from("cafeteria_items").select("id, kind, parent_id, name, sort_order").order("sort_order"),
        supabase.from("counter_days").select("item_id, state, note").eq("on_date", d),
        supabase.from("menu_days").select("item_id, name, price, image").eq("on_date", d),
      ]);
      setItems((a.data as ItemRow[]) ?? []);
      setStates(new Map(((b.data as { item_id: number; state: string; note: string }[]) ?? []).map((r) => [r.item_id, r])));
      setMenus(
        new Map(
          (
            (c.data as
              | { item_id: number; name: string; price: number | null; image: string }[]
              | null) ?? []
          ).map((r) => [r.item_id, { ...r, image: r.image ?? "" }]),
        ),
      );
      setLoading(false);
    })();
  }, [date]);

  if (loading) return <Note>{T("読み込み中…")}</Note>;

  const counters = items.filter((i) => i.kind === "counter");
  if (counters.length === 0) return <Note>{T("食堂の情報がまだ登録されていません。")}</Note>;

  return (
    <>
    {/*
      写真を大きく見る。

      どこを押しても閉じる。小さな✕だけだと、指の大きい人や
      急いでいる人が閉じられない。写真そのものを押しても閉じてよい
      ——ここから先へ進む道は無いので、押し間違いで困ることがない。
    */}
    {zoom && (
      <div
        onClick={() => setZoom(null)}
        role="button"
        aria-label={T("閉じる")}
        className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-slate-900/85 p-4 backdrop-blur-sm"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={zoom.src}
          alt={zoom.name}
          className="max-h-[75vh] w-auto max-w-full rounded-2xl object-contain shadow-2xl"
        />
        {zoom.name && (
          <div className="mt-3 max-w-full truncate text-sm font-bold text-white">{zoom.name}</div>
        )}
        <div className="mt-1 text-[11px] text-slate-300">{T("どこかを押すと閉じます")}</div>
      </div>
    )}

    <ul className="flex flex-col gap-2">
      {counters.map((c) => {
        const st = states.get(c.id);
        const badge = st ? STATE_LABEL[st.state] : null;
        const slots = items.filter((i) => i.parent_id === c.id);
        return (
          <li key={c.id} className="rounded-xl bg-slate-50 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-bold text-slate-900">・{c.name}</span>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                  badge ? badge.cls : "bg-slate-100 text-slate-400"
                }`}
              >
                {T(badge ? badge.text : "未登録")}
              </span>
            </div>
            {st?.note && <p className="mt-1 text-[10px] text-slate-500">{st.note}</p>}

            {slots.length > 0 && (
              <ul className="mt-1.5 flex flex-col gap-1 border-t border-slate-200 pt-1.5">
                {slots.map((s) => {
                  const m = menus.get(s.id);
                  return (
                    <li key={s.id} className="flex items-center gap-2 text-[11px]">
                      {/*
                        写真はいちばん左。

                        無いことのほうが多いので、無いときも同じ場所に
                        同じ大きさで「なし」と出す。場所ごと消すと、
                        撮り忘れたのか、もともと出さない決まりなのかが
                        分からなくなるうえ、行ごとに高さが変わって読みにくい。
                      */}
                      {m?.image ? (
                        <button
                          onClick={() => setZoom({ src: m.image, name: m.name })}
                          aria-label={T("写真を大きく見る")}
                          className="shrink-0 transition active:scale-95"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={m.image}
                            alt=""
                            loading="lazy"
                            className="h-11 w-11 rounded-lg object-cover ring-1 ring-slate-200"
                          />
                        </button>
                      ) : (
                        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-white text-[9px] font-bold text-slate-300 ring-1 ring-slate-200">
                          {T("なし")}
                        </span>
                      )}
                      <span className="shrink-0 text-slate-500">− {s.name}</span>
                      <span className="ml-auto min-w-0 truncate text-right font-bold text-slate-800">
                        {m ? m.name : "—"}
                        {m?.price ? (
                          <span className="ml-1 font-normal text-slate-500">
                            {T("{n}円").replace("{n}", String(m.price))}
                          </span>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
    </>
  );
}

/* ================= 時間割 ================= */

type Faculty = { id: number; name: string };
type Dept = { id: number; faculty_id: number; name: string; code: string };
type Cat = { id: number; name: string };
type Act = { id: number; category_id: number | null; name: string };

type ClassRow = {
  id: number;
  starts_at: string;
  ends_at: string;
  teacher: string;
  changed: boolean;
  change_note: string;
  rooms: { building_code: string; code: string; name: string } | null;
  courses: { name: string; class_name: string; teacher: string } | null;
};

type ActRow = {
  id: number;
  starts_at: string;
  ends_at: string;
  title: string;
  rooms: { building_code: string; code: string; name: string } | null;
};

function Timetable({
  date,
  periods,
  role,
}: {
  date: Date;
  periods: Period[];
  role: Role | null;
}) {
  const T = useT();

  // null = 未選択、数字 = その限、"act" = 課外活動
  const [sel, setSel] = useState<number | "act" | null>(null);

  return (
    <div>
      {/* 教授には、自分が担当する授業をいちばん上に出す */}
      {role === "admin_l2" && <MyClasses date={date} />}

      <p className="mb-1.5 text-[11px] font-bold text-slate-500">{T("何限を見ますか")}</p>
      <div className="grid grid-cols-3 gap-1.5">
        {periods.map((p) => (
          <button
            key={p.id}
            onClick={() => setSel(p.id)}
            className={`rounded-xl py-2 text-xs font-bold transition active:scale-95 ${
              sel === p.id ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"
            }`}
          >
            {p.label}
            <span className="mt-0.5 block text-[9px] font-normal opacity-70">
              {hhmm(p.starts_at)}
            </span>
          </button>
        ))}
      </div>

      {/* 課外活動は授業と選び方が違うので、離して別の見た目にする */}
      <button
        onClick={() => setSel("act")}
        className={`mt-1.5 w-full rounded-xl border-2 border-dashed py-2.5 text-xs font-bold transition active:scale-95 ${
          sel === "act"
            ? "border-violet-500 bg-violet-500 text-white"
            : "border-violet-300 bg-violet-50 text-violet-700 hover:bg-violet-100"
        }`}
      >
        {T("課外活動")}
      </button>

      <div className="mt-3">
        {sel === null && <Note>{T("時限を選んでください。")}</Note>}
        {typeof sel === "number" && <ByDepartment date={date} periodId={sel} />}
        {sel === "act" && <ByActivity date={date} />}
      </div>
    </div>
  );
}

/**
 * 学科を選び、その学科の授業を出す。
 *
 * 学生は申請のときに自分の学科（クラス記号）を出しているので、
 * ここで改めて選ばせない。読み込んだ時点でその学科の授業を出す。
 * 毎回17個の中から自分の学科を探させるのは、分かっていることを
 * もう一度たずねているだけで、時間割を見るまでが遠くなる。
 *
 * 他の学科も見たいときのために「学科を選び直す」は残す。
 * 学科を持たない人（食堂の担当や教職員）は、これまでどおり選ぶところから。
 */
function ByDepartment({ date, periodId }: { date: Date; periodId: number }) {
  const T = useT();

  const [facs, setFacs] = useState<Faculty[]>([]);
  const [depts, setDepts] = useState<Dept[]>([]);
  const [dept, setDept] = useState<Dept | null>(null);
  const [rows, setRows] = useState<ClassRow[] | null>(null);
  /**
   * 自分の学年。0 は未記入。
   *
   * 学生なら、自分の学年の授業だけを出す。学年を問わない科目（grade=0）は
   * どの学年でも出す。学年を持たない人は絞らない。
   */
  const [grade, setGrade] = useState(0);
  /** 学年で絞っているか。「全学年を見る」で外せる */
  const [byGrade, setByGrade] = useState(true);
  /**
   * 自分が教職として通っているか。
   *
   * 通っていれば、教職の授業も時間割に出る。
   * 通っていなければ、教職の授業ははじめから並べない。
   */
  const [myTeaching, setMyTeaching] = useState(false);
  /**
   * 自分の学科を、もう当てはめたか。
   *
   * 当てはめるのは一度だけ。これが無いと「選び直す」で戻った瞬間に
   * また自分の学科へ引き戻され、他の学科を見られなくなる。
   */
  const applied = useRef(false);

  useEffect(() => {
    void (async () => {
      const supabase = createClient();
      const [f, d, u] = await Promise.all([
        supabase.from("faculties").select("id, name").order("sort_order"),
        supabase.from("departments").select("id, faculty_id, name, code").order("sort_order"),
        supabase.auth.getUser(),
      ]);
      const list = (d.data as Dept[]) ?? [];
      setFacs((f.data as Faculty[]) ?? []);
      setDepts(list);

      if (!u.data.user) return;
      /*
       * 列を並べずに取る。teaching の列を足す SQL を流す前でも
       * 落ちないようにするため（並べると、無い列一つで全部が失敗する）。
       */
      const { data: me } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", u.data.user.id)
        .single();

      const p = me as { class_code?: string; grade?: number; teaching?: boolean } | null;
      setMyTeaching(p?.teaching === true);
      if (applied.current) return;
      if (p?.grade) setGrade(p.grade);

      /*
       * 突き合わせは、まず記号どうしで行う。
       *
       * departments には code の列があるので（"CC" など）、
       * profiles.class_code とそのまま比べられる。
       * 記号が入っていない学科のために、名前でも探せるようにしておく。
       */
      const code = p?.class_code;
      if (!code) return;
      const name = CLASS_CODES.find((c) => c.code === code)?.name;
      const mine =
        list.find((x) => x.code === code) ??
        (name ? list.find((x) => x.name === name) : undefined);
      if (mine) {
        applied.current = true;
        setDept(mine);
      }
    })();
  }, []);

  // 限か日か学科が変わったら取り直す
  useEffect(() => {
    if (!dept) {
      setRows(null);
      return;
    }
    void (async () => {
      let q = createClient()
        .from("timetable")
        .select(
          "id, starts_at, ends_at, teacher, changed, change_note, rooms(building_code, code, name), courses!inner(name, class_name, teacher, department_id, department_ids, grade, teaching)",
        )
        .eq("on_date", ymd(date))
        .eq("period_id", periodId)
        .eq("kind", "class")
        /*
         * 学科は並びで持っている。
         *
         * 教養や共通の科目は、いくつもの学科が同じものを受ける。
         * 代表の一つ（department_id）だけを見ていたときは、
         * そういう科目がどこか一つの学科にしか出なかった。
         * 並びに入っていれば出す。
         */
        .contains("courses.department_ids", [dept.id]);

      /*
       * 学年で絞る。0 の科目は「学年を問わない」ので必ず残す。
       * 学年を持たない人（教職員など）や「全学年を見る」にしたときは絞らない。
       */
      if (byGrade && grade) q = q.in("courses.grade", [0, grade]);

      /*
       * 教職の授業は、教職として通っている人にだけ出す。
       *
       * 通っていない人には、そもそも並べない。
       * 「出ているのに開けない」より、初めから見えないほうがよい。
       */
      if (!myTeaching) q = q.eq("courses.teaching", false);

      const { data, error } = await q;
      if (error) {
        /*
         * 並びの列がまだ無い版のときは、前の形（代表の一つ）で訊き直す。
         * 入れ直すまでのあいだ、時間割が真っ白になるのを避ける。
         */
        let q2 = createClient()
          .from("timetable")
          .select(
            "id, starts_at, ends_at, teacher, changed, change_note, rooms(building_code, code, name), courses!inner(name, class_name, teacher, department_id, grade)",
          )
          .eq("on_date", ymd(date))
          .eq("period_id", periodId)
          .eq("kind", "class")
          .eq("courses.department_id", dept.id);
        if (byGrade && grade) q2 = q2.in("courses.grade", [0, grade]);
        const again = await q2;
        setRows((again.data as unknown as ClassRow[]) ?? []);
        return;
      }
      setRows((data as unknown as ClassRow[]) ?? []);
    })();
  }, [dept, date, periodId, byGrade, grade, myTeaching]);

  if (dept) {
    return (
      <div>
        {/*
          いま何を出しているのかを、いちばん上に出す。

          学生には自分の学科と学年で絞ったものを出すので、黙って絞ると
          「授業が無い」のか「絞られている」のかが分からなくなる。
          何で絞っているかと、外し方を並べて置く。
        */}
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-bold text-slate-900">{dept.name}</span>
          {byGrade && grade > 0 && (
            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold text-blue-800">
              {T("{n}年").replace("{n}", String(grade))}
            </span>
          )}
          <span className="ml-auto flex gap-1">
            {grade > 0 && (
              <button
                onClick={() => setByGrade((v) => !v)}
                className="rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600 transition hover:bg-slate-200 active:scale-95"
              >
                {byGrade ? T("全学年を見る") : T("{n}年だけに戻す").replace("{n}", String(grade))}
              </button>
            )}
            <button
              onClick={() => setDept(null)}
              className="rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600 transition hover:bg-slate-200 active:scale-95"
            >
              {T("他の学科")}
            </button>
          </span>
        </div>
        {rows === null ? (
          <Note>{T("読み込み中…")}</Note>
        ) : rows.length === 0 ? (
          <Note>{T("この時限に登録された授業はありません。")}</Note>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {rows.map((r) => (
              <li key={r.id} className="rounded-xl bg-slate-50 p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-bold text-slate-900">
                    {r.courses?.name ?? T("（科目名なし）")}
                  </span>
                  {r.changed && (
                    <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">
                      {T("変更あり")}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-slate-600">
                  {r.courses?.class_name && (
                    <span>
                      {T("クラス")} {r.courses.class_name}
                    </span>
                  )}
                  <span>{r.courses?.teacher || r.teacher || T("担当未定")}</span>
                </div>
                <div className="mt-1 text-[11px] font-bold text-slate-700">
                  {r.rooms ? r.rooms.code : T("教室未定")}
                  <span className="ml-2 font-normal text-slate-500">
                    {hhmm(r.starts_at)}〜{hhmm(r.ends_at)}
                  </span>
                </div>
                {r.change_note && (
                  <p className="mt-1 text-[10px] text-amber-700">{r.change_note}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div>
      <p className="mb-1.5 text-[11px] font-bold text-slate-500">{T("学科を選んでください")}</p>
      <div className="flex flex-col gap-2">
        {facs.map((f) => {
          const list = depts.filter((d) => d.faculty_id === f.id);
          if (list.length === 0) return null;
          return (
            <div key={f.id}>
              <div className="mb-1 text-[10px] font-bold text-slate-400">{f.name}</div>
              <div className="flex flex-col gap-1">
                {list.map((d) => (
                  <button
                    key={d.id}
                    onClick={() => setDept(d)}
                    className="rounded-lg bg-slate-100 px-3 py-2 text-left text-[11px] font-bold text-slate-700 transition hover:bg-slate-200 active:scale-95"
                  >
                    {d.name}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {facs.length === 0 && <Note>{T("学科がまだ登録されていません。")}</Note>}
      </div>
    </div>
  );
}

/** 系統を選び、団体を選び、その日の予定を出す */
function ByActivity({ date }: { date: Date }) {
  const T = useT();

  const [cats, setCats] = useState<Cat[]>([]);
  const [acts, setActs] = useState<Act[]>([]);
  const [cat, setCat] = useState<Cat | null>(null);
  const [act, setAct] = useState<Act | null>(null);
  const [rows, setRows] = useState<ActRow[] | null>(null);

  useEffect(() => {
    void (async () => {
      const supabase = createClient();
      const [c, a] = await Promise.all([
        supabase.from("activity_categories").select("id, name").order("sort_order"),
        supabase.from("club_activities").select("id, category_id, name").order("sort_order"),
      ]);
      setCats((c.data as Cat[]) ?? []);
      setActs((a.data as Act[]) ?? []);
    })();
  }, []);

  useEffect(() => {
    if (!act) {
      setRows(null);
      return;
    }
    void (async () => {
      const { data } = await createClient()
        .from("timetable")
        .select("id, starts_at, ends_at, title, rooms(building_code, code, name)")
        .eq("on_date", ymd(date))
        .eq("kind", "activity")
        .eq("activity_id", act.id)
        .order("starts_at");
      setRows((data as unknown as ActRow[]) ?? []);
    })();
  }, [act, date]);

  if (act) {
    return (
      <div>
        <button
          onClick={() => setAct(null)}
          className="mb-2 rounded-lg bg-slate-100 px-2.5 py-1.5 text-[11px] font-bold text-slate-600"
        >
          {T("← 団体を選び直す")}
        </button>
        <p className="mb-1.5 text-xs font-bold text-slate-900">{act.name}</p>
        {rows === null ? (
          <Note>{T("読み込み中…")}</Note>
        ) : rows.length === 0 ? (
          <div className="rounded-xl bg-slate-50 p-4 text-center">
            <p className="text-sm font-bold text-slate-700">{T("なし")}</p>
            <p className="mt-0.5 text-[10px] text-slate-500">{T("この日の活動予定はありません")}</p>
          </div>
        ) : (
          <>
            {rows.length > 1 && (
              <p className="mb-1.5 rounded-lg bg-violet-50 px-2.5 py-1.5 text-[10px] font-bold text-violet-700">
                {T("複数の教室（{n}か所）で活動します").replace("{n}", String(rows.length))}
              </p>
            )}
            <ul className="flex flex-col gap-1.5">
              {rows.map((r) => (
                <li key={r.id} className="rounded-xl bg-slate-50 p-2.5">
                  <div className="text-sm font-bold text-slate-900">
                    {hhmm(r.starts_at)}〜{hhmm(r.ends_at)}
                  </div>
                  <div className="mt-0.5 text-[11px] font-bold text-slate-700">
                    {r.rooms ? `${r.rooms.code}` : "教室未定"}
                    {r.rooms?.name ? (
                      <span className="ml-1 font-normal text-slate-500">{r.rooms.name}</span>
                    ) : null}
                  </div>
                  {r.title && <p className="mt-0.5 text-[10px] text-slate-500">{r.title}</p>}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    );
  }

  if (cat) {
    const list = acts.filter((a) => a.category_id === cat.id);
    return (
      <div>
        <button
          onClick={() => setCat(null)}
          className="mb-2 rounded-lg bg-slate-100 px-2.5 py-1.5 text-[11px] font-bold text-slate-600"
        >
          {T("← 系統を選び直す")}
        </button>
        <p className="mb-1.5 text-[11px] font-bold text-slate-500">{cat.name}</p>
        <div className="flex flex-col gap-1">
          {list.map((a) => (
            <button
              key={a.id}
              onClick={() => setAct(a)}
              className="rounded-lg bg-violet-50 px-3 py-2 text-left text-[11px] font-bold text-violet-800 transition hover:bg-violet-100 active:scale-95"
            >
              {a.name}
            </button>
          ))}
          {list.length === 0 && <Note>{T("この系統の団体は登録されていません。")}</Note>}
        </div>
      </div>
    );
  }

  return (
    <div>
      <p className="mb-1.5 text-[11px] font-bold text-slate-500">{T("何系の活動ですか")}</p>
      <div className="flex flex-col gap-1">
        {cats.map((c) => (
          <button
            key={c.id}
            onClick={() => setCat(c)}
            className="rounded-lg bg-slate-100 px-3 py-2 text-left text-[11px] font-bold text-slate-700 transition hover:bg-slate-200 active:scale-95"
          >
            {c.name}
          </button>
        ))}
        {cats.length === 0 && <Note>{T("課外活動がまだ登録されていません。")}</Note>}
      </div>
    </div>
  );
}

/* ================= 申請 ================= */

/**
 * 申請の入口。
 *
 * 中に二つある。
 *   教職課程            名簿の教職の欄（xlsx の P列）と照らす
 *   課外活動リーダー    8桁の番号と団体を、リーダーの名簿と照らす
 *
 * どちらも「もう一段」であって、権限（role）そのものではない。
 * 断られても、いままでの使い方は何も変わらない。
 * 跡を消したいときは「取り消す」で、ただのログインに戻せる。
 *
 * ■ 見ているのは kit-agent
 *   申請を自動で見る仕組みにつけた名前。実体は Python ではなく、
 *   データベースの中の関数（teaching_match / leader_match）。
 *   Python を常に走らせておく場所が無いので、判断はぜんぶ
 *   データベース側に置いてある。誰も何も動かしていなくても、
 *   押したその場で答が出る。
 */

type AgentStep = { label: string; ok: boolean; detail: string };

type AgentAnswer = {
  ok: boolean;
  /** ok … 通る／no … 通らない／wait … こちらの落ち度で決められない */
  kind?: string;
  reason: string;
  activity?: string;
  steps?: AgentStep[];
};

type Mine = {
  email: string;
  verified: boolean;
  role: string;
  teaching: boolean;
  teaching_applied: boolean;
  /** 教職が通らなかった・外れた訳（38）。古いデータベースには無い */
  teaching_reason: string;
  leader: boolean;
  leader_applied: boolean;
  leader_no: string;
  leader_activity_id: number | null;
  leader_reason: string;
};

/**
 * いまの自分の様子。
 *
 * 列を並べずに取る。teaching や leader の列を足す SQL を流す前でも
 * 落ちないようにするため。並べて書くと、無い列を一つ指しただけで
 * 問い合わせ全部が失敗する（それで一度、感想が届かなくなった）。
 */
function useMe(): { me: Mine | null | undefined; reload: () => Promise<void> } {
  /*
   * 三つある。
   *   undefined … まだ読んでいる
   *   null      … 席が見つからない（ログインが切れている）
   *   中身      … 読めた
   *
   * 「読んでいる」と「無い」を分けておかないと、席が切れたときに
   * 「読み込み中…」が出たまま止まって見える。何が起きているのか
   * 画面から分からなくなる。
   */
  const [me, setMe] = useState<Mine | null | undefined>(undefined);

  const reload = useCallback(async () => {
    if (!supabaseReady) {
      setMe(null);
      return;
    }
    const supabase = createClient();
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) {
      setMe(null);
      return;
    }
    /*
     * 本人確認の印を、認証アプリの実体に合わせてから読む。
     *
     * 印（profiles.verified）は申請の画面の④を通ったときに立つ。
     * ところが、そこで通信が切れた人や、データベースから直に権限を
     * 付けた人には立っていない。認証アプリは登録されているのに
     * 「本人確認がまだ」と出て、教職課程も課外活動リーダーも申請できない。
     * しかも申請の画面は登録済みのものを作り直さないので、自力で直せない。
     *
     * 読む前に直しておけば、その場で正しい様子になる。
     * まだ base/32 を入れていないときは、黙って今までどおり動く。
     */
    try {
      await supabase.rpc("sync_verified");
    } catch {
      /* 直せなくても、下の読み込みは続ける */
    }
    const { data } = await supabase.from("profiles").select("*").eq("id", u.user.id).single();
    const p = (data ?? {}) as Record<string, unknown>;
    setMe({
      email: typeof p.email === "string" ? p.email : (u.user.email ?? ""),
      verified: p.verified === true,
      role: typeof p.role === "string" ? p.role : "",
      teaching: p.teaching === true,
      teaching_applied: p.teaching_applied === true,
      teaching_reason: typeof p.teaching_reason === "string" ? p.teaching_reason : "",
      leader: p.leader === true,
      leader_applied: p.leader_applied === true,
      leader_no: typeof p.leader_no === "string" ? p.leader_no : "",
      leader_activity_id: typeof p.leader_activity_id === "number" ? p.leader_activity_id : null,
      leader_reason: typeof p.leader_reason === "string" ? p.leader_reason : "",
    });
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { me, reload };
}

/**
 * kit-agent が見ているあいだと、見終わったあと。
 *
 * ■ 段（steps）は本物
 *   データベースが実際に見た順と、その結果をそのまま返している。
 *   こちらで組み立てた飾りではない。
 *
 * ■ 順に出しているのは、読めるようにするため
 *   答は一度に返ってくる。六行がいっぺんに現れると
 *   どこで引っかかったのか目で追えない。少しずつ出す。
 *   出す速さを変えているだけで、答そのものは触っていない。
 *
 * ■ 「確認しています」を、少しのあいだは出しておく
 *   答が速く返ると、押した人には何も起きなかったように見える。
 *   読めるだけの間（0.9秒）は出したままにする。
 */
function useAgent() {
  const [phase, setPhase] = useState<"idle" | "run" | "done">("idle");
  const [answer, setAnswer] = useState<AgentAnswer | null>(null);
  /** いま何段まで出したか */
  const [shown, setShown] = useState(0);
  const timers = useRef<number[]>([]);

  const stop = useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  }, []);

  // 画面を離れたら、待ち合わせをぜんぶ止める
  useEffect(() => stop, [stop]);

  const run = useCallback(
    async (call: () => Promise<AgentAnswer>) => {
      stop();
      setPhase("run");
      setAnswer(null);
      setShown(0);

      const began = Date.now();
      let v: AgentAnswer;
      try {
        v = await call();
      } catch (e) {
        v = { ok: false, kind: "wait", reason: e instanceof Error ? e.message : String(e) };
      }

      const rest = Math.max(0, 900 - (Date.now() - began));
      timers.current.push(
        window.setTimeout(() => {
          setAnswer(v);
          const steps = v.steps ?? [];
          steps.forEach((_, k) => {
            timers.current.push(window.setTimeout(() => setShown(k + 1), k * 240));
          });
          timers.current.push(
            window.setTimeout(() => setPhase("done"), Math.max(0, steps.length - 1) * 240 + 120),
          );
        }, rest),
      );
    },
    [stop],
  );

  const reset = useCallback(() => {
    stop();
    setPhase("idle");
    setAnswer(null);
    setShown(0);
  }, [stop]);

  return { phase, answer, shown, run, reset };
}

function AgentView({
  phase,
  answer,
  shown,
}: {
  phase: "idle" | "run" | "done";
  answer: AgentAnswer | null;
  shown: number;
}) {
  const T = useT();
  if (phase === "idle") return null;

  const done = phase === "done";
  const ok = answer?.ok === true;
  const steps = (answer?.steps ?? []).slice(0, shown);

  return (
    <div
      className={`mt-3 rounded-xl border p-3 ${
        done
          ? ok
            ? "border-emerald-200 bg-emerald-50/70"
            : "border-red-200 bg-red-50/70"
          : "border-blue-200 bg-blue-50/70"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          {!done && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
          )}
          <span
            className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
              done ? (ok ? "bg-emerald-500" : "bg-red-500") : "bg-blue-500"
            }`}
          />
        </span>
        <span
          className={`text-xs font-bold ${
            done ? (ok ? "text-emerald-900" : "text-red-800") : "text-blue-900"
          }`}
        >
          {!done
            ? T("kit-agent が確認しています…")
            : ok
              ? T("できました")
              : T("できませんでした")}
        </span>
      </div>

      {steps.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {steps.map((st, k) => (
            <li key={k} className="flex items-baseline gap-1.5 text-[11px]">
              <span
                className={`shrink-0 font-bold ${st.ok ? "text-emerald-600" : "text-red-600"}`}
              >
                {st.ok ? "✓" : "✕"}
              </span>
              <span className="shrink-0 font-bold text-slate-700">{T(st.label)}</span>
              <span className="min-w-0 truncate text-slate-500">{st.detail}</span>
            </li>
          ))}
        </ul>
      )}

      {done && answer && (
        <p
          className={`mt-2 border-t pt-2 text-[11px] leading-relaxed ${
            ok ? "border-emerald-200 text-emerald-900" : "border-red-200 text-red-800"
          }`}
        >
          {answer.reason}
          {!ok && answer.kind === "wait" && (
            <>
              <br />
              {T("こちらで直すことです。しばらく待つか、管理する人にお知らせください。")}
            </>
          )}
        </p>
      )}
    </div>
  );
}

/** 申請の入口。二つのうちどちらかを選ぶ */
function Apply() {
  const T = useT();
  const [which, setWhich] = useState<"" | "teaching" | "leader">("");
  const { me, reload } = useMe();

  if (me === undefined) return <Note>{T("読み込み中…")}</Note>;
  if (me === null)
    return (
      <div>
        <Note>{T("ログインの様子が読み取れませんでした。入り直してからお試しください。")}</Note>
        <a
          href="/login"
          className="mt-2 block rounded-xl bg-slate-900 px-3 py-2.5 text-center text-xs font-bold text-white transition hover:bg-slate-800"
        >
          {T("ログインの画面へ")}
        </a>
      </div>
    );

  if (which !== "") {
    return (
      <div>
        <button
          onClick={() => {
            setWhich("");
            void reload();
          }}
          className="mb-2 rounded-lg bg-slate-100 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 transition hover:bg-slate-200"
        >
          {T("← 申請にもどる")}
        </button>
        {which === "teaching" ? (
          <TeachingApply me={me} onDone={reload} />
        ) : (
          <LeaderApply me={me} onDone={reload} />
        )}
      </div>
    );
  }

  return (
    <div>
      <p className="rounded-xl bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-600">
        {T("申請すると、kit-agent が名簿と照らして、その場で決めます。")}
        <br />
        {T("通らなくても、いままでの使い方は何も変わりません。")}
      </p>

      <div className="mt-3 flex flex-col gap-2">
        <Big
          onClick={() => setWhich("teaching")}
          icon="🎓"
          label={T("教職の申請")}
          sub={
            me.teaching
              ? T("通っています")
              : me.teaching_applied
                ? T("申請しましたが、通っていません")
                : T("教職課程を履修している人")
          }
        />
        <Big
          onClick={() => setWhich("leader")}
          icon="🏳"
          label={T("課外活動リーダー申請")}
          sub={
            me.leader
              ? T("通っています")
              : me.leader_applied
                ? T("申請しましたが、通っていません")
                : T("部やプロジェクトの長をしている人")
          }
        />
      </div>
    </div>
  );
}

/**
 * 教職課程の申請。
 *
 * ■ 順番
 *   ① 本人確認（認証アプリ）が済んでいること
 *   ② ここで申請を出す
 *   ③ kit-agent が名簿と照らして、通すか断るかまで決まる
 *
 *   人を待たせない。名簿に印があれば、押したその場で通る。
 */
function TeachingApply({ me, onDone }: { me: Mine; onDone: () => Promise<void> }) {
  const T = useT();
  const { phase, answer, shown, run, reset } = useAgent();
  const [busy, setBusy] = useState(false);

  const apply = async () => {
    setBusy(true);
    await run(async () => {
      const { data, error } = await createClient().rpc("apply_teaching");
      if (error) throw new Error(`${error.message}（base/03_roster.sql をまだ入れていない場合は、先に入れてください）`);
      return data as AgentAnswer;
    });
    await onDone();
    setBusy(false);
  };

  const clear = async () => {
    if (!window.confirm("教職の申請を取り消して、ふつうのログインに戻します。よろしいですか？"))
      return;
    setBusy(true);
    reset();
    try {
      const { error } = await createClient().rpc("clear_teaching");
      if (error) throw error;
      await onDone();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="rounded-xl bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-600">
        {T("教職課程を履修している人だけが使える欄です。")}
        <br />
        {T("申請すると、名簿の教職の欄と突き合わせて、その場で決まります。")}
      </p>

      <Status
        ok={me.teaching}
        applied={me.teaching_applied}
        okText={T("教職として通っています")}
        reason={me.teaching_reason}
      />

      {!me.verified ? (
        <NeedVerify what={T("教職")} />
      ) : me.role === "pending" ? (
        <div className="mt-3 rounded-xl bg-amber-50 p-3 text-[11px] leading-relaxed text-amber-900">
          {T("まだ利用の承認を待っています。承認されたら、ここから申請できます。")}
        </div>
      ) : (
        <>
          <AgentView phase={phase} answer={answer} shown={shown} />

          <button
            onClick={() => void apply()}
            disabled={busy}
            className="mt-3 w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold text-white transition hover:bg-blue-700 disabled:bg-slate-300"
          >
            {busy
              ? T("kit-agent が確認しています…")
              : me.teaching
                ? T("もう一度たしかめる")
                : T("教職課程を申請する")}
          </button>

          {me.teaching_applied && (
            <button
              onClick={() => void clear()}
              disabled={busy}
              className="mt-1.5 w-full rounded-xl px-4 py-2 text-xs font-bold text-slate-500 transition hover:bg-slate-100"
            >
              {T("教職の申請を取り消す")}
            </button>
          )}
        </>
      )}

      <p className="mt-3 text-[10px] leading-relaxed text-slate-400">
        {T("名簿の教職の欄に印が無いと、申請は通りません。")}
        {T("履修しているのに通らないときは、管理者にお知らせください。")}
        <br />
        {T("教職として通っても、いままでの使い方は何も変わりません。")}
      </p>
    </div>
  );
}

/**
 * 課外活動リーダーの申請。
 *
 * ■ 順番
 *   ① 本人確認（認証アプリ）が済んでいること
 *   ② 8桁の番号を入れる（学生証・職員証の番号）
 *   ③ どこの課外活動のリーダーかを選ぶ
 *   ④ kit-agent が、リーダーの名簿と照らして決める
 *
 * ■ なぜ番号が要るのか
 *   団体を選ぶだけで通ると、誰でもどこの長にでもなれてしまう。
 *   番号は「その名簿の行が、いま押しているこの人のものか」を
 *   確かめるための鍵。人のものを入れても通らない（データベース側で、
 *   その番号がご本人のものかを先に見ている）。
 *
 * ■ 通ると、課外活動リーダーの権限が付く
 *   この権限（admin_l1）は前からあって、今までは承認する人が
 *   手で付けていた。付くと、自分の団体の予定を入れられる。
 *   教授など、もっと上の権限の人は動かさない（下げない）。
 */
function LeaderApply({ me, onDone }: { me: Mine; onDone: () => Promise<void> }) {
  const T = useT();
  const { phase, answer, shown, run, reset } = useAgent();
  const [busy, setBusy] = useState(false);

  const [cats, setCats] = useState<Cat[]>([]);
  const [acts, setActs] = useState<Act[]>([]);
  const [catId, setCatId] = useState<number | null>(null);
  const [actId, setActId] = useState<number | null>(null);
  const [no, setNo] = useState("");

  useEffect(() => {
    void (async () => {
      const supabase = createClient();
      const [c, a] = await Promise.all([
        supabase.from("activity_categories").select("id, name").order("sort_order"),
        supabase.from("club_activities").select("id, category_id, name").order("sort_order"),
      ]);
      setCats((c.data as Cat[]) ?? []);
      setActs((a.data as Act[]) ?? []);
    })();
  }, []);

  // 前に出した申請があれば、その番号と団体を入れておく（打ち直さなくて済む）
  useEffect(() => {
    if (me.leader_no) setNo(me.leader_no);
    if (me.leader_activity_id !== null) setActId(me.leader_activity_id);
  }, [me.leader_no, me.leader_activity_id]);

  // 団体が決まっているなら、その分類を開いておく
  useEffect(() => {
    if (actId === null || catId !== null) return;
    const a = acts.find((x) => x.id === actId);
    if (a?.category_id != null) setCatId(a.category_id);
  }, [actId, catId, acts]);

  /* 管理の権限が付いたのに、このログインで6桁を確かめていないか */
  const [needCode, setNeedCode] = useState(false);
  useEffect(() => {
    let alive = true;
    void needsCode().then((v) => {
      if (alive) setNeedCode(v);
    });
    return () => {
      alive = false;
    };
  }, [me.role, me.leader]);

  const list = catId === null ? [] : acts.filter((a) => a.category_id === catId);
  const picked = acts.find((a) => a.id === actId) ?? null;
  const trimmed = no.replace(/[\s\u3000]/g, "");

  const apply = async () => {
    setBusy(true);
    await run(async () => {
      const { data, error } = await createClient().rpc("apply_leader", {
        p_no: trimmed,
        p_activity_id: actId,
      });
      if (error)
        throw new Error(`${error.message}（base/03_roster.sql をまだ入れていない場合は、先に入れてください）`);
      return data as AgentAnswer;
    });
    await onDone();
    setBusy(false);
  };

  const clear = async () => {
    if (!window.confirm("リーダーの申請を取り消して、ふつうのログインに戻します。よろしいですか？"))
      return;
    setBusy(true);
    reset();
    try {
      const { error } = await createClient().rpc("clear_leader");
      if (error) throw error;
      setNo("");
      setActId(null);
      await onDone();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="rounded-xl bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-600">
        {T("部・サークル・プロジェクトの長をしている人だけが使える欄です。")}
        <br />
        {T("8桁の番号と団体を、kit-agent がリーダーの名簿と照らします。")}
        <br />
        {T("通ると、自分の団体の予定を入れられるようになります。")}
      </p>

      <Status
        ok={me.leader}
        applied={me.leader_applied}
        okText={
          picked && me.leader
            ? `${picked.name}${T("のリーダーとして通っています")}`
            : T("リーダーとして通っています")
        }
        reason={me.leader_reason}
      />

      {/*
        リーダーとして通ると、管理の権限（admin_l1）が付く。管理の操作は、
        このログインで認証アプリの6桁を確かめてからでないと使えない（36）。
        学生は覚えた端末なら6桁を省いているので、通った直後はここで知らせる。
      */}
      {me.leader && needCode && (
        <div className="mt-2 rounded-xl bg-amber-50 p-3 text-[11px] leading-relaxed text-amber-900 ring-1 ring-amber-200">
          {T("リーダーの操作（予定を入れる・ニュースを出す）は、認証アプリの6桁を確かめてから使えます。")}
          <br />
          <a href="/login" className="mt-1.5 inline-block font-bold text-blue-700 underline">
            {T("6桁を入れる")}
          </a>
        </div>
      )}

      {!me.verified ? (
        <NeedVerify what={T("リーダー")} />
      ) : me.role === "pending" ? (
        <div className="mt-3 rounded-xl bg-amber-50 p-3 text-[11px] leading-relaxed text-amber-900">
          {T("まだ利用の承認を待っています。承認されたら、ここから申請できます。")}
        </div>
      ) : (
        <>
          <div className="mt-3 rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
            <label className="block text-[10px] font-bold text-slate-500">
              {T("8桁の番号")}
            </label>
            <input
              value={no}
              onChange={(e) => setNo(e.target.value)}
              autoComplete="off"
              inputMode="text"
              maxLength={16}
              placeholder={T("学生証の番号（例：c1234567）")}
              className="mt-1 w-full rounded-lg bg-slate-50 px-3 py-2 font-mono text-sm outline-none ring-1 ring-slate-200 focus:ring-2 focus:ring-blue-500"
            />
            <p className="mt-1 text-[10px] text-slate-400">
              {trimmed === ""
                ? T("学生証・職員証に書いてある番号を、そのまま入れてください。")
                : trimmed.length === 8
                  ? T("8桁になっています。")
                  : T("いま {n}桁です。8桁で入れてください。").replace("{n}", String(trimmed.length))}
            </p>

            <label className="mt-3 block text-[10px] font-bold text-slate-500">
              {T("何系の活動ですか")}
            </label>
            <select
              value={catId ?? ""}
              onChange={(e) => {
                setCatId(e.target.value ? Number(e.target.value) : null);
                setActId(null);
              }}
              className="mt-1 w-full rounded-lg bg-slate-50 px-3 py-2 text-xs outline-none ring-1 ring-slate-200 focus:ring-2 focus:ring-blue-500"
            >
              <option value="">{T("選んでください")}</option>
              {cats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>

            <label className="mt-2 block text-[10px] font-bold text-slate-500">
              {T("どこのリーダーですか")}
            </label>
            <select
              value={actId ?? ""}
              onChange={(e) => setActId(e.target.value ? Number(e.target.value) : null)}
              disabled={catId === null}
              className="mt-1 w-full rounded-lg bg-slate-50 px-3 py-2 text-xs outline-none ring-1 ring-slate-200 focus:ring-2 focus:ring-blue-500 disabled:text-slate-400"
            >
              <option value="">
                {catId === null ? T("先に系統を選んでください") : T("選んでください")}
              </option>
              {list.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>

          <AgentView phase={phase} answer={answer} shown={shown} />

          <button
            onClick={() => void apply()}
            disabled={busy || trimmed === "" || actId === null}
            className="mt-3 w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold text-white transition hover:bg-blue-700 disabled:bg-slate-300"
          >
            {busy
              ? T("kit-agent が確認しています…")
              : me.leader
                ? T("もう一度たしかめる")
                : T("リーダーとして申請する")}
          </button>

          {me.leader_applied && (
            <button
              onClick={() => void clear()}
              disabled={busy}
              className="mt-1.5 w-full rounded-xl px-4 py-2 text-xs font-bold text-slate-500 transition hover:bg-slate-100"
            >
              {T("リーダーの申請を取り消す")}
            </button>
          )}
        </>
      )}

      <p className="mt-3 text-[10px] leading-relaxed text-slate-400">
        {T("リーダーの名簿に載っていないと、申請は通りません。")}
        {T("長をしているのに通らないときは、管理者にお知らせください。")}
        <br />
        {T("人の番号を入れても通りません。番号がご本人のものかを先に見ています。")}
      </p>
    </div>
  );
}

/** いまの様子の帯。教職とリーダーで同じ形にする */
function Status({
  ok,
  applied,
  okText,
  reason = "",
}: {
  ok: boolean;
  applied: boolean;
  okText: string;
  /** 通らなかった・外れた訳。開き直しても、何を直せばよいかが分かるように */
  reason?: string;
}) {
  const T = useT();
  return (
    <div className="mt-3 rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
      <div className="text-[10px] font-bold text-slate-500">{T("いまの様子")}</div>
      <div className="mt-1 flex items-center gap-2">
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-bold ${
            ok
              ? "bg-emerald-100 text-emerald-900"
              : applied
                ? "bg-amber-100 text-amber-900"
                : "bg-slate-100 text-slate-600"
          }`}
        >
          {ok ? okText : applied ? T("申請しましたが、通っていません") : T("まだ申請していません")}
        </span>
      </div>
      {!ok && applied && reason !== "" && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-amber-900">
          {T("訳")}：{T(reason)}
        </p>
      )}
    </div>
  );
}

/** 本人確認がまだのとき */
function NeedVerify({ what }: { what: string }) {
  const T = useT();
  return (
    <div className="mt-3 rounded-xl bg-amber-50 p-3 text-[11px] leading-relaxed text-amber-900">
      <b>{T("先に本人確認をしてください")}</b>
      <br />
      {T("認証アプリの登録が済んでいないと、{x}の申請はできません。").replace("{x}", what)}
      <br />
      <a href="/login" className="mt-2 inline-block font-bold text-blue-700 underline">
        {T("ログインの画面へ")}
      </a>
    </div>
  );
}

/* ================= 教授の、自分の授業 ================= */

/**
 * その日、自分が担当する授業。
 *
 * ■ なぜ要るか
 *   時間割は「学科と学年で絞って見る」形になっている。
 *   教授にとっては、自分の授業が別々の学科・学年に散らばっているので、
 *   何度も選び直さないと自分の一日が見えなかった。
 *
 * ■ どうやって自分のものと見分けるか
 *   予定には担当者の名前が文字で入っている（timetable.teacher）。
 *   科目のほうにも担当者がある（courses.teacher）。
 *   どちらかが自分の名前と合えば、自分の授業とみなす。
 *
 *   名前で見分けるのは弱い。同姓同名がいれば混ざるし、
 *   表記がゆれれば出てこない。ただ、いま持っているのは名前だけで、
 *   予定と席を結ぶ列が無い。空白のゆれだけは吸収しておく。
 */
function MyClasses({ date }: { date: Date }) {
  const T = useT();
  const [rows, setRows] = useState<ClassRow[] | null>(null);
  const [name, setName] = useState("");

  useEffect(() => {
    if (!supabaseReady) return;
    let alive = true;
    void (async () => {
      const supabase = createClient();
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) {
        if (alive) setRows([]);
        return;
      }
      const { data: p } = await supabase
        .from("profiles")
        .select("full_name")
        .eq("id", u.user.id)
        .single();
      const me = String((p as { full_name?: string } | null)?.full_name ?? "").trim();
      if (alive) setName(me);
      if (me === "") {
        if (alive) setRows([]);
        return;
      }

      const cols =
        "id, starts_at, ends_at, teacher, changed, change_note," +
        " rooms(building_code, code, name), courses(name, class_name, teacher)";

      /*
       * 二回に分けて訊く。
       *
       * 予定の担当（timetable.teacher）と、科目の担当（courses.teacher）は
       * 別の表にある。片方だけで訊くと、もう片方にしか名前が入っていない
       * 授業が落ちる。二つ取ってきて、同じ番号のものを一つにまとめる。
       */
      const [a, b] = await Promise.all([
        supabase
          .from("timetable")
          .select(cols)
          .eq("on_date", ymd(date))
          .eq("kind", "class")
          .ilike("teacher", `%${me}%`),
        supabase
          .from("timetable")
          .select(cols.replace("courses(", "courses!inner("))
          .eq("on_date", ymd(date))
          .eq("kind", "class")
          .ilike("courses.teacher", `%${me}%`),
      ]);

      const byId = new Map<number, ClassRow>();
      for (const r of [
        ...(((a.data as unknown as ClassRow[] | null) ?? []) as ClassRow[]),
        ...(((b.data as unknown as ClassRow[] | null) ?? []) as ClassRow[]),
      ]) {
        byId.set(r.id, r);
      }
      const got = [...byId.values()].sort((x, y) => x.starts_at.localeCompare(y.starts_at));
      if (alive) setRows(got);
    })();
    return () => {
      alive = false;
    };
  }, [date]);

  // 名前が入っていない人には、そもそも出さない
  if (rows === null || name === "") return null;

  return (
    <section className="mb-3 rounded-xl bg-blue-50/60 p-2.5 ring-1 ring-blue-200">
      <div className="text-[11px] font-bold text-blue-900">{T("自分の授業")}</div>
      {rows.length === 0 ? (
        <p className="mt-1 text-[10px] leading-relaxed text-blue-800">
          {T("この日に、あなたが担当する授業は入っていません。")}
        </p>
      ) : (
        <ul className="mt-1.5 flex flex-col gap-1">
          {rows.map((r) => (
            <li key={r.id} className="rounded-lg bg-white px-2.5 py-1.5">
              <div className="flex items-baseline gap-1.5">
                <span className="shrink-0 font-mono text-[10px] text-slate-500">
                  {hhmm(r.starts_at)}
                </span>
                <span className="truncate text-xs font-bold text-slate-800">
                  {r.courses?.name || T("（科目名なし）")}
                </span>
                {r.changed && (
                  <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold text-amber-900">
                    {r.change_note || T("変更あり")}
                  </span>
                )}
              </div>
              <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-slate-500">
                <span>
                  {r.rooms
                    ? `${r.rooms.building_code}${T("号館")} ${r.rooms.code} ${r.rooms.name}`.trim()
                    : T("教室未定")}
                </span>
                {r.courses?.class_name && <span>{r.courses.class_name}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 text-[9px] leading-relaxed text-blue-700">
        {T("担当者の名前で照らしています。出てこないときは、予定の担当の書き方をお確かめください。")}
      </p>
    </section>
  );
}

/* ================= 課外活動を探す ================= */

/** 課外活動のお気に入り。この端末にだけ覚える */
const CLUB_FAV_KEY = "kitmap.clubFavs";

/**
 * お気に入りを読む。
 *
 * 端末に覚えるだけにしてある。データベースに持たせると、
 * どの団体を気にしているかが人に見えてしまう。
 * 見せる相手のいない覚えなので、手元で足りる。
 */
function loadClubFavs(): number[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(CLUB_FAV_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : [];
  } catch {
    return [];
  }
}

type ClubHit = {
  id: number;
  starts_at: string;
  ends_at: string;
  title: string;
  on_date: string;
  rooms: { building_code: string; code: string; name: string } | null;
  club_activities: { name: string } | null;
};

/**
 * 課外活動を名前で探して、どこでやっているかを見る。
 *
 * ■ 時間割の中の一覧とは、入り方が違う
 *   あちらは「その日・その時間に何があるか」を見るためのもの。
 *   ここは「あの部活はどこ？」から入る。分類をたどらずに、
 *   名前を打てば辿りつける。
 *
 * ■ 探し方は道案内と同じ
 *   当たり方は lib/appdata の rankOf を使う。全角・記号・
 *   大文字小文字のゆれを同じように吸収するので、
 *   地図で慣れた手ごたえのまま使える。
 *
 * ■ その日に無ければ、先の予定を探す
 *   活動は毎日あるとはかぎらない。選んだ日に無いからといって
 *   「やっていない」ではないので、そこから先を見にいく。
 */
function Clubs({ date }: { date: Date }) {
  const T = useT();
  const dateText = useDateText();

  const [acts, setActs] = useState<Act[]>([]);
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<Act | null>(null);
  const [rows, setRows] = useState<ClubHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  /** お気に入りにした団体の番号 */
  const [favs, setFavs] = useState<number[]>([]);

  useEffect(() => {
    setFavs(loadClubFavs());
  }, []);

  const toggleFav = useCallback((id: number) => {
    setFavs((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      try {
        localStorage.setItem(CLUB_FAV_KEY, JSON.stringify(next));
      } catch {
        /* 覚えられなくても、その場では使える */
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!supabaseReady) return;
    void createClient()
      .from("club_activities")
      .select("id, category_id, name")
      .order("sort_order")
      .then(({ data }) => setActs((data as Act[]) ?? []));
  }, []);

  /** 打った言葉に当たる団体 */
  const hits = useMemo(() => {
    const word = q.trim();
    if (word === "") return [];
    return acts
      .map((a) => ({ a, r: rankOf(a.name, word) }))
      .filter((x) => x.r >= 0)
      .sort((x, y) => x.r - y.r || x.a.name.localeCompare(y.a.name, "ja"))
      .slice(0, 10);
  }, [acts, q]);

  /**
   * お気に入りにした団体。あいうえお順。
   *
   * 押した順に並べると、あとから足したものが下に付いて、
   * 探す目が毎回そこへ行かない。名前の順なら、いつも同じ場所にある。
   */
  const favActs = useMemo(
    () =>
      acts
        .filter((a) => favs.includes(a.id))
        .sort((a, b) => a.name.localeCompare(b.name, "ja")),
    [acts, favs],
  );

  useEffect(() => {
    if (!pick || !supabaseReady) {
      setRows(null);
      return;
    }
    let alive = true;
    setBusy(true);
    void (async () => {
      /*
       * 選んだ日から、ひと月ぶん先までを見る。
       * その日に無いからといって「やっていない」ではないので、
       * 次にいつ・どこであるのかまで出す。
       */
      const from = ymd(date);
      const end = new Date(date);
      end.setDate(end.getDate() + 31);
      const { data } = await createClient()
        .from("timetable")
        .select(
          "id, on_date, starts_at, ends_at, title, rooms(building_code, code, name), club_activities(name)",
        )
        .eq("kind", "club")
        .eq("activity_id", pick.id)
        .gte("on_date", from)
        .lte("on_date", ymd(end))
        .order("on_date")
        .order("starts_at")
        .limit(60);
      if (alive) {
        setRows((data as unknown as ClubHit[]) ?? []);
        setBusy(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [pick, date]);

  return (
    <div>
      <p className="mb-2 rounded-xl bg-slate-50 p-2.5 text-[11px] leading-relaxed text-slate-600">
        {T("課外活動の名前で探すと、いつ・どこでやっているかが出ます。")}
      </p>

      {/*
        お気に入り。探す前から、いちばん上に出しておく。

        いつも同じ団体を見る人のほうが多い。毎回名前を打たせるのは、
        分かっている答えを打たせているのと同じ。
        並びはあいうえお順。押した順だと、あとから足したものが下に付いて、
        探す目が毎回そこへ行かない。
      */}
      {favActs.length > 0 && !pick && (
        <div className="mb-2">
          <div className="text-[10px] font-bold text-amber-700">{T("★ お気に入り")}</div>
          <ul className="mt-1 flex flex-col gap-1">
            {favActs.map((a) => (
              <li key={a.id} className="flex items-center gap-1">
                <button
                  onClick={() => setPick(a)}
                  className="min-w-0 flex-1 rounded-xl bg-amber-50 px-3 py-2.5 text-left text-xs font-bold text-amber-900 transition hover:bg-amber-100 active:scale-95"
                >
                  <span className="block truncate">{a.name}</span>
                </button>
                <button
                  onClick={() => toggleFav(a.id)}
                  aria-label={T("お気に入りから外す")}
                  className="shrink-0 rounded-lg px-2 py-2 text-sm text-amber-500 transition hover:bg-amber-50 active:scale-90"
                >
                  ★
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="relative">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoComplete="off"
          placeholder={T("吹奏楽、ロボット、テニス…")}
          className="w-full rounded-xl bg-slate-100 px-4 py-3 text-sm outline-none transition focus:bg-white focus:ring-2 focus:ring-blue-500"
        />
        {hits.length > 0 && (
          <ul className="absolute left-0 right-0 top-full z-10 mt-1 max-h-64 overflow-y-auto rounded-xl bg-white py-1 shadow-lg ring-1 ring-slate-200">
            {hits.map((h) => (
              <li key={h.a.id} className="flex items-center">
                <button
                  onClick={() => {
                    setPick(h.a);
                    setQ("");
                  }}
                  className="min-w-0 flex-1 truncate px-4 py-2.5 text-left text-sm text-slate-800 transition hover:bg-slate-50"
                >
                  {h.a.name}
                </button>
                {/* 探している最中でも、その場で印を付けられる */}
                <button
                  onClick={() => toggleFav(h.a.id)}
                  aria-label={
                    favs.includes(h.a.id) ? T("お気に入りから外す") : T("お気に入りに入れる")
                  }
                  className={`shrink-0 px-3 py-2.5 text-sm transition active:scale-90 ${
                    favs.includes(h.a.id) ? "text-amber-500" : "text-slate-300 hover:text-amber-400"
                  }`}
                >
                  ★
                </button>
              </li>
            ))}
          </ul>
        )}
        {q.trim() !== "" && hits.length === 0 && (
          <p className="absolute left-0 right-0 top-full z-10 mt-1 rounded-xl bg-white px-4 py-2.5 text-xs text-slate-500 shadow-lg ring-1 ring-slate-200">
            {T("その名前の課外活動は見つかりませんでした。")}
          </p>
        )}
      </div>

      {pick && (
        <div className="mt-3">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 truncate text-sm font-bold text-slate-900">{pick.name}</span>

            {/* 予定。いま出しているものが、まさにそれ */}
            <span className="shrink-0 rounded-full bg-blue-100 px-2.5 py-1 text-[10px] font-bold text-blue-800">
              {T("予定")}
              {rows !== null ? `　${rows.length}` : ""}
            </span>

            {/* お気に入り。ここからも入れられる */}
            <button
              onClick={() => toggleFav(pick.id)}
              aria-label={
                favs.includes(pick.id) ? T("お気に入りから外す") : T("お気に入りに入れる")
              }
              className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold transition active:scale-95 ${
                favs.includes(pick.id)
                  ? "bg-amber-500 text-white"
                  : "bg-slate-100 text-slate-500 hover:bg-amber-100"
              }`}
            >
              ★ {favs.includes(pick.id) ? T("お気に入り") : T("入れる")}
            </button>

            <button
              onClick={() => setPick(null)}
              className="ml-auto shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-bold text-slate-600 transition hover:bg-slate-200 active:scale-95"
            >
              {T("やめる")}
            </button>
          </div>

          {busy && <Note>{T("読み込み中…")}</Note>}

          {!busy && rows !== null && rows.length === 0 && (
            <Note>{T("この先ひと月に、この団体の予定は入っていません。")}</Note>
          )}

          {!busy && rows !== null && rows.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1.5">
              {rows.map((r) => (
                <li key={r.id} className="rounded-xl bg-slate-50 px-3 py-2">
                  <div className="text-[11px] font-bold text-slate-800">
                    {dateText(new Date(`${r.on_date}T00:00:00`))}
                    <span className="ml-2 font-mono font-normal text-slate-500">
                      {hhmm(r.starts_at)}
                      {r.ends_at ? `–${hhmm(r.ends_at)}` : ""}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs font-bold text-blue-800">
                    {r.rooms
                      ? `${r.rooms.building_code}${T("号館")} ${r.rooms.code} ${r.rooms.name}`.trim()
                      : T("教室未定")}
                  </div>
                  {r.title && <div className="text-[10px] text-slate-500">{r.title}</div>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/* ================= 空き教室 ================= */

type FreeRow = {
  room_id: number;
  building_code: string;
  room_code: string;
  room_name: string;
  floor: number;
  period_id: number;
  period_label: string;
};

function FreeRooms({ date, periods }: { date: Date; periods: Period[] }) {
  const T = useT();

  const [building, setBuilding] = useState("");
  const [periodId, setPeriodId] = useState<number | null>(null);
  const [all, setAll] = useState<FreeRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  /**
   * 空いている教室を読む。
   *
   * ★見ている時限のぶんだけを読む。
   *
   *   前はその日ぜんぶ（教室×5時限）を読んで、画面で絞っていた。
   *   教室が400室あると2000行を超え、Supabase が一度に返せる
   *   1000行で切られていた。後ろの号館は、空いていても
   *   いつまでも出てこない状態だった。
   *
   *   同時に何人も開いたときの重さも、ここが効く。
   *   見るのは一つの時限なのだから、その一つだけを訊く。
   */
  const load = useCallback(async () => {
    if (periodId === null) return;
    setLoading(true);
    const { data, error } = await createClient().rpc("free_rooms", {
      d: ymd(date),
      p_period_id: periodId,
    });
    if (error) {
      /*
       * 引数を増やす前の版がまだ入っていることがある。
       * そのときは前の形（日だけ）で訊き直す。
       * 入れ直すまでのあいだ、使えなくなるのを避ける。
       */
      const again = await createClient().rpc("free_rooms", { d: ymd(date) });
      setAll((again.data as FreeRow[]) ?? []);
    } else {
      setAll((data as FreeRow[]) ?? []);
    }
    setLoading(false);
  }, [date, periodId]);

  /*
   * 日か時限が変わったら取り直す。
   *
   * 押したときに読むのではなく、変わったのを見て読む。
   * 押したときだと、その場ではまだ前の時限のままなので、
   * 一つ前の時限のぶんを読んでしまう。
   */
  useEffect(() => {
    setAll(null);
    if (periodId === null) return;
    void load();
  }, [date, periodId, load]);

  const hits = useMemo(() => {
    if (!all || periodId === null) return null;
    const b = building.trim().replace(/号館$/, "");
    return all.filter(
      (r) => r.period_id === periodId && (b === "" || r.building_code === b),
    );
  }, [all, periodId, building]);

  return (
    <div>
      <p className="mb-1.5 text-[11px] font-bold text-slate-500">{T("何号館を調べますか")}</p>
      <div className="flex items-center gap-1.5">
        <input
          value={building}
          onChange={(e) => setBuilding(e.target.value)}
          inputMode="numeric"
          placeholder="23"
          className="w-20 rounded-xl bg-slate-100 px-3 py-2 text-sm font-bold outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
        />
        <span className="text-xs font-bold text-slate-500">{T("号館")}</span>
        <span className="ml-auto text-[10px] text-slate-400">{T("空欄なら全体")}</span>
      </div>

      <p className="mb-1.5 mt-3 text-[11px] font-bold text-slate-500">{T("時限")}</p>
      <div className="grid grid-cols-3 gap-1.5">
        {periods.map((p) => (
          <button
            key={p.id}
            onClick={() => setPeriodId(p.id)}
            className={`rounded-xl py-2 text-xs font-bold transition active:scale-95 ${
              periodId === p.id ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="mt-3">
        {periodId === null ? (
          <Note>{T("時限を選んでください。")}</Note>
        ) : loading || hits === null ? (
          <Note>{T("読み込み中…")}</Note>
        ) : hits.length === 0 ? (
          <Note>{T("空いている教室はありません。")}</Note>
        ) : (
          <>
            <p className="mb-1.5 text-[11px] font-bold text-slate-500">
              {T("{n} 室が空いています").replace("{n}", String(hits.length))}
            </p>
            <ul className="flex flex-col gap-1">
              {hits.map((r) => (
                <li
                  key={r.room_id}
                  className="flex items-baseline justify-between gap-2 rounded-lg bg-emerald-50 px-3 py-2"
                >
                  {/* 番号がそれだけで号館まで表すので、重ねて書かない */}
                  <span className="text-xs font-bold text-emerald-900">{r.room_code}</span>
                  <span className="min-w-0 truncate text-[10px] text-emerald-700">
                    {r.room_name}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

/* ================= 共通 ================= */

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-500">
      {children}
    </p>
  );
}

function Big({
  onClick,
  icon,
  label,
  sub,
}: {
  onClick: () => void;
  icon: string;
  label: string;
  sub: string;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-3 rounded-xl bg-slate-100 px-3 py-3 text-left transition hover:bg-slate-200 active:scale-95"
    >
      <span className="text-lg">{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-bold text-slate-800">{label}</span>
        <span className="block text-[10px] text-slate-500">{sub}</span>
      </span>
    </button>
  );
}
