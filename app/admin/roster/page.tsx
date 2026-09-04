"use client";

/**
 * 名簿を見る・入れる。
 *
 * ■ 誰が何をできるか
 *   教授（レベル2）        … 学生の名簿を見るだけ
 *   レベル2.1・2.2・管理者 … 全部見られて、入れる・消す・ドメインも変えられる
 *
 *   教授に教職員の名簿を見せないのは、8桁の番号が並ぶため。
 *   その番号は、そのまま本人確認に使えてしまう。
 *
 *   画面での出し分けは親切であって、守っているのはデータベース側
 *   （can_read_roster / can_manage_roster）。権限の無い人がこの住所を
 *   直接開いても、関数のほうが断る。
 *
 * ■ 何をするか
 *   ・名簿を探して見る（区切ってめくる）
 *   ・xlsx をまとめて取り込む
 *   ・一人ずつ手で入れる
 *   ・ドメイン名を確かめる・変える
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
import { useAdminT } from "@/lib/adminLang";
import {
  CLASS_CODES,
  CLASS_NOS,
  GRADES,
  canManageAll,
  canReadRoster,
  type Role,
} from "@/lib/auth";
import { readXlsx, type Row } from "@/lib/xlsx";

/**
 * xlsx の列。A列から順に。
 *
 *   A 身分（学生・教授・その他）
 *   B メールアドレス
 *   C 氏名
 *   D 学年            学生だけ
 *   E 学科            学生だけ。KM・CC など
 *   F クラス（1〜10）  学生だけ
 *   G 名列番号        学生だけ
 *   H 学籍番号        学生だけ。アドレスの7桁と同じもの
 *   I〜N 担当学科     教授だけ。いくつでも（空けてよい）
 *   O 8桁の番号       教授とその他
 *
 * 身分ごとに使う列
 *   学生    A B C D E F G H
 *   教授    A B C  I〜N O
 *   その他  A B C      O
 *
 * ★E列は以前「クラス」と書いていたが、指しているのは学科。
 *   クラス（1〜10）は新しく F 列に分けた。
 */
const COLS = [
  "kind",
  "email",
  "name",
  "grade",
  "class_code",
  "class_no",
  "seat_no",
  "student_no",
  "dept1",
  "dept2",
  "dept3",
  "dept4",
  "dept5",
  "dept6",
  "number",
] as const;

/** そのうち担当学科の列（I〜N）。まとめて一つの並びにして送る */
const DEPT_COLS = ["dept1", "dept2", "dept3", "dept4", "dept5", "dept6"] as const;

type DeptCol = (typeof DEPT_COLS)[number];
/** 担当学科以外の列。こちらは一つずつそのまま送る */
type PlainCol = Exclude<(typeof COLS)[number], DeptCol>;

const isDeptCol = (c: (typeof COLS)[number]): c is DeptCol =>
  (DEPT_COLS as readonly string[]).includes(c);

/** 確認の文を組み立てるときの改行。書き換えの途中で消えないよう、変数にしてある */
const BR = String.fromCharCode(10);

/**
 * 学籍番号として使う7桁の数字を取り出す。
 *
 * 学籍番号は「アドレスに書いてある7桁の数字」。
 *   c1234567@st.example.ac.jp → 1234567
 *   c1234567                  → 1234567
 *   1234567                   → 1234567
 *   7桁にならないもの          → 空
 *
 * 通す・弾くを決めるのはデータベース側（student_no_of）。
 * ここは、押す前に画面で気づけるようにするための同じ計算。
 */
function studentNoOf(text: string): string {
  const local = (text ?? "").split("@")[0];
  const digits = local.replace(/\D/g, "");
  return digits.length === 7 ? digits : "";
}

/** データベースへ渡す一行。担当学科だけは並びにまとめる */
type Sending = { row: number; depts: string[] } & Record<PlainCol, string>;
type Rejected = { row: number; why: string };
type Report = { students: number; staff: number; rejected: Rejected[] };
/** all が false なら「学生の数しか見せてもらえていない」（教授のとき） */
type Counts = { students: number; teachers?: number; others?: number; all: boolean };
type DomainKind = "student" | "teacher" | "other";
type Domains = Record<DomainKind, string>;
/** その身分のドメインを見るか。false なら合っていなくても通る */
type DomainOn = Record<DomainKind, boolean>;

/**
 * 登録している人を見る欄。身分で五つに分ける。
 *
 * ★名簿（roster_students / roster_staff）とは別のもの。
 *   名簿は「申請と突き合わせるために入れておいた表」で、
 *   その人が実際に使っているかは分からない。
 *   ここで出すのは、席があって権限が付いている人（profiles）。
 */
type PeopleKind = "student" | "teacher" | "leader" | "cafeteria" | "other";

const PEOPLE_KINDS: { id: PeopleKind; label: string; byDept: boolean }[] = [
  // byDept … 学部と学科を選んでから見る（学年・クラスを持っている人）
  { id: "student", label: "学生", byDept: true },
  { id: "teacher", label: "教授", byDept: false },
  { id: "leader", label: "課外活動リーダー", byDept: true },
  { id: "cafeteria", label: "食堂", byDept: false },
  { id: "other", label: "その他", byDept: false },
];

/**
 * 名簿（突き合わせ用の表）の中を見るときの身分。
 *
 * 上の PeopleKind（登録している人）とは別のもの。
 * 名簿は学生・教授・その他の三つしか持っていない。
 */
type RosterKind = "student" | "teacher" | "other";

const ROSTER_KINDS: { id: RosterKind; label: string }[] = [
  { id: "student", label: "学生" },
  { id: "teacher", label: "教授" },
  { id: "other", label: "その他" },
];

/** 名簿にいる学生の一行 */
type RosterStudent = {
  student_no: string;
  email: string;
  full_name: string;
  grade: number;
  class_code: string;
  class_no: number | null;
  seat_no: number | null;
  updated_at: string;
  total: number;
};

/** 名簿にいる教授・その他の一行 */
type RosterStaff = {
  email: string;
  full_name: string;
  number: string;
  kind: string;
  dept_codes: string[] | null;
  updated_at: string;
  total: number;
};

type Person = {
  id: string;
  email: string;
  student_no: string;
  staff_no: string;
  full_name: string;
  grade: number;
  /** 学科の記号。列の名前は昔のまま */
  class_code: string;
  /** クラス（1〜10）。入れていない人は 0 */
  class_no: number | null;
  seat_no: number | null;
  /** 教授の担当学科 */
  dept_codes: string[] | null;
  role: string;
  affiliation: string;
  total: number;
};

type Faculty = { id: number; name: string };
type Dept = { id: number; faculty_id: number; name: string; code: string };

/** 一度に読む件数。多すぎると画面が重く、少なすぎるとめくる回数が増える */
const PAGE = 50;

/** 名簿の絞り込みに使う、選ぶ欄の見た目。三つ並ぶので一か所にまとめる */
const rSelect =
  "w-full rounded-lg bg-slate-100 px-2 py-2 text-[11px] outline-none focus:bg-white focus:ring-2 focus:ring-blue-500";

/** ドメイン名確認の中の、身分の並び */
const DOMAIN_KINDS: { id: DomainKind; label: string; note: string }[] = [
  {
    id: "student",
    label: "学生",
    note: "このドメインの人だけを学生として扱います。アドレスに入っている7桁の数字が学籍番号になり、名簿の学籍番号と合っているかも見ます。",
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
  const T = useAdminT();
  const [role, setRole] = useState<Role | null>(null);
  const [loading, setLoading] = useState(supabaseReady);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [counts, setCounts] = useState<Counts | null>(null);

  /** 登録している人を見る欄 */
  const [listOpen, setListOpen] = useState(false);
  const [listKind, setListKind] = useState<PeopleKind>("student");

  /* 名簿の中を一人ずつ見る欄 */
  const [rOpen, setROpen] = useState(false);
  const [rKind, setRKind] = useState<RosterKind>("student");
  const [rStudents, setRStudents] = useState<RosterStudent[]>([]);
  const [rStaff, setRStaff] = useState<RosterStaff[]>([]);
  const [rTotal, setRTotal] = useState(0);
  const [rPage, setRPage] = useState(0);
  const [rBusy, setRBusy] = useState(false);
  const [rq, setRq] = useState("");
  /** 学年で絞る。null なら絞らない */
  const [rGrade, setRGrade] = useState<number | null>(null);
  /** 学科の記号で絞る。学生は自分の学科、教授は担当学科を見る */
  const [rDept, setRDept] = useState<string | null>(null);
  /** クラス（1〜10）で絞る */
  const [rClassNo, setRClassNo] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [people, setPeople] = useState<Person[]>([]);
  const [total, setTotal] = useState(0);
  const [listBusy, setListBusy] = useState(false);
  /** 身分ごとの人数。見せない相手には返ってこない */
  const [peopleCounts, setPeopleCounts] = useState<Record<string, number> | null>(null);

  /** 学部と学科。学生と課外活動リーダーは、ここで絞ってから見る */
  const [facs, setFacs] = useState<Faculty[]>([]);
  const [depts, setDepts] = useState<Dept[]>([]);
  const [facId, setFacId] = useState<number | null>(null);
  const [deptId, setDeptId] = useState<number | null>(null);

  /** ドメイン名確認 */
  const [domainOpen, setDomainOpen] = useState(false);
  const [domainKind, setDomainKind] = useState<DomainKind>("student");
  const [domains, setDomains] = useState<Domains | null>(null);
  const [domainOn, setDomainOn] = useState<DomainOn | null>(null);
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
    /** 学科。E列と同じもの */
    class_code: "",
    /** クラス（1〜10）。F列と同じもの */
    class_no: "",
    seat_no: "",
    student_no: "",
    number: "",
    /** 教授の担当学科。I〜N列と同じもの */
    depts: [] as string[],
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

    if (canReadRoster(r)) {
      const { data: c } = await supabase.rpc("roster_counts");
      if (c) setCounts(c as Counts);
      const { data: pc } = await supabase.rpc("people_counts");
      if (pc) setPeopleCounts(pc as Record<string, number>);

      /*
       * 学部と学科。学生と課外活動リーダーを、学科ごとに見るために使う。
       * profiles.class_code は departments.code と同じ並び（KM・CC …）。
       */
      const [f, d] = await Promise.all([
        supabase.from("faculties").select("id, name").order("sort_order"),
        supabase.from("departments").select("id, faculty_id, name, code").order("sort_order"),
      ]);
      setFacs((f.data as Faculty[]) ?? []);
      setDepts((d.data as Dept[]) ?? []);
    }
    if (canManageAll(r)) {
      const { data: d } = await supabase.rpc("get_domains");
      if (d) {
        // ドメインは文字、見るかどうかは真偽。混ぜて持つので unknown で受ける
        const got = d as Record<string, unknown>;
        const text = (k: string) => (typeof got[k] === "string" ? (got[k] as string) : "");
        setDomains({ student: text("student"), teacher: text("teacher"), other: text("other") });
        setDomainOn({
          // 読めないときは「あり」に倒す。うっかり全部通すほうが危ない
          student: got.student_on !== false,
          teacher: got.teacher_on !== false,
          other: got.other_on !== false,
        });
      }
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /* ---------------- 名簿の中を、一人ずつ見る ---------------- */

  /**
   * 名簿を読み直す。
   *
   * ★これは「入れておいた突き合わせ用の表」のほう。
   *   下の「登録している人を見る」（list_people）とは別のもの。
   *   あちらは席がある人、こちらは名簿に入れた人。
   *   入れたはずの人が名簿にいるかを確かめるのは、こちら。
   *
   * 学生は学年・学科・クラスで、教授は担当学科で絞れる。
   * 何千人もいると、探す言葉だけでは目当ての一人に届かない。
   */
  const loadRoster = useCallback(
    /**
     * keepMsg … 出ている知らせを消さない。
     *   消したあとに引き直すときに使う。消さないと
     *   「消しました」がその場で見えなくなる。
     */
    async (kind: RosterKind, at: number, keepMsg = false) => {
      if (!supabaseReady) return;
      setRBusy(true);
      if (!keepMsg) setMsg(null);
      try {
        const supabase = createClient();
        if (kind === "student") {
          const { data, error } = await supabase.rpc("roster_list_students", {
            p_q: rq.trim(),
            p_limit: PAGE,
            p_offset: at * PAGE,
            p_grade: rGrade ?? 0,
            p_class_code: rDept ?? "",
            p_class_no: rClassNo ?? 0,
          });
          if (error) throw error;
          const rows = (data as RosterStudent[]) ?? [];
          setRStudents(rows);
          setRStaff([]);
          setRTotal(rows.length > 0 ? Number(rows[0].total) : 0);
        } else {
          const { data, error } = await supabase.rpc("roster_list_staff", {
            p_kind: kind,
            p_q: rq.trim(),
            p_limit: PAGE,
            p_offset: at * PAGE,
            // 担当学科で絞れるのは教授だけ。その他は持っていない
            p_dept: kind === "teacher" ? (rDept ?? "") : "",
          });
          if (error) throw error;
          const rows = (data as RosterStaff[]) ?? [];
          setRStaff(rows);
          setRStudents([]);
          setRTotal(rows.length > 0 ? Number(rows[0].total) : 0);
        }
      } catch (e) {
        setRStudents([]);
        setRStaff([]);
        setRTotal(0);
        setMsg({
          kind: "err",
          text:
            e instanceof Error
              ? `${e.message}（base/12_roster_import.sql を入れ直していない場合は、先に入れてください）`
              : String(e),
        });
      } finally {
        setRBusy(false);
      }
    },
    [rq, rGrade, rDept, rClassNo],
  );

  /* 絞り込みや探す言葉を変えたら、少し待ってから引き直す */
  useEffect(() => {
    if (!rOpen) return;
    const id = window.setTimeout(() => {
      setRPage(0);
      void loadRoster(rKind, 0);
    }, 250);
    return () => window.clearTimeout(id);
  }, [rOpen, rKind, loadRoster]);

  /* ---------------- 登録している人を見る ---------------- */

  /** いま見ている身分の決まり（学部・学科で絞るかどうか） */
  const kindDef = PEOPLE_KINDS.find((k) => k.id === listKind) ?? PEOPLE_KINDS[0];

  /**
   * 登録している人を読み直す。
   *
   * profiles の表そのものは、自分の行しか読めない。
   * データベース側の関数（list_people）を通したときだけ、
   * その人に見せてよい分が返る。
   *
   * 何件あるかは、行と一緒に total として返ってくる。
   * 数えるためだけの往復を増やさないため。
   */
  const loadList = useCallback(
    async (kind: PeopleKind, dept: number | null, word: string, at: number) => {
      if (!supabaseReady) return;
      setListBusy(true);
      setMsg(null);
      try {
        const { data, error } = await createClient().rpc("list_people", {
          p_kind: kind,
          p_dept_id: dept,
          p_q: word,
          p_limit: PAGE,
          p_offset: at * PAGE,
        });
        if (error) throw error;
        const rows = (data as Person[]) ?? [];
        setPeople(rows);
        setTotal(rows.length > 0 ? Number(rows[0].total) : 0);
      } catch (e) {
        setPeople([]);
        setTotal(0);
        setMsg({
          kind: "err",
          text:
            e instanceof Error
              ? `${e.message}（base/15_people.sql をまだ入れていない場合は、先に入れてください）`
              : String(e),
        });
      } finally {
        setListBusy(false);
      }
    },
    [],
  );

  /**
   * 探す言葉や絞り込みを変えたら、少し待ってから引き直す。
   *
   * 1文字打つたびに引くと、人数が多いほど無駄な往復が増える。
   * 打ち終わってから引くようにして、めくっている位置も先頭へ戻す。
   */
  useEffect(() => {
    if (!listOpen) return;
    const id = window.setTimeout(() => {
      setPage(0);
      void loadList(listKind, kindDef.byDept ? deptId : null, q.trim(), 0);
    }, 250);
    return () => window.clearTimeout(id);
  }, [listOpen, listKind, deptId, q, kindDef.byDept, loadList]);

  /**
   * 名簿（突き合わせ用の表）から一人消す。入れられる人だけ。
   *
   * ★消えるのは名簿のほうで、その人の席は消えない。
   *   席を消すのは承認の画面（/admin）の役目。
   */
  const removeFromRoster = async (
    kind: "student" | "staff",
    key: string,
    label: string,
  ) => {
    if (
      !window.confirm(
        [
          `${label} を名簿から消します。`,
          "",
          "消えるのは突き合わせ用の名簿だけで、その人の席は残ります。",
          "元には戻せません。よろしいですか？",
        ].join(BR),
      )
    )
      return;
    setListBusy(true);
    try {
      const { data, error } = await createClient().rpc("roster_remove", {
        p_kind: kind,
        p_key: key,
      });
      if (error) throw error;
      setMsg(
        (data as number) > 0
          ? { kind: "ok", text: `${label} を名簿から消しました。` }
          : { kind: "err", text: T("その人は名簿にいませんでした。") },
      );
      await load();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setListBusy(false);
    }
  };

  /**
   * 名簿の一覧から、その場で一人消す。
   *
   * 消したあとは一覧を引き直す。消えた人が並んだままだと、
   * もう一度押してしまう。知らせ（消しました）は残す。
   *
   * 最後の一人を消してその頁が空になったら、一つ前の頁へ戻る。
   * 空の頁を見せられても、何が起きたのか分からないため。
   */
  const removeShown = async (
    kind: "student" | "staff",
    key: string,
    label: string,
  ) => {
    await removeFromRoster(kind, key, label);
    const at = rStudents.length + rStaff.length <= 1 ? Math.max(0, rPage - 1) : rPage;
    setRPage(at);
    await loadRoster(rKind, at, true);
  };

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
        const o = { row: i + 1, depts: [] as string[] } as Sending;
        COLS.forEach((c, n) => {
          const v = (cells[n] ?? "").trim();
          // 担当学科（I〜N）はまとめて一つの並びに。空けてある列は飛ばす
          if (isDeptCol(c)) {
            if (v !== "") o.depts.push(v);
          } else {
            o[c] = v;
          }
        });
        return o;
      });
      // まったくの空行は送らない
      const kept = sending.filter(
        (s) => s.depts.length > 0 || COLS.some((c) => !isDeptCol(c) && s[c] !== ""),
      );
      setFileName(file.name);
      setRows(kept);
      if (kept.length === 0) setMsg({ kind: "err", text: T("中身のある行がありませんでした") });
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
      // 見ている最中なら、入れたものがそのまま並ぶようにする
      if (listOpen) await loadList(listKind, kindDef.byDept ? deptId : null, q.trim(), page);
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
          class_no: "",
          seat_no: "",
          student_no: "",
          number: "",
          depts: [],
        }));
        await load();
        if (listOpen) await loadList(listKind, kindDef.byDept ? deptId : null, q.trim(), page);
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
  /**
   * その身分のドメインを「あり／なし」で切り替える。
   *
   * ■ 「なし」は「空」とは違う
   *   空   … まだ決めていない。学生と教授は、決まるまで人に回す
   *   なし … 見ないと決めた。合っていなくても通す
   *
   * ■ 「なし」にするほうだけ二度たずねる
   *   守りを緩める向きなので、間違えると誰でも入れるようになる。
   *   「あり」に戻すのは締める向きなので、一度でよい。
   */
  const changeDomainCheck = async (next: boolean) => {
    const kind = DOMAIN_KINDS.find((k) => k.id === domainKind);
    if (!kind) return;

    if (!next) {
      const first = window.confirm(
        [
          `${kind.label}のドメインを「なし」にします。`,
          "",
          "この身分の人は、ドメインが合っていなくても通るようになります。",
          "外部のアドレスの人を受け入れたいときのための設定です。",
          "",
          "続けますか？",
        ].join(BR),
      );
      if (!first) return;
      const second = window.confirm(
        [
          "本当に「なし」にしますか？",
          "",
          "これが最後の確認です。",
          "一つでも「なし」があると、席を作るところでもドメインを見なくなります",
          "（席を作る時点では、その人がどの身分かまだ分からないため）。",
        ].join(BR),
      );
      if (!second) return;
    }

    setMsg(null);
    setBusy(true);
    try {
      const { error } = await createClient().rpc("set_domain_check", {
        p_kind: domainKind,
        p_on: next,
      });
      if (error) throw error;
      setDomainOn((d) => (d ? { ...d, [domainKind]: next } : d));
      setMsg({
        kind: "ok",
        text:
          `${kind.label}のドメインを「${next ? "あり" : "なし"}」にしました。` +
          (next ? "" : "この身分は、ドメインが合っていなくても通ります。"),
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

  if (loading) return <Shell>{T("読み込み中…")}</Shell>;

  if (!canReadRoster(role))
    return (
      <Shell>
        <p className="text-sm text-slate-700">{T("この画面は、いまの権限では使えません。")}</p>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
          {T("名簿を見られるのは、教授（レベル2）・副管理者（2.1・2.2）・管理者です。")}
          {T("入れる・消すのは、副管理者と管理者だけです。")}
        </p>
        <Link href="/login" className="mt-3 inline-block text-sm font-bold text-blue-600">
          {T("ログインへ")}
        </Link>
      </Shell>
    );

  /** 入れる・消す・ドメインを変える。教授はここに入らない */
  const canWrite = canManageAll(role);
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <Shell wide>
      <AdminHeader title={T("名簿")} />
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
        <div className="text-[11px] font-bold text-slate-500">{T("いま入っている名簿")}</div>
        <div className="mt-1 flex flex-wrap gap-3 text-xs font-bold text-slate-800">
          <span>学生 {counts?.students ?? "—"}</span>
          {canWrite && (
            <>
              <span>教授 {counts?.teachers ?? "—"}</span>
              <span>その他 {counts?.others ?? "—"}</span>
            </>
          )}
        </div>
        {!canWrite && (
          <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
            教授（レベル2）が見られるのは、<b>{T("学生の名簿だけ")}</b>です。
            {T("教職員の名簿には8桁の番号が並ぶので、副管理者と管理者だけが見られます。")}
          </p>
        )}
      </div>

      {/*
        名簿の中を、一人ずつ見る。

        ★こちらは「入れておいた突き合わせ用の表」。
          下の「登録している人を見る」とは別のもの。
          入れたはずの人が名簿にいるか、中身が合っているかを
          確かめるのは、こちら。

        学生は学年・学科・クラスで、教授は担当学科で絞れる。
        何千人もいると、探す言葉だけでは目当ての一人に届かない。
      */}
      <section className="mt-4 rounded-xl border border-slate-200 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-bold text-slate-900">{T("名簿の中を見る")}</div>
          <button
            onClick={() => {
              const next = !rOpen;
              setROpen(next);
              if (next) {
                setRPage(0);
                void loadRoster(rKind, 0);
              }
            }}
            className="rounded-lg bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-600 transition hover:bg-slate-200 active:scale-95"
          >
            {rOpen ? T("閉じる") : T("名簿を開く")}
          </button>
        </div>

        {rOpen && (
          <div className="mt-2">
            {/* 身分。教授（レベル2）が見られるのは学生の名簿だけ */}
            {canWrite ? (
              <div className="grid grid-cols-3 gap-1.5">
                {ROSTER_KINDS.map((k) => (
                  <button
                    key={k.id}
                    onClick={() => {
                      setRKind(k.id);
                      setRPage(0);
                      // 身分を変えたら絞り込みは外す。前の条件が残ると
                      // 「誰もいない」に見えて、外し方が分からなくなる
                      setRGrade(null);
                      setRDept(null);
                      setRClassNo(null);
                    }}
                    className={`rounded-lg px-2 py-2 text-[11px] font-bold transition active:scale-95 ${
                      rKind === k.id
                        ? "bg-slate-900 text-white"
                        : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                    }`}
                  >
                    {T(k.label)}
                    <span className="mt-0.5 block text-[9px] font-normal opacity-70">
                      {k.id === "student"
                        ? (counts?.students ?? 0)
                        : k.id === "teacher"
                          ? (counts?.teachers ?? 0)
                          : (counts?.others ?? 0)}{" "}
                      {T("人")}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-[10px] leading-relaxed text-slate-500">
                教授（レベル2）が見られるのは<b>{T("学生の名簿だけ")}</b>です。
              </p>
            )}

            {/* 学生の絞り込み。学年 → 学科 → クラス */}
            {rKind === "student" && (
              <div className="mt-2 grid grid-cols-3 gap-1.5">
                <select
                  value={rGrade ?? ""}
                  onChange={(e) => setRGrade(e.target.value ? Number(e.target.value) : null)}
                  className={rSelect}
                >
                  <option value="">{T("学年（すべて）")}</option>
                  {GRADES.map((g) => (
                    <option key={g} value={g}>
                      {g}
                      {T("年")}
                    </option>
                  ))}
                </select>
                <select
                  value={rDept ?? ""}
                  onChange={(e) => setRDept(e.target.value || null)}
                  className={rSelect}
                >
                  <option value="">{T("学科（すべて）")}</option>
                  {CLASS_CODES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code}　{T(c.name)}
                    </option>
                  ))}
                </select>
                <select
                  value={rClassNo ?? ""}
                  onChange={(e) => setRClassNo(e.target.value ? Number(e.target.value) : null)}
                  className={rSelect}
                >
                  <option value="">{T("クラス（すべて）")}</option>
                  {CLASS_NOS.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* 教授の絞り込み。担当学科 */}
            {rKind === "teacher" && (
              <select
                value={rDept ?? ""}
                onChange={(e) => setRDept(e.target.value || null)}
                className={`${rSelect} mt-2`}
              >
                <option value="">{T("担当学科（すべて）")}</option>
                {CLASS_CODES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code}　{T(c.name)}
                  </option>
                ))}
              </select>
            )}

            <input
              value={rq}
              onChange={(e) => setRq(e.target.value)}
              autoComplete="off"
              placeholder={
                rKind === "student" ? "名前・学籍番号・アドレスで探す" : "名前・アドレス・番号で探す"
              }
              className="mt-2 w-full rounded-lg bg-slate-100 px-3 py-2 text-xs outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
            />

            <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
              <span className="font-bold">
                {rBusy ? T("探しています…") : `${rTotal} ${T("人")}`}
              </span>
              {rTotal > PAGE && (
                <span className="ml-auto flex items-center gap-1.5">
                  <button
                    onClick={() => {
                      const at = Math.max(0, rPage - 1);
                      setRPage(at);
                      void loadRoster(rKind, at);
                    }}
                    disabled={rPage === 0 || rBusy}
                    className="rounded-md bg-slate-100 px-2 py-1 font-bold text-slate-600 disabled:text-slate-300"
                  >
                    {T("前")}
                  </button>
                  <span>
                    {rPage + 1} / {Math.max(1, Math.ceil(rTotal / PAGE))}
                  </span>
                  <button
                    onClick={() => {
                      const at = Math.min(Math.ceil(rTotal / PAGE) - 1, rPage + 1);
                      setRPage(at);
                      void loadRoster(rKind, at);
                    }}
                    disabled={rPage >= Math.ceil(rTotal / PAGE) - 1 || rBusy}
                    className="rounded-md bg-slate-100 px-2 py-1 font-bold text-slate-600 disabled:text-slate-300"
                  >
                    {T("次")}
                  </button>
                </span>
              )}
            </div>

            {/* 一人ぶんの中身は、名簿が持っているものを全部出す */}
            <ul className="mt-1.5 max-h-96 divide-y divide-slate-100 overflow-y-auto rounded-lg bg-slate-50">
              {rKind === "student"
                ? rStudents.map((s) => (
                    <li key={s.student_no} className="flex items-start gap-2 px-2.5 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-1.5">
                          {s.seat_no !== null && (
                            <span className="shrink-0 rounded bg-slate-200 px-1.5 py-0.5 font-mono text-[10px] font-bold text-slate-700">
                              {s.seat_no}
                            </span>
                          )}
                          <span className="truncate text-xs font-bold text-slate-800">
                            {s.full_name || "（名前なし）"}
                          </span>
                        </div>
                        <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-slate-500">
                          {s.grade > 0 && <span>{s.grade}年</span>}
                          {s.class_code && <span>{s.class_code}</span>}
                          {!!s.class_no && (
                            <span>
                              {T("クラス")}
                              {s.class_no}
                            </span>
                          )}
                          <span className="font-mono">学籍番号 {s.student_no}</span>
                        </div>
                        <div className="truncate font-mono text-[10px] text-slate-400">{s.email}</div>
                      </div>
                      {/* 消せるのは 2.1・2.2・管理者だけ。教授には出さない */}
                      {canWrite && (
                        <button
                          onClick={() =>
                            void removeShown(
                              "student",
                              s.student_no,
                              `${s.full_name || "名前なし"}（${s.student_no}）`,
                            )
                          }
                          disabled={rBusy || listBusy}
                          className="shrink-0 rounded-lg bg-white px-2 py-1.5 text-[10px] font-bold text-red-600 shadow-sm transition hover:bg-red-50 active:scale-95 disabled:text-slate-300"
                        >
                          {T("消す")}
                        </button>
                      )}
                    </li>
                  ))
                : rStaff.map((t) => (
                    <li key={t.email} className="flex items-start gap-2 px-2.5 py-2">
                      <div className="min-w-0 flex-1">
                        <span className="truncate text-xs font-bold text-slate-800">
                          {t.full_name || "（名前なし）"}
                        </span>
                        <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-slate-500">
                          <span className="font-mono">番号 {t.number}</span>
                          {(t.dept_codes ?? []).length > 0 && (
                            <span>
                              {T("担当")} {(t.dept_codes ?? []).join("・")}
                            </span>
                          )}
                        </div>
                        <div className="truncate font-mono text-[10px] text-slate-400">{t.email}</div>
                      </div>
                      {canWrite && (
                        <button
                          onClick={() =>
                            void removeShown("staff", t.email, `${t.full_name || t.email}`)
                          }
                          disabled={rBusy || listBusy}
                          className="shrink-0 rounded-lg bg-white px-2 py-1.5 text-[10px] font-bold text-red-600 shadow-sm transition hover:bg-red-50 active:scale-95 disabled:text-slate-300"
                        >
                          {T("消す")}
                        </button>
                      )}
                    </li>
                  ))}

              {!rBusy && rStudents.length === 0 && rStaff.length === 0 && (
                <li className="px-2.5 py-6 text-center text-[11px] leading-relaxed text-slate-500">
                  {rq.trim() || rGrade || rDept || rClassNo
                    ? T("見つかりませんでした。")
                    : T("この身分は、まだ名簿に入っていません。")}
                </li>
              )}
            </ul>
          </div>
        )}
      </section>

      {/*
        登録している人を見る。

        ★名簿（突き合わせ用の表）とは別のもの。
          ここに出るのは、席があって権限が付いている人。
          誰が実際に使っているのかを見たいときは、こちら。

        身分で五つに分ける。学生と課外活動リーダーは学年とクラスを
        持っているので、学部 → 学科 と選んでから、名列番号順に並べる。
        教授・食堂・その他は、氏名の順に並べる。

        表そのものは開かない。データベース側の関数（list_people）を
        通したときだけ、その人に見せてよい分が返る。
        教授には学生のぶんしか返らない。
      */}
      <section className="mt-4 rounded-xl border border-slate-200 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-bold text-slate-900">{T("登録している人を見る")}</div>
          <button
            onClick={() => {
              const next = !listOpen;
              setListOpen(next);
              if (next) {
                setPage(0);
                void loadList(listKind, kindDef.byDept ? deptId : null, q.trim(), 0);
              }
            }}
            className="rounded-lg bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-600 transition hover:bg-slate-200 active:scale-95"
          >
            {listOpen ? "閉じる" : "一覧を見る"}
          </button>
        </div>

        {listOpen && (
          <div className="mt-2">
            {/* 身分。教授には学生のぶんしか無いので、切り替えを出さない */}
            {canWrite ? (
              <div className="grid grid-cols-3 gap-1.5">
                {PEOPLE_KINDS.map((k) => (
                  <button
                    key={k.id}
                    onClick={() => {
                      setListKind(k.id);
                      setPage(0);
                      // 身分を変えたら、絞り込みも外す。前の学科が残ると
                      // 「誰もいない」に見えて、外し方が分からなくなる
                      setFacId(null);
                      setDeptId(null);
                    }}
                    className={`rounded-lg px-2 py-2 text-[11px] font-bold leading-tight transition active:scale-95 ${
                      listKind === k.id
                        ? "bg-slate-900 text-white"
                        : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                    }`}
                  >
                    {k.label}
                    <span className="mt-0.5 block text-[9px] font-normal opacity-70">
                      {peopleCounts?.[k.id] ?? 0} 人
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-[10px] leading-relaxed text-slate-500">
                教授（レベル2）が見られるのは<b>{T("学生だけ")}</b>です。
              </p>
            )}

            {/*
              学部 → 学科。学年とクラスを持っている身分でだけ出す。
              profiles のクラス記号（CC・KM …）は departments.code と同じ並び。
            */}
            {kindDef.byDept && (
              <div className="mt-2 grid grid-cols-2 gap-1.5">
                <select
                  value={facId ?? ""}
                  onChange={(e) => {
                    setFacId(e.target.value ? Number(e.target.value) : null);
                    setDeptId(null);
                  }}
                  className="w-full rounded-lg bg-slate-100 px-2.5 py-2 text-[11px] outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">{T("学部（すべて）")}</option>
                  {facs.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
                <select
                  value={deptId ?? ""}
                  onChange={(e) => setDeptId(e.target.value ? Number(e.target.value) : null)}
                  disabled={facId === null}
                  className="w-full rounded-lg bg-slate-100 px-2.5 py-2 text-[11px] outline-none focus:bg-white focus:ring-2 focus:ring-blue-500 disabled:text-slate-400"
                >
                  <option value="">
                    {facId === null ? "先に学部を選ぶ" : "学科（すべて）"}
                  </option>
                  {depts
                    .filter((d) => d.faculty_id === facId)
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                        {d.code ? `（${d.code}）` : ""}
                      </option>
                    ))}
                </select>
              </div>
            )}

            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              autoComplete="off"
              placeholder={
                kindDef.byDept
                  ? "名前・学籍番号・アドレス・クラスで探す"
                  : "名前・アドレスで探す"
              }
              className="mt-2 w-full rounded-lg bg-slate-100 px-3 py-2 text-xs outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
            />

            <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
              <span className="font-bold">
                {listBusy ? "探しています…" : `${total} 人`}
              </span>
              <span className="text-slate-400">
                {kindDef.byDept ? T("学年 → 学科 → クラス → 名列番号の順") : T("氏名の順")}
              </span>
              {total > PAGE && (
                <span className="ml-auto flex items-center gap-1.5">
                  <button
                    onClick={() => {
                      const at = Math.max(0, page - 1);
                      setPage(at);
                      void loadList(listKind, kindDef.byDept ? deptId : null, q.trim(), at);
                    }}
                    disabled={page === 0 || listBusy}
                    className="rounded-md bg-slate-100 px-2 py-1 font-bold text-slate-600 disabled:text-slate-300"
                  >
                    {T("前")}
                  </button>
                  <span>
                    {page + 1} / {pages}
                  </span>
                  <button
                    onClick={() => {
                      const at = Math.min(pages - 1, page + 1);
                      setPage(at);
                      void loadList(listKind, kindDef.byDept ? deptId : null, q.trim(), at);
                    }}
                    disabled={page >= pages - 1 || listBusy}
                    className="rounded-md bg-slate-100 px-2 py-1 font-bold text-slate-600 disabled:text-slate-300"
                  >
                    {T("次")}
                  </button>
                </span>
              )}
            </div>

            {/*
              一人ぶんの中身は、持っているものを全部出す。
              学生は学籍番号と学年・学科・クラス・名列番号、
              教授は8桁の番号と担当学科。持っていない欄は出さない。
            */}
            <ul className="mt-1.5 max-h-96 divide-y divide-slate-100 overflow-y-auto rounded-lg bg-slate-50">
              {people.map((p) => (
                <li key={p.id} className="px-2.5 py-2">
                  <div className="flex items-baseline gap-1.5">
                    {p.seat_no !== null && (
                      <span className="shrink-0 rounded bg-slate-200 px-1.5 py-0.5 font-mono text-[10px] font-bold text-slate-700">
                        {p.seat_no}
                      </span>
                    )}
                    <span className="truncate text-xs font-bold text-slate-800">
                      {p.full_name || "（名前なし）"}
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-slate-500">
                    {p.grade > 0 && <span>{p.grade}年</span>}
                    {p.class_code && <span>{p.class_code}</span>}
                    {/* クラス（1〜10）。まだ入れていない人には出さない */}
                    {!!p.class_no && (
                      <span>
                        {T("クラス")}
                        {p.class_no}
                      </span>
                    )}
                    {p.seat_no !== null && <span>{p.seat_no}番</span>}
                    {p.student_no && (
                      <span className="font-mono">学籍番号 {p.student_no}</span>
                    )}
                    {p.staff_no && <span className="font-mono">番号 {p.staff_no}</span>}
                    {/* 教授の担当学科 */}
                    {(p.dept_codes ?? []).length > 0 && (
                      <span>
                        {T("担当")} {(p.dept_codes ?? []).join("・")}
                      </span>
                    )}
                  </div>
                  <div className="truncate font-mono text-[10px] text-slate-400">{p.email}</div>
                </li>
              ))}

              {!listBusy && people.length === 0 && (
                <li className="px-2.5 py-6 text-center text-[11px] leading-relaxed text-slate-500">
                  {q.trim() || deptId !== null
                    ? "見つかりませんでした。"
                    : "この身分の人は、まだ登録されていません。"}
                </li>
              )}
            </ul>
          </div>
        )}
      </section>

      {/*
        ここから下は、入れる・変えるための欄。教授には出さない。

        出さないのは親切であって、守っているのはデータベース側。
        教授が直接この関数を呼んでも、can_manage_roster が断る。
      */}
      {!canWrite && (
        <p className="mt-4 rounded-xl bg-slate-50 p-3 text-[10px] leading-relaxed text-slate-500">
          {T("名簿に入れる・消す、ドメインを変えるといった操作は、")}
          {T("副管理者（2.1・2.2）と管理者だけができます。")}
        </p>
      )}

      {/*
        ドメイン名確認。

        ふだんは畳んでおく。開くと、身分を選んで、その身分の
        ドメインだけを見て・直せる。三つまとめて保存できる形にすると、
        直したつもりのないものまで上書きしてしまう。

        変えるときは二度たずねる。ここを間違えると、正しい人が
        申請できなくなったり、名簿が一行も入らなくなったりする。
      */}
      {canWrite && (
      <section className="mt-4 rounded-xl border border-slate-200 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-bold text-slate-900">{T("ドメイン名確認")}</div>
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

                  {/*
                    ドメインを見るか、見ないか。

                    「空（決めていない）」とは別のもの。
                      空   … まだ決めていない。学生と教授は人に回す
                      なし … 見ないと決めた。合っていなくても通す
                    外部のアドレスの人を受け入れたいときに使う。
                  */}
                  <label className="mt-2 block text-[10px] font-bold text-slate-500">
                    {T("ドメインを見るか")}
                  </label>
                  <div className="mt-0.5 grid grid-cols-2 gap-1.5">
                    {([true, false] as const).map((on) => {
                      const now = domainOn?.[domainKind] !== false;
                      return (
                        <button
                          key={String(on)}
                          onClick={() => void changeDomainCheck(on)}
                          disabled={busy || now === on}
                          className={`rounded-lg px-2 py-2 text-[11px] font-bold transition active:scale-95 ${
                            now === on
                              ? on
                                ? "bg-slate-900 text-white"
                                : "bg-amber-500 text-white"
                              : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                          }`}
                        >
                          {on ? "あり" : "なし"}
                          <span className="mt-0.5 block text-[9px] font-normal opacity-80">
                            {on ? "このドメインだけ通す" : "合っていなくても通す"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {domainOn?.[domainKind] === false && (
                    <p className="mt-1 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[10px] leading-relaxed text-amber-900">
                      いまは<b>{T("「なし」")}</b>です。{kind.label}は、ドメインが合っていなくても通ります。
                      <br />
                      {T("一つでも「なし」があると、席を作るところでもドメインを見ません")}
                      {T("（その時点では、まだ身分が分からないため）。")}
                    </p>
                  )}

                  <label className="mt-2 block text-[10px] font-bold text-slate-500">
                    {T("いま決まっているもの")}
                  </label>
                  <p className="mt-0.5 rounded-lg bg-slate-100 px-3 py-2 font-mono text-xs text-slate-800">
                    {domainOn?.[domainKind] === false
                      ? "（見ていません）"
                      : saved || "（決めていません）"}
                  </p>

                  <label className="mt-2 block text-[10px] font-bold text-slate-500">
                    {T("直す")}
                  </label>
                  <input
                    value={draftDomain}
                    onChange={(e) => setDraftDomain(e.target.value)}
                    autoComplete="off"
                    placeholder="example.ac.jp"
                    className="mt-0.5 w-full rounded-lg bg-slate-100 px-3 py-2 font-mono text-xs outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
                  />
                  <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
                    {T("空にすると「決めていない」に戻ります。")}
                    <br />
                    <b>{T("いまログインしている人は、変えても入ったままです。")}</b>
                    {T("この設定は、これから席を作る人にだけ効きます。")}
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
      )}

      {/* xlsx を選ぶ */}
      {canWrite && (
      <section className="mt-4 rounded-xl border border-slate-200 p-3">
        <div className="text-xs font-bold text-slate-900">{T("xlsx から取り込む")}</div>
        <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
          1行が1人。<b>{T("A 身分（学生／教授／その他）・B メールアドレス・C 名前")}</b>
          {T("は全員に要ります。")}
          <br />
          {T("そのあとは身分で変わります。")}
        </p>
        <ul className="mt-1 space-y-0.5 rounded-lg bg-slate-50 p-2 text-[10px] leading-relaxed text-slate-600">
          <li>
            <b className="text-slate-900">{T("学生")}</b>　A B C ＋{" "}
            <b>{T("D 学年・E 学科・F クラス（1〜10）・G 名列番号・H 学籍番号")}</b>
          </li>
          <li>
            <b className="text-slate-900">{T("教授")}</b>　A B C ＋{" "}
            <b>{T("I〜N 担当学科（いくつでも。空けてよい）・O 8桁の番号")}</b>
          </li>
          <li>
            <b className="text-slate-900">{T("その他")}</b>　A B C ＋ <b>{T("O 8桁の番号")}</b>
          </li>
        </ul>
        <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
          <b>{T("E 学科")}</b>
          {T("は KM・CC などの記号です。")}
          <b>{T("F クラス")}</b>
          {T("は、同じ学科・学年の中で分かれている組（1〜10）。")}
          <br />
          <b>{T("H 学籍番号")}</b>
          {T("は、アドレスに書いてある")}
          <b>{T("7桁の数字")}</b>です
          {T("（c1234567@… なら 1234567）。頭の一文字ごと書いてあっても構いません。")}
          <br />
          {T("見出しの行があっても構いません（A列が三択でないので自動で飛ばされます）。")}
          <br />
          <span className="text-slate-400">
            {T("ファイルそのものはどこにも送りません。この端末で読み取った中身だけを送ります。")}
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
                  {r.class_code ? ` / ${r.class_code}` : ""}
                  {r.class_no ? `-${r.class_no}` : ""}
                  {r.student_no ? ` / ${r.student_no}` : ""}
                  {r.depts.length > 0 ? ` / ${r.depts.join("・")}` : ""}
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
      )}

      {/*
        一人ずつ手で入れる。

        xlsx を作るまでもない一人や、あとから増えた一人のため。
        通す・弾くの判定は xlsx と同じもの（import_roster）を通す。
        ここだけ甘い決まりにすると、名簿の中身が揃わなくなる。
      */}
      {canWrite && (
      <section className="mt-4 rounded-xl border border-slate-200 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-bold text-slate-900">{T("一人ずつ手で入れる")}</div>
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
                <div className="grid grid-cols-4 gap-2">
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
                  <Field label="学科">
                    <input
                      value={one.class_code}
                      onChange={(e) =>
                        setOne((o) => ({ ...o, class_code: e.target.value.toUpperCase().slice(0, 4) }))
                      }
                      placeholder="CC"
                      className={manualInput}
                    />
                  </Field>
                  <Field label="クラス">
                    <input
                      value={one.class_no}
                      onChange={(e) =>
                        setOne((o) => ({
                          ...o,
                          class_no: e.target.value.replace(/\D/g, "").slice(0, 2),
                        }))
                      }
                      inputMode="numeric"
                      placeholder="1〜10"
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
                <Field label="学籍番号（7桁の数字）">
                  <input
                    value={one.student_no}
                    onChange={(e) => setOne((o) => ({ ...o, student_no: e.target.value.trim() }))}
                    autoComplete="off"
                    placeholder={studentNoOf(one.email) || "1234567"}
                    className={manualInput}
                  />
                  <p className="mt-0.5 text-[10px] leading-relaxed text-slate-400">
                    {T("メールアドレスに書いてある7桁の数字です。")}
                    {studentNoOf(one.email) && (
                      <>
                        <br />
                        このアドレスなら <b className="font-mono">{studentNoOf(one.email)}</b> です。
                      </>
                    )}
                    <br />
                    {T("頭の一文字ごと（c1234567）打っても構いません。数字だけを取り出してしまいます。")}
                  </p>
                  {studentNoOf(one.email) && !one.student_no && (
                    <button
                      onClick={() => setOne((o) => ({ ...o, student_no: studentNoOf(o.email) }))}
                      className="mt-1 rounded-lg bg-slate-100 px-2.5 py-1 text-[10px] font-bold text-slate-600 transition hover:bg-slate-200 active:scale-95"
                    >
                      アドレスから入れる（{studentNoOf(one.email)}）
                    </button>
                  )}
                </Field>
              </>
            ) : (
              <>
                <Field label="8桁の番号">
                  <input
                    value={one.number}
                    onChange={(e) =>
                      setOne((o) => ({ ...o, number: e.target.value.trim().slice(0, 8) }))
                    }
                    autoComplete="off"
                    placeholder="12345678"
                    className={`${manualInput} text-center tracking-[0.3em]`}
                  />
                </Field>

                {/*
                  担当学科（I〜N列）。教授だけ。
                  その他の人には受け取ってもらえないので、出さない。
                */}
                {one.kind === "教授" && (
                  <Field label="担当学科（いくつでも）">
                    <input
                      value={one.depts.join(" ")}
                      onChange={(e) =>
                        setOne((o) => ({
                          ...o,
                          // 空白でも読点でも区切れるようにする。打ちやすいほうで入れてもらう
                          depts: e.target.value
                            .toUpperCase()
                            .split(/[\s,、・]+/)
                            .filter((s) => s !== "")
                            .slice(0, DEPT_COLS.length),
                        }))
                      }
                      autoComplete="off"
                      placeholder="CC KM"
                      className={manualInput}
                    />
                    <p className="mt-0.5 text-[10px] leading-relaxed text-slate-400">
                      {T("KM・CC などの記号を、間を空けて並べてください。")}
                      {T("空でも構いません。")}
                    </p>
                  </Field>
                )}
              </>
            )}

            {/*
              入れる前につまずく所を、先に言っておく。

              教授のドメインは、はじめ空にしてある（こちらで手打ちする決まり）。
              空のままだと import_roster が教授の行を必ず弾くので、
              押してから断られるより、押す前に分かるようにする。
            */}
            {one.kind === "教授" && !domains?.teacher && (
              <p className="mt-2 rounded-lg bg-amber-50 p-2 text-[10px] leading-relaxed text-amber-900">
                {T("教授のドメインが、まだ決まっていません。このままだと入れられません。")}
                上の<b>{T("ドメイン名確認")}</b>から、教授のドメインを入れてください。
              </p>
            )}
            {one.kind === "学生" &&
              one.email.includes("@") &&
              one.student_no !== "" &&
              (() => {
                const fromMail = studentNoOf(one.email);
                const typed = studentNoOf(one.student_no);
                if (!typed)
                  return (
                    <p className="mt-2 rounded-lg bg-amber-50 p-2 text-[10px] leading-relaxed text-amber-900">
                      {T("学籍番号は7桁の数字です。このままだと入れられません。")}
                    </p>
                  );
                if (fromMail && typed !== fromMail)
                  return (
                    <p className="mt-2 rounded-lg bg-amber-50 p-2 text-[10px] leading-relaxed text-amber-900">
                      学籍番号（<b className="font-mono">{typed}</b>）と、メールアドレスの中の番号
                      （<b className="font-mono">{fromMail}</b>）が違います。
                      {T("このままだと入れられません。")}
                    </p>
                  );
                if (!fromMail)
                  return (
                    <p className="mt-2 rounded-lg bg-amber-50 p-2 text-[10px] leading-relaxed text-amber-900">
                      {T("メールアドレスの中に7桁の数字がありません。このままだと入れられません。")}
                    </p>
                  );
                return null;
              })()}

            <button
              onClick={() => void sendOne()}
              disabled={busy || !one.email.trim() || !one.name.trim()}
              className="mt-3 w-full rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-bold text-white transition hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400"
            >
              {busy ? "入れています…" : "この一人を入れる"}
            </button>

            {/*
              名簿から消す。

              入れる道だけあって消す道が無いと、間違えて入れた一人を
              直す手立てが無くなる。上書きはできても、消すことはできない。
              打ってあるアドレスをそのまま使うので、欄は増やさない。

              ★消えるのは突き合わせ用の名簿だけ。その人の席は残る。
            */}
            {one.email.trim() !== "" && (
              <button
                onClick={() =>
                  void removeFromRoster(
                    one.kind === "学生" ? "student" : "staff",
                    one.kind === "学生"
                      ? studentNoOf(one.student_no) || studentNoOf(one.email)
                      : one.email.trim(),
                    one.email.trim(),
                  )
                }
                disabled={busy || listBusy}
                className="mt-1.5 w-full rounded-xl px-4 py-2 text-[11px] font-bold text-red-600 transition hover:bg-red-50 active:scale-95 disabled:text-slate-300"
              >
                {T("このアドレスを名簿から消す")}
              </button>
            )}
          </div>
        )}
      </section>
      )}

      {/* 弾いた行 */}
      {report && (
        <section className="mt-4 rounded-xl border border-slate-200 p-3">
          <div className="text-xs font-bold text-slate-900">
            取り込まなかった行：{report.rejected.length}
          </div>
          {report.rejected.length === 0 ? (
            <p className="mt-1 text-[11px] text-emerald-700">{T("全部入りました。")}</p>
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
