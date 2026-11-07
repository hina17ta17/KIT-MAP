"use client";

/**
 * 予定の確認。
 *
 * 「入れたはずの授業が、どの日のどの時限に入ったのか」を確かめる欄。
 *
 * ■ なぜ登録の画面とは別に置くか
 *   登録の画面は「これから入れるもの」を組み立てる場所で、
 *   すでに入っているものは、その日の一覧としてしか出ない。
 *   何週もまとめて入れたあとに「本当に15回ぶん入ったか」を
 *   見ようとすると、日を一つずつ選び直すことになっていた。
 *
 *   ここはカレンダーから入る。日を押せば、その日の1限から5限までが
 *   縦に並ぶ。予定の入っている日はカレンダーに印が付くので、
 *   どの日に入っているかが、押す前に分かる。
 *
 * ■ 誰が見られるか
 *   予定を入れられる人と同じ（課外活動リーダー・教授・2.1・2.2・管理者）。
 *   学生は地図の「学内の情報」から時間割を見る。
 *
 *   守っているのは timetable の読みの決まり（段1以上）で、
 *   ここは画面を出し分けるためのもの。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient, supabaseReady } from "@/lib/supabase/client";
import { AdminHeader, AdminMenu } from "@/components/AdminNav";
import { useAdminT } from "@/lib/adminLang";
import { canViewPlans, type Role } from "@/lib/auth";
import { dayColor, holidayName } from "@/lib/holidays";
import { soon } from "@/lib/soon";

type Period = { id: number; label: string; starts_at: string; ends_at: string };

/** その日に入っている予定の一つ */
type Plan = {
  id: number;
  room_id: number;
  kind: string;
  title: string;
  teacher: string;
  starts_at: string;
  ends_at: string;
  rooms: { building_code: string; code: string; name: string } | null;
  courses: { name: string; class_name: string } | null;
  club_activities: { name: string } | null;
};

const KIND_LABEL: Record<string, string> = {
  class: "授業",
  event: "イベント",
  activity: "課外活動",
};

const KIND_CLS: Record<string, string> = {
  class: "bg-blue-100 text-blue-900",
  event: "bg-emerald-100 text-emerald-900",
  activity: "bg-amber-100 text-amber-900",
};

/* ---------------- 日付まわり ---------------- */

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
const todayYmd = () => {
  const d = new Date();
  return ymd(d.getFullYear(), d.getMonth(), d.getDate());
};
const niceDate = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  const w = ["日", "月", "火", "水", "木", "金", "土"][new Date(y, m - 1, d).getDay()];
  return `${m}月${d}日（${w}）`;
};
const hhmm = (t: string) => t.slice(0, 5);

export default function PlanPage() {
  const T = useAdminT();
  const [role, setRole] = useState<Role | null>(null);
  const [loading, setLoading] = useState(true);
  const [periods, setPeriods] = useState<Period[]>([]);

  /** 出している月 */
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() };
  });
  /** 押した日。ここの予定を下に出す */
  const [day, setDay] = useState(todayYmd());
  const [plans, setPlans] = useState<Plan[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  /**
   * その月の、予定が入っている日。
   *
   * カレンダーに印を付けるためだけに使う。件数まで出すと
   * 月を送るたびに重くなるので、日付だけを数えて持つ。
   */
  const [marks, setMarks] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    if (!supabaseReady) return soon(() => setLoading(false));
    void (async () => {
      const supabase = createClient();
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) {
        setLoading(false);
        return;
      }
      const { data: me } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", u.user.id)
        .single();
      setRole((me?.role as Role) ?? null);

      const { data: p } = await supabase
        .from("periods")
        .select("id, label, starts_at, ends_at")
        .order("id");
      setPeriods((p as Period[]) ?? []);
      setLoading(false);
    })();
  }, []);

  /** その月に予定が入っている日を数える */
  const loadMarks = useCallback(async (y: number, m: number) => {
    if (!supabaseReady) return;
    const from = ymd(y, m, 1);
    const to = ymd(y, m + 1, 0).replace(`-${pad(m + 2)}-00`, "");
    const last = new Date(y, m + 1, 0).getDate();
    try {
      const { data, error } = await createClient()
        .from("timetable")
        .select("on_date")
        .gte("on_date", from)
        .lte("on_date", ymd(y, m, last))
        .limit(5000);
      if (error) throw error;
      const m2 = new Map<string, number>();
      for (const r of (data as { on_date: string }[]) ?? [])
        m2.set(r.on_date, (m2.get(r.on_date) ?? 0) + 1);
      setMarks(m2);
    } catch {
      // 印が出ないだけ。日を押せば中身は読めるので、ここでは黙る
      setMarks(new Map());
      void to;
    }
  }, []);

  useEffect(() => soon(() => loadMarks(cursor.y, cursor.m)), [cursor, loadMarks]);

  /** 押した日の予定を読む */
  const loadDay = useCallback(async (d: string) => {
    if (!supabaseReady) return;
    setBusy(true);
    setMsg(null);
    try {
      const { data, error } = await createClient()
        .from("timetable")
        .select(
          "id, room_id, kind, title, teacher, starts_at, ends_at, rooms(building_code, code, name), courses(name, class_name), club_activities(name)",
        )
        .eq("on_date", d)
        .order("starts_at")
        .limit(2000);
      if (error) throw error;
      setPlans((data as unknown as Plan[]) ?? []);
    } catch (e) {
      setPlans([]);
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => soon(() => loadDay(day)), [day, loadDay]);

  /** その月の升目。頭の空きぶんだけ null を置く */
  const cells = useMemo(() => {
    const first = new Date(cursor.y, cursor.m, 1);
    const days = new Date(cursor.y, cursor.m + 1, 0).getDate();
    const out: (string | null)[] = Array(first.getDay()).fill(null);
    for (let d = 1; d <= days; d++) out.push(ymd(cursor.y, cursor.m, d));
    return out;
  }, [cursor]);

  /**
   * 時限ごとに分ける。
   *
   * 時限そのものは持っていない（持っているのは時刻）ので、
   * 時限の時間帯と重なるかで振り分ける。
   * どの時限にも当てはまらないもの（昼休みの催しなど）は
   * 「その他の時間」にまとめる。
   */
  const byPeriod = useMemo(() => {
    const m = new Map<number | "other", Plan[]>();
    for (const pl of plans) {
      const hit = periods.find(
        (p) => pl.starts_at < p.ends_at && p.starts_at < pl.ends_at,
      );
      const key: number | "other" = hit ? hit.id : "other";
      const cur = m.get(key) ?? [];
      cur.push(pl);
      m.set(key, cur);
    }
    return m;
  }, [plans, periods]);

  const move = (by: number) => {
    const d = new Date(cursor.y, cursor.m + by, 1);
    setCursor({ y: d.getFullYear(), m: d.getMonth() });
  };

  const where = (pl: Plan) =>
    pl.rooms ? `${pl.rooms.building_code}号館 ${pl.rooms.code}` : T("教室未定");

  const nameOf = (pl: Plan) =>
    pl.kind === "class"
      ? (pl.courses?.name ?? pl.title ?? "")
      : pl.kind === "activity"
        ? (pl.club_activities?.name ?? pl.title ?? "")
        : (pl.title ?? "");

  if (loading) return <Shell>{T("読み込み中…")}</Shell>;

  if (!canViewPlans(role))
    return (
      <Shell>
        <p className="text-sm text-slate-700">{T("この画面は、いまの権限では使えません。")}</p>
        <Link href="/login" className="mt-3 inline-block text-sm font-bold text-blue-600">
          {T("ログインへ")}
        </Link>
      </Shell>
    );

  return (
    <Shell wide>
      <AdminHeader title={T("予定の確認")} />
      <AdminMenu current="plan" role={role} />

      <p className="mt-3 rounded-xl bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-600">
        {T("日にちを押すと、その日の1限から5限までの予定が出ます。")}
        <br />
        {T("予定が入っている日には、カレンダーに点が付いています。")}
      </p>

      {/* 月を送る */}
      <div className="mt-3 flex items-center justify-between">
        <button
          onClick={() => move(-1)}
          aria-label={T("前の月")}
          className="h-9 w-9 rounded-lg bg-slate-100 text-sm font-bold text-slate-600 transition hover:bg-slate-200 active:scale-90"
        >
          ‹
        </button>
        <div className="text-sm font-bold text-slate-900">
          {cursor.y}年 {cursor.m + 1}月
        </div>
        <button
          onClick={() => move(1)}
          aria-label={T("次の月")}
          className="h-9 w-9 rounded-lg bg-slate-100 text-sm font-bold text-slate-600 transition hover:bg-slate-200 active:scale-90"
        >
          ›
        </button>
      </div>

      <div className="mt-2 grid grid-cols-7 gap-1 text-center text-[10px] font-bold">
        {["日", "月", "火", "水", "木", "金", "土"].map((w, i) => (
          <div
            key={w}
            className={i === 0 ? "text-red-400" : i === 6 ? "text-blue-400" : "text-slate-400"}
          >
            {T(w)}
          </div>
        ))}
      </div>

      <div className="mt-1 grid grid-cols-7 gap-1">
        {cells.map((d, i) => {
          if (!d) return <div key={`x${i}`} />;
          const on = d === day;
          const n = marks.get(d) ?? 0;
          const isToday = d === todayYmd();
          /* 日曜と祝日は赤、土曜は青（lib/holidays.ts） */
          const tone = dayColor(d);
          const hol = holidayName(d);
          return (
            <button
              key={d}
              onClick={() => setDay(d)}
              title={hol ?? undefined}
              className={`relative flex h-11 flex-col items-center justify-center rounded-lg text-xs font-bold transition active:scale-95 ${
                on
                  ? "bg-slate-900 text-white"
                  : isToday
                    ? "bg-blue-50 text-blue-900 ring-1 ring-blue-200"
                    : tone === "holiday"
                      ? "bg-slate-50 text-red-500 hover:bg-slate-100"
                      : tone === "sat"
                        ? "bg-slate-50 text-blue-600 hover:bg-slate-100"
                        : "bg-slate-50 text-slate-700 hover:bg-slate-100"
              }`}
            >
              {Number(d.slice(8))}
              {n > 0 && (
                <span
                  className={`mt-0.5 h-1 w-1 rounded-full ${on ? "bg-white" : "bg-blue-500"}`}
                />
              )}
            </button>
          );
        })}
      </div>

      {/* 押した日の中身 */}
      <div className="mt-4">
        <div className="flex items-baseline justify-between">
          <h2
            className={`text-sm font-bold ${
              dayColor(day) === "holiday" ? "text-red-600" : "text-slate-900"
            }`}
          >
            {niceDate(day)}
            {holidayName(day) && (
              <span className="ml-1.5 rounded bg-red-100 px-1.5 py-0.5 text-[10px] text-red-700">
                {holidayName(day)}
              </span>
            )}
          </h2>
          <span className="text-[11px] font-bold text-slate-500">
            {busy ? T("読み込み中…") : `${plans.length} ${T("件")}`}
          </span>
        </div>

        {msg && (
          <p className="mt-2 rounded-xl bg-red-50 p-3 text-xs leading-relaxed text-red-800">{msg}</p>
        )}

        <div className="mt-2 grid gap-2">
          {periods.map((p) => {
            const list = byPeriod.get(p.id) ?? [];
            return (
              <div key={p.id} className="rounded-xl bg-slate-50 p-2.5">
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-bold text-slate-900">{p.label}</span>
                  <span className="text-[10px] text-slate-400">
                    {hhmm(p.starts_at)}〜{hhmm(p.ends_at)}
                  </span>
                  <span className="ml-auto text-[10px] font-bold text-slate-500">
                    {list.length} {T("件")}
                  </span>
                </div>

                {list.length === 0 ? (
                  <p className="mt-1 text-[11px] text-slate-400">{T("予定はありません")}</p>
                ) : (
                  <ul className="mt-1.5 grid gap-1">
                    {list.map((pl) => (
                      <li
                        key={pl.id}
                        className="flex items-start gap-2 rounded-lg bg-white px-2.5 py-2 shadow-sm"
                      >
                        <span
                          className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold ${
                            KIND_CLS[pl.kind] ?? "bg-slate-100 text-slate-700"
                          }`}
                        >
                          {T(KIND_LABEL[pl.kind] ?? pl.kind)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-bold text-slate-800">
                            {nameOf(pl) || T("（名称なし）")}
                          </div>
                          <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-slate-500">
                            <span>{where(pl)}</span>
                            {pl.courses?.class_name && <span>{pl.courses.class_name}</span>}
                            {pl.teacher && <span>{pl.teacher}</span>}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}

          {/* どの時限にも当てはまらないもの */}
          {(byPeriod.get("other") ?? []).length > 0 && (
            <div className="rounded-xl bg-slate-50 p-2.5">
              <div className="text-xs font-bold text-slate-900">{T("その他の時間")}</div>
              <ul className="mt-1.5 grid gap-1">
                {(byPeriod.get("other") ?? []).map((pl) => (
                  <li
                    key={pl.id}
                    className="flex items-start gap-2 rounded-lg bg-white px-2.5 py-2 shadow-sm"
                  >
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold ${
                        KIND_CLS[pl.kind] ?? "bg-slate-100 text-slate-700"
                      }`}
                    >
                      {T(KIND_LABEL[pl.kind] ?? pl.kind)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-bold text-slate-800">
                        {nameOf(pl) || T("（名称なし）")}
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-slate-500">
                        <span>{where(pl)}</span>
                        <span>
                          {hhmm(pl.starts_at)}〜{hhmm(pl.ends_at)}
                        </span>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      <Link
        href="/admin/schedule"
        className="mt-4 block rounded-xl bg-slate-100 px-4 py-3 text-center text-xs font-bold text-slate-700 transition hover:bg-slate-200"
      >
        {T("予定の登録へ")}
      </Link>
    </Shell>
  );
}

/**
 * 本文は地図のために overflow-hidden にしてある。
 * そのままだと管理画面が画面より高くなったときに送れないので、
 * この中で送れるようにする。
 */
function Shell({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <main className="h-[100dvh] overflow-y-auto bg-slate-100 p-4">
      <div
        className={`mx-auto w-full ${wide ? "max-w-2xl lg:max-w-5xl" : "max-w-sm sm:max-w-2xl lg:max-w-4xl"} rounded-2xl bg-white p-5 shadow-lg`}
      >
        {children}
      </div>
    </main>
  );
}
