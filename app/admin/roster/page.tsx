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
 *   同じ決まりを画面と kit-agent の二箇所に書くと、
 *   片方だけ直したときに食い違う。判定はデータベース側の
 *   import_roster に一本化してあり、ここは渡して結果を見せるだけ。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient, supabaseReady } from "@/lib/supabase/client";
import { AdminHeader, AdminMenu } from "@/components/AdminNav";
import { useAdminT } from "@/lib/adminLang";
import { rankOf } from "@/lib/appdata";
import {
  CLASS_CODES,
  CLASS_NOS,
  DEPT_MAX,
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
/**
 * 身分ごとのドメイン。いくつでも持てる。
 *
 * 学科や入学年でアドレスが分かれていることがあるので、
 * 一つに決め打てない。
 */
type Domains = Record<DomainKind, string[]>;
/** その身分のドメインを見るか。false なら合っていなくても通る */
type DomainOn = Record<DomainKind, boolean>;

/**
 * ログインしている人を見る欄。身分で五つに分ける。
 *
 * ★名簿（roster_students / roster_staff）とは別のもの。
 *   名簿は「申請と突き合わせるために入れておいた表」で、
 *   その人が実際に使っているかは分からない。
 *   ここで出すのは、席があって権限が付いている人（profiles）。
 */
type PeopleKind = "student" | "teacher" | "leader" | "cafeteria" | "other" | "pending";

const PEOPLE_KINDS: { id: PeopleKind; label: string; byDept: boolean }[] = [
  // byDept … 学部と学科を選んでから見る（学年・クラスを持っている人）
  { id: "student", label: "学生", byDept: true },
  { id: "teacher", label: "教授", byDept: false },
  { id: "leader", label: "課外活動リーダー", byDept: true },
  { id: "cafeteria", label: "食堂", byDept: false },
  { id: "other", label: "その他", byDept: false },
  /*
   * 承認待ち。まだ身分が決まっていない人。
   *
   * 前はどこにも出さないようにしていたが、その人たちも
   * ログインはできている。出さないと人数にも入らず、
   * xlsx に書き出しても入らなかった。
   */
  { id: "pending", label: "承認待ち", byDept: false },
];

/**
 * 名簿（突き合わせ用の表）の中を見るときの身分。
 *
 * 上の PeopleKind（ログインしている人）とは別のもの。
 * 名簿は学生・教授・その他の三つしか持っていない。
 */
type RosterKind = "student" | "teacher" | "other";

const ROSTER_KINDS: { id: RosterKind; label: string }[] = [
  { id: "student", label: "学生" },
  { id: "teacher", label: "教授" },
  { id: "other", label: "その他" },
];

/** 教職課程を履修している学生の一行 */
type TeachingRow = {
  student_no: string;
  email: string;
  full_name: string;
  grade: number;
  class_code: string;
  class_no: number | null;
  seat_no: number | null;
  total: number;
};

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

/** 課外活動リーダーの名簿の一行 */
type LeaderRow = {
  id: number;
  activity_id: number;
  activity_name: string;
  category_name: string;
  number: string;
  full_name: string;
  note: string;
  total: number;
};

/** 課外活動の団体 */
type Activity = { id: number; name: string; category_id: number | null };

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

  /** ログインしている人を見る欄 */
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

  /* 教職の名簿 */
  const [tOpen, setTOpen] = useState(false);
  const [tCan, setTCan] = useState(false);
  const [tRows, setTRows] = useState<TeachingRow[]>([]);
  const [tTotal, setTTotal] = useState(0);
  const [tBusy, setTBusy] = useState(false);
  const [tq, setTq] = useState("");
  const [tGrade, setTGrade] = useState<number | null>(null);
  const [tDept, setTDept] = useState<string | null>(null);
  const [tClassNo, setTClassNo] = useState<number | null>(null);

  /* 課外活動リーダーの名簿 */
  const [lOpen, setLOpen] = useState(false);
  const [lRows, setLRows] = useState<LeaderRow[]>([]);
  const [lTotal, setLTotal] = useState(0);
  const [lBusy, setLBusy] = useState(false);
  /** 探している言葉。当たるのは課外活動の名前だけ */
  const [lq, setLq] = useState("");
  /** 選んだ団体。null なら全部 */
  const [lPick, setLPick] = useState<Activity | null>(null);
  /** 団体の一覧。探すときの候補に使う */
  const [acts, setActs] = useState<Activity[]>([]);
  /**
   * まとめて消すために印を付けた人。
   *
   * 学生は学籍番号、教授とその他はアドレスで持つ。
   * 消すときにデータベースへ渡す鍵と、同じものにしてある。
   */
  const [rPicked, setRPicked] = useState<string[]>([]);
  /** いま直している人の鍵。null なら誰も直していない */
  const [rEdit, setREdit] = useState<string | null>(null);
  /** 直している最中の中身 */
  const [rForm, setRForm] = useState<{
    name: string;
    grade: number;
    class_code: string;
    class_no: number;
    seat_no: string;
    number: string;
    depts: string[];
  } | null>(null);
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
  /**
   * 直している最中のドメインの並び。
   *
   * 空の一行を末尾に置いて見せるので、ここには打ち終わったものだけが入る。
   */
  const [draftDomains, setDraftDomains] = useState<string[]>([]);

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
        /*
         * 並び（students など）で返るが、13 を入れ直す前は
         * 一つぶん（student）しか返らない。どちらでも読めるようにする。
         */
        const list = (many: string, one: string): string[] => {
          const v = got[many];
          if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
          return typeof got[one] === "string" && got[one] ? [got[one] as string] : [];
        };
        setDomains({
          student: list("students", "student"),
          teacher: list("teachers", "teacher"),
          other: list("others", "other"),
        });
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

  /* ---------------- 教職の名簿 ---------------- */

  /**
   * 教職課程を履修している学生を読む。
   *
   * 見られるのは、教職として通っている教授と、副管理者・管理者だけ
   * （データベース側の can_see_teaching が決める）。
   * 学年・学科・クラスの三つで絞れる。
   */
  const loadTeaching = useCallback(async () => {
    if (!supabaseReady) return;
    setTBusy(true);
    try {
      const { data, error } = await createClient().rpc("teaching_list", {
        p_q: tq.trim(),
        p_grade: tGrade ?? 0,
        p_class_code: tDept ?? "",
        p_class_no: tClassNo ?? 0,
        p_limit: 500,
        p_offset: 0,
      });
      if (error) throw error;
      const rows = (data as TeachingRow[]) ?? [];
      setTRows(rows);
      setTTotal(rows.length > 0 ? Number(rows[0].total) : 0);
    } catch (e) {
      setTRows([]);
      setTTotal(0);
      setMsg({
        kind: "err",
        text:
          e instanceof Error
            ? `${e.message}（base/18_teaching.sql をまだ入れていない場合は、先に入れてください）`
            : String(e),
      });
    } finally {
      setTBusy(false);
    }
  }, [tq, tGrade, tDept, tClassNo]);

  useEffect(() => {
    if (!tOpen) return;
    const id = window.setTimeout(() => void loadTeaching(), 250);
    return () => window.clearTimeout(id);
  }, [tOpen, loadTeaching]);

  /*
   * 教職の名簿を見られるか、データベースに訊く。
   *
   * 権限だけでは決まらない（教職として通っている教授かどうか）ので、
   * 画面で数えずに、決める側に訊く。
   */
  useEffect(() => {
    if (!supabaseReady) return;
    void (async () => {
      const { data } = await createClient().rpc("can_see_teaching");
      setTCan(data === true);
    })();
  }, []);

  /* ---------------- 名簿の中を、一人ずつ見る ---------------- */

  /**
   * 名簿を読み直す。
   *
   * ★これは「入れておいた突き合わせ用の表」のほう。
   *   下の「ログインしている人を見る」（list_people）とは別のもの。
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
      /*
       * 印と、直しかけの欄は捨てる。
       * 並びが変われば、印の付いていた鍵はもう画面に無い。
       * 見えていないものが消えるのがいちばん困る。
       */
      setRPicked([]);
      setREdit(null);
      setRForm(null);
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

  /**
   * いま並んでいる人の鍵。
   *
   * 学生は学籍番号、教授とその他はアドレス。
   * まとめて消すときにデータベースへ渡すものと、同じにしてある。
   */
  const shownKeys = useMemo(
    () =>
      rKind === "student" ? rStudents.map((s) => s.student_no) : rStaff.map((t) => t.email),
    [rKind, rStudents, rStaff],
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

  /* ---------------- 課外活動リーダーの名簿 ---------------- */

  /**
   * 団体の一覧。探すときの候補に使う。
   *
   * 97 団体しかないので、はじめに全部もらっておく。
   * 一文字打つたびに問い合わせると、そのぶん待たされる。
   */
  useEffect(() => {
    if (!lOpen || !supabaseReady || acts.length > 0) return;
    void createClient()
      .from("club_activities")
      .select("id, name, category_id")
      .order("sort_order")
      .then(({ data }) => setActs((data as Activity[]) ?? []));
  }, [lOpen, acts.length]);

  /**
   * リーダーの名簿を読む。
   *
   * 団体を選んでいれば、その団体だけ。
   * 選んでいなければ全部（分類 → 団体 → 番号の順）。
   */
  const loadLeaders = useCallback(async (actId: number | null) => {
    if (!supabaseReady) return;
    setLBusy(true);
    try {
      const { data, error } = await createClient().rpc("leader_roster_list", {
        p_q: "",
        p_activity_id: actId,
        p_limit: 500,
        p_offset: 0,
      });
      if (error) throw error;
      const rows = (data as LeaderRow[]) ?? [];
      setLRows(rows);
      setLTotal(rows.length > 0 ? Number(rows[0].total) : 0);
    } catch (e) {
      setLRows([]);
      setLTotal(0);
      setMsg({
        kind: "err",
        text:
          e instanceof Error
            ? `${e.message}（base/20_leader.sql をまだ入れていない場合は、先に入れてください）`
            : String(e),
      });
    } finally {
      setLBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!lOpen) return;
    void loadLeaders(lPick?.id ?? null);
  }, [lOpen, lPick, loadLeaders]);

  /**
   * 探している言葉に当たる団体。
   *
   * 当たり方は案内の検索と同じ（lib/appdata の rankOf）。
   * 全角・記号・大文字小文字のゆれは、あちらが吸収する。
   * 別に書くと、同じ言葉で探しているのに片方だけ出る、という
   * 食い違いが起きる。
   *
   * ★探せるのは団体の名前だけ
   *   人の名前や番号では探さない。ここは「どの団体のリーダーか」を
   *   見る欄なので、団体で辿れれば足りる。
   */
  const lHits = useMemo(() => {
    const word = lq.trim();
    if (word === "") return [];
    return acts
      .map((a) => ({ a, r: rankOf(a.name, word) }))
      .filter((x) => x.r >= 0)
      .sort((x, y) => x.r - y.r || x.a.name.localeCompare(y.a.name, "ja"))
      .slice(0, 8);
  }, [acts, lq]);

  /* ---------------- ログインしている人を見る ---------------- */

  /** いま見ている身分の決まり（学部・学科で絞るかどうか） */
  const kindDef = PEOPLE_KINDS.find((k) => k.id === listKind) ?? PEOPLE_KINDS[0];

  /**
   * ログインしている人を読み直す。
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
    setRPicked((p) => p.filter((x) => x !== key));
    const at = rStudents.length + rStaff.length <= 1 ? Math.max(0, rPage - 1) : rPage;
    setRPage(at);
    await loadRoster(rKind, at, true);
  };

  /**
   * 印を付けたぶんを、まとめて消す。
   *
   * 一人ずつ消せるだけだと、間違えて取り込んだ一学年ぶんを
   * 消すのに何百回も押すことになる。
   * 消す前に、何人ぶんかと名前の先頭を出して一度たずねる。
   */
  const removePicked = async () => {
    if (rPicked.length === 0) return;
    const kind = rKind === "student" ? "student" : "staff";
    const names =
      rKind === "student"
        ? rStudents.filter((s) => rPicked.includes(s.student_no)).map((s) => s.full_name || s.student_no)
        : rStaff.filter((t) => rPicked.includes(t.email)).map((t) => t.full_name || t.email);

    if (
      !window.confirm(
        [
          `印を付けた ${rPicked.length} 件を名簿から消します。`,
          "",
          ...names.slice(0, 10).map((n) => "  " + n),
          names.length > 10 ? `  ほか ${rPicked.length - 10} 件` : "",
          "",
          "消えるのは突き合わせ用の名簿だけで、その人の席は残ります。",
          "元には戻せません。よろしいですか？",
        ]
          .filter((s) => s !== "")
          .join(BR),
      )
    )
      return;

    setRBusy(true);
    try {
      const { data, error } = await createClient().rpc("roster_remove_many", {
        p_kind: kind,
        p_keys: rPicked,
      });
      if (error) throw error;
      setMsg({ kind: "ok", text: `${data ?? 0} 件を名簿から消しました。` });
      setRPicked([]);
      const at = rPicked.length >= rStudents.length + rStaff.length ? Math.max(0, rPage - 1) : rPage;
      setRPage(at);
      await load();
      await loadRoster(rKind, at, true);
    } catch (e) {
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
  };

  /**
   * 名簿の一人を直す。
   *
   * ★入れるときと同じ道（import_roster）を通す。
   *
   *   名簿は「同じ鍵なら上書き」で入る作りなので、直した中身を
   *   一行ぶんの取り込みとして渡せば、そのまま置き換わる。
   *   直す用の関数を別に作ると、弾く決まりが二か所になり、
   *   xlsx からは通らない中身が画面からは入る、ということが起きる。
   *
   *   鍵（学生は学籍番号とアドレス、教授とその他はアドレス）は
   *   直せない。変えたいときは、消して入れ直す。
   *   鍵を変えると別人になり、古いほうが名簿に残ってしまうため。
   */
  const saveEdit = async (row: RosterStudent | RosterStaff) => {
    if (!rForm) return;
    const isStudent = rKind === "student";
    const s = row as RosterStudent;
    const t = row as RosterStaff;

    const one = {
      row: 1,
      kind: isStudent ? "学生" : rKind === "teacher" ? "教授" : "その他",
      email: row.email,
      name: rForm.name,
      grade: isStudent ? String(rForm.grade || "") : "",
      class_code: isStudent ? rForm.class_code : "",
      class_no: isStudent ? String(rForm.class_no || "") : "",
      seat_no: isStudent ? rForm.seat_no : "",
      student_no: isStudent ? s.student_no : "",
      depts: rKind === "teacher" ? rForm.depts : [],
      number: isStudent ? "" : rForm.number,
    };

    setRBusy(true);
    try {
      const { data, error } = await createClient().rpc("import_roster", { p_rows: [one] });
      if (error) throw error;
      const rep = data as { students: number; staff: number; rejected: { why: string }[] };
      if (rep.rejected.length > 0) {
        setMsg({ kind: "err", text: `直せませんでした：${rep.rejected[0].why}` });
        return;
      }
      setMsg({
        kind: "ok",
        text: `${rForm.name || (isStudent ? s.student_no : t.email)} を直しました。`,
      });
      setREdit(null);
      setRForm(null);
      await loadRoster(rKind, rPage, true);
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setRBusy(false);
    }
  };

  /** その行を直しはじめる。いまの中身を欄に入れる */
  const startEdit = (row: RosterStudent | RosterStaff, key: string) => {
    const s = row as RosterStudent;
    const t = row as RosterStaff;
    setREdit(key);
    setRForm({
      name: row.full_name ?? "",
      grade: s.grade ?? 0,
      class_code: s.class_code ?? "",
      class_no: s.class_no ?? 0,
      seat_no: s.seat_no != null ? String(s.seat_no) : "",
      number: t.number ?? "",
      depts: t.dept_codes ?? [],
    });
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
    setDraftDomains(domains?.[k] ?? []);
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
    const before = domains?.[domainKind] ?? [];
    const after = draftDomains.map((d) => d.trim().toLowerCase()).filter(Boolean);
    if (before.join(",") === after.join(",")) return;

    const first = window.confirm(
      [
        `${kind.label}のドメインを変えます。`,
        "",
        "  いま",
        ...(before.length ? before.map((d) => "    " + d) : ["    （決めていません）"]),
        "  あと",
        ...(after.length ? after.map((d) => "    " + d) : ["    （決めていない状態に戻す）"]),
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
        after.length
          ? `本当に、この ${after.length} つにしますか？`
          : "本当に「決めていない」に戻しますか？",
        "",
        "これが最後の確認です。",
        after.length
          ? "ここに並んでいない アドレスでは、新しく申請できなくなります。"
          : "決めていない状態に戻すと、この身分ではドメインを見なくなります。",
      ].join(BR),
    );
    if (!second) return;

    setMsg(null);
    setBusy(true);
    try {
      const { data, error } = await createClient().rpc("set_domains", {
        p_kind: domainKind,
        p_list: after,
      });
      if (error) throw error;
      const rep = data as { before: string[]; after: string[] };
      const list = Array.isArray(rep.after) ? rep.after : [];
      setDomains((d) => (d ? { ...d, [domainKind]: list } : d));
      setDraftDomains(list);
      setMsg({
        kind: "ok",
        text: `${kind.label}のドメインを ${
          list.length ? list.join("・") : "（未設定）"
        } にしました。ログイン中の人はそのままです。`,
      });
      await load();
    } catch (e) {
      setMsg({
        kind: "err",
        text:
          e instanceof Error
            ? `${e.message}（base/13_domains.sql を入れ直していない場合は、先に入れてください）`
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
          下の「ログインしている人を見る」とは別のもの。
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

            {/*
              まとめて消す。

              印を付けたぶんを一度で消す。間違えて取り込んだ一学年ぶんを
              一人ずつ押して消すのは、現実には終わらない。
              印が付いているときだけ出す。ふだんは並びを邪魔しない。
            */}
            {canWrite && (rStudents.length > 0 || rStaff.length > 0) && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <button
                  onClick={() =>
                    setRPicked(
                      rPicked.length === shownKeys.length ? [] : shownKeys,
                    )
                  }
                  className="rounded-lg bg-slate-100 px-2.5 py-1.5 text-[10px] font-bold text-slate-600 transition hover:bg-slate-200 active:scale-95"
                >
                  {rPicked.length === shownKeys.length
                    ? T("印を外す")
                    : `${T("この頁をすべて選ぶ")}（${shownKeys.length}）`}
                </button>
                {rPicked.length > 0 && (
                  <button
                    onClick={() => void removePicked()}
                    disabled={rBusy || listBusy}
                    className="rounded-lg bg-red-600 px-2.5 py-1.5 text-[10px] font-bold text-white transition hover:bg-red-700 active:scale-95 disabled:bg-slate-300"
                  >
                    {T("印を付けた")} {rPicked.length} {T("件を消す")}
                  </button>
                )}
              </div>
            )}

            {/* 一人ぶんの中身は、名簿が持っているものを全部出す */}
            <ul className="mt-1.5 max-h-96 divide-y divide-slate-100 overflow-y-auto rounded-lg bg-slate-50">
              {rKind === "student"
                ? rStudents.map((s) => (
                    <li key={s.student_no} className="px-2.5 py-2">
                      <div className="flex items-start gap-2">
                        {canWrite && (
                          <button
                            onClick={() =>
                              setRPicked((p) =>
                                p.includes(s.student_no)
                                  ? p.filter((x) => x !== s.student_no)
                                  : [...p, s.student_no],
                              )
                            }
                            aria-label={T("印を付ける")}
                            className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-bold transition ${
                              rPicked.includes(s.student_no)
                                ? "bg-red-600 text-white"
                                : "bg-white text-transparent ring-1 ring-slate-300"
                            }`}
                          >
                            ✓
                          </button>
                        )}
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
                          <div className="truncate font-mono text-[10px] text-slate-400">
                            {s.email}
                          </div>
                        </div>
                        {/* 直す・消すは 2.1・2.2・管理者だけ。教授には出さない */}
                        {canWrite && (
                          <div className="flex shrink-0 gap-1">
                            <button
                              onClick={() =>
                                rEdit === s.student_no
                                  ? (setREdit(null), setRForm(null))
                                  : startEdit(s, s.student_no)
                              }
                              disabled={rBusy || listBusy}
                              className="rounded-lg bg-white px-2 py-1.5 text-[10px] font-bold text-slate-600 shadow-sm transition hover:bg-slate-100 active:scale-95 disabled:text-slate-300"
                            >
                              {rEdit === s.student_no ? T("やめる") : T("直す")}
                            </button>
                            <button
                              onClick={() =>
                                void removeShown(
                                  "student",
                                  s.student_no,
                                  `${s.full_name || "名前なし"}（${s.student_no}）`,
                                )
                              }
                              disabled={rBusy || listBusy}
                              className="rounded-lg bg-white px-2 py-1.5 text-[10px] font-bold text-red-600 shadow-sm transition hover:bg-red-50 active:scale-95 disabled:text-slate-300"
                            >
                              {T("消す")}
                            </button>
                          </div>
                        )}
                      </div>

                      {rEdit === s.student_no && rForm && (
                        <EditForm
                          t={T}
                          kind="student"
                          form={rForm}
                          setForm={setRForm}
                          busy={rBusy}
                          onSave={() => void saveEdit(s)}
                        />
                      )}
                    </li>
                  ))
                : rStaff.map((t) => (
                    <li key={t.email} className="px-2.5 py-2">
                      <div className="flex items-start gap-2">
                        {canWrite && (
                          <button
                            onClick={() =>
                              setRPicked((p) =>
                                p.includes(t.email)
                                  ? p.filter((x) => x !== t.email)
                                  : [...p, t.email],
                              )
                            }
                            aria-label={T("印を付ける")}
                            className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-bold transition ${
                              rPicked.includes(t.email)
                                ? "bg-red-600 text-white"
                                : "bg-white text-transparent ring-1 ring-slate-300"
                            }`}
                          >
                            ✓
                          </button>
                        )}
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
                          <div className="truncate font-mono text-[10px] text-slate-400">
                            {t.email}
                          </div>
                        </div>
                        {canWrite && (
                          <div className="flex shrink-0 gap-1">
                            <button
                              onClick={() =>
                                rEdit === t.email
                                  ? (setREdit(null), setRForm(null))
                                  : startEdit(t, t.email)
                              }
                              disabled={rBusy || listBusy}
                              className="rounded-lg bg-white px-2 py-1.5 text-[10px] font-bold text-slate-600 shadow-sm transition hover:bg-slate-100 active:scale-95 disabled:text-slate-300"
                            >
                              {rEdit === t.email ? T("やめる") : T("直す")}
                            </button>
                            <button
                              onClick={() =>
                                void removeShown("staff", t.email, `${t.full_name || t.email}`)
                              }
                              disabled={rBusy || listBusy}
                              className="rounded-lg bg-white px-2 py-1.5 text-[10px] font-bold text-red-600 shadow-sm transition hover:bg-red-50 active:scale-95 disabled:text-slate-300"
                            >
                              {T("消す")}
                            </button>
                          </div>
                        )}
                      </div>

                      {rEdit === t.email && rForm && (
                        <EditForm
                          t={T}
                          kind={rKind === "teacher" ? "teacher" : "other"}
                          form={rForm}
                          setForm={setRForm}
                          busy={rBusy}
                          onSave={() => void saveEdit(t)}
                        />
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
        教職の名簿。

        見られるのは、教職として通っている教授と、副管理者・管理者だけ。
        誰に見せるかはデータベース側（can_see_teaching）が決めるので、
        画面では訊いた答えをそのまま使う。

        学年・学科・クラスの三つで絞れる。
        名簿の教職の欄（xlsx の P列）に印がある人だけが並ぶ。
      */}
      {tCan && (
        <section className="mt-4 rounded-xl border border-violet-200 bg-violet-50/40 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-bold text-violet-900">{T("教職の名簿")}</div>
            <button
              onClick={() => setTOpen((v) => !v)}
              className="rounded-lg bg-violet-100 px-2.5 py-1 text-[11px] font-bold text-violet-800 transition hover:bg-violet-200 active:scale-95"
            >
              {tOpen ? T("閉じる") : T("教職の名簿を開く")}
            </button>
          </div>

          {tOpen && (
            <div className="mt-2">
              <div className="grid grid-cols-3 gap-1.5">
                <select
                  value={tGrade ?? ""}
                  onChange={(e) => setTGrade(e.target.value ? Number(e.target.value) : null)}
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
                  value={tDept ?? ""}
                  onChange={(e) => setTDept(e.target.value || null)}
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
                  value={tClassNo ?? ""}
                  onChange={(e) => setTClassNo(e.target.value ? Number(e.target.value) : null)}
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

              <input
                value={tq}
                onChange={(e) => setTq(e.target.value)}
                autoComplete="off"
                placeholder="名前・学籍番号・アドレスで探す"
                className="mt-2 w-full rounded-lg bg-white px-3 py-2 text-xs outline-none ring-1 ring-violet-200 focus:ring-2 focus:ring-violet-500"
              />

              <div className="mt-2 text-[10px] font-bold text-violet-800">
                {tBusy ? T("探しています…") : tTotal + " " + T("人")}
              </div>

              <ul className="mt-1.5 max-h-96 divide-y divide-violet-100 overflow-y-auto rounded-lg bg-white">
                {tRows.map((r) => (
                  <li key={r.student_no} className="px-2.5 py-2">
                    <div className="flex items-baseline gap-1.5">
                      {r.seat_no !== null && (
                        <span className="shrink-0 rounded bg-violet-100 px-1.5 py-0.5 font-mono text-[10px] font-bold text-violet-800">
                          {r.seat_no}
                        </span>
                      )}
                      <span className="truncate text-xs font-bold text-slate-800">
                        {r.full_name || "（名前なし）"}
                      </span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-slate-500">
                      {r.grade > 0 && <span>{r.grade}年</span>}
                      {r.class_code && <span>{r.class_code}</span>}
                      {!!r.class_no && (
                        <span>
                          {T("クラス")}
                          {r.class_no}
                        </span>
                      )}
                      <span className="font-mono">学籍番号 {r.student_no}</span>
                    </div>
                    <div className="truncate font-mono text-[10px] text-slate-400">{r.email}</div>
                  </li>
                ))}
                {!tBusy && tRows.length === 0 && (
                  <li className="px-2.5 py-6 text-center text-[11px] text-slate-500">
                    {T("教職を履修している人が見つかりませんでした。")}
                  </li>
                )}
              </ul>

              <p className="mt-1.5 text-[10px] leading-relaxed text-violet-700">
                {T("ここに並ぶのは、名簿の教職の欄（xlsx の P列）に T と書いてある人です。")}
              </p>
            </div>
          )}
        </section>
      )}

      {/*
        課外活動リーダーの名簿。教職の名簿のすぐ下。

        ★探せるのは団体の名前だけ
          ここは「どの団体のリーダーか」を見る欄なので、
          団体で辿れれば足りる。人の名前や番号では探さない。

        当たり方は案内の検索と同じにしてある。全角・記号・大文字小文字の
        ゆれを同じように吸収するので、地図で慣れた手ごたえのまま使える。
      */}
      {canWrite && (
        <section className="mt-4 rounded-xl border border-amber-200 bg-amber-50/40 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-bold text-amber-900">{T("課外活動リーダー")}</div>
            <button
              onClick={() => setLOpen((v) => !v)}
              className="rounded-lg bg-amber-100 px-2.5 py-1 text-[11px] font-bold text-amber-800 transition hover:bg-amber-200 active:scale-95"
            >
              {lOpen ? T("閉じる") : T("リーダーを見る")}
            </button>
          </div>

          {lOpen && (
            <div className="mt-2">
              {/* 探す欄。打つと団体の候補が下に出る */}
              <div className="relative">
                <input
                  value={lq}
                  onChange={(e) => setLq(e.target.value)}
                  autoComplete="off"
                  placeholder="課外活動の名前で探す（例：吹奏楽、ロボット）"
                  className="w-full rounded-lg bg-white px-3 py-2 text-xs outline-none ring-1 ring-amber-200 focus:ring-2 focus:ring-amber-500"
                />
                {lHits.length > 0 && (
                  <ul className="absolute left-0 right-0 top-full z-10 mt-1 max-h-64 overflow-y-auto rounded-lg bg-white py-1 shadow-lg ring-1 ring-slate-200">
                    {lHits.map((h) => (
                      <li key={h.a.id}>
                        <button
                          onClick={() => {
                            setLPick(h.a);
                            setLq("");
                          }}
                          className="block w-full px-3 py-2 text-left text-xs text-slate-800 transition hover:bg-amber-50"
                        >
                          {h.a.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {lq.trim() !== "" && lHits.length === 0 && (
                  <p className="absolute left-0 right-0 top-full z-10 mt-1 rounded-lg bg-white px-3 py-2 text-[11px] text-slate-500 shadow-lg ring-1 ring-slate-200">
                    {T("その名前の課外活動は見つかりませんでした。")}
                  </p>
                )}
              </div>

              {/* いま選んでいる団体 */}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] font-bold text-amber-800">
                  {lPick ? T("この団体だけ") : T("すべての団体")}
                </span>
                {lPick && (
                  <button
                    onClick={() => setLPick(null)}
                    className="rounded-full bg-amber-600 px-2.5 py-1 text-[10px] font-bold text-white transition hover:bg-amber-700 active:scale-95"
                  >
                    {lPick.name} ✕
                  </button>
                )}
              </div>

              <div className="mt-2 text-[10px] font-bold text-amber-800">
                {lBusy ? T("探しています…") : lTotal + " " + T("人")}
              </div>

              <ul className="mt-1.5 max-h-96 divide-y divide-amber-100 overflow-y-auto rounded-lg bg-white">
                {lRows.map((r) => (
                  <li key={r.id} className="px-2.5 py-2">
                    <div className="flex items-baseline gap-1.5">
                      <span className="truncate text-xs font-bold text-slate-800">
                        {r.full_name || "（名前なし）"}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-slate-500">
                        {r.number}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-[10px] text-amber-800">
                      {r.activity_name}
                      {r.category_name ? `　${r.category_name}` : ""}
                    </div>
                    {r.note && (
                      <div className="truncate text-[10px] text-slate-400">{r.note}</div>
                    )}
                  </li>
                ))}
                {!lBusy && lRows.length === 0 && (
                  <li className="px-2.5 py-6 text-center text-[11px] text-slate-500">
                    {T("リーダーが登録されていません。")}
                  </li>
                )}
              </ul>

              <p className="mt-1.5 text-[10px] leading-relaxed text-amber-700">
                {T("並びは、分類 → 団体 → 番号の順です。")}
                {T("入れる・消すは「大学の情報登録」から。")}
              </p>
            </div>
          )}
        </section>
      )}

      {/*
        ログインしている人。課外活動リーダーのすぐ下。

        ★名簿（突き合わせ用の表）とは別のもの
          上に並んでいるのは「名簿に入れてある人」。
          ここに出るのは「席があって権限が付いている人」＝
          いま実際に使える状態になっている人。
          名簿に居ても使っていない人は、ここには出てこない。

        表そのものは開かない。データベース側の関数（list_people）を
        通したときだけ、その人に見せてよい分が返る。
        教授（レベル2）には学生のぶんしか返らない。
      */}
      <section className="mt-4 rounded-xl border border-sky-200 bg-sky-50/40 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-bold text-sky-900">{T("ログインしている人")}</div>
          <button
            onClick={() => {
              const next = !listOpen;
              setListOpen(next);
              if (next) {
                setPage(0);
                void loadList(listKind, kindDef.byDept ? deptId : null, q.trim(), 0);
              }
            }}
            className="rounded-lg bg-sky-100 px-2.5 py-1 text-[11px] font-bold text-sky-800 transition hover:bg-sky-200 active:scale-95"
          >
            {listOpen ? T("閉じる") : T("ログインしている人を見る")}
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
                      setDeptId(null);
                    }}
                    className={`rounded-lg px-2 py-2 text-[11px] font-bold leading-tight transition active:scale-95 ${
                      listKind === k.id
                        ? "bg-sky-900 text-white"
                        : "bg-white text-slate-600 hover:bg-sky-100"
                    }`}
                  >
                    {T(k.label)}
                    <span className="mt-0.5 block text-[9px] font-normal opacity-70">
                      {peopleCounts?.[k.id] ?? 0} {T("人")}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="rounded-lg bg-white px-2.5 py-1.5 text-[10px] leading-relaxed text-slate-500">
                {T("教授（レベル2）が見られるのは学生だけです。")}
              </p>
            )}

            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              autoComplete="off"
              placeholder="名前・アドレス・学籍番号で探す"
              className="mt-2 w-full rounded-lg bg-white px-3 py-2 text-xs outline-none ring-1 ring-sky-200 focus:ring-2 focus:ring-sky-500"
            />

            <div className="mt-2 text-[10px] font-bold text-sky-800">
              {listBusy ? T("探しています…") : total + " " + T("人")}
            </div>

            <ul className="mt-1.5 max-h-96 divide-y divide-sky-100 overflow-y-auto rounded-lg bg-white">
              {people.map((r) => (
                <li key={r.id} className="px-2.5 py-2">
                  <div className="flex items-baseline gap-1.5">
                    {r.seat_no !== null && r.seat_no !== 0 && (
                      <span className="shrink-0 rounded bg-sky-100 px-1.5 py-0.5 font-mono text-[10px] font-bold text-sky-800">
                        {r.seat_no}
                      </span>
                    )}
                    <span className="truncate text-xs font-bold text-slate-800">
                      {r.full_name || "（名前なし）"}
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-slate-500">
                    {r.grade > 0 && <span>{r.grade}{T("年")}</span>}
                    {r.class_code && <span>{r.class_code}</span>}
                    {!!r.class_no && (
                      <span>
                        {T("クラス")}
                        {r.class_no}
                      </span>
                    )}
                    {r.student_no && <span className="font-mono">{r.student_no}</span>}
                    {r.staff_no && <span className="font-mono">{r.staff_no}</span>}
                    {r.dept_codes && r.dept_codes.length > 0 && (
                      <span>
                        {T("担当")} {r.dept_codes.join("・")}
                      </span>
                    )}
                  </div>
                  <div className="truncate font-mono text-[10px] text-slate-400">{r.email}</div>
                </li>
              ))}
              {!listBusy && people.length === 0 && (
                <li className="px-2.5 py-6 text-center text-[11px] text-slate-500">
                  {T("見つかりませんでした。")}
                </li>
              )}
            </ul>

            {total > PAGE && (
              <div className="mt-2 flex items-center justify-between gap-2">
                <button
                  onClick={() => {
                    const at = Math.max(0, page - 1);
                    setPage(at);
                    void loadList(listKind, kindDef.byDept ? deptId : null, q.trim(), at);
                  }}
                  disabled={page === 0}
                  className="rounded-lg bg-white px-3 py-1.5 text-[11px] font-bold text-slate-600 transition hover:bg-sky-100 disabled:text-slate-300"
                >
                  {T("前")}
                </button>
                <span className="text-[10px] text-slate-500">
                  {page * PAGE + 1}–{Math.min((page + 1) * PAGE, total)} / {total}
                </span>
                <button
                  onClick={() => {
                    const at = page + 1;
                    setPage(at);
                    void loadList(listKind, kindDef.byDept ? deptId : null, q.trim(), at);
                  }}
                  disabled={(page + 1) * PAGE >= total}
                  className="rounded-lg bg-white px-3 py-1.5 text-[11px] font-bold text-slate-600 transition hover:bg-sky-100 disabled:text-slate-300"
                >
                  {T("次")}
                </button>
              </div>
            )}

            <p className="mt-1.5 text-[10px] leading-relaxed text-sky-700">
              {T("ここに出るのは、席があって権限が付いている人です。名簿に居ても、まだ使っていない人は出ません。")}
              <br />
              {T("xlsx に保存するのは「大学の情報登録」から。")}
            </p>
          </div>
        )}
      </section>

      {/*
        入れる・消す・ドメインを変えるは、この画面から外した。

        ここは「入れてある名簿を見る」ためだけの場所。
        入れる（xlsx・一人ずつ）・ドメイン名確認・ログインしている人を見る は、
        「大学の情報登録」へまとめてある。
        見るための画面に、戻せない操作が並んでいると危ない。
      */}
      {canWrite && (
        <Link
          href="/admin/campus"
          className="mt-4 block rounded-xl bg-slate-100 px-4 py-3 text-center text-xs font-bold text-slate-700 transition hover:bg-slate-200"
        >
          {T("名簿に入れる・消す、ドメインを変えるは「大学の情報登録」から")}
        </Link>
      )}

    </Shell>
  );
}

/** 手で入れる欄の見た目。同じものを何度も書かないでまとめておく */
const manualInput =
  "mt-0.5 w-full rounded-lg bg-slate-100 px-3 py-2 text-xs outline-none focus:bg-white focus:ring-2 focus:ring-blue-500";

/** 名簿を直す欄の、共通の見た目 */
const editInput =
  "mt-0.5 w-full rounded-lg bg-white px-2 py-1.5 text-xs outline-none ring-1 ring-slate-200 focus:ring-2 focus:ring-blue-500";

/**
 * 名簿の一人を、その場で直す欄。
 *
 * 直せるのは中身だけ。鍵（学生は学籍番号とアドレス、教授とその他は
 * アドレス）は出さない。ここを変えると別人になり、古いほうが
 * 名簿に残ってしまう。変えたいときは消して入れ直す。
 *
 * 入れるときと同じ道（import_roster）へ渡すので、
 * 弾く決まりは xlsx から入れるときとまったく同じになる。
 */
function EditForm({
  t: T,
  kind,
  form,
  setForm,
  busy,
  onSave,
}: {
  t: (ja: string) => string;
  kind: "student" | "teacher" | "other";
  form: {
    name: string;
    grade: number;
    class_code: string;
    class_no: number;
    seat_no: string;
    number: string;
    depts: string[];
  };
  setForm: (
    f: (p: {
      name: string;
      grade: number;
      class_code: string;
      class_no: number;
      seat_no: string;
      number: string;
      depts: string[];
    } | null) => typeof form | null,
  ) => void;
  busy: boolean;
  onSave: () => void;
}) {
  const set = (patch: Partial<typeof form>) =>
    setForm((p) => (p ? { ...p, ...patch } : p));

  /* 担当学科。選ぶと下に空の欄が一つ増える */
  const deptRows = form.depts.length < DEPT_MAX ? [...form.depts, ""] : form.depts;

  return (
    <div className="mt-2 rounded-lg bg-white p-2 ring-1 ring-slate-200">
      <label className="block text-[10px] font-bold text-slate-500">{T("氏名")}</label>
      <input
        value={form.name}
        onChange={(e) => set({ name: e.target.value })}
        className={editInput}
      />

      {kind === "student" ? (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] font-bold text-slate-500">{T("学年")}</label>
            <select
              value={form.grade || ""}
              onChange={(e) => set({ grade: Number(e.target.value) || 0 })}
              className={editInput}
            >
              <option value="">—</option>
              {GRADES.map((g) => (
                <option key={g} value={g}>
                  {g}
                  {T("年")}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-bold text-slate-500">{T("学科")}</label>
            <select
              value={form.class_code}
              onChange={(e) => set({ class_code: e.target.value })}
              className={editInput}
            >
              <option value="">—</option>
              {CLASS_CODES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code}　{T(c.name)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-bold text-slate-500">{T("クラス")}</label>
            <select
              value={form.class_no || ""}
              onChange={(e) => set({ class_no: Number(e.target.value) || 0 })}
              className={editInput}
            >
              <option value="">—</option>
              {CLASS_NOS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-bold text-slate-500">{T("名列番号")}</label>
            <input
              value={form.seat_no}
              onChange={(e) => set({ seat_no: e.target.value.replace(/\D/g, "").slice(0, 3) })}
              inputMode="numeric"
              className={editInput}
            />
          </div>
        </div>
      ) : (
        <>
          <label className="mt-2 block text-[10px] font-bold text-slate-500">
            {T("8桁の番号")}
          </label>
          <input
            value={form.number}
            onChange={(e) => set({ number: e.target.value.trim().slice(0, 8) })}
            inputMode="text"
            autoCapitalize="off"
            className={`${editInput} font-mono`}
          />
          {kind === "teacher" && (
            <>
              <label className="mt-2 block text-[10px] font-bold text-slate-500">
                {T("担当学科")}
              </label>
              <div className="grid gap-1">
                {deptRows.map((code, i) => (
                  <select
                    key={i}
                    value={code}
                    onChange={(e) => {
                      const next = [...form.depts];
                      if (e.target.value === "") next.splice(i, 1);
                      else if (i < next.length) next[i] = e.target.value;
                      else next.push(e.target.value);
                      set({ depts: next });
                    }}
                    className={editInput}
                  >
                    <option value="">{code ? T("（外す）") : T("学科を選ぶ")}</option>
                    {CLASS_CODES.filter(
                      (c) => c.code === code || !form.depts.includes(c.code),
                    ).map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.code}　{T(c.name)}
                      </option>
                    ))}
                  </select>
                ))}
              </div>
            </>
          )}
        </>
      )}

      <button
        onClick={onSave}
        disabled={busy || form.name.trim() === ""}
        className="mt-2 w-full rounded-lg bg-blue-600 px-2 py-2 text-[11px] font-bold text-white transition hover:bg-blue-700 active:scale-95 disabled:bg-slate-200 disabled:text-slate-400"
      >
        {busy ? T("処理中…") : T("この内容にする")}
      </button>
    </div>
  );
}

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
