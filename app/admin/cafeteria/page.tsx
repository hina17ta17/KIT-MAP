"use client";

/**
 * 食堂のメニューの設定（Lv0 と Lv3）。
 *
 * 日を選んでから、どの項目を設定するかを選ぶ。
 * 提供口は「活動中／活動休止」の二択、枠は品名を書く。
 *
 * 画面で出し分けてはいるが、守っているのは RLS。
 * Lv0 と Lv3 以外は書き込めない。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient, supabaseReady } from "@/lib/supabase/client";
import { AdminHeader, AdminMenu } from "@/components/AdminNav";
import { useAdminT } from "@/lib/adminLang";
import MultiDatePicker from "@/components/MultiDatePicker";
import { ROLE_LABEL, canManageAll, canManageCafeteria, type Role } from "@/lib/auth";
import { dayColor, holidayName } from "@/lib/holidays";

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

function ymd(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
function sameDay(a: Date, b: Date) {
  return ymd(a) === ymd(b);
}

type Item = {
  id: number;
  /** どの食堂の枠か。控え（テンプレ）を食堂ごとに分けるのに使う */
  cafeteria_id: number;
  kind: "counter" | "slot";
  parent_id: number | null;
  name: string;
  sort_order: number;
};

/** 提供口の状態。二択で選べるようにする */
const STATES = [
  { id: "open", label: "活動中", cls: "bg-emerald-600" },
  { id: "closed", label: "活動休止", cls: "bg-slate-600" },
] as const;

/** 確かめの文で使う改行 */
const BR = String.fromCharCode(10);

/** よく出す品の控え */
type Preset = { id: number; cafeteria_id: number; name: string; price: number | null };

export default function CafeteriaAdminPage() {
  const T = useAdminT();
  const [role, setRole] = useState<Role | null>(null);
  const [loading, setLoading] = useState(true);

  /**
   * 見ている日。
   *
   * ★カレンダーから始めない
   *   前は「まず日を選んでください」でカレンダーだけを出していた。
   *   毎日いちばん多いのは「今日のぶんを入れる」なので、
   *   そのたびに今日を押させていたことになる。
   *   予定の登録と同じで、はじめから中身の欄を出し、
   *   日は上のカレンダーで選び直す形にする。
   */
  const [date, setDate] = useState<Date | null>(() => new Date());
  /** カレンダーを開いているか。日を選び直すときだけ出す */
  const [calOpen, setCalOpen] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  /** いま設定している項目 */
  const [target, setTarget] = useState<Item | null>(null);

  const [states, setStates] = useState<Map<number, string>>(new Map());
  const [menus, setMenus] = useState<Map<number, { name: string; price: number | null }>>(new Map());

  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  /* 入力欄 */
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");

  /**
   * よく出す品の控え（テンプレ）。
   *
   * 出てくるものはだいたい決まっているのに、来るたびに
   * 品名と値段を打ち直していた。一度控えておけば、次からは押すだけ。
   */
  const [presets, setPresets] = useState<Preset[]>([]);
  /**
   * まとめて入れる日。
   *
   * 同じ品を何日も出すことがある。日を一つずつ選び直して
   * 同じものを打つのは、週に5回、月に20回になる。
   */
  const [bulkDates, setBulkDates] = useState<string[]>([]);
  /** まとめて入れる欄を開いているか */
  const [bulkOpen, setBulkOpen] = useState(false);

  useEffect(() => {
    if (!supabaseReady) {
      setLoading(false);
      return;
    }
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

      const { data } = await supabase
        .from("cafeteria_items")
        .select("id, cafeteria_id, kind, parent_id, name, sort_order")
        .order("sort_order");
      setItems((data as Item[]) ?? []);

      /*
       * よく出す品の控え。
       * 表がまだ無い版でも画面が止まらないよう、失敗しても黙って空にする。
       */
      const pr = await supabase
        .from("menu_presets")
        .select("id, cafeteria_id, name, price")
        .order("sort_order")
        .order("name");
      setPresets((pr.data as Preset[]) ?? []);
      // はじめから今日を出しているので、その日のぶんも一緒に読む
      await loadDay(new Date());
      setLoading(false);
    })();
  }, []);

  /** その日の登録済みを読む */
  const loadDay = useCallback(async (d: Date) => {
    const supabase = createClient();
    const [a, b] = await Promise.all([
      supabase.from("counter_days").select("item_id, state").eq("on_date", ymd(d)),
      supabase.from("menu_days").select("item_id, name, price").eq("on_date", ymd(d)),
    ]);
    setStates(new Map(((a.data as { item_id: number; state: string }[]) ?? []).map((r) => [r.item_id, r.state])));
    setMenus(
      new Map(
        ((b.data as { item_id: number; name: string; price: number | null }[]) ?? []).map((r) => [
          r.item_id,
          { name: r.name, price: r.price },
        ]),
      ),
    );
  }, []);

  /* 項目を選んだら、いまの中身を入力欄に写す */
  useEffect(() => {
    if (!target) return;
    const m = menus.get(target.id);
    setName(m?.name ?? "");
    setPrice(m?.price != null ? String(m.price) : "");
    setMsg(null);
  }, [target, menus]);

  const counters = useMemo(() => items.filter((i) => i.kind === "counter"), [items]);

  /* ---------------- 保存 ---------------- */

  const saveState = async (item: Item, state: string) => {
    if (!date) return;
    setBusy(true);
    setMsg(null);
    const { error } = await createClient()
      .from("counter_days")
      .upsert({ item_id: item.id, on_date: ymd(date), state }, { onConflict: "item_id,on_date" });
    setBusy(false);
    if (error) {
      setMsg({ kind: "err", text: error.message });
      return;
    }
    setStates((prev) => new Map(prev).set(item.id, state));
    setMsg({ kind: "ok", text: `${item.name} を「${STATES.find((s) => s.id === state)?.label}」にしました` });
  };

  const saveMenu = async () => {
    if (!date || !target) return;
    if (!name.trim()) {
      setMsg({ kind: "err", text: T("名称を入れてください") });
      return;
    }

    /*
     * 入れる前に一度たずねる。
     *
     * その日にもう入っているものは、黙って置き換わる。
     * 何日ぶんもまとめて入れたあとだと、どこを上書きするのか
     * 分からなくなるので、日と枠と中身をそのまま出して確かめる。
     */
    const before = menus.get(target.id);
    if (
      !window.confirm(
        [
          `${ymd(date)}（${WEEK[date.getDay()]}）の ${target.name} に入れます。`,
          "",
          `  ${name.trim()}${price.trim() ? `  ${price}円` : ""}`,
          "",
          before
            ? `いまは「${before.name}${before.price != null ? ` ${before.price}円` : ""}」が入っています。置き換わります。`
            : "この枠は、まだ何も入っていません。",
          "",
          "よろしいですか？",
        ].join(BR),
      )
    )
      return;

    setBusy(true);
    setMsg(null);
    const { error } = await createClient().from("menu_days").upsert(
      {
        item_id: target.id,
        on_date: ymd(date),
        name: name.trim(),
        price: price.trim() ? Number(price) : null,
      },
      { onConflict: "item_id,on_date" },
    );
    setBusy(false);
    if (error) {
      setMsg({ kind: "err", text: error.message });
      return;
    }
    setMenus((prev) =>
      new Map(prev).set(target.id, { name: name.trim(), price: price.trim() ? Number(price) : null }),
    );
    setMsg({ kind: "ok", text: `${target.name} を「${name.trim()}」にしました` });
  };

  /** 控えを読み直す */
  const loadPresets = async () => {
    const { data } = await createClient()
      .from("menu_presets")
      .select("id, cafeteria_id, name, price")
      .order("sort_order")
      .order("name");
    setPresets((data as Preset[]) ?? []);
  };

  /**
   * いま打っている品名と値段を、控えに入れる。
   *
   * 同じ品名がもう控えてあれば、値段のほうを新しくする。
   * 同じ名前で値段違いが並ぶと、どちらを押せばよいか分からなくなる。
   */
  const savePreset = async () => {
    if (!target || !name.trim()) return;
    setBusy(true);
    setMsg(null);
    const { error } = await createClient()
      .from("menu_presets")
      .upsert(
        {
          cafeteria_id: target.cafeteria_id,
          name: name.trim(),
          price: price.trim() ? Number(price) : null,
        },
        { onConflict: "cafeteria_id,name" },
      );
    setBusy(false);
    if (error) {
      setMsg({
        kind: "err",
        text: `${error.message}（base/04_cafeteria.sql を入れ直していない場合は、先に入れてください）`,
      });
      return;
    }
    await loadPresets();
    setMsg({ kind: "ok", text: `「${name.trim()}」を控えに入れました` });
  };

  /** 控えを一つ消す */
  const removePreset = async (pr: Preset) => {
    if (!window.confirm(`「${pr.name}」を控えから消します。よろしいですか？`)) return;
    setBusy(true);
    const { error } = await createClient().from("menu_presets").delete().eq("id", pr.id);
    setBusy(false);
    if (error) {
      setMsg({ kind: "err", text: error.message });
      return;
    }
    await loadPresets();
    setMsg({ kind: "ok", text: `「${pr.name}」を控えから消しました` });
  };

  /**
   * いま打っている中身を、選んだ日ぜんぶに入れる。
   *
   * 同じ品を何日も出すことがある。日を一つずつ選び直して
   * 同じものを打つのは、月に20回になる。
   * 入れる先は「いま選んでいる枠」だけ。枠まで一度に変えると、
   * どこへ入るのか分からなくなる。
   */
  const saveMany = async () => {
    if (!target || !name.trim() || bulkDates.length === 0) return;
    const rows = bulkDates.map((d) => ({
      item_id: target.id,
      on_date: d,
      name: name.trim(),
      price: price.trim() ? Number(price) : null,
    }));

    if (
      !window.confirm(
        [
          `${target.name} に「${name.trim()}${price.trim() ? ` ${price}円` : ""}」を`,
          `${bulkDates.length} 日ぶん入れます。`,
          "",
          bulkDates.slice(0, 8).join("、") + (bulkDates.length > 8 ? " ほか" : ""),
          "",
          "その日にすでに入っているものは、置き換わります。",
          "よろしいですか？",
        ].join(BR),
      )
    )
      return;

    setBusy(true);
    setMsg(null);
    const { error } = await createClient()
      .from("menu_days")
      .upsert(rows, { onConflict: "item_id,on_date" });
    setBusy(false);
    if (error) {
      setMsg({ kind: "err", text: error.message });
      return;
    }
    // いま見ている日が入っていれば、画面のほうも合わせる
    if (date && bulkDates.includes(ymd(date))) {
      setMenus((prev) =>
        new Map(prev).set(target.id, {
          name: name.trim(),
          price: price.trim() ? Number(price) : null,
        }),
      );
    }
    setMsg({ kind: "ok", text: `${bulkDates.length} 日ぶんに入れました` });
  };

  const clearMenu = async () => {
    if (!date || !target) return;
    setBusy(true);
    const { error } = await createClient()
      .from("menu_days")
      .delete()
      .eq("item_id", target.id)
      .eq("on_date", ymd(date));
    setBusy(false);
    if (error) {
      setMsg({ kind: "err", text: error.message });
      return;
    }
    setMenus((prev) => {
      const n = new Map(prev);
      n.delete(target.id);
      return n;
    });
    setName("");
    setPrice("");
    setMsg({ kind: "ok", text: `${target.name} の登録を消しました` });
  };

  /**
   * その日の食堂の登録を、まとめて全部消す。
   *
   * 一つずつ消す道は前からあるが、間違えて何品も入れたときに終わらない。
   * 他の人が入れたぶんも消えるので、二度たずねてから実行する。
   */
  const clearAllMenus = async () => {
    if (!date) return;
    const n = menus.size;
    if (n === 0) return;
    const first = window.confirm(
      [
        `${ymd(date)} の食堂の登録を、すべて消します。`,
        "",
        `  ${n} 件（品名・値段・提供状況）`,
        "",
        "他の人が入れたぶんも消えます。元には戻せません。",
        "続けますか？",
      ].join(BR),
    );
    if (!first) return;
    const second = window.confirm(
      `本当に消しますか？（${n} 件）${BR}${BR}これが最後の確認です。`,
    );
    if (!second) return;

    setBusy(true);
    setMsg(null);
    const supabase = createClient();
    const d = ymd(date);
    const a = await supabase.from("menu_days").delete().eq("on_date", d);
    const b = await supabase.from("counter_days").delete().eq("on_date", d);
    setBusy(false);
    if (a.error || b.error) {
      setMsg({ kind: "err", text: (a.error ?? b.error)!.message });
      return;
    }
    setMenus(new Map());
    setName("");
    setPrice("");
    setMsg({ kind: "ok", text: `${n} 件の登録を消しました` });
  };

  /* ---------------- 表示 ---------------- */

  if (loading) return <Shell>{T("読み込み中…")}</Shell>;

  if (!supabaseReady)
    return <Shell><p className="text-sm text-red-700">{T("サーバーに接続できません。")}</p></Shell>;

  if (!role)
    return (
      <Shell>
        <p className="text-sm text-slate-700">{T("ログインしていません。")}</p>
        <Link href="/login" className="mt-3 inline-block text-sm font-bold text-blue-600">{T("ログインへ")}</Link>
      </Shell>
    );

  if (!canManageCafeteria(role))
    return (
      <Shell>
        <p className="text-sm text-slate-700">
          {T("食堂の設定ができるのは、食堂の担当だけです。")}
        </p>
        <p className="mt-1 text-xs text-slate-500">現在の権限：{ROLE_LABEL[role]}</p>
        <Link href="/" className="mt-3 inline-block text-sm font-bold text-blue-600">{T("地図へ戻る")}</Link>
      </Shell>
    );

  return (
    <Shell wide>
      <AdminHeader title={T("食堂のメニュー")} />
      <AdminMenu current="cafeteria" role={role} />

      {/* その日ぶんをまとめて消す。他人が入れたぶんも消えるので上位だけ */}
      {date && canManageAll(role) && menus.size > 0 && (
        <button
          onClick={() => void clearAllMenus()}
          disabled={busy}
          className="mb-3 w-full rounded-lg bg-red-600 px-2 py-2 text-[11px] font-bold text-white transition hover:bg-red-700 disabled:bg-slate-300"
        >
          {ymd(date)} の登録（{menus.size}件）をすべて消す
        </button>
      )}

      {date && (
        <>
          {/*
            日。押すとカレンダーが開く。

            予定の登録と同じ形にしてある。はじめから今日が入っていて、
            別の日にしたいときだけカレンダーを開く。
          */}
          <div className="mb-2 flex items-center gap-2">
            {target && (
              <button
                onClick={() => setTarget(null)}
                className="rounded-lg bg-slate-100 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 transition hover:bg-slate-200"
              >
                ← {T("項目を選び直す")}
              </button>
            )}
            <button
              onClick={() => setCalOpen((v) => !v)}
              className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-bold text-slate-800 transition hover:bg-slate-200"
            >
              📅 {date.getFullYear()}年{date.getMonth() + 1}月{date.getDate()}日（
              {WEEK[date.getDay()]}）
              <span className="ml-1 text-[10px] font-normal text-slate-500">
                {calOpen ? T("閉じる") : T("日を選ぶ")}
              </span>
            </button>
          </div>

          {calOpen && (
            <div className="mb-3 rounded-xl bg-slate-50 p-2">
              <Cal
                onPick={(d) => {
                  setDate(d);
                  setCalOpen(false);
                  void loadDay(d);
                }}
              />
            </div>
          )}

          {/* ---- 2. 項目を選ぶ ---- */}
          {!target && (
            <>
              <p className="mb-2 text-[11px] font-bold text-slate-500">
                {T("どの項目を設定しますか")}
              </p>
              <div className="flex flex-col gap-2">
                {counters.map((c) => {
                  const st = states.get(c.id);
                  const slots = items.filter((i) => i.parent_id === c.id);
                  return (
                    <div key={c.id} className="rounded-xl bg-slate-50 p-2">
                      <button
                        onClick={() => setTarget(c)}
                        className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left transition hover:bg-white"
                      >
                        <span className="text-sm font-bold text-slate-900">{c.name}</span>
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold text-white ${
                            st === "open"
                              ? "bg-emerald-600"
                              : st === "closed"
                                ? "bg-slate-600"
                                : st === "soldout"
                                  ? "bg-red-600"
                                  : "bg-slate-300"
                          }`}
                        >
                          {st === "open"
                            ? "活動中"
                            : st === "closed"
                              ? "活動休止"
                              : st === "soldout"
                                ? "売り切れ"
                                : "未設定"}
                        </span>
                      </button>

                      {slots.map((s) => {
                        const m = menus.get(s.id);
                        return (
                          <button
                            key={s.id}
                            onClick={() => setTarget(s)}
                            className="flex w-full items-baseline justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-white"
                          >
                            <span className="shrink-0 text-[11px] text-slate-500">− {s.name}</span>
                            <span className="min-w-0 truncate text-right text-[11px] font-bold text-slate-800">
                              {m ? m.name : "未設定"}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
                {counters.length === 0 && (
                  <p className="rounded-xl bg-slate-50 p-3 text-[11px] text-slate-500">
                    {T("食堂の項目が登録されていません。")}
                  </p>
                )}
              </div>
            </>
          )}

          {/* ---- 3. 設定する ---- */}
          {target && (
            <div>
              <p className="mb-1 text-xs font-bold text-slate-900">{target.name}</p>

              {target.kind === "counter" ? (
                <>
                  <p className="mb-2 text-[11px] text-slate-500">
                    {T("この日の状態を選んでください")}
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {STATES.map((s) => {
                      const on = states.get(target.id) === s.id;
                      return (
                        <button
                          key={s.id}
                          disabled={busy}
                          onClick={() => void saveState(target, s.id)}
                          className={`rounded-xl py-4 text-sm font-bold transition active:scale-95 ${
                            on ? `${s.cls} text-white` : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                          }`}
                        >
                          {s.label}
                          {on && <span className="mt-0.5 block text-[10px] font-normal">{T("選択中")}</span>}
                        </button>
                      );
                    })}
                  </div>
                </>
              ) : (
                <>
                  {/*
                    よく出す品の控え。

                    出てくるものはだいたい決まっているのに、来るたびに
                    品名と値段を打ち直していた。押せば両方が入る。
                  */}
                  {/*
                    よく出す品の控え。

                    ★いつでも出す
                      控えが一つも無いうちは、この欄ごと隠していた。
                      隠れていると「そんな仕組みがある」と気づけないので、
                      空でも枠は出して、入れ方を書いておく。

                      使えるのは食堂を預かる人（レベル0）と、
                      副管理者（2.1・2.2）・管理者。
                      この画面に入れる人と同じなので、ここでは分けない。
                  */}
                  {canManageCafeteria(role) && (
                    <div className="mb-2 rounded-xl bg-slate-50 p-2">
                      <div className="text-[10px] font-bold text-slate-500">
                        {T("よく出す品（押すと入ります）")}
                      </div>
                      {presets.filter((pr) => pr.cafeteria_id === target.cafeteria_id).length ===
                        0 && (
                        <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
                          {T("まだ控えがありません。品名と値段を入れて、下の「この品を控えに入れる」を押すと、次から押すだけで入ります。")}
                        </p>
                      )}
                      <div className="mt-1 flex flex-wrap gap-1">
                        {presets
                          .filter((pr) => pr.cafeteria_id === target.cafeteria_id)
                          .map((pr) => (
                            <span key={pr.id} className="flex items-stretch">
                              <button
                                onClick={() => {
                                  setName(pr.name);
                                  setPrice(pr.price != null ? String(pr.price) : "");
                                }}
                                className="rounded-l-lg bg-white px-2.5 py-1.5 text-[11px] font-bold text-slate-700 shadow-sm transition hover:bg-blue-50 active:scale-95"
                              >
                                {pr.name}
                                {pr.price != null && (
                                  <span className="ml-1 font-normal text-slate-400">
                                    {pr.price}円
                                  </span>
                                )}
                              </button>
                              <button
                                onClick={() => void removePreset(pr)}
                                title={T("控えから消す")}
                                className="rounded-r-lg bg-white px-1.5 text-[10px] font-bold text-slate-300 shadow-sm transition hover:bg-red-50 hover:text-red-500"
                              >
                                ×
                              </button>
                            </span>
                          ))}
                      </div>
                    </div>
                  )}

                  <p className="mb-2 text-[11px] text-slate-500">
                    {T("この日の名称を入れてください")}
                  </p>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={T("味噌カツ丼")}
                    className="w-full rounded-xl bg-slate-100 px-4 py-3 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
                  />
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      value={price}
                      onChange={(e) => setPrice(e.target.value.replace(/[^0-9]/g, ""))}
                      inputMode="numeric"
                      placeholder="450"
                      className="w-28 rounded-xl bg-slate-100 px-4 py-3 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
                    />
                    <span className="text-xs font-bold text-slate-500">{T("円（任意）")}</span>
                  </div>
                  <button
                    onClick={() => void saveMenu()}
                    disabled={busy}
                    className="mt-3 w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold text-white transition hover:bg-blue-700 disabled:bg-slate-300"
                  >
                    {busy ? "保存中…" : `この日（${date ? ymd(date) : ""}）に入れる`}
                  </button>

                  {/* 控えに入れる。次からは押すだけで済む */}
                  <button
                    onClick={() => void savePreset()}
                    disabled={busy || !name.trim()}
                    className="mt-1.5 w-full rounded-xl bg-slate-100 px-4 py-2.5 text-xs font-bold text-slate-700 transition hover:bg-slate-200 disabled:text-slate-300"
                  >
                    {T("この品を控えに入れる（次から押すだけ）")}
                  </button>

                  {/*
                    まとめて入れる。

                    同じ品を何日も出すことがある。日を一つずつ選び直して
                    同じものを打つと、月に20回になる。
                    入れる先はいま選んでいる枠だけ。枠まで一度に変えると、
                    どこへ入るのか分からなくなる。
                  */}
                  <button
                    onClick={() => {
                      setBulkOpen((v) => !v);
                      if (!bulkOpen && date) setBulkDates([ymd(date)]);
                    }}
                    className="mt-1.5 w-full rounded-xl bg-slate-100 px-4 py-2.5 text-xs font-bold text-slate-700 transition hover:bg-slate-200"
                  >
                    {bulkOpen ? T("カレンダーを閉じる") : T("カレンダーから何日ぶんかまとめて入れる")}
                  </button>

                  {bulkOpen && (
                    <div className="mt-2 rounded-xl bg-slate-50 p-2">
                      <div className="mb-1 text-[10px] font-bold text-slate-500">
                        {target.name} に「{name.trim() || "（品名を入れてください）"}
                        {price.trim() ? ` ${price}円` : ""}」を入れる日
                      </div>
                      {/*
                        予定の登録と同じカレンダー。
                        日をいくつでも押せて、「毎週くり返す」で
                        何週ぶんかをまとめて足せる。
                        同じ献立を何週も出すことがあるので、そこが要る。
                      */}
                      <MultiDatePicker value={bulkDates} onChange={setBulkDates} />
                      <button
                        onClick={() => void saveMany()}
                        disabled={busy || bulkDates.length === 0 || !name.trim()}
                        className="mt-2 w-full rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-bold text-white transition hover:bg-blue-700 disabled:bg-slate-300"
                      >
                        {busy
                          ? "保存中…"
                          : !name.trim()
                            ? "品名を入れてください"
                            : `${bulkDates.length} 日ぶんに入れる`}
                      </button>
                    </div>
                  )}
                  {menus.get(target.id) && (
                    <button
                      onClick={() => void clearMenu()}
                      disabled={busy}
                      className="mt-1.5 w-full rounded-xl px-4 py-2 text-xs font-semibold text-red-600 transition hover:bg-red-50"
                    >
                      {T("この日の登録を消す")}
                    </button>
                  )}
                </>
              )}

              {msg && (
                <p
                  className={`mt-3 rounded-xl p-3 text-xs leading-relaxed ${
                    msg.kind === "ok" ? "bg-emerald-50 text-emerald-900" : "bg-red-50 text-red-800"
                  }`}
                >
                  {msg.text}
                </p>
              )}
            </div>
          )}

          {!target && msg && (
            <p
              className={`mt-3 rounded-xl p-3 text-xs ${
                msg.kind === "ok" ? "bg-emerald-50 text-emerald-900" : "bg-red-50 text-red-800"
              }`}
            >
              {msg.text}
            </p>
          )}
        </>
      )}
    </Shell>
  );
}

/* ---------------- カレンダー ---------------- */

function Cal({ onPick }: { onPick: (d: Date) => void }) {
  const today = useMemo(() => new Date(), []);
  const [shown, setShown] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));

  const cells = useMemo(() => {
    const first = new Date(shown.getFullYear(), shown.getMonth(), 1);
    const last = new Date(shown.getFullYear(), shown.getMonth() + 1, 0);
    const out: (Date | null)[] = [];
    for (let i = 0; i < first.getDay(); i++) out.push(null);
    for (let d = 1; d <= last.getDate(); d++)
      out.push(new Date(shown.getFullYear(), shown.getMonth(), d));
    return out;
  }, [shown]);

  const move = (n: number) =>
    setShown((s) => new Date(s.getFullYear(), s.getMonth() + n, 1));

  return (
    <div>
      <div className="mb-2 flex items-center gap-1">
        <button
          onClick={() => move(-1)}
          className="h-9 w-9 rounded-lg bg-slate-100 text-sm font-bold text-slate-600 hover:bg-slate-200"
        >
          ‹
        </button>
        <span className="flex-1 text-center text-sm font-bold text-slate-800">
          {shown.getFullYear()}年 {shown.getMonth() + 1}月
        </span>
        <button
          onClick={() => move(1)}
          className="h-9 w-9 rounded-lg bg-slate-100 text-sm font-bold text-slate-600 hover:bg-slate-200"
        >
          ›
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center">
        {WEEK.map((w, i) => (
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
          /* 日曜と祝日は赤、土曜は青（lib/holidays.ts）。食堂の休みと重なる日 */
          const tone = dayColor(ymd(d));
          const hol = holidayName(ymd(d));
          return (
            <button
              key={ymd(d)}
              onClick={() => onPick(d)}
              title={hol ?? undefined}
              className={`relative aspect-square rounded-lg text-sm font-bold transition active:scale-90 ${
                isToday
                  ? "bg-amber-100 text-amber-900 ring-2 ring-amber-400"
                  : tone === "holiday"
                    ? "text-red-500 hover:bg-slate-100"
                    : tone === "sat"
                      ? "text-blue-500 hover:bg-slate-100"
                      : "text-slate-700 hover:bg-slate-100"
              }`}
            >
              {d.getDate()}
              {hol && (
                <span className="absolute inset-x-0 top-0.5 mx-auto block h-1 w-1 rounded-full bg-red-400" />
              )}
            </button>
          );
        })}
      </div>

      <button
        onClick={() => onPick(new Date())}
        className="mt-3 w-full rounded-xl bg-amber-500 px-4 py-3 text-sm font-bold text-white transition hover:bg-amber-600"
      >
        今日（{today.getMonth() + 1}/{today.getDate()}）を設定する
      </button>
    </div>
  );
}

function Shell({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    // 本文は地図のために overflow-hidden。ここで送れるようにする
    <main className="h-[100dvh] overflow-y-auto bg-slate-100 p-4">
      <div className={`mx-auto ${wide ? "max-w-lg" : "max-w-sm"} rounded-2xl bg-white p-5 shadow-lg`}>
        {children}
      </div>
    </main>
  );
}
