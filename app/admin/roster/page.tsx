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

/** 確認の文を組み立てるときの改行。書き換えの途中で消えないよう、変数にしてある */
const BR = String.fromCharCode(10);

type Sending = { row: number } & Record<(typeof COLS)[number], string>;
type Rejected = { row: number; why: string };
type Report = { students: number; staff: number; rejected: Rejected[] };
type Counts = { students: number; teachers: number; others: number };
type DomainKind = "student" | "teacher" | "other";
type Domains = Record<DomainKind, string>;

/** ドメイン名確認の中の、身分の並び */
const DOMAIN_KINDS: { id: DomainKind; label: string; note: string }[] = [
  {
    id: "student",
    label: "学生",
    note: "このドメインの人だけを学生として扱います。学籍番号は @ の前と同じであることも見ます。",
  },
  {
    id: "teacher",
    label: "教授・教員",
    note: "このドメインの人だけを教授として扱います。空のあいだは、教授の行を取り込まず、教授の申請は人に回します（追い返しません）。",
  },
  {
    id: "other",
    label: "その他",
    note: "職員・関係者。空にしておくとドメインを見ません（外部のアドレスの人もいるため）。入れると、そのドメインだけを通します。",
  },
];

export default function RosterPage() {
  const [role, setRole] = useState<Role | null>(null);
  const [loading, setLoading] = useState(supabaseReady);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [counts, setCounts] = useState<Counts | null>(null);

  /** ドメイン名確認 */
  const [domainOpen, setDomainOpen] = useState(false);
  const [domainKind, setDomainKind] = useState<DomainKind>("student");
  const [domains, setDomains] = useState<Domains | null>(null);
  /** いま直している途中の文字。保存するまで反映しない */
  const [draftDomain, setDraftDomain] = useState("");

  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<Sending[] | null>(null);
  const [report, setReport] = useState<Report | null>(null);

  /** 一人ずつ手で入れる欄 */
  const [manualOpen, setManualOpen] = useState(false);
  const [one, setOne] = useState({
    kind: "学生",
    email: "",
    name: "",
    grade: "",
    class_code: "",
    seat_no: "",
    student_no: "",
    number: "",
  });

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
      const { data: d } = await supabase.rpc("get_domains");
      if (d) {
        const got = d as Record<string, string>;
        const next: Domains = {
          student: got.student ?? "",
          teacher: got.teacher ?? "",
          other: got.other ?? "",
        };
        setDomains(next);
      }
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * 身分を切り替える。
   *
   * 直す欄も、その身分のいまの値に入れ直す。学生の欄に打ちかけた
   * ものが教授に切り替えた先にも残っていると、気づかずに別の身分へ
   * 入れてしまう。押したときに揃えるので、描いている最中に
   * 外のものを書き換えることにならない。
   */
  const pickKind = (k: DomainKind) => {
    setDomainKind(k);
    setDraftDomain(domains?.[k] ?? "");
  };

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

  /**
   * 手で入れた一人を送る。
   *
   * 通す・弾くの判定は xlsx と同じ import_roster に任せる。
   * ここだけ甘い決まりにすると、名簿の中身が揃わなくなる。
   */
  const sendOne = async () => {
    setMsg(null);
    setBusy(true);
    try {
      const row = { row: 1, ...one };
      const { data, error } = await createClient().rpc("import_roster", { p_rows: [row] });
      if (error) throw error;
      const rep = data as Report;
      if (rep.rejected.length > 0) {
        setMsg({ kind: "err", text: `入れられません: ${rep.rejected[0].why}` });
      } else {
        setMsg({ kind: "ok", text: `${one.name} さんを入れました。` });
        setOne((o) => ({
          ...o,
          email: "",
          name: "",
          grade: "",
          class_code: "",
          seat_no: "",
          student_no: "",
          number: "",
        }));
        await load();
      }
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

  /**
   * ドメインを一つ変える。
   *
   * ■ 二度たずねる
   *   ここを間違えると、正しい人が申請できなくなったり、
   *   名簿が一行も入らなくなったりする。すぐには気づけない種類の
   *   間違いなので、何から何へ変わるのかを見せて、二度確かめる。
   *
   * ■ いま入っている人は切れない
   *   この操作が触るのは roster_config だけ。席にも権限にも
   *   触れないので、ログイン中の人はそのまま使い続けられる。
   *   データベース側の守り（check_email_domain）も、席を作るときと
   *   アドレスを変えるときにしか動かない。
   */
  const changeDomain = async () => {
    const kind = DOMAIN_KINDS.find((k) => k.id === domainKind);
    if (!kind) return;
    /*
     * domains が読めていなくても、ここで黙って返さない。
     *
     * 13_domains.sql を流す前は get_domains が無いので domains は空になる。
     * そこで返してしまうと、ボタンは押せるのに何も起きない——という
     * いちばん困る形になる（実際にそうなっていた）。
     * 空のまま進めて、データベース側の断りを画面に出す。
     */
    const before = domains?.[domainKind] ?? "";
    const after = draftDomain.trim().toLowerCase();
    if (before.toLowerCase() === after) return;

    const first = window.confirm(
      [
        `${kind.label}のドメインを変えます。`,
        "",
        `  いま  ${before || "（決めていません）"}`,
        `  あと  ${after || "（決めていない状態に戻す）"}`,
        "",
        "これから席を作る人に効きます。",
        "いまログインしている人は、そのまま使い続けられます。",
        "",
        "続けますか？",
      ].join(BR),
    );
    if (!first) return;

    const second = window.confirm(
      [
        `本当に「${after || "（決めていない）"}」にしますか？`,
        "",
        "これが最後の確認です。",
        after
          ? "このドメイン以外のアドレスでは、新しく申請できなくなります。"
          : "決めていない状態に戻すと、この身分ではドメインを見なくなります。",
      ].join(BR),
    );
    if (!second) return;

    setMsg(null);
    setBusy(true);
    try {
      const { data, error } = await createClient().rpc("set_domain", {
        p_kind: domainKind,
        p_domain: after,
      });
      if (error) throw error;
      const rep = data as { before: string; after: string };
      setDomains((d) => (d ? { ...d, [domainKind]: rep.after } : d));
      setMsg({
        kind: "ok",
        text: `${kind.label}のドメインを「${rep.before || "（未設定）"}」から「${
          rep.after || "（未設定）"
        }」にしました。ログイン中の人はそのままです。`,
      });
      await load();
    } catch (e) {
      setMsg({
        kind: "err",
        text:
          e instanceof Error
            ? `${e.message}（base/13_domains.sql をまだ入れていない場合は、先に入れてください）`
            : String(e),
      });
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

      {/*
        ドメイン名確認。

        ふだんは畳んでおく。開くと、身分を選んで、その身分の
        ドメインだけを見て・直せる。三つまとめて保存できる形にすると、
        直したつもりのないものまで上書きしてしまう。

        変えるときは二度たずねる。ここを間違えると、正しい人が
        申請できなくなったり、名簿が一行も入らなくなったりする。
      */}
      <section className="mt-4 rounded-xl border border-slate-200 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-bold text-slate-900">ドメイン名確認</div>
          <button
            onClick={() => {
              const next = !domainOpen;
              setDomainOpen(next);
              if (next) setDraftDomain(domains?.[domainKind] ?? "");
            }}
            className="rounded-lg bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-600 transition hover:bg-slate-200 active:scale-95"
          >
            {domainOpen ? "閉じる" : "ドメイン名確認"}
          </button>
        </div>

        {domainOpen && (
          <div className="mt-2">
            <div className="grid grid-cols-3 gap-1.5">
              {DOMAIN_KINDS.map((k) => (
                <button
                  key={k.id}
                  onClick={() => pickKind(k.id)}
                  className={`rounded-lg px-2 py-2 text-[11px] font-bold transition active:scale-95 ${
                    domainKind === k.id
                      ? "bg-slate-900 text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {k.label}
                </button>
              ))}
            </div>

            {(() => {
              const kind = DOMAIN_KINDS.find((k) => k.id === domainKind)!;
              const saved = domains?.[domainKind] ?? "";
              const changed = draftDomain.trim().toLowerCase() !== saved.toLowerCase();
              return (
                <>
                  <p className="mt-2 rounded-lg bg-slate-50 p-2 text-[10px] leading-relaxed text-slate-600">
                    <b>{kind.label}</b>：{kind.note}
                  </p>

                  <label className="mt-2 block text-[10px] font-bold text-slate-500">
                    いま決まっているもの
                  </label>
                  <p className="mt-0.5 rounded-lg bg-slate-100 px-3 py-2 font-mono text-xs text-slate-800">
                    {saved || "（決めていません）"}
                  </p>

                  <label className="mt-2 block text-[10px] font-bold text-slate-500">
                    直す
                  </label>
                  <input
                    value={draftDomain}
                    onChange={(e) => setDraftDomain(e.target.value)}
                    autoComplete="off"
                    placeholder="example.ac.jp"
                    className="mt-0.5 w-full rounded-lg bg-slate-100 px-3 py-2 font-mono text-xs outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
                  />
                  <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
                    空にすると「決めていない」に戻ります。
                    <br />
                    <b>いまログインしている人は、変えても入ったままです。</b>
                    この設定は、これから席を作る人にだけ効きます。
                  </p>

                  <button
                    onClick={() => void changeDomain()}
                    disabled={busy || !changed}
                    className="mt-2 w-full rounded-xl bg-slate-900 px-3 py-2.5 text-xs font-bold text-white transition hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400"
                  >
                    {busy ? "変えています…" : changed ? `${kind.label}のドメインを変える` : "変わっていません"}
                  </button>
                </>
              );
            })()}
          </div>
        )}
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

      {/*
        一人ずつ手で入れる。

        xlsx を作るまでもない一人や、あとから増えた一人のため。
        通す・弾くの判定は xlsx と同じもの（import_roster）を通す。
        ここだけ甘い決まりにすると、名簿の中身が揃わなくなる。
      */}
      <section className="mt-4 rounded-xl border border-slate-200 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-bold text-slate-900">一人ずつ手で入れる</div>
          <button
            onClick={() => setManualOpen((v) => !v)}
            className="rounded-lg bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-600 transition hover:bg-slate-200 active:scale-95"
          >
            {manualOpen ? "閉じる" : "手で入れる"}
          </button>
        </div>

        {manualOpen && (
          <div className="mt-2">
            <div className="grid grid-cols-3 gap-1.5">
              {(
                [
                  ["学生", "学生"],
                  ["教授", "教授"],
                  ["その他", "その他"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setOne((o) => ({ ...o, kind: id }))}
                  className={`rounded-lg px-2 py-2 text-[11px] font-bold transition active:scale-95 ${
                    one.kind === id
                      ? "bg-slate-900 text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <Field label="メールアドレス">
              <input
                value={one.email}
                onChange={(e) => setOne((o) => ({ ...o, email: e.target.value }))}
                autoComplete="off"
                className={manualInput}
              />
            </Field>
            <Field label="名前">
              <input
                value={one.name}
                onChange={(e) => setOne((o) => ({ ...o, name: e.target.value }))}
                autoComplete="off"
                className={manualInput}
              />
            </Field>

            {one.kind === "学生" ? (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <Field label="学年">
                    <input
                      value={one.grade}
                      onChange={(e) =>
                        setOne((o) => ({ ...o, grade: e.target.value.replace(/\D/g, "").slice(0, 1) }))
                      }
                      inputMode="numeric"
                      placeholder="1〜4"
                      className={manualInput}
                    />
                  </Field>
                  <Field label="クラス">
                    <input
                      value={one.class_code}
                      onChange={(e) =>
                        setOne((o) => ({ ...o, class_code: e.target.value.toUpperCase().slice(0, 4) }))
                      }
                      placeholder="CC"
                      className={manualInput}
                    />
                  </Field>
                  <Field label="名列番号">
                    <input
                      value={one.seat_no}
                      onChange={(e) =>
                        setOne((o) => ({ ...o, seat_no: e.target.value.replace(/\D/g, "").slice(0, 3) }))
                      }
                      inputMode="numeric"
                      placeholder="1〜200"
                      className={manualInput}
                    />
                  </Field>
                </div>
                <Field label="学籍番号">
                  <input
                    value={one.student_no}
                    onChange={(e) => setOne((o) => ({ ...o, student_no: e.target.value.trim() }))}
                    autoComplete="off"
                    className={manualInput}
                  />
                  <p className="mt-0.5 text-[10px] text-slate-400">
                    メールアドレスの @ より前と同じにしてください
                  </p>
                </Field>
              </>
            ) : (
              <Field label="8桁の番号">
                <input
                  value={one.number}
                  onChange={(e) => setOne((o) => ({ ...o, number: e.target.value.trim().slice(0, 8) }))}
                  autoComplete="off"
                  placeholder="12345678"
                  className={`${manualInput} text-center tracking-[0.3em]`}
                />
              </Field>
            )}

            <button
              onClick={() => void sendOne()}
              disabled={busy || !one.email.trim() || !one.name.trim()}
              className="mt-3 w-full rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-bold text-white transition hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400"
            >
              {busy ? "入れています…" : "この一人を入れる"}
            </button>
          </div>
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

/** 手で入れる欄の見た目。同じものを何度も書かないでまとめておく */
const manualInput =
  "mt-0.5 w-full rounded-lg bg-slate-100 px-3 py-2 text-xs outline-none focus:bg-white focus:ring-2 focus:ring-blue-500";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-2">
      <label className="block text-[10px] font-bold text-slate-500">{label}</label>
      {children}
    </div>
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
