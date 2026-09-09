"use client";

/**
 * 教室の登録（Lv3のみ）。
 *
 * 教室は建物と経路の土台になる情報で、消したり番号を変えたりすると
 * 時間割や予約も道連れになる。触れる人を絞ってある。
 *
 * 「何号館の何階の何番の教室は何という名前か」をまとめて入れる画面。
 * シラバスからコピーした一覧をそのまま貼り付けられるようにしてある。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { FeatureCollection, Polygon } from "geojson";
import { createClient, supabaseReady } from "@/lib/supabase/client";
import { AdminHeader, AdminMenu } from "@/components/AdminNav";
import { useAdminT } from "@/lib/adminLang";
import { type Role, canManageAll } from "@/lib/auth";
import { guessFloor, floorLabel, type BuildingProps } from "@/lib/features";

type Row = {
  id: number;
  building_id: string;
  building_code: string;
  floor: number;
  code: string;
  name: string;
  category: string;
  hint: string;
};

type Building = { tempId: string; label: string; code: string };

const CATEGORIES = [
  { id: "class", label: "教室" },
  { id: "lab", label: "研究室" },
  { id: "office", label: "事務" },
  { id: "facility", label: "設備" },
  { id: "other", label: "その他" },
];

export default function RoomsPage() {
  const T = useAdminT();
  const [role, setRole] = useState<Role | null>(null);
  const [loading, setLoading] = useState(true);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [target, setTarget] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [bulk, setBulk] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  /* 建物の一覧は地図データから取る */
  useEffect(() => {
    void fetch("/data/buildings.geojson")
      .then((r) => r.json())
      .then((fc: FeatureCollection<Polygon, BuildingProps>) => {
        const list = fc.features
          .map((f) => ({
            tempId: f.properties.tempId,
            code: f.properties.code ?? "",
            label: f.properties.name || `${f.properties.code}号館`,
          }))
          .filter((b) => b.label)
          .sort((a, b) => (Number(a.code) || 999) - (Number(b.code) || 999));
        setBuildings(list);
        if (list.length) setTarget(list[0].tempId);
      })
      .catch(() => setBuildings([]));
  }, []);

  const load = useCallback(async () => {
    if (!supabaseReady) {
      setLoading(false);
      return;
    }
    const supabase = createClient();
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) {
      setRole(null);
      setLoading(false);
      return;
    }
    const { data: me } = await supabase.from("profiles").select("role").eq("id", u.user.id).single();
    setRole((me?.role as Role) ?? null);

    const { data } = await supabase
      .from("rooms")
      .select("id, building_id, building_code, floor, code, name, category, hint")
      .order("building_code")
      .order("floor")
      .order("code");
    setRows((data as Row[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const canEdit = canManageAll(role);

  const ofTarget = useMemo(
    () => rows.filter((r) => r.building_id === target),
    [rows, target],
  );

  /* まとめて追加 */
  const addBulk = async () => {
    setMsg(null);
    const b = buildings.find((x) => x.tempId === target);
    if (!b) return;

    const codes = bulk
      .split(/[\n,、]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (codes.length === 0) return;

    const payload = codes.map((code) => ({
      building_id: b.tempId,
      building_code: b.code,
      code,
      floor: guessFloor(code),
      name: "",
      category: "class",
    }));

    // 同じ建物に同じ番号があれば飛ばす（unique 制約に任せる）
    const { error } = await createClient()
      .from("rooms")
      .upsert(payload, { onConflict: "building_id,code", ignoreDuplicates: true });

    if (error) setMsg(error.message);
    else {
      setBulk("");
      await load();
    }
  };

  const update = async (id: number, patch: Partial<Row>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    const { error } = await createClient().from("rooms").update(patch).eq("id", id);
    if (error) setMsg(error.message);
  };

  /**
   * 教室を一つ消す。
   *
   * 押す前に一度たずねる。消したものは戻せない
   * （どこにも控えを残していない）ので、
   * 打ち間違いで一つ消えたことに気づけないほうが困る。
   *
   * 何を消すのかを、確認の文にそのまま出す。
   * 「本当に消しますか？」だけだと、どれを押したのか分からない。
   */
  const remove = async (id: number) => {
    const r = rows.find((x) => x.id === id);
    if (!r) return;
    const b = buildings.find((x) => x.tempId === r.building_id);

    const ok = window.confirm(
      [
        "この教室を名簿から消します。",
        "",
        `  ${b?.label ?? r.building_code + "号館"}  ${r.code}${r.name ? `（${r.name}）` : ""}`,
        "",
        "元には戻せません。もう一度入れ直すことはできます。",
        "この教室に入れてある予定は、教室が決まっていない扱いになります。",
        "",
        "消しますか？",
      ].join("\n"),
    );
    if (!ok) return;

    const { error } = await createClient().from("rooms").delete().eq("id", id);
    if (error) setMsg(error.message);
    else setRows((prev) => prev.filter((x) => x.id !== id));
  };

  if (loading) return <Shell>{T("読み込み中…")}</Shell>;

  if (!canEdit)
    return (
      <Shell>
        <p className="text-sm text-slate-700">{T("この画面は、いまの権限では使えません。")}</p>
        <Link href="/login" className="mt-3 inline-block text-sm font-bold text-blue-600">
          {T("ログインへ")}
        </Link>
      </Shell>
    );

  const floors = [...new Set(ofTarget.map((r) => r.floor))].sort((a, b) => a - b);

  return (
    <Shell wide>
      <AdminHeader title={T("教室の登録")} />
      <AdminMenu current="campus" role={role} />

      {/* ここは「大学の情報登録」の中の一つ。戻る道を出しておく */}
      <Link
        href="/admin/campus"
        className="mb-3 inline-flex items-center gap-1 text-xs font-bold text-blue-600 hover:underline"
      >
        ← {T("大学の情報登録へ戻る")}
      </Link>

      {msg && <p className="mb-3 rounded-xl bg-red-50 p-3 text-xs text-red-800">{msg}</p>}

      <label className="block text-[11px] font-semibold text-slate-500">{T("建物")}</label>
      <select
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        className="mt-1 w-full rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-medium outline-none"
      >
        {buildings.map((b) => (
          <option key={b.tempId} value={b.tempId}>
            {b.label}（{rows.filter((r) => r.building_id === b.tempId).length}室）
          </option>
        ))}
      </select>

      <div className="mt-4 rounded-xl bg-slate-50 p-3">
        <p className="text-[11px] leading-relaxed text-slate-600">
          部屋番号を1行ずつ貼り付けます。<b>{T("階は番号から自動で判定")}</b>します
          {T("（302→3階、B01→地下1階）。あとから直せます。")}
        </p>
        <textarea
          value={bulk}
          onChange={(e) => setBulk(e.target.value)}
          rows={4}
          placeholder={"302\n301\n201"}
          className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
        />
        <button
          onClick={addBulk}
          disabled={!bulk.trim()}
          className="mt-2 w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-bold text-white disabled:bg-slate-300"
        >
          {T("まとめて追加")}
        </button>
      </div>

      {ofTarget.length > 0 && (
        <>
          <p className="mt-4 text-[11px] text-slate-500">
            {ofTarget.length}室 ／{" "}
            {floors.map((f) => `${floorLabel(f)} ${ofTarget.filter((r) => r.floor === f).length}室`).join(" ・ ")}
          </p>
          <ul className="mt-2 space-y-1">
            {ofTarget.map((r) => (
              <li key={r.id} className="flex items-center gap-1 rounded-lg bg-white px-2 py-1.5 ring-1 ring-slate-200">
                <input
                  value={r.code}
                  onChange={(e) => update(r.id, { code: e.target.value })}
                  className="w-16 rounded border border-slate-300 px-1.5 py-1 text-xs"
                />
                <input
                  value={r.name}
                  onChange={(e) => update(r.id, { name: e.target.value })}
                  placeholder={T("名称（任意）")}
                  className="min-w-0 flex-1 rounded border border-slate-300 px-1.5 py-1 text-xs"
                />
                <input
                  type="number"
                  value={r.floor}
                  onChange={(e) => update(r.id, { floor: Number(e.target.value) })}
                  title={T("階。地下は -1")}
                  className="w-14 rounded border border-slate-300 px-1.5 py-1 text-xs"
                />
                <select
                  value={r.category}
                  onChange={(e) => update(r.id, { category: e.target.value })}
                  className="rounded border border-slate-300 px-1 py-1 text-[11px]"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c.id} value={c.id}>{c.label}</option>
                  ))}
                </select>
                <button
                  onClick={() => remove(r.id)}
                  className="px-1 text-xs font-bold text-red-600 hover:text-red-800"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
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
      <div className={`mx-auto w-full ${wide ? "max-w-2xl lg:max-w-5xl" : "max-w-sm sm:max-w-2xl lg:max-w-4xl"} rounded-2xl bg-white p-5 shadow-lg`}>
        {children}
      </div>
    </main>
  );
}
