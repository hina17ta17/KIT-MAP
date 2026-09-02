"use client";

/**
 * 名簿の取り込み。
 *
 * ■ 誰が使えるか
 *   レベル2.1・2.2・管理者だけ。教授（レベル2）も、食堂の担当も入れない。
 *   名簿には学籍番号と氏名が並ぶため。
 *   画面での出し分けは親切であって、守っているのは
 *   データベース側（can_manage_roster）。
 *
 * ■ 何をするか
 *   xlsx を選ぶ → 中身をこの画面で読む → 通る行と弾く行を見せる
 *   → よければ取り込む。
 *
 *   xlsx を読むのはこの端末の中だけで、ファイルそのものはどこにも送らない。
 *   送るのは、読み取った行の中身だけ。
 *
 * ■ 通す・弾くの判定はここに書かない
 *   同じ決まりを画面と Python のエージェントの二箇所に書くと、
 *   片方だけ直したときに食い違う。判定はデータベース側の
 *   import_roster に一本化してあり、ここは渡して結果を見せるだけ。
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient, supabaseReady } from "@/lib/supabase/client";
import { AdminHeader, AdminMenu } from "@/components/AdminNav";
import { canManageAll, type Role } from "@/lib/auth";
import { readXlsx, type Row } from "@/lib/xlsx";

/** xlsx の列。A列から順に */
const COLS = ["kind", "email", "name", "grade", "class_code", "seat_no", "student_no", "number"] as const;

type Sending = { row: number } & Record<(typeof COLS)[number], string>;
type Rejected = { row: number; why: string };
type Report = { students: number; staff: number; rejected: Rejected[] };
type Counts = { students: number; teachers: number; others: number };

export default function RosterPage() {
  const [role, setRole] = useState<Role | null>(null);
  const [loading, setLoading] = useState(supabaseReady);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [counts, setCounts] = useState<Counts | null>(null);
  const [studentDomain, setStudentDomain] = useState("");
  const [teacherDomain, setTeacherDomain] = useState("");

  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<Sending[] | null>(null);
  const [report, setReport] = useState<Report | null>(null);

  const load = useCallback(async () => {
    if (!supabaseReady) return;
    const supabase = createClient();
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) {
      setRole(null);
      setLoading(false);
      return;
    }
    const { data: me } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", u.user.id)
      .single();
    const r = (me?.role as Role) ?? null;
    setRole(r);

    if (canManageAll(r)) {
      const { data: c } = await supabase.rpc("roster_counts");
      if (c) setCounts(c as Counts);
      const { data: cfg } = await supabase
        .from("roster_config")
        .select("student_domain, teacher_domain")
        .eq("id", 1)
        .single();
      if (cfg) {
        setStudentDomain((cfg as { student_domain: string }).student_domain ?? "");
        setTeacherDomain((cfg as { teacher_domain: string }).teacher_domain ?? "");
      }
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /* ---------------- ファイルを読む ---------------- */

  const pick = async (file: File | null) => {
    setMsg(null);
    setReport(null);
    setRows(null);
    setFileName("");
    if (!file) return;
    setBusy(true);
    try {
      const raw: Row[] = await readXlsx(file);
      /*
       * 何行目かを添えて渡す。弾かれたときに
       * 「xlsx の何行目を直せばよいか」を言えるようにするため。
       */
      const sending: Sending[] = raw.map((cells, i) => {
        const o = { row: i + 1 } as Sending;
        COLS.forEach((c, n) => {
          o[c] = (cells[n] ?? "").trim();
        });
        return o;
      });
      // まったくの空行は送らない
      const kept = sending.filter((s) => COLS.some((c) => s[c] !== ""));
      setFileName(file.name);
      setRows(kept);
      if (kept.length === 0) setMsg({ kind: "err", text: "中身のある行がありませんでした" });
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "読めませんでした" });
    } finally {
      setBusy(false);
    }
  };

  /* ---------------- 取り込む ---------------- */

  const send = async () => {
    if (!rows || rows.length === 0) return;
    setMsg(null);
    setBusy(true);
    try {
      const { data, error } = await createClient().rpc("import_roster", { p_rows: rows });
      if (error) throw error;
      const rep = data as Report;
      setReport(rep);
      setMsg({
        kind: "ok",
        text: `学生 ${rep.students} 件、教授・その他 ${rep.staff} 件を入れました。`,
      });
      await load();
    } catch (e) {
      setMsg({
        kind: "err",
        text:
          e instanceof Error
            ? `${e.message}（base/12_roster_import.sql をまだ入れていない場合は、先に入れてください）`
            : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  const saveDomain = async () => {
    setMsg(null);
    setBusy(true);
    try {
      const { error } = await createClient()
        .from("roster_config")
        .update({
          student_domain: studentDomain.trim().toLowerCase(),
          teacher_domain: teacherDomain.trim().toLowerCase(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", 1);
      if (error) throw error;
      setMsg({ kind: "ok", text: "ドメインを保存しました。" });
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Shell>読み込み中…</Shell>;

  if (!canManageAll(role))
    return (
      <Shell>
        <p className="text-sm text-slate-700">この画面は、いまの権限では使えません。</p>
        <p className="mt-1 text-[11px] text-slate-500">
          名簿を触れるのは、副管理者（2.1・2.2）と管理者だけです。
        </p>
        <Link href="/login" className="mt-3 inline-block text-sm font-bold text-blue-600">
          ログインへ
        </Link>
      </Shell>
    );

  return (
    <Shell wide>
      <AdminHeader title="名簿" />
      <AdminMenu current="roster" role={role} />

      {msg && (
        <p
          className={`mb-3 rounded-xl p-3 text-xs leading-relaxed ${
            msg.kind === "ok" ? "bg-emerald-50 text-emerald-900" : "bg-red-50 text-red-800"
          }`}
        >
          {msg.text}
        </p>
      )}

      {/* いま何件入っているか */}
      <div className="rounded-xl bg-slate-50 p-3">
        <div className="text-[11px] font-bold text-slate-500">いま入っている名簿</div>
        <div className="mt-1 flex flex-wrap gap-3 text-xs font-bold text-slate-800">
          <span>学生 {counts?.students ?? "—"}</span>
          <span>教授 {counts?.teachers ?? "—"}</span>
          <span>その他 {counts?.others ?? "—"}</span>
        </div>
        <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
          名簿そのものは、この画面には出しません。学籍番号と氏名が並ぶためです。
          数だけを出しています。
        </p>
      </div>

      {/* ドメインの設定 */}
      <section className="mt-4 rounded-xl border border-slate-200 p-3">
        <div className="text-xs font-bold text-slate-900">ドメイン</div>
        <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
          突き合わせに使います。<b>教授のドメインは空</b>にしてあるので、ここに入れてください。
          空のあいだ、教授の行は取り込まれません（申請のほうも、追い返さずに人へ回します）。
          その他の人はドメインを見ません。
        </p>
        <label className="mt-2 block text-[10px] font-bold text-slate-500">学生</label>
        <input
          value={studentDomain}
          onChange={(e) => setStudentDomain(e.target.value)}
          placeholder="st.example.ac.jp"
          className="mt-0.5 w-full rounded-lg bg-slate-100 px-3 py-2 text-xs outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
        />
        <label className="mt-2 block text-[10px] font-bold text-slate-500">教授・教員</label>
        <input
          value={teacherDomain}
          onChange={(e) => setTeacherDomain(e.target.value)}
          placeholder="（ここに入れてください）"
          className="mt-0.5 w-full rounded-lg bg-slate-100 px-3 py-2 text-xs outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={() => void saveDomain()}
          disabled={busy}
          className="mt-2 rounded-lg bg-slate-900 px-3 py-2 text-[11px] font-bold text-white transition hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400"
        >
          ドメインを保存
        </button>
      </section>

      {/* xlsx を選ぶ */}
      <section className="mt-4 rounded-xl border border-slate-200 p-3">
        <div className="text-xs font-bold text-slate-900">xlsx から取り込む</div>
        <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
          1行が1人。<b>A 身分（学生／教授／その他）・B メールアドレス・C 名前</b>。
          学生はさらに <b>D 学年・E クラス・F 名列番号・G 学籍番号</b>、
          教授とその他は <b>H 8桁の番号</b>。
          <br />
          見出しの行があっても構いません（A列が三択でないので自動で飛ばされます）。
          <br />
          <span className="text-slate-400">
            ファイルそのものはどこにも送りません。この端末で読み取った中身だけを送ります。
          </span>
        </p>

        <input
          type="file"
          accept=".xlsx"
          onChange={(e) => void pick(e.target.files?.[0] ?? null)}
          className="mt-2 w-full rounded-lg bg-slate-100 p-2 text-[11px] file:mr-2 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-1.5 file:text-[11px] file:font-bold file:text-white"
        />

        {rows && (
          <>
            <p className="mt-2 text-[11px] font-bold text-slate-700">
              {fileName}：{rows.length} 行を読みました
            </p>
            <ul className="mt-1 max-h-40 overflow-y-auto rounded-lg bg-slate-50 p-2 text-[10px] leading-relaxed text-slate-600">
              {rows.slice(0, 30).map((r) => (
                <li key={r.row} className="truncate">
                  {r.row}: {r.kind} / {r.email} / {r.name}
                  {r.student_no ? ` / ${r.student_no}` : ""}
                  {r.number ? ` / ${r.number}` : ""}
                </li>
              ))}
              {rows.length > 30 && <li className="text-slate-400">ほか {rows.length - 30} 行</li>}
            </ul>
            <button
              onClick={() => void send()}
              disabled={busy}
              className="mt-2 w-full rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-bold text-white transition hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400"
            >
              {busy ? "取り込んでいます…" : `${rows.length} 行を取り込む`}
            </button>
          </>
        )}
      </section>

      {/* 弾いた行 */}
      {report && (
        <section className="mt-4 rounded-xl border border-slate-200 p-3">
          <div className="text-xs font-bold text-slate-900">
            取り込まなかった行：{report.rejected.length}
          </div>
          {report.rejected.length === 0 ? (
            <p className="mt-1 text-[11px] text-emerald-700">全部入りました。</p>
          ) : (
            <ul className="mt-1 max-h-60 space-y-1 overflow-y-auto text-[10px] leading-relaxed">
              {report.rejected.map((r, i) => (
                <li key={i} className="rounded bg-amber-50 px-2 py-1 text-amber-900">
                  <b>{r.row}行目</b> {r.why}
                </li>
              ))}
            </ul>
          )}
        </section>
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
      <div
        className={`mx-auto ${wide ? "max-w-2xl" : "max-w-sm"} rounded-2xl bg-white p-5 shadow-lg`}
      >
        {children}
      </div>
    </main>
  );
}
