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
 *   ・登録者を増やす（一人ずつ手で入れる）
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
import {
  CLASS_CODES,
  CLASS_NOS,
  DEPT_MAX,
  GRADES,
  canManage,
  canManageAll,
  canReadRoster,
  type Role,
} from "@/lib/auth";
import { readXlsx } from "@/lib/xlsx";
import { noteError, noteEvent } from "@/lib/note";
import {
  COLS,
  DEPT_COLS,
  EXPORT_HEAD,
  LABEL,
  colName,
  isDeptCol,
  studentNoOf,
  toRow,
  toSending,
  headNoteOf,
  type PlainCol,
  type Sending,
} from "@/lib/roster";
import { buildXlsx, type Sheet } from "@/lib/xlsxOut";
import { soon } from "@/lib/soon";

/* 確認の文を組み立てるときの改行。書き換えの途中で消えないよう、変数にしてある */
const BR = String.fromCharCode(10);

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

/** 課外活動リーダーの名簿の一行 */
type LeaderRow = {
  id: number;
  activity_id: number;
  activity_name: string;
  category_name: string;
  number: string;
  full_name: string;
  note: string;
};

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
  /** 教職課程として通っているか。xlsx の P列に出す */
  teaching?: boolean;
  /** 身分。書き出しでシートを分けるのに使う（export_people が添えてくる） */
  kind?: string;
  /** Q列。課外活動のリーダーか */
  leader?: boolean;
  /** R列。どの課外活動か */
  leader_activity?: string;
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

export default function CampusPage() {
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

  /* 学科登録 */
  const [deptOpen, setDeptOpen] = useState(false);
  /** 選んでいる学部。"new" なら新しく作る */
  const [facPick, setFacPick] = useState<string>("new");
  const [facNew, setFacNew] = useState("");
  /** 選んでいる学科。"new" なら新しく作る */
  const [deptPick, setDeptPick] = useState<string>("new");
  const [deptNew, setDeptNew] = useState("");
  /** 学科の記号（CC など） */
  const [codeNew, setCodeNew] = useState("");

  /*
   * 課外活動リーダーの名簿。
   *
   * ここに入れた人だけが、地図の「申請 → 課外活動リーダー申請」で通る。
   * ここが空のあいだ、kit-agent は誰も通さない（「まだ入っていません」と
   * 言って断る）。名簿の入れ忘れで、正しい人を追い返さないため。
   */
  const [leadOpen, setLeadOpen] = useState(false);
  const [leadCats, setLeadCats] = useState<{ id: number; name: string }[]>([]);
  const [leadActs, setLeadActs] = useState<{ id: number; category_id: number | null; name: string }[]>([]);
  const [leadRows, setLeadRows] = useState<LeaderRow[]>([]);
  const [leadTotal, setLeadTotal] = useState(0);
  const [leadBusy, setLeadBusy] = useState(false);
  const [leadQ, setLeadQ] = useState("");
  /** 一覧を絞る団体。null なら絞らない */
  const [leadPick, setLeadPick] = useState<number | null>(null);
  /** 入れる欄。分類を選んでから団体を選ぶ */
  const [leadCat, setLeadCat] = useState<number | null>(null);
  /* 課外活動そのものを増やす欄 */
  const [newActCat, setNewActCat] = useState<number | null>(null);
  const [newActName, setNewActName] = useState("");
  const [leadAct, setLeadAct] = useState<number | null>(null);
  const [leadNo, setLeadNo] = useState("");
  const [leadName, setLeadName] = useState("");
  /** 名簿から人を探すときの言葉 */
  const [pickQ, setPickQ] = useState("");
  /** 探して出てきた人 */
  const [pickRows, setPickRows] = useState<
    {
      kind: string;
      email: string;
      full_name: string;
      student_no: string;
      number: string;
      grade: number | null;
      class_code: string;
      class_no: number | null;
      seat_no: number | null;
    }[]
  >([]);
  const [pickBusy, setPickBusy] = useState(false);
  /** 学年・学科・クラスでの絞り込み。名前がうろ覚えのときに使う */
  const [pickGrade, setPickGrade] = useState<number | null>(null);
  const [pickCode, setPickCode] = useState<string | null>(null);
  const [pickNo, setPickNo] = useState<number | null>(null);

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
  /** 見出しから読み取った列の当て方。空なら A列から順に当てた */
  const [headNote, setHeadNote] = useState("");
  /** 見出しの行から読めたか。false なら A列から順に当てた */
  const [headNamed, setHeadNamed] = useState(false);

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

  useEffect(() => soon(load), [load]);

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
              ? `${e.message}（base/03_roster.sql を入れ直していない場合は、先に入れてください）`
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

  /* ---------------- xlsx に書き出す ---------------- */

  /** 書き出している途中か */
  const [outBusy, setOutBusy] = useState(false);
  /**
   * どの身分を出すか。空なら、ぜんぶ。
   *
   * 「学生だけほしい」「教職員だけほしい」は、よくある頼まれ方。
   * ぜんぶ出してから消してもらうのは、渡す側の手間になる。
   */
  const [outKinds, setOutKinds] = useState<PeopleKind[]>([]);
  /**
   * 出来上がったファイル。
   *
   * ★押した流れの中で保存させない
   *
   *   前は、押したらそのまま保存させていた。人を集めるのに何度か
   *   問い合わせるので、保存が始まるのは押してから少しあと。
   *   端末によっては「押した勢い」がそこまで続かず、
   *   何も起きないまま終わる。押しても反応しない、の正体。
   *
   *   集めるのと保存するのを分ける。集め終わったら、押せる形の
   *   保存の道が出る。そこを押した瞬間に保存が始まるので、
   *   どの端末でも取りこぼさない。
   */
  const [outFile, setOutFile] = useState<{ url: string; name: string; n: number } | null>(null);

  /**
   * いまログインしている人を、xlsx にまとめて保存する。
   *
   * ■ 身分ごとにシートを分ける
   *   一枚にぜんぶ並べると、学生の欄と教授の欄が混ざる。
   *   分けておけば、その身分で使う列だけを見ればよい。
   *
   * ■ 読むときと同じ形にする
   *   一行目が見出し、そこから一行に一人。列の並びも、見出しの言葉も、
   *   xlsx から取り込むときとまったく同じにしてある。
   *   だから、出したものを直して入れ直せる。
   *
   * ■ 何人いても最後まで出す
   *   データベース側は一度に 2000 人までしか返さない。
   *   足りなければ続きを取りに行く。途中で切れたことに
   *   気づけないほうが困る。
   */
  /**
   * 席のある人を集める。
   *
   * ■ 三通りのやり方を、順に試す
   *
   *   ① export_people(限り, 位置, 身分)   28 まで入っている
   *   ② export_people(限り, 位置)         24 まで入っている
   *   ③ list_people(身分, …) を身分ごと    15 まで入っている
   *
   *   なぜこうするか。データベース側は手で貼るので、画面のほうだけが
   *   先に新しくなる時期が必ずある。そのとき「関数がありません」と
   *   出るだけで、何も保存できなかった。何が足りないのか、
   *   どれを貼ればよいのかも分からない。
   *
   *   古いやり方でも動くようにしておけば、貼るまでのあいだも使える。
   *   そのうえで「どれを貼ると、もっとよくなるか」を画面に出す。
   *
   * ■ ③は取りこぼす
   *   身分ごとに訊く形なので、どの身分にも当てはまらない人
   *   （承認待ちなど）が返ってこない。そこは正直に知らせる。
   */
  const collectPeople = async (
    supabase: ReturnType<typeof createClient>,
    pick: PeopleKind[] | null,
  ): Promise<{ rows: Person[]; how: 1 | 2 | 3; note: string }> => {
    /* ① いちばん新しいやり方 */
    try {
      const rows: Person[] = [];
      for (let at = 0; ; at += 2000) {
        const { data, error } = await supabase.rpc("export_people", {
          p_limit: 2000,
          p_offset: at,
          p_kinds: pick,
        });
        if (error) throw error;
        const got = (data as Person[]) ?? [];
        rows.push(...got);
        if (got.length < 2000) break;
      }
      return { rows, how: 1, note: "" };
    } catch {
      /* 次を試す */
    }

    /* ② 身分で絞れない版。こちらで絞る */
    try {
      const rows: Person[] = [];
      for (let at = 0; ; at += 2000) {
        const { data, error } = await supabase.rpc("export_people", {
          p_limit: 2000,
          p_offset: at,
        });
        if (error) throw error;
        const got = (data as Person[]) ?? [];
        rows.push(...got);
        if (got.length < 2000) break;
      }
      return {
        rows: pick ? rows.filter((x) => pick.includes(String(x.kind ?? "other") as PeopleKind)) : rows,
        how: 2,
        note: "課外活動リーダーの欄（Q列・R列）は、base/03_roster.sql を入れると出ます。",
      };
    } catch {
      /* 次を試す */
    }

    /* ③ いちばん古いやり方。身分ごとに訊く */
    const rows: Person[] = [];
    for (const k of PEOPLE_KINDS) {
      if (pick && !pick.includes(k.id)) continue;
      for (let at = 0; ; at += 2000) {
        const { data, error } = await supabase.rpc("list_people", {
          p_kind: k.id,
          p_dept_id: null,
          p_q: "",
          p_limit: 2000,
          p_offset: at,
        });
        if (error) throw error;
        const got = ((data as Person[]) ?? []).map((x) => ({ ...x, kind: k.id }));
        rows.push(...got);
        if (got.length < 2000) break;
      }
    }
    return {
      rows,
      how: 3,
      note: "身分ごとに訊く古いやり方で集めました。base/03_roster.sql を入れると、一度で確かに集められます。",
    };
  };

  const saveAll = async () => {
    if (!supabaseReady) return;
    setOutBusy(true);
    setMsg(null);
    try {
      const supabase = createClient();

      /* 選んでいなければ、ぜんぶ（null を渡す） */
      const pick = outKinds.length > 0 ? outKinds : null;

      const { rows: all, how, note } = await collectPeople(supabase, pick);

      /*
       * 席の数と、もらえた数を突き合わせる。
       *
       * 足りないまま渡すと、あとから気づけない。
       * 数が合わなければ、その場で知らせる。
       */
      let seats = -1;
      try {
        const a = await supabase.rpc("people_total", { p_kinds: pick });
        if (a.error) throw a.error;
        seats = Number(a.data ?? -1);
      } catch {
        try {
          const b = await supabase.rpc("people_total");
          if (!b.error && pick === null) seats = Number(b.data ?? -1);
        } catch {
          /* 数えられなくても、書き出しは続ける */
        }
      }

      /* 身分ごとにシートを分ける。並びは PEOPLE_KINDS のとおり */
      const byKind = new Map<string, Person[]>();
      for (const x of all) {
        const k = String(x.kind ?? "other");
        const list = byKind.get(k);
        if (list) list.push(x);
        else byKind.set(k, [x]);
      }

      const sheets: Sheet[] = [];
      const seen = new Set<string>();
      for (const k of PEOPLE_KINDS) {
        if (pick && !pick.includes(k.id)) continue;
        seen.add(k.id);
        sheets.push({
          name: k.label,
          rows: [EXPORT_HEAD, ...(byKind.get(k.id) ?? []).map(toRow)],
        });
      }
      /* 知らない身分が返ってきたら、そのぶんのシートも作る */
      for (const [k, list] of byKind) {
        if (seen.has(k)) continue;
        sheets.push({ name: k, rows: [EXPORT_HEAD, ...list.map(toRow)] });
      }

      /* 押した瞬間に保存できるよう、ここでは作るだけ */
      if (outFile) URL.revokeObjectURL(outFile.url);
      const url = URL.createObjectURL(buildXlsx(sheets));
      setOutFile({ url, name: "kit(people).xlsx", n: all.length });

      const inner = sheets.map((x) => `${x.name} ${x.rows.length - 1}`).join("、");
      const short = seats >= 0 && seats !== all.length;
      setMsg({
        kind: short ? "err" : "ok",
        text: short
          ? `${all.length} 人ぶんを集めましたが、席は ${seats} 人あります。${seats - all.length} 人ぶんが入っていません。${note}`
          : `${all.length} 人ぶんを集めました（${inner}）。下の「保存する」を押してください。${note}`,
      });
      noteEvent("people", `ログインしている人を xlsx に書き出しました（${all.length} 人）`, {
        人数: all.length,
        席: seats,
        やり方: how,
        シート: inner,
      });
    } catch (e) {
      /*
       * どこで止まったのかを、そのまま出す。
       *
       * 「保存できません」だけでは、貼り忘れなのか、権限なのか、
       * つながっていないのかが分からない。出た言葉をそのまま見せて、
       * 貼るべきものも並べる。
       */
      const raw =
        e instanceof Error
          ? e.message
          : typeof e === "object" && e !== null && "message" in e
            ? String((e as { message: unknown }).message)
            : String(e);
      setMsg({
        kind: "err",
        text: `${raw}｜base/03_roster.sql が入っているかをお確かめください。`,
      });
      noteError("people", "ログインしている人を書き出せませんでした", e);
    } finally {
      setOutBusy(false);
    }
  };

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
              ? `${e.message}（base/03_roster.sql をまだ入れていない場合は、先に入れてください）`
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
            ? `${e.message}（base/03_roster.sql を入れ直していない場合は、先に入れてください）`
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

  /**
   * 学科を登録する（新しく作る／記号を直す）。
   *
   * ■ 増やす前に一度たずねる
   *   学科は、申請・時間割・名簿のぜんぶが見ている土台。
   *   打ち間違いのまま入ると、あとから直すのが大ごとになる。
   *
   * ■ 断られたときは、理由をそのまま出す
   *   「その記号はもう使われています」「その学部にはもう同じ名前が
   *   あります」——データベースが持っている決まりなので、
   *   画面で数え直さず、返ってきたものを見せる。
   */
  const saveDept = async () => {
    setMsg(null);
    const facName = facNew.trim();
    const dName = deptNew.trim();
    const code = codeNew.trim().toUpperCase();

    if (facPick === "new" && !facName) {
      setMsg({ kind: "err", text: T("学部の名前を入れてください") });
      return;
    }
    if (deptPick === "new" && !dName) {
      setMsg({ kind: "err", text: T("学科の名前を入れてください") });
      return;
    }

    const facLabel =
      facPick === "new" ? facName : (facs.find((f) => String(f.id) === facPick)?.name ?? "");
    const dLabel =
      deptPick === "new" ? dName : (depts.find((d) => String(d.id) === deptPick)?.name ?? "");
    const before =
      deptPick === "new" ? "" : (depts.find((d) => String(d.id) === deptPick)?.code ?? "");

    if (
      !window.confirm(
        [
          deptPick === "new" ? "学科を新しく登録します。" : "学科の記号を直します。",
          "",
          `  学部  ${facLabel}${facPick === "new" ? "（新しく作ります）" : ""}`,
          `  学科  ${dLabel}`,
          `  記号  ${code || "（無し）"}${
            deptPick !== "new" && before !== code ? `（いまは ${before || "無し"}）` : ""
          }`,
          "",
          "この記号で、申請してきた人の学科と突き合わせます。",
          "よろしいですか？",
        ].join(BR),
      )
    )
      return;

    setBusy(true);
    try {
      const supabase = createClient();

      /* 学部。新しく作るなら、先に作って id をもらう */
      let facId: number;
      if (facPick === "new") {
        const made = await supabase
          .from("faculties")
          .insert({ name: facName })
          .select("id")
          .single();
        if (made.error) throw made.error;
        facId = (made.data as { id: number }).id;
      } else {
        facId = Number(facPick);
      }

      if (deptPick === "new") {
        const { error } = await supabase
          .from("departments")
          .insert({ faculty_id: facId, name: dName, code });
        if (error) throw error;
        setMsg({ kind: "ok", text: `${facLabel} に「${dName}（${code || "記号なし"}）」を足しました。` });
      } else {
        const { error } = await supabase
          .from("departments")
          .update({ code })
          .eq("id", Number(deptPick));
        if (error) throw error;
        setMsg({ kind: "ok", text: `${dLabel} の記号を「${code || "無し"}」にしました。` });
      }

      setFacNew("");
      setDeptNew("");
      setCodeNew("");
      setDeptPick("new");
      await load();
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setMsg({
        kind: "err",
        text: /departments_code_key/.test(m)
          ? `その記号（${code}）は、ほかの学科が使っています。別の記号にしてください。`
          : /departments_faculty_name_key/.test(m)
            ? `${facLabel} には、もう「${dName}」があります。`
            : /faculties_name_key/.test(m)
              ? `「${facName}」という学部は、もうあります。上の欄から選んでください。`
              : `${m}（base/02_campus.sql を入れ直していない場合は、先に入れてください）`,
      });
    } finally {
      setBusy(false);
    }
  };

  /**
   * 学科ごとの科目の数。
   *
   * 消すときの確認に出す。「この学科の科目 12 件が学科なしになります」
   * と数で言えないと、押していいのか判断できない。
   */
  const [courseCount, setCourseCount] = useState<Record<number, number>>({});

  useEffect(() => {
    if (!supabaseReady || !deptOpen) return;
    void (async () => {
      const { data } = await createClient().from("courses").select("department_id").limit(5000);
      const m: Record<number, number> = {};
      for (const c of (data as { department_id: number | null }[]) ?? [])
        if (c.department_id != null) m[c.department_id] = (m[c.department_id] ?? 0) + 1;
      setCourseCount(m);
    })();
  }, [deptOpen]);

  /* ---------------- 課外活動リーダーの名簿 ---------------- */

  const loadLeaders = useCallback(async () => {
    if (!supabaseReady) return;
    setLeadBusy(true);
    try {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("leader_roster_list", {
        p_q: leadQ.trim(),
        p_activity_id: leadPick,
        p_limit: 300,
        p_offset: 0,
      });
      if (error) throw error;
      const list = (data as (LeaderRow & { total: number })[]) ?? [];
      setLeadRows(list);
      setLeadTotal(list.length > 0 ? Number(list[0].total) : 0);
    } catch (e) {
      setMsg({
        kind: "err",
        text:
          (e instanceof Error ? e.message : String(e)) +
          "（base/03_roster.sql をまだ入れていない場合は、先に入れてください）",
      });
      setLeadRows([]);
      setLeadTotal(0);
    } finally {
      setLeadBusy(false);
    }
  }, [leadQ, leadPick]);

  // 開いたときに、団体の一覧を読む（分類 → 団体 と選ばせるため）
  useEffect(() => {
    if (!supabaseReady || !leadOpen || leadActs.length > 0) return;
    void (async () => {
      const supabase = createClient();
      const [c, a] = await Promise.all([
        supabase.from("activity_categories").select("id, name").order("sort_order"),
        supabase.from("club_activities").select("id, category_id, name").order("sort_order"),
      ]);
      setLeadCats((c.data as { id: number; name: string }[]) ?? []);
      setLeadActs((a.data as { id: number; category_id: number | null; name: string }[]) ?? []);
    })();
  }, [leadOpen, leadActs.length]);

  useEffect(() => {
    if (!leadOpen) return;
    const t = window.setTimeout(() => void loadLeaders(), 200);
    return () => window.clearTimeout(t);
  }, [leadOpen, loadLeaders]);

  /**
   * リーダーを一人足す。
   *
   * 番号は 8桁。学生証・職員証に書いてあるものをそのまま入れる。
   * ここで入れた番号と、申請する本人の番号が合わないと通らないので、
   * 打ち間違いはそのまま「通らない」になって返ってくる。
   */
  /**
   * 名簿から人を探す。
   *
   * ★手で打たせない
   *   前は番号と氏名を手で打っていた。打ち間違えると、その人は
   *   申請しても通らない。しかも間違いに気づけない——
   *   「入れたのに通らない」だけが残る。
   *   名簿から選べば、番号も氏名もそのまま入る。
   */
  const findPeople = useCallback(
    async (word: string, g: number | null, c: string | null, n: number | null) => {
      if (!supabaseReady) {
        setPickRows([]);
        return;
      }
      /* 言葉も絞り込みも無いときは、訊きにいかない（名簿ぜんぶは出さない） */
      if (word.trim() === "" && g === null && c === null && n === null) {
        setPickRows([]);
        return;
      }
      setPickBusy(true);
      try {
        const { data, error } = await createClient().rpc("roster_pick", {
          p_q: word.trim(),
          p_limit: 60,
          p_grade: g,
          p_class_code: c,
          p_class_no: n,
        });
        if (error) throw error;
        setPickRows(
          (data as {
            kind: string;
            email: string;
            full_name: string;
            student_no: string;
            number: string;
            grade: number | null;
            class_code: string;
            class_no: number | null;
            seat_no: number | null;
          }[]) ?? [],
        );
      } catch (e) {
        setPickRows([]);
        setMsg({
          kind: "err",
          text:
            e instanceof Error
              ? `${e.message}（base/03_roster.sql をまだ入れていない場合は、先に入れてください）`
              : String(e),
        });
      } finally {
        setPickBusy(false);
      }
    },
    [],
  );

  /**
   * 課外活動そのものを増やす。
   *
   * ■ なぜ要るか
   *   団体の一覧は、はじめに入れた 97 のまま増やせなかった。
   *   新しい同好会ができても、リーダーを入れることも、
   *   予定を入れることも、学内の情報で探すこともできない。
   *   一覧に無いものは、どこからも扱えない。
   *
   * ■ 系統は選ぶ、名前は打つ
   *   系統（体育部会・文化部会・同好会…）は決まったものなので選ぶ。
   *   名前は、そこにしか無いものなので打ってもらう。
   *
   * ■ 同じ名前は入れない
   *   二つあると、リーダーも予定もどちらに付いたのか分からなくなる。
   *   先に在るかを見て、あればそう伝える。
   *
   * ■ できるのはレベル2.2 と管理者だけ
   *   欄そのものを 2.1 には出していないが、ここでも見ている。
   *   画面の出し分けは、押せるかどうかを決めるものではない。
   *   本当に止めているのはデータベース側（base/02_campus.sql）。
   */
  const addActivity = async () => {
    if (!canManage(role)) {
      setMsg({ kind: "err", text: "課外活動を増やせるのは、レベル2.2 と管理者だけです。" });
      return;
    }
    const name = newActName.trim();
    if (newActCat === null) {
      setMsg({ kind: "err", text: "何系の活動かを選んでください。" });
      return;
    }
    if (name === "") {
      setMsg({ kind: "err", text: "課外活動の名前を入れてください。" });
      return;
    }
    const same = leadActs.find((a) => a.name.replace(/\s/g, "") === name.replace(/\s/g, ""));
    if (same) {
      setMsg({ kind: "err", text: `「${same.name}」は、もう入っています。` });
      return;
    }

    const catName = leadCats.find((c) => c.id === newActCat)?.name ?? "";
    if (
      !window.confirm(
        [
          `課外活動を一つ増やします。`,
          "",
          `  系統  ${catName}`,
          `  名前  ${name}`,
          "",
          "増やすと、リーダーの名簿・予定の登録・学内の情報の三つに出てきます。",
          "よろしいですか？",
        ].join(BR),
      )
    )
      return;

    setLeadBusy(true);
    setMsg(null);
    try {
      const supabase = createClient();
      /* 並びは、その系統のいちばん後ろに付ける */
      const tail =
        leadActs.filter((a) => a.category_id === newActCat).length + 1;
      const { error } = await supabase
        .from("club_activities")
        .insert({ category_id: newActCat, name, sort_order: tail });
      if (error) throw error;

      const { data } = await supabase
        .from("club_activities")
        .select("id, category_id, name")
        .order("sort_order");
      setLeadActs((data as { id: number; category_id: number | null; name: string }[]) ?? []);
      setNewActName("");
      setMsg({ kind: "ok", text: `${catName} に「${name}」を増やしました。` });
      noteEvent("campus", `課外活動を増やしました（${name}）`, { 系統: catName, 名前: name });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setMsg({
        kind: "err",
        text: /duplicate|unique/i.test(m)
          ? `「${name}」は、もう入っています。`
          : `${m}（base/02_campus.sql をまだ入れていない場合は、先に入れてください）`,
      });
      noteError("campus", "課外活動を増やせませんでした", e);
    } finally {
      setLeadBusy(false);
    }
  };

  const addLeader = async () => {
    /* すべて数字の8桁だけ。学籍番号（c1234567）は番号ではない */
    const no = leadNo.replace(/[^0-9]/g, "");
    if (leadAct === null) {
      setMsg({ kind: "err", text: "どこの団体かを選んでください。" });
      return;
    }
    if (no.length !== 8) {
      setMsg({
        kind: "err",
        text: `番号は、すべて数字の8桁で入れてください（いま ${no.length}桁）。`,
      });
      return;
    }
    const act = leadActs.find((a) => a.id === leadAct);
    if (
      !window.confirm(
        [
          "課外活動リーダーの名簿に、一人足します。",
          "",
          `  団体  ${act?.name ?? ""}`,
          `  番号  ${no}`,
          leadName.trim() ? `  氏名  ${leadName.trim()}` : "",
          "",
          "この番号の人が申請すると、kit-agent が通します。",
        ]
          .filter((x) => x !== "")
          .join(BR),
      )
    )
      return;

    setLeadBusy(true);
    setMsg(null);
    try {
      const { error } = await createClient()
        .from("club_leaders")
        .insert({ activity_id: leadAct, number: no, full_name: leadName.trim() });
      if (error) throw error;
      setMsg({ kind: "ok", text: `${act?.name ?? ""} に ${no} を足しました。` });
      setLeadNo("");
      setLeadName("");
      await loadLeaders();
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setMsg({
        kind: "err",
        text: /duplicate|club_leaders_one/.test(m)
          ? "その団体には、その番号がもう入っています。"
          : m,
      });
    } finally {
      setLeadBusy(false);
    }
  };

  const removeLeader = async (r: LeaderRow) => {
    if (
      !window.confirm(
        [
          "課外活動リーダーの名簿から、一人外します。",
          "",
          `  団体  ${r.activity_name}`,
          `  番号  ${r.number}`,
          r.full_name ? `  氏名  ${r.full_name}` : "",
          "",
          "外すと、その人は次に確かめたときにリーダーでなくなります。",
          "（申請で付いた権限だけが学生に戻ります。手で付けた権限は残ります）",
        ]
          .filter((x) => x !== "")
          .join(BR),
      )
    )
      return;

    setLeadBusy(true);
    setMsg(null);
    try {
      const { error } = await createClient().from("club_leaders").delete().eq("id", r.id);
      if (error) throw error;
      setMsg({ kind: "ok", text: `${r.activity_name} から ${r.number} を外しました。` });
      await loadLeaders();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setLeadBusy(false);
    }
  };

  /**
   * 学科を消す。
   *
   * ■ 何が道連れになるか
   *   学科は、科目（courses.department_id）から指されている。
   *   消すと、その科目の学科は「無し」になる（on delete set null）。
   *   科目そのものと、入れてある予定は残る。
   *
   *   申請してきた人の学科（profiles.class_code）は記号で持っていて、
   *   この表とは繋がっていない。だから学科を消しても、
   *   その人の申請が消えることはない。ただし記号が合わなくなるので、
   *   自動の割り振りは通らなくなる。そこは確認の文に書く。
   */
  const removeDept = async () => {
    if (deptPick === "new") return;
    const d = depts.find((x) => String(x.id) === deptPick);
    if (!d) return;

    const used = courseCount[d.id] ?? 0;
    if (
      !window.confirm(
        [
          `学科「${d.name}${d.code ? `（${d.code}）` : ""}」を消します。`,
          "",
          used > 0 ? `  この学科の科目 ${used} 件は、学科が「無し」になります` : "  この学科の科目はありません",
          "  科目そのものと、入れてある予定は残ります",
          "",
          d.code
            ? `記号「${d.code}」の人の申請は、これ以降その学科として通らなくなります。`
            : "",
          "元には戻せません。よろしいですか？",
        ]
          .filter((x) => x !== "")
          .join(BR),
      )
    )
      return;
    if (!window.confirm(`本当に「${d.name}」を消しますか？${BR}${BR}これが最後の確認です。`)) return;

    setBusy(true);
    setMsg(null);
    try {
      const { error } = await createClient().from("departments").delete().eq("id", d.id);
      if (error) throw error;
      setMsg({ kind: "ok", text: `学科「${d.name}」を消しました。` });
      setDeptPick("new");
      setCodeNew("");
      await load();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  /**
   * 学部を消す。
   *
   * ★中の学科も一緒に消える（on delete cascade）。
   *   いちばん強い操作なので、中に何があるかを数えて見せてから訊く。
   */
  const removeFaculty = async () => {
    if (facPick === "new") return;
    const f = facs.find((x) => String(x.id) === facPick);
    if (!f) return;
    const inside = depts.filter((d) => d.faculty_id === f.id);

    if (
      !window.confirm(
        [
          `学部「${f.name}」を消します。`,
          "",
          inside.length > 0
            ? `★この学部の学科 ${inside.length} 件も、一緒に消えます`
            : "  この学部に学科はありません",
          ...inside.slice(0, 8).map((d) => `    ・${d.name}${d.code ? `（${d.code}）` : ""}`),
          inside.length > 8 ? `    ほか ${inside.length - 8} 件` : "",
          "",
          "消えた学科の科目は、学科が「無し」になります。",
          "元には戻せません。よろしいですか？",
        ]
          .filter((x) => x !== "")
          .join(BR),
      )
    )
      return;
    if (
      !window.confirm(
        `本当に「${f.name}」と、その中の ${inside.length} 学科を消しますか？${BR}${BR}これが最後の確認です。`,
      )
    )
      return;

    setBusy(true);
    setMsg(null);
    try {
      const { error } = await createClient().from("faculties").delete().eq("id", f.id);
      if (error) throw error;
      setMsg({ kind: "ok", text: `学部「${f.name}」を消しました。` });
      setFacPick("new");
      setDeptPick("new");
      setCodeNew("");
      await load();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
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
      const raw = await readXlsx(file);

      /*
       * 見出しがあればそこから、無ければ A列から順に当てる。
       * 決まりそのものは lib/roster.ts に置いてある（机の上で試せるように）。
       */
      const { rows: kept, head, named } = toSending(raw);
      setHeadNote(headNoteOf(head));
      setHeadNamed(named);

      setFileName(file.name);
      setRows(kept);
      noteEvent("roster", `xlsx を読みました（${file.name}／${kept.length} 行）`, {
        file: file.name,
        rows: kept.length,
        見出しから: named,
        列の当て方: headNoteOf(head),
      });
      if (kept.length === 0) setMsg({ kind: "err", text: T("中身のある行がありませんでした") });
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "読めませんでした" });
      noteError("roster", `xlsx を読めませんでした（${file.name}）`, e);
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
      /*
       * 何行入って何行落ちたかを、履歴に残す。
       * 「読ませたのに入らない」を、あとから追えるようにするため。
       * 落ちた理由も 20 件まで一緒に残る。
       */
      void createClient().rpc("import_note", { p_result: rep, p_from: fileName });
      await load();
      // 見ている最中なら、入れたものがそのまま並ぶようにする
      if (listOpen) await loadList(listKind, kindDef.byDept ? deptId : null, q.trim(), page);
    } catch (e) {
      setMsg({
        kind: "err",
        text:
          e instanceof Error
            ? `${e.message}（base/03_roster.sql をまだ入れていない場合は、先に入れてください）`
            : String(e),
      });
      noteError("roster", `名簿を取り込めませんでした（${fileName}／${rows.length} 行）`, e);
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
            ? `${e.message}（base/03_roster.sql をまだ入れていない場合は、先に入れてください）`
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
            ? `${e.message}（base/03_roster.sql をまだ入れていない場合は、先に入れてください）`
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
     * 03_roster.sql の 03-3 を流す前は get_domains が無いので domains は空になる。
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
            ? `${e.message}（base/03_roster.sql を入れ直していない場合は、先に入れてください）`
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
      <AdminHeader title={T("大学の情報登録")} />
      <AdminMenu current="campus" role={role} />

      {msg && (
        <p
          className={`mb-3 rounded-xl p-3 text-xs leading-relaxed ${
            msg.kind === "ok" ? "bg-emerald-50 text-emerald-900" : "bg-red-50 text-red-800"
          }`}
        >
          {msg.text}
        </p>
      )}

      {/*
        この画面でできること。

        中身は下に縦に並んでいる。それぞれ「開く」を押すと出るので、
        いっぺんに全部が見えて迷う、ということにならない。
        押すとその欄まで送る。
      */}
      <nav className="mb-3 grid grid-cols-2 gap-1.5">
        {[
          ["/admin/rooms", "教室の登録"],
          ["#depts", "学科登録"],
          ["#leaders", "課外活動の情報"],
          ["#domain", "ドメイン名確認"],
          ["#people", "ログインしている人を見る"],
          ["#xlsx", "xlsx から取り込む"],
          ["#manual", "登録者を増やす"],
        ].map(([to, label]) => (
          <a
            key={to}
            href={to}
            className="rounded-xl bg-slate-100 px-3 py-2.5 text-center text-[11px] font-bold text-slate-700 transition hover:bg-slate-200 active:scale-95"
          >
            {T(label)}
          </a>
        ))}
      </nav>

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
        ログインしている人を見る。

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
      <section id="people" className="mt-4 scroll-mt-4 rounded-xl border border-slate-200 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-bold text-slate-900">{T("ログインしている人を見る")}</div>
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

        {/*
          xlsx に保存する。

          身分ごとにシートを分け、一行目に見出し、そこから一行に一人。
          取り込むときとまったく同じ形なので、出したものを直して
          入れ直せる。絞り込みは掛けずに、いまいる人ぜんぶを出す。
        */}
        {canWrite && (
          <div className="mt-2">
            {/*
              どの身分を出すか。

              何も選ばなければ、ぜんぶ出す。「ぜんぶ」を選ばせる形にすると、
              選び忘れたときに何も出ないことになる。既定はぜんぶのほうが安全。
            */}
            <div className="mb-2">
              <div className="text-[10px] font-bold text-slate-500">{T("出す身分")}</div>
              <div className="mt-1 flex flex-wrap gap-1">
                <button
                  onClick={() => setOutKinds([])}
                  className={`rounded-lg px-2.5 py-1.5 text-[11px] font-bold transition active:scale-95 ${
                    outKinds.length === 0
                      ? "bg-slate-900 text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {T("すべて")}
                </button>
                {PEOPLE_KINDS.map((k) => {
                  const on = outKinds.includes(k.id);
                  return (
                    <button
                      key={k.id}
                      onClick={() =>
                        setOutKinds((v) =>
                          on ? v.filter((x) => x !== k.id) : [...v, k.id],
                        )
                      }
                      className={`rounded-lg px-2.5 py-1.5 text-[11px] font-bold transition active:scale-95 ${
                        on
                          ? "bg-emerald-600 text-white"
                          : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                      }`}
                    >
                      {T(k.label)}
                      <span className="ml-1 font-normal opacity-70">
                        {peopleCounts?.[k.id] ?? 0}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <button
              onClick={() => void saveAll()}
              disabled={outBusy || busy}
              className="w-full rounded-xl bg-emerald-600 px-3 py-2.5 text-xs font-bold text-white transition hover:bg-emerald-700 active:scale-95 disabled:bg-slate-200 disabled:text-slate-400"
            >
              {outBusy
                ? T("集めています…")
                : outKinds.length === 0
                  ? T("ぜんぶ集める")
                  : `${outKinds.map((k) => T(PEOPLE_KINDS.find((x) => x.id === k)?.label ?? k)).join("・")} を集める`}
            </button>

            {/*
              保存の道。集め終わってから出す。

              押した瞬間に保存が始まるので、端末を選ばない。
              a に download を付けた本物の道にしてあるのは、そのため。
            */}
            {outFile && (
              <a
                href={outFile.url}
                download={outFile.name}
                className="mt-1.5 block w-full rounded-xl bg-blue-600 px-3 py-3 text-center text-xs font-bold text-white transition hover:bg-blue-700 active:scale-95"
              >
                {T("保存する")}（{outFile.name}・{outFile.n} {T("人")}）
              </a>
            )}
            <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
              {T("身分ごとにシートを分けて出します。1行目が見出しで、そこから1行に1人です。")}
              <br />
              {T("取り込むときと同じ形なので、直してそのまま入れ直せます。")}
            </p>
          </div>
        )}

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
                    {T(k.label)}
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
      {/*
        学科登録。

        ■ 学部も学科も、選ぶか、新しく作るか
          はじめて使うときは何も無い。選ぶだけの形にすると、
          そこで手が止まる。どちらの欄も「新しく作る」を選べる。

        ■ 同じ名前の学科が、学部をまたいで在ることがある
            工学部       情報工学科  EP
            情報理工学部 情報工学科  CC
          名前は学部の中だけで一つ。学部が違えば同じ名前を入れられる。
          記号（CC など）のほうは、全体で一つ。
          記号は申請の学科と突き合わせる鍵なので、二つの学科が
          同じ記号を持つと、どちらの学科か分からなくなる。

        ■ 増やす前に一度たずねる
          学科は、申請・時間割・名簿のぜんぶが見ている土台。
          打ち間違いのまま入ると、あとから直すのが大ごとになる。
      */}
      <section id="depts" className="mt-4 scroll-mt-4 rounded-xl border border-slate-200 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-bold text-slate-900">{T("学科登録")}</div>
          <button
            onClick={() => setDeptOpen((v) => !v)}
            className="rounded-lg bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-600 transition hover:bg-slate-200 active:scale-95"
          >
            {deptOpen ? T("閉じる") : T("学科を登録する")}
          </button>
        </div>

        {deptOpen && (
          <div className="mt-2">
            {!canWrite ? (
              <p className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-[10px] leading-relaxed text-slate-500">
                {T("学科を登録できるのは、副管理者と管理者だけです。")}
              </p>
            ) : (
              <>
                <label className="block text-[10px] font-bold text-slate-500">{T("学部")}</label>
                <select
                  value={facPick}
                  onChange={(e) => {
                    setFacPick(e.target.value);
                    setDeptPick("new");
                  }}
                  className={rSelect}
                >
                  {facs.map((f) => (
                    <option key={f.id} value={String(f.id)}>
                      {f.name}
                    </option>
                  ))}
                  <option value="new">＋ {T("新しい学部を作る")}</option>
                </select>
                {facPick === "new" && (
                  <input
                    value={facNew}
                    onChange={(e) => setFacNew(e.target.value)}
                    placeholder={T("学部の名前（例：工学部）")}
                    className={`${rSelect} mt-1`}
                  />
                )}

                <label className="mt-2 block text-[10px] font-bold text-slate-500">
                  {T("学科")}
                </label>
                <select
                  value={deptPick}
                  onChange={(e) => {
                    setDeptPick(e.target.value);
                    const d = depts.find((x) => String(x.id) === e.target.value);
                    // 選び直したら、その学科のいまの記号を入れておく
                    if (d) setCodeNew(d.code ?? "");
                  }}
                  disabled={facPick === "new"}
                  className={rSelect}
                >
                  <option value="new">＋ {T("新しい学科を作る")}</option>
                  {depts
                    .filter((d) => String(d.faculty_id) === facPick)
                    .map((d) => (
                      <option key={d.id} value={String(d.id)}>
                        {d.name}
                        {d.code ? `（${d.code}）` : "（記号なし）"}
                      </option>
                    ))}
                </select>

                {deptPick === "new" && (
                  <input
                    value={deptNew}
                    onChange={(e) => setDeptNew(e.target.value)}
                    placeholder={T("学科の名前（例：情報工学科）")}
                    className={`${rSelect} mt-1`}
                  />
                )}

                <label className="mt-2 block text-[10px] font-bold text-slate-500">
                  {T("記号")}
                </label>
                <input
                  value={codeNew}
                  onChange={(e) => setCodeNew(e.target.value.toUpperCase().slice(0, 8))}
                  placeholder="CC"
                  autoCapitalize="characters"
                  className={`${rSelect} font-mono`}
                />
                <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
                  {T("申請とクラスの突き合わせに使う記号です（CC・KM など）。")}
                  <br />
                  {T("同じ名前の学科でも、学部が違えば別の記号を付けられます（例：工学部 情報工学科 EP ／ 情報理工学部 情報工学科 CC）。")}
                  <br />
                  {T("記号は全体で一つ。ほかの学科が使っている記号は入れられません。")}
                </p>

                <button
                  onClick={() => void saveDept()}
                  disabled={busy}
                  className="mt-2 w-full rounded-xl bg-slate-900 px-3 py-2.5 text-xs font-bold text-white transition hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400"
                >
                  {busy ? T("登録中…") : T("この内容で登録する")}
                </button>

                {/*
                  消す道。

                  記号だけを消したいこともある（学科は残す）ので、
                  「記号を空にする」も別に置いてある。
                  学部を消すと、中の学科も一緒に消える。いちばん強いので下に。
                */}
                <div className="mt-3 border-t border-slate-200 pt-2">
                  <div className="text-[10px] font-bold text-slate-500">{T("消す")}</div>
                  <div className="mt-1 grid gap-1.5">
                    {deptPick !== "new" && codeNew.trim() !== "" && (
                      <button
                        onClick={() => setCodeNew("")}
                        disabled={busy}
                        className="rounded-lg bg-slate-100 px-2 py-2 text-[11px] font-bold text-slate-700 transition hover:bg-slate-200 active:scale-95"
                      >
                        {T("記号を空にする（上の「この内容で登録する」で決まります）")}
                      </button>
                    )}
                    {deptPick !== "new" && (
                      <button
                        onClick={() => void removeDept()}
                        disabled={busy}
                        className="rounded-lg bg-white px-2 py-2 text-[11px] font-bold text-red-600 shadow-sm transition hover:bg-red-50 active:scale-95 disabled:text-slate-300"
                      >
                        {T("この学科を消す")}
                      </button>
                    )}
                    {facPick !== "new" && (
                      <button
                        onClick={() => void removeFaculty()}
                        disabled={busy}
                        className="rounded-lg bg-red-600 px-2 py-2 text-[11px] font-bold text-white transition hover:bg-red-700 active:scale-95 disabled:bg-slate-300"
                      >
                        {T("この学部を消す")}（
                        {depts.filter((d) => String(d.faculty_id) === facPick).length}
                        {T("学科ごと")}）
                      </button>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </section>

      {/*
        課外活動の情報。

        はじめはリーダーの名簿だけだったので「課外活動リーダーの名簿」と
        呼んでいたが、団体そのものを増やす欄が入ったので、
        二つをまとめた呼び方にしてある。

        ■ 中は二つ
          団体を増やす … 2.2 と管理者だけ
          リーダーの名簿 … 2.1 以上（この画面を開ける人）

        ■ 名簿は、kit-agent が照らす先
          地図の「申請 → 課外活動リーダー申請」で使う。
          ここに載っている番号の人だけが通る。

        ■ 番号は 8桁
          学生証・職員証に書いてあるもの（c1234567 など）。
          申請する人が入れた番号が本人のものかは、データベース側で
          先に見ている。ここは「誰が長か」だけを持つ。

        ■ 外すと、次に確かめたときに落ちる
          落ちた人は、この申請で付いた権限だけが学生へ戻る。
          承認する人が手で付けた権限は、そのまま残す。
      */}
      {canWrite && (
      <section id="leaders" className="mt-4 scroll-mt-4 rounded-xl border border-slate-200 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-bold text-slate-900">{T("課外活動の情報")}</div>
          <button
            onClick={() => setLeadOpen((v) => !v)}
            className="rounded-lg bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-600 transition hover:bg-slate-200 active:scale-95"
          >
            {leadOpen ? T("閉じる") : T("開く")}
          </button>
        </div>

        {leadOpen && (
          <div className="mt-2">
            <p className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-[10px] leading-relaxed text-slate-500">
              {T("ここに載っている番号の人だけが、課外活動リーダーの申請で通ります。")}
              {T("空のあいだは、kit-agent は誰も通しません。")}
            </p>

            {/*
              課外活動そのものを増やす。

              一覧に無いものは、リーダーも予定も学内の情報も扱えない。
              新しい同好会ができたときに、ここから足せるようにしておく。

              ■ 出すのはレベル2.2 と管理者だけ
                この画面じたいは 2.1 も開けるが、団体を増やす欄は出さない。
                増やしたものは消すのが難しい（リーダーも予定もぶら下がる）ので、
                人の権限に触れられるのと同じ顔ぶれに合わせてある。
                データベース側も base/02_campus.sql で同じ所に締めてある。
            */}
            {canManage(role) && (
            <div className="mt-2 rounded-xl bg-emerald-50 p-2.5">
              <div className="text-[10px] font-bold text-emerald-800">
                {T("課外活動そのものを増やす")}
              </div>
              <div className="mt-1 grid grid-cols-2 gap-1">
                <select
                  value={newActCat ?? ""}
                  onChange={(e) => setNewActCat(e.target.value ? Number(e.target.value) : null)}
                  className={rSelect}
                >
                  <option value="">{T("何系の活動ですか")}</option>
                  {leadCats.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <input
                  value={newActName}
                  onChange={(e) => setNewActName(e.target.value.slice(0, 60))}
                  autoComplete="off"
                  placeholder={T("課外活動の名前")}
                  className={rSelect}
                />
              </div>
              <button
                onClick={() => void addActivity()}
                disabled={leadBusy || newActCat === null || newActName.trim() === ""}
                className="mt-1.5 w-full rounded-xl bg-emerald-600 px-3 py-2 text-[11px] font-bold text-white transition hover:bg-emerald-700 active:scale-95 disabled:bg-slate-200 disabled:text-slate-400"
              >
                {leadBusy ? T("入れています…") : T("この課外活動を増やす")}
              </button>
              <p className="mt-1 text-[10px] leading-relaxed text-emerald-700">
                {T("増やすと、リーダーの名簿・予定の登録・学内の情報の三つに出てきます。")}
              </p>
            </div>
            )}

            {/* 入れる */}
            <div className="mt-2 rounded-xl bg-slate-50 p-2.5">
              <div className="text-[10px] font-bold text-slate-500">{T("一人足す")}</div>
              <select
                value={leadCat ?? ""}
                onChange={(e) => {
                  setLeadCat(e.target.value ? Number(e.target.value) : null);
                  setLeadAct(null);
                }}
                className={`${rSelect} mt-1`}
              >
                <option value="">{T("何系の活動ですか")}</option>
                {leadCats.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <select
                value={leadAct ?? ""}
                onChange={(e) => setLeadAct(e.target.value ? Number(e.target.value) : null)}
                disabled={leadCat === null}
                className={`${rSelect} mt-1`}
              >
                <option value="">
                  {leadCat === null ? T("先に系統を選んでください") : T("どこの団体ですか")}
                </option>
                {leadActs
                  .filter((a) => a.category_id === leadCat)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
              {/*
                人は、名簿から選ぶ。

                ★手で打たせない
                  打ち間違えると、その人は申請しても通らない。しかも
                  間違いに気づけず、「入れたのに通らない」だけが残る。
                  名簿から選べば、番号も氏名もそのまま入る。

                  名簿にいない人はリーダーにできないが、それでよい。
                  名簿にいない人は、そもそも申請そのものが通らない。
              */}
              <div className="mt-1.5 rounded-lg bg-white p-2 ring-1 ring-slate-200">
                <div className="text-[10px] font-bold text-slate-500">{T("名簿から選ぶ")}</div>
                <input
                  value={pickQ}
                  onChange={(e) => {
                    setPickQ(e.target.value);
                    void findPeople(e.target.value, pickGrade, pickCode, pickNo);
                  }}
                  autoComplete="off"
                  placeholder={T("氏名・学籍番号・アドレスで探す")}
                  className={`${rSelect} mt-1`}
                />

                {/*
                  学年・学科・クラスでも絞れる。

                  名前がうろ覚えのときがある。「2年の CC の 3組」まで
                  分かれば、そこから選べる。名前で探すのと、どちらでもよい。
                */}
                <div className="mt-1 grid grid-cols-3 gap-1">
                  <select
                    value={pickGrade ?? ""}
                    onChange={(e) => {
                      const v = e.target.value ? Number(e.target.value) : null;
                      setPickGrade(v);
                      void findPeople(pickQ, v, pickCode, pickNo);
                    }}
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
                    value={pickCode ?? ""}
                    onChange={(e) => {
                      const v = e.target.value || null;
                      setPickCode(v);
                      void findPeople(pickQ, pickGrade, v, pickNo);
                    }}
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
                    value={pickNo ?? ""}
                    onChange={(e) => {
                      const v = e.target.value ? Number(e.target.value) : null;
                      setPickNo(v);
                      void findPeople(pickQ, pickGrade, pickCode, v);
                    }}
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

                {pickBusy && (
                  <p className="mt-1 text-[10px] text-slate-400">{T("探しています…")}</p>
                )}

                {pickRows.length > 0 && (
                  <ul className="mt-1 max-h-48 divide-y divide-slate-100 overflow-y-auto rounded-lg bg-slate-50">
                    {pickRows.map((x) => (
                      <li key={`${x.kind}-${x.email}`}>
                        <button
                          onClick={() => {
                            /*
                             * 学生は名簿に 8桁の番号を持っていない。
                             * 学生証の番号は、こちらでは分からないので
                             * 空にして、手で入れてもらう。
                             * 氏名とアドレスは、そのまま入れる。
                             */
                            setLeadNo(x.number ?? "");
                            setLeadName(x.full_name ?? "");
                            setPickQ(x.full_name ?? "");
                            setPickRows([]);
                          }}
                          className="block w-full px-2.5 py-2 text-left transition hover:bg-white"
                        >
                          <span className="block truncate text-xs font-bold text-slate-800">
                            {x.full_name || "（名前なし）"}
                            <span className="ml-1.5 rounded bg-slate-200 px-1 py-0.5 text-[9px] font-bold text-slate-600">
                              {x.kind === "student" ? T("学生") : T("教職員・職員")}
                            </span>
                          </span>
                          <span className="block truncate text-[10px] text-slate-500">
                            <span className="font-mono">
                              {x.number || x.student_no || x.email}
                            </span>
                            {x.grade ? `　${x.grade}${T("年")}` : ""}
                            {x.class_code ? `　${x.class_code}` : ""}
                            {x.class_no ? `　${T("クラス")}${x.class_no}` : ""}
                            {x.seat_no ? `　${x.seat_no}${T("番")}` : ""}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                {(pickQ.trim() !== "" || pickGrade !== null || pickCode !== null || pickNo !== null) &&
                  !pickBusy &&
                  pickRows.length === 0 && (
                  <p className="mt-1 text-[10px] leading-relaxed text-amber-700">
                      {T("名簿に見つかりません。先に名簿へ入れてください。")}
                    </p>
                  )}
              </div>

              {/* 選んだ人。番号は 8桁の数字で */}
              <div className="mt-1.5 grid grid-cols-2 gap-1">
                <input
                  value={leadNo}
                  onChange={(e) => setLeadNo(e.target.value.replace(/[^0-9]/g, "").slice(0, 8))}
                  autoComplete="off"
                  inputMode="numeric"
                  maxLength={8}
                  placeholder={T("8桁の番号（数字だけ）")}
                  className={`${rSelect} font-mono`}
                />
                <input
                  value={leadName}
                  onChange={(e) => setLeadName(e.target.value)}
                  autoComplete="off"
                  placeholder={T("氏名")}
                  className={rSelect}
                />
              </div>
              <p className="mt-0.5 text-[10px] leading-relaxed text-slate-400">
                {T("学生証・職員証の8桁の番号です。すべて数字で、アドレスの前の部分とは別のものです。")}
              </p>
              <button
                onClick={() => void addLeader()}
                disabled={leadBusy}
                className="mt-1.5 w-full rounded-xl bg-slate-900 px-3 py-2.5 text-xs font-bold text-white transition hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400"
              >
                {leadBusy ? T("入れています…") : T("この人を名簿に入れる")}
              </button>
            </div>

            {/* 探す */}
            <div className="mt-2 grid grid-cols-2 gap-1">
              <input
                value={leadQ}
                onChange={(e) => setLeadQ(e.target.value)}
                autoComplete="off"
                placeholder={T("番号・氏名・団体で探す")}
                className={rSelect}
              />
              <select
                value={leadPick ?? ""}
                onChange={(e) => setLeadPick(e.target.value ? Number(e.target.value) : null)}
                className={rSelect}
              >
                <option value="">{T("団体（すべて）")}</option>
                {leadActs.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="mt-1.5 text-[10px] font-bold text-slate-500">
              {leadBusy ? T("探しています…") : `${leadTotal} ${T("人")}`}
            </div>

            <ul className="mt-1 max-h-96 divide-y divide-slate-100 overflow-y-auto rounded-lg bg-white ring-1 ring-slate-200">
              {leadRows.map((r) => (
                <li key={r.id} className="flex items-center gap-2 px-2.5 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-bold text-slate-800">
                      {r.activity_name}
                    </div>
                    <div className="flex flex-wrap gap-x-2 text-[10px] text-slate-500">
                      <span className="font-mono">{r.number}</span>
                      {r.full_name && <span>{r.full_name}</span>}
                    </div>
                  </div>
                  <button
                    onClick={() => void removeLeader(r)}
                    disabled={leadBusy}
                    className="shrink-0 rounded-lg px-2 py-1.5 text-[10px] font-bold text-red-600 transition hover:bg-red-50 active:scale-95 disabled:text-slate-300"
                  >
                    {T("外す")}
                  </button>
                </li>
              ))}
              {!leadBusy && leadRows.length === 0 && (
                <li className="px-2.5 py-6 text-center text-[11px] text-slate-500">
                  {T("まだ一人も入っていません。")}
                </li>
              )}
            </ul>
          </div>
        )}
      </section>
      )}

      {canWrite && (
      <section id="domain" className="mt-4 scroll-mt-4 rounded-xl border border-slate-200 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-bold text-slate-900">{T("ドメイン名確認")}</div>
          <button
            onClick={() => {
              const next = !domainOpen;
              setDomainOpen(next);
              if (next) setDraftDomains(domains?.[domainKind] ?? []);
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
                  {T(k.label)}
                </button>
              ))}
            </div>

            {(() => {
              const kind = DOMAIN_KINDS.find((k) => k.id === domainKind)!;
              const saved = domains?.[domainKind] ?? [];
              const clean = draftDomains.map((d) => d.trim().toLowerCase()).filter(Boolean);
              const changed = clean.join(",") !== saved.join(",");
              /* 打ち終わったものの下に、いつも空の欄を一つ置く */
              const rows = [...draftDomains, ""];
              return (
                <>
                  <p className="mt-2 rounded-lg bg-slate-50 p-2 text-[10px] leading-relaxed text-slate-600">
                    <b>{T(kind.label)}</b>：{T(kind.note)}
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
                      {T("いまは「なし」です。ドメインが合っていなくても通ります。")}
                      <br />
                      {T("一つでも「なし」があると、席を作るところでもドメインを見ません")}
                      {T("（その時点では、まだ身分が分からないため）。")}
                    </p>
                  )}

                  <label className="mt-2 block text-[10px] font-bold text-slate-500">
                    {T("いま決まっているもの")}
                  </label>
                  {domainOn?.[domainKind] === false ? (
                    <p className="mt-0.5 rounded-lg bg-slate-100 px-3 py-2 font-mono text-xs text-slate-800">
                      {T("（見ていません）")}
                    </p>
                  ) : saved.length === 0 ? (
                    <p className="mt-0.5 rounded-lg bg-slate-100 px-3 py-2 font-mono text-xs text-slate-800">
                      {T("（決めていません）")}
                    </p>
                  ) : (
                    <ul className="mt-0.5 flex flex-wrap gap-1">
                      {saved.map((d) => (
                        <li
                          key={d}
                          className="rounded-lg bg-slate-100 px-2.5 py-1.5 font-mono text-[11px] text-slate-800"
                        >
                          {d}
                        </li>
                      ))}
                    </ul>
                  )}

                  {/*
                    直す欄。いくつでも入れられる。

                    打ち終わったものの下に、いつも空の欄が一つある。
                    そこに打てば増え、消して空にすればその行は消える。
                    「＋」を押させないのは、押し忘れて一つしか入らないのを避けるため。
                  */}
                  <label className="mt-2 block text-[10px] font-bold text-slate-500">
                    {T("直す")}（{T("いくつでも入れられます")}）
                  </label>
                  <div className="mt-0.5 grid gap-1">
                    {rows.map((d, i) => (
                      <div key={i} className="flex gap-1">
                        <input
                          value={d}
                          onChange={(e) => {
                            const next = [...draftDomains];
                            if (i < next.length) next[i] = e.target.value;
                            else if (e.target.value !== "") next.push(e.target.value);
                            setDraftDomains(next);
                          }}
                          autoComplete="off"
                          placeholder={i === 0 ? "example.ac.jp" : T("もう一つ足す")}
                          className="w-full rounded-lg bg-slate-100 px-3 py-2 font-mono text-xs outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
                        />
                        {i < draftDomains.length && (
                          <button
                            onClick={() =>
                              setDraftDomains(draftDomains.filter((_, j) => j !== i))
                            }
                            className="shrink-0 rounded-lg bg-white px-2.5 py-2 text-[10px] font-bold text-red-600 shadow-sm transition hover:bg-red-50 active:scale-95"
                          >
                            {T("外す")}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
                    {T("学科や入学年でアドレスが分かれているときは、そのぶんだけ入れてください。")}
                    <br />
                    {T("全部空にすると「決めていない」に戻ります。")}
                    <br />
                    <b>{T("いまログインしている人は、変えても入ったままです。")}</b>
                    {T("この設定は、これから席を作る人にだけ効きます。")}
                  </p>

                  <button
                    onClick={() => void changeDomain()}
                    disabled={busy || !changed}
                    className="mt-2 w-full rounded-xl bg-slate-900 px-3 py-2.5 text-xs font-bold text-white transition hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400"
                  >
                    {busy
                      ? "変えています…"
                      : changed
                        ? `${kind.label}のドメインを ${clean.length} つにする`
                        : "変わっていません"}
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
      <section id="xlsx" className="mt-4 scroll-mt-4 rounded-xl border border-slate-200 p-3">
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
          <li className="text-slate-500">
            {T("P 教職（学生と教授。履修していれば T。空なら履修していない）")}
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
          <b>{T("1行目に見出しを入れておくと、その言葉で列を読み取ります。")}</b>
          {T("列を足しても、順を入れ替えても構いません。見出しが無いときだけ、A列から順に当てます。")}
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

            {/*
              どの列を何として読んだか。

              ここが見えないと、列がずれていても気づけない。
              「名列番号が入らない」は、ずれたまま送っていたのが原因だった。
            */}
            <p
              className={`mt-1 rounded-lg px-2 py-1.5 text-[10px] leading-relaxed ${
                headNamed ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-900"
              }`}
            >
              <b>
                {headNamed
                  ? T("見出しから読み取りました")
                  : T("見出しが見つからないので、A列から順に当てました")}
              </b>
              <br />
              {headNote}
              {headNote.includes("＊") && (
                <>
                  <br />
                  {T("＊が付いた列は、見出しでは分からなかったので中身から当てたものです。")}
                </>
              )}
              {!headNamed && (
                <>
                  <br />
                  {T("下の中身が思ったとおりでなければ、1行目に見出しを入れてから読ませてください。")}
                </>
              )}
            </p>

            {(() => {
              /* 学生の行で、名列番号が空のもの。多ければ列がずれている */
              const miss = rows.filter((r) => r.kind === "学生" && r.seat_no === "").length;
              const stu = rows.filter((r) => r.kind === "学生").length;
              if (stu === 0 || miss === 0) return null;
              return (
                <p className="mt-1 rounded-lg bg-red-50 px-2 py-1.5 text-[10px] leading-relaxed text-red-800">
                  <b>
                    {T("学生 {n} 行のうち {m} 行で、名列番号が空です。")
                      .replace("{n}", String(stu))
                      .replace("{m}", String(miss))}
                  </b>
                  <br />
                  {T("列がずれている可能性があります。下の中身を見て確かめてください。")}
                </p>
              );
            })()}

            <ul className="mt-1 max-h-40 overflow-y-auto rounded-lg bg-slate-50 p-2 text-[10px] leading-relaxed text-slate-600">
              {rows.slice(0, 30).map((r) => (
                <li key={r.row} className="truncate">
                  {r.row}: {r.kind} / {r.email} / {r.name}
                  {r.grade ? ` / ${r.grade}年` : ""}
                  {r.class_code ? ` / ${r.class_code}` : ""}
                  {r.class_no ? `-${r.class_no}` : ""}
                  {r.kind === "学生" ? (
                    <span className={r.seat_no ? "" : "font-bold text-red-600"}>
                      {r.seat_no ? ` / ${r.seat_no}番` : " / 名列番号なし"}
                    </span>
                  ) : null}
                  {r.student_no ? ` / ${r.student_no}` : ""}
                  {r.depts.length > 0 ? ` / ${r.depts.join("・")}` : ""}
                  {r.number ? ` / ${r.number}` : ""}
                  {r.teaching ? ` / 教職${r.teaching}` : ""}
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
      <section id="manual" className="mt-4 scroll-mt-4 rounded-xl border border-slate-200 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-bold text-slate-900">{T("登録者を増やす")}</div>
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
                      setOne((o) => ({
                        ...o,
                        // すべて数字の8桁。アドレスの前の部分とは別のもの
                        number: e.target.value.replace(/[^0-9]/g, "").slice(0, 8),
                      }))
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
            // すべて数字の8桁。アドレスの前の部分とは別のもの
            onChange={(e) => set({ number: e.target.value.replace(/[^0-9]/g, "").slice(0, 8) })}
            inputMode="numeric"
            maxLength={8}
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
        className={`mx-auto w-full ${wide ? "max-w-2xl lg:max-w-5xl" : "max-w-sm sm:max-w-2xl lg:max-w-4xl"} rounded-2xl bg-white p-5 shadow-lg`}
      >
        {children}
      </div>
    </main>
  );
}
