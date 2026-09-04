"use client";

/**
 * 予定の登録（授業・イベント・課外活動）。
 *
 * 入れるのは register_slot だけ。画面から直接 timetable へは書かない。
 * 優先順位（授業 > イベント > 課外活動）の判断と、弱い予定の削除、
 * 消された人への知らせを一つの処理としてまとめてあるため。
 *
 * 授業がすでに入っている時間には、イベントも課外活動も入れられない。
 * その判断もデータベース側で行う。画面だけで止めると、
 * 同時に操作されたときにすり抜ける。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient, supabaseReady } from "@/lib/supabase/client";
import { AdminHeader, AdminMenu } from "@/components/AdminNav";
import { useAdminT } from "@/lib/adminLang";
import {
  canManageAll,
  canPickAllRooms,
  effectiveKind,
  pickableKinds,
  type Role,
} from "@/lib/auth";
import MultiDatePicker, { niceDate, todayYmd } from "@/components/MultiDatePicker";
import { dayColor, holidayName } from "@/lib/holidays";

type Kind = "class" | "event" | "activity";

/**
 * 教室をぜんぶ読む。
 *
 * ■ なぜ「ぜんぶ」を自分で書くのか
 *
 *   Supabase（PostgREST）は、一度に返す行の数に上限がある。
 *   既定は 1000 行で、それを超えたぶんは黙って切られる。
 *   エラーにはならないので、画面からは「無い」ようにしか見えない。
 *
 *   教室は 1600 室を超えていて、実際に 681 室が切られていた。
 *   並びが号館の番号（文字の順）なので、後ろのほうの号館
 *   —— 5・6・7・8・9・32・36・39・40・41・43・47 号館は
 *   まるごと出てこず、選びようがなかった。
 *
 *   1000 室ずつ、返ってこなくなるまで読み継ぐ。
 *
 * ■ 数え直さない
 *   件数を先に問い合わせてから読む形にはしない。往復が増えるうえ、
 *   その間に増えた教室を取りこぼす。返りが 1000 未満になったら終わり。
 */
async function readAllRooms(supabase: ReturnType<typeof createClient>) {
  const STEP = 1000;
  const rows: Room[] = [];
  for (let from = 0; ; from += STEP) {
    const { data, error } = await supabase
      .from("rooms")
      .select("id, building_id, building_code, code, name, category")
      .order("building_code")
      .order("code")
      .range(from, from + STEP - 1);
    if (error) return { data: rows, error };
    const got = (data as Room[]) ?? [];
    rows.push(...got);
    if (got.length < STEP) break;
    // 念のための止め木。数え違いで永久に回らないように
    if (from > 100000) break;
  }
  return { data: rows, error: null };
}

type Period = { id: number; label: string; starts_at: string; ends_at: string };
type Room = {
  id: number;
  /** 地図の建物の目印（"B-04"）。号館番号を持たない場所もあるので、こちらで結ぶ */
  building_id: string;
  building_code: string;
  code: string;
  name: string;
  /** 部屋の種類。class（教室）・lab（研究室）・office（事務）・facility（設備）・other */
  category: string;
};

/**
 * 部屋の種類の呼び名。
 *
 * 予定を入れられるのは講義室だけではない。研究室でのゼミ、
 * 体育館や食堂で行う催しもある。しぼり込みで探せるようにして、
 * 「講義室しか選べない」と思われないようにする。
 */
const ROOM_KINDS: { id: string; label: string }[] = [
  { id: "", label: "すべて" },
  { id: "class", label: "教室" },
  { id: "lab", label: "研究室" },
  { id: "office", label: "事務" },
  { id: "facility", label: "設備" },
  { id: "other", label: "その他" },
];

const ROOM_KIND_LABEL: Record<string, string> = {
  class: "教室",
  lab: "研究室",
  office: "事務",
  facility: "設備",
  other: "その他",
};
type Faculty = { id: number; name: string };
/** code は学科のクラス記号（機械工学科なら KM）。006 を流す前は空 */
type Dept = { id: number; faculty_id: number; name: string; code?: string };
type Course = { id: number; name: string; class_name: string; teacher: string };
type Cat = { id: number; name: string };
type Act = { id: number; category_id: number | null; name: string };

/** register_slot の返り値 */
type SlotResult =
  | { ok: true; id: number; removed: Conflict[] }
  | { ok: false; reason: "blocked"; blocked_by: Conflict[] }
  | { ok: false; reason: "confirm"; will_remove: Conflict[] };

type Conflict = {
  id: number;
  kind: Kind;
  title: string;
  starts_at: string;
  ends_at: string;
};

/** その日にすでに入っている予定 */
type Booked = {
  id: number;
  room_id: number;
  kind: Kind;
  title: string;
  starts_at: string;
  ends_at: string;
  teacher: string;
  rooms: { building_code: string; code: string; name: string } | null;
  courses: { name: string; class_name: string } | null;
  club_activities: { name: string } | null;
};

/** register_slots（まとめて登録）の返り値 */
type BatchResult = {
  registered: { room_id: number }[];
  blocked: { room_id: number; blocked_by: Conflict[] }[];
  confirm: { room_id: number; will_remove: Conflict[] }[];
  removed: number;
};

/** 確かめの文で使う改行。文字そのものを書くと編集で壊れやすい */
const BR = String.fromCharCode(10);

const KIND_LABEL: Record<Kind, string> = {
  class: "授業",
  event: "イベント",
  activity: "課外活動",
};

/** 表が無いときの Postgres の返し方。まだ SQL を流していないと起きる */
function isMissingTable(e: { code?: string; message?: string } | null): boolean {
  if (!e) return false;
  return e.code === "42P01" || /does not exist|schema cache/i.test(e.message ?? "");
}

/** 日にちの作り方は MultiDatePicker と同じものを使う。二か所で書くとずれる */
const today = todayYmd;

function hhmm(t: string): string {
  const [h, m] = t.split(":");
  return `${h}:${m}`;
}

export default function SchedulePage() {
  const T = useAdminT();
  const [role, setRole] = useState<Role | null>(null);
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(true);
  /** SQL をまだ流していないか。表が無いことで見分ける */
  const [setupNeeded, setSetupNeeded] = useState(false);

  /**
   * 押して選んだ種類。
   *
   * ★これをそのまま使わない。下の kind のほうを使う。
   *   まだ権限が分かっていない一瞬のあいだ、ここは "class" のままだから。
   */
  const [kindPick, setKindPick] = useState<Kind>("class");
  /**
   * 入れる日。いくつでも選べる。
   *
   * 授業は同じ組み合わせを毎週くり返すので、一日ずつ入れると
   * 15回ぶん同じ操作になる。まとめて選んで、一度に入れられるようにする。
   */
  const [dates, setDates] = useState<string[]>([today()]);
  /**
   * 下の「入っている予定」で見ている日。
   *
   * 選んだ日が何日もあるので、そのうち一日を見る。
   * 既定は先頭（いちばん早い日）。
   */
  const [viewDate, setViewDate] = useState(today());

  const [periods, setPeriods] = useState<Period[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  /**
   * 予定を入れられる場所。
   *
   * 号館ぜんぶと、グラウンド・テニスコートだけを並べる。
   * 駐輪場やバス停も地図には載っているが、予定を入れる所ではない。
   */
  const [places, setPlaces] = useState<{ id: string; label: string; code: string }[]>([]);
  const [facs, setFacs] = useState<Faculty[]>([]);
  const [depts, setDepts] = useState<Dept[]>([]);
  const [cats, setCats] = useState<Cat[]>([]);
  const [acts, setActs] = useState<Act[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);

  /* 入力 */
  /** 見ている号館。号館ごと、あるいは全号館を選べる */
  const [buildingCodes, setBuildingCodes] = useState<string[]>([]);
  /** 選んだ教室。まとめて同じ予定を入れられるよう複数持つ */
  const [roomIds, setRoomIds] = useState<number[]>([]);
  /** 部屋の種類のしぼり。空なら「すべて」 */
  const [roomKind, setRoomKind] = useState("");
  /**
   * 選んだ時限。いくつでも選べる。
   *
   * 同じ科目を1限と2限で続けて行う、といった入れ方がある。
   * 一つずつ登録し直すのは手間なので、まとめて入れられるようにする。
   */
  const [periodIds, setPeriodIds] = useState<number[]>([]);
  /**
   * どの学科の授業か。いくつでも選べる。
   *
   * 教養や共通の科目は、学科をまたいで同じ時間に同じ教室で行う。
   * 一つしか選べないと、そういう科目がどこか一つの学科の
   * 時間割にしか出なかった。
   */
  const [deptIds, setDeptIds] = useState<number[]>([]);
  /** 何年生の授業か。0 は「学年を問わない」 */
  const [grade, setGrade] = useState(0);
  const [courseId, setCourseId] = useState<number | null>(null);
  const [courseName, setCourseName] = useState("");
  /**
   * 選んだクラス。空なら「すべて（分かれていない）」。
   *
   * 一つの授業を CC1 と CC2 が一緒に受けることがあるので、いくつでも選べる。
   * しまうときは「CC1・CC2」の形に揃える（class_name は文字の列一つ）。
   */
  const [classes, setClasses] = useState<string[]>([]);
  /** 並んでいないクラスを打ち込んで足すための欄 */
  const [classDraft, setClassDraft] = useState("");
  const [teacher, setTeacher] = useState("");
  const [catId, setCatId] = useState<number | null>(null);
  const [activityId, setActivityId] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [startAt, setStartAt] = useState("18:00");
  const [endAt, setEndAt] = useState("20:00");

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err" | "warn"; text: string } | null>(null);
  /** 登録の前に「この内容でよいか」を見せている最中か */
  const [ask, setAsk] = useState(false);
  /** 消してよいか尋ねている最中の、日と教室と、その相手 */
  const [pending, setPending] = useState<
    { date: string; periodId: number | null; room: Room; conflicts: Conflict[] }[] | null
  >(null);
  /** その日にすでに入っている予定 */
  const [booked, setBooked] = useState<Booked[]>([]);
  /** 消す前に一度確かめる。押し間違いで消えないように */
  const [confirmDelete, setConfirmDelete] = useState<Booked | null>(null);
  /** 登録したあとに一覧を読み直すための合図 */
  const [bookedTick, setBookedTick] = useState(0);

  /* ---------------- 何を登録できるか ---------------- */

  /*
   * 判定は lib/auth.ts にまとめてある。ほかの権限の決まりと同じ場所に
   * 置いておくと、あとから見るときに一か所で足りる。
   */
  // 課外活動とイベントは Lv1 以上
  const canEvent = role === "admin_l1" || role === "admin_l2" || canManageAll(role);
  /** 他人が立てた予定も消せるか。副管理者（2.1・2.2）といちばん上だけ */
  const canDeleteAny = canManageAll(role);

  /** 押せる種類。押せないものは並べない */
  const kinds = pickableKinds(role);
  /**
   * いま実際に選ばれている種類。
   *
   * 権限が分かる前は押した値が "class" のままなので、そのまま描くと
   * 授業を入れられない人の画面が「授業が選ばれているのに、
   * 授業のボタンは無い」形で始まる。描くときに読み替える。
   */
  const kind: Kind = effectiveKind(role, kindPick);

  /* ---------------- 読み込み ---------------- */

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
      setEmail(u.user.email ?? "");

      const { data: me } = await supabase
        .from("profiles")
        .select("role, full_name")
        .eq("id", u.user.id)
        .single();
      const myRole = (me?.role as Role) ?? null;
      setRole(myRole);

      /*
       * 登録者の欄には、氏名を入れる。
       *
       * これまではメールアドレスを入れていた。予定の一覧に並ぶのは
       * この文字なので、時間割に学籍番号入りのアドレスが出ていた。
       * 見る人にとっては誰か分からないうえ、アドレスをそのまま
       * 出すことになる。申請のときに入れてもらった氏名を使う。
       *
       * 氏名が空のときだけ、これまでどおりアドレスにする。
       * 空欄で登録されると、誰が入れたのか追えなくなるため。
       */
      const name = ((me?.full_name as string | null) ?? "").trim();
      setTeacher(name || (u.user.email ?? ""));

      /*
       * ここで種類を書き戻さない。
       *
       * 授業を入れられない人にイベントを見せるのは、上の kind が
       * 描くときに読み替えている。ここで setKind すると、
       * 権限が分かる前と後で二度描き直すことになる。
       */

      const [p, r, f, d, c, a] = await Promise.all([
        supabase.from("periods").select("id, label, starts_at, ends_at").order("id"),
        readAllRooms(supabase),
        supabase.from("faculties").select("id, name").order("sort_order"),
        // 記号の列がまだ無い場合もあるので、列を並べずにまとめて取る
        supabase.from("departments").select("*").order("sort_order"),
        supabase.from("activity_categories").select("id, name").order("sort_order"),
        supabase.from("club_activities").select("id, category_id, name").order("sort_order"),
      ]);

      setPeriods((p.data as Period[]) ?? []);
      setRooms((r.data as Room[]) ?? []);
      setFacs((f.data as Faculty[]) ?? []);
      setDepts((d.data as Dept[]) ?? []);
      setCats((c.data as Cat[]) ?? []);
      setActs((a.data as Act[]) ?? []);

      // 表そのものが無い＝まだ SQL を流していない。
      // どれか一つでも無ければ同じことなので、まとめて一度だけ知らせる
      setSetupNeeded(
        [f.error, d.error, c.error, a.error].some((e) => isMissingTable(e)),
      );

      setLoading(false);
    })();
  }, []);

  /*
   * 号館の一覧は、地図のデータから取る。
   *
   * 教室（rooms）から作ると、教室を入れた号館しか出てこない。
   * 講義室だけ入れている段では、ほかの号館を選びようがなかった。
   * 地図が知っている号館を土台にして、そこへ教室の数を重ねる。
   *
   * 読めなくても止めない。そのときは教室のある号館だけが並ぶ
   * （前と同じ姿）ので、画面は使える。
   */
  useEffect(() => {
    void fetch("/data/buildings.geojson")
      .then((r) => r.json())
      .then(
        (fc: {
          features?: { properties?: { tempId?: string; code?: string; name?: string } }[];
        }) => {
          /*
           * 並べるのは、号館（番号を持っているもの）と、
           * グラウンド・テニスコートだけ。
           * 駐輪場やバス停は地図には載っているが、予定を入れる所ではない。
           */
          const OUTDOOR = ["グラウンド", "テニスコート"];
          const list = (fc.features ?? [])
            .map((f) => ({
              id: (f.properties?.tempId ?? "").trim(),
              code: (f.properties?.code ?? "").trim(),
              name: (f.properties?.name ?? "").trim(),
            }))
            .filter((b) => b.id && (b.code !== "" || OUTDOOR.includes(b.name)))
            .map((b) => ({
              id: b.id,
              code: b.code,
              label: b.code !== "" ? `${b.code}号館` : b.name,
            }));
          // 号館は番号の小さい順、外の場所はそのあと
          list.sort((a, b) => {
            const na = a.code === "" ? 9999 : Number(a.code) || 9999;
            const nb = b.code === "" ? 9999 : Number(b.code) || 9999;
            return na - nb || a.label.localeCompare(b.label, "ja");
          });
          setPlaces(list);
        },
      )
      .catch(() => setPlaces([]));
  }, []);

  /** 代表の学科。科目を読むときと、クラス記号を出すときに使う */
  const deptId = deptIds[0] ?? null;

  /* 学科を選んだら、その学科の科目を読む */
  useEffect(() => {
    if (deptId === null) {
      setCourses([]);
      return;
    }
    void createClient()
      .from("courses")
      .select("id, name, class_name, teacher")
      .eq("department_id", deptId)
      .order("name")
      .then(({ data }) => setCourses((data as Course[]) ?? []));
  }, [deptId]);

  /**
   * 号館の並び。1号館から昇順。
   *
   * ■ 教室が入っていない号館も並べる
   *   以前は「教室が登録されている号館」だけを並べていた。
   *   講義室しか入れていないと、そのぶんの号館しか出てこず、
   *   ほかの号館は選びようがなかった。
   *   地図が知っている号館を全部並べ、教室のあるものだけ押せるようにする。
   *   押せない号館も見えていれば、「入れ忘れている」と分かる。
   *
   * ■ 番号の順に
   *   1, 2, 3 … と数として並べる。文字として並べると
   *   1, 10, 11, 2 の順になり、探すときに目が迷う。
   *   グラウンドとテニスコートは番号を持たないので、いちばん後ろ。
   *
   * ■ 号館番号ではなく、地図の目印（building_id）で結ぶ
   *   グラウンドとテニスコートには号館番号が無い。番号で結んでいると、
   *   その二つは空の号館としてまとまってしまい、選べなかった。
   */
  const allBuildings = useMemo(() => {
    const seen = new Set(places.map((p) => p.id));
    const out = [...places];
    /*
     * 地図に載っていない建物に教室が入っていることがある
     * （建物の名前を変えたあとなど）。取りこぼすと選べなくなるので、
     * 教室が持っている建物も足しておく。
     */
    for (const r of rooms) {
      if (!r.building_id || seen.has(r.building_id)) continue;
      seen.add(r.building_id);
      out.push({
        id: r.building_id,
        code: r.building_code,
        label: r.building_code ? `${r.building_code}号館` : r.building_id,
      });
    }
    return out;
  }, [rooms, places]);

  /** 建物ごとの教室の数。押せるかどうかと、そのまま数の表示に使う */
  const roomCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rooms) m.set(r.building_id, (m.get(r.building_id) ?? 0) + 1);
    return m;
  }, [rooms]);

  /** 教室が一つでも入っている建物。「すべて選ぶ」はこれだけを選ぶ */
  const usableBuildings = useMemo(
    () => allBuildings.filter((b) => (roomCount.get(b.id) ?? 0) > 0).map((b) => b.id),
    [allBuildings, roomCount],
  );

  /** 建物の目印から、見せる名前へ */
  const placeLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of allBuildings) m.set(b.id, b.label);
    return m;
  }, [allBuildings]);

  /**
   * いま選んでいる建物にある教室。種類でしぼっていれば、そのぶんだけ。
   *
   * しぼりの既定は「すべて」。研究室でのゼミも、体育館での催しも
   * 入れられるので、はじめから隠さない。
   */
  const roomsInScope = useMemo(
    () =>
      buildingCodes.length === 0
        ? []
        : rooms.filter(
            (r) =>
              buildingCodes.includes(r.building_id) &&
              (roomKind === "" || (r.category || "other") === roomKind),
          ),
    [rooms, buildingCodes, roomKind],
  );

  /** 建物の中に、どの種類が何室あるか。しぼりのボタンに数を出す */
  const kindCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rooms) {
      if (!buildingCodes.includes(r.building_id)) continue;
      const k = r.category || "other";
      m.set(k, (m.get(k) ?? 0) + 1);
      m.set("", (m.get("") ?? 0) + 1);
    }
    return m;
  }, [rooms, buildingCodes]);

  const chosen = useMemo(
    () => roomIds.map((id) => rooms.find((r) => r.id === id)).filter((r): r is Room => !!r),
    [rooms, roomIds],
  );
  const actsInCat = useMemo(
    () => (catId === null ? [] : acts.filter((a) => a.category_id === catId)),
    [acts, catId],
  );
  /** 選んだ学科のクラス記号。クラス欄の書き方を示すのに使う */
  const deptCode = useMemo(
    () => depts.find((d) => d.id === deptId)?.code ?? "",
    [depts, deptId],
  );

  /**
   * クラスの選択肢。
   *
   * 決まった一覧はどこにも無いので、二つから作る。
   *   ・その学科ですでに使われているクラス（courses.class_name）
   *   ・記号 + 1〜4（まだ一つも入れていないときのため）
   *
   * すでに使われているものを先に出すのは、打ち方を揃えるため。
   * 足りないものは、下の欄から打ち込んで足せる。
   */
  const classChoices = useMemo(() => {
    const used = new Set<string>();
    for (const c of courses) {
      for (const one of (c.class_name ?? "").split("・")) {
        const v = one.trim();
        if (v) used.add(v);
      }
    }
    if (deptCode) for (let i = 1; i <= 4; i++) used.add(`${deptCode}${i}`);
    return [...used].sort((a, b) => a.localeCompare(b, "ja", { numeric: true }));
  }, [courses, deptCode]);

  /**
   * いま入れようとしている時間帯。時限をいくつも選べるので並びで持つ。
   * まだ決まっていなければ空。
   */
  const slots = useMemo(() => {
    if (kind === "class") {
      return periods
        .filter((x) => periodIds.includes(x.id))
        .map((p) => ({ id: p.id, s: p.starts_at, e: p.ends_at }));
    }
    return startAt && endAt && endAt > startAt
      ? [{ id: null as number | null, s: startAt, e: endAt }]
      : [];
  }, [kind, periodIds, periods, startAt, endAt]);

  /**
   * その時間帯にもう予定が入っている教室。
   *
   * 押してから「入れられません」と言われるのでは分かりにくいので、
   * 選ぶ時点で塞ぐ。最後に守っているのはデータベースの決まりで、
   * 同じ教室の同じ時間には一つしか入らない。
   *
   * ★見ているのは「見ている日」の一日ぶんだけ。
   *   何日も選んでいるとき、他の日で埋まっている教室までは分からない。
   *   全部の日を先に読むと、15週ぶんで往復が増えるうえ、
   *   一つでも埋まっていると押せなくなって、入れられる日まで入らなくなる。
   *   埋まっている日は、登録したあとに「入れられませんでした」として
   *   日付つきで返る。守っているのは向こう側なので、取りこぼしはない。
   */
  const takenRooms = useMemo(() => {
    const m = new Map<number, Booked>();
    if (slots.length === 0) return m;
    for (const b of booked) {
      for (const slot of slots) {
        // 時刻は "08:40:00" の形なので、文字のまま比べれば前後が分かる
        if (b.starts_at < `${slot.e}:00`.slice(0, 8) && `${slot.s}:00`.slice(0, 8) < b.ends_at) {
          m.set(b.room_id, b);
          break;
        }
      }
    }
    return m;
  }, [booked, slots]);

  /* 時間帯を変えたら、その時間に使えない教室は外す */
  useEffect(() => {
    setRoomIds((prev) => prev.filter((id) => !takenRooms.has(id)));
  }, [takenRooms]);

  /**
   * 実際に見ている日。
   *
   * 選んだ日から外れていたら、いちばん早い日に戻す。
   * これを useEffect で書き戻すと、外れた日のまま一度描いてから
   * 直すことになり、一覧が一瞬ちらつく。描くときに決めれば起きない。
   */
  const shownDate = dates.includes(viewDate) ? viewDate : (dates[0] ?? today());

  /* ---------------- 登録 ---------------- */

  /**
   * 選んだ日と教室ぶん、順に登録する。
   *
   * ■ 日ごとに呼ぶ
   *   register_slots は一日ぶんをまとめて入れる。日を増やすには、
   *   日ごとに呼び直す。教室のほうは向こうでまとめて入るので、
   *   往復の数は「日の数」だけで済む（15回×全号館でも15往復）。
   *
   * ■ targets
   *   渡すと、その日とその教室だけを対象にする。
   *   「消してよいか」を尋ねたあとは、すでに入ったものをもう一度
   *   なぞらないよう、尋ねた相手だけを渡し直す。
   */
  const submit = useCallback(
    async (
      force: boolean,
      targets?: { date: string; periodId: number | null; rooms: Room[] }[],
    ) => {
      setMsg(null);
      const supabase = createClient();
      /*
       * 「この日の、この時限に、この教室ぶん」の組み合わせ。
       *
       * 授業は時限をいくつも選べるので、日 × 時限で並べる。
       * 授業いがいは時限を使わないので、日ごとに一つだけ。
       */
      const plan: { date: string; periodId: number | null; rooms: Room[] }[] =
        targets ??
        (kind === "class"
          ? dates.flatMap((d) => periodIds.map((pid) => ({ date: d, periodId: pid, rooms: chosen })))
          : dates.map((d) => ({ date: d, periodId: null, rooms: chosen })));

      if (plan.length === 0 || plan.every((p) => p.rooms.length === 0)) {
        setMsg({ kind: "err", text: T("教室を選んでください") });
        return;
      }
      if (dates.length === 0) {
        setMsg({ kind: "err", text: T("日にちを選んでください") });
        return;
      }

      setBusy(true);
      try {
        let useCourseId = courseId;

        // 授業で、まだ無い科目なら先に作る
        if (kind === "class" && !useCourseId) {
          if (!courseName.trim()) {
            setMsg({ kind: "err", text: T("授業名を入れてください") });
            return;
          }
          if (deptIds.length === 0) {
            setMsg({ kind: "err", text: T("学科を選んでください") });
            return;
          }
          /*
           * 学科は並びで持つ。前からある department_id は代表の一つで、
           * データベース側の引き金が並びの先頭を入れてくれる。
           * 並びの列がまだ無いときのために、両方を送る。
           */
          const row = {
            name: courseName.trim(),
            // 選んだクラスは「CC1・CC2」の形にそろえる。空なら「すべて」
            class_name: classes.join("・"),
            teacher: teacher.trim(),
            department_id: deptIds[0],
            department_ids: deptIds,
            grade,
          };
          let made = await supabase.from("courses").insert(row).select("id").single();
          if (made.error && /department_ids|grade/i.test(made.error.message)) {
            // 列がまだ無い版。そのぶんを外して入れ直す
            const { department_ids: _a, grade: _b, ...rest } = row;
            made = await supabase.from("courses").insert(rest).select("id").single();
          }
          const { data, error } = made;
          if (error) throw error;
          useCourseId = (data as { id: number }).id;
        }

        if (kind === "class" && periodIds.length === 0) {
          setMsg({ kind: "err", text: T("時限を選んでください") });
          return;
        }
        if (kind === "activity" && activityId === null) {
          setMsg({ kind: "err", text: T("団体を選んでください") });
          return;
        }
        if (kind === "event" && !title.trim()) {
          setMsg({ kind: "err", text: T("イベント名を入れてください") });
          return;
        }

        /*
         * 日ごとに一度ずつ呼ぶ。
         *
         * 教室ごとに呼ぶと、全号館では千回を超える往復になる。
         * 教室はまとめて渡し、向こうで順に入れてもらう。
         * 増えるのは日の数だけ（15週なら15往復）。
         */
        let done = 0;
        let removed = 0;
        const blockedByClass: string[] = [];
        const blockedOther: string[] = [];
        const ask: { date: string; periodId: number | null; room: Room; conflicts: Conflict[] }[] = [];

        for (const step of plan) {
          if (step.rooms.length === 0) continue;
          const byId = new Map(step.rooms.map((r) => [r.id, r]));
          const where = (id: number) => byId.get(id)?.code ?? `教室${id}`;

          const { data, error } = await supabase.rpc("register_slots", {
            p_kind: kind,
            p_room_ids: step.rooms.map((r) => r.id),
            p_date: step.date,
            p_period_id: kind === "class" ? step.periodId : null,
            p_starts: kind === "class" ? null : startAt,
            p_ends: kind === "class" ? null : endAt,
            p_course_id: kind === "class" ? useCourseId : null,
            p_activity_id: kind === "activity" ? activityId : null,
            p_title: title.trim(),
            p_teacher: teacher.trim(),
            p_force: force,
          });
          if (error) throw error;

          const res = data as BatchResult;
          done += res.registered.length;
          removed += res.removed;

          /*
           * 何日ぶんも、何限ぶんも並ぶので、どの日のどの時限かを添える。
           * 「入れられませんでした」だけでは、どれのことか分からない。
           */
          const pl = periods.find((x) => x.id === step.periodId);
          const day =
            plan.length > 1
              ? `${niceDate(step.date)}${pl ? ` ${pl.label}` : ""} `
              : "";
          for (const b of res.blocked) {
            const names = b.blocked_by
              .map((x) => `${KIND_LABEL[x.kind]}「${x.title || "（名称なし）"}」`)
              .join("・");
            if (b.blocked_by.some((x) => x.kind === "class"))
              blockedByClass.push(`${day}${where(b.room_id)}（${names}）`);
            else blockedOther.push(`${day}${where(b.room_id)}（${names}）`);
          }

          for (const c of res.confirm) {
            const room = byId.get(c.room_id);
            if (room)
              ask.push({
                date: step.date,
                periodId: step.periodId,
                room,
                conflicts: c.will_remove,
              });
          }
        }

        // 入った分は下の一覧にも出したいので、どちらの道でも読み直す
        if (done > 0) setBookedTick((v) => v + 1);

        // 尋ねる相手が残っていれば、そこで一度止める
        if (ask.length > 0) {
          setPending(ask);
          if (done > 0) {
            setMsg({ kind: "warn", text: `${done}件を登録しました。残りは確認が必要です。` });
          }
          return;
        }

        setPending(null);

        const parts: string[] = [];
        if (done > 0) {
          const many = dates.length > 1 || (kind === "class" && periodIds.length > 1);
          parts.push(
            many
              ? `${dates.length}日 × ${
                  kind === "class" ? `${periodIds.length}時限` : "1件"
                }ぶん、あわせて${done}件を登録しました。`
              : `${done}室に登録しました。`,
          );
        }
        if (removed > 0) parts.push(`重なっていた予定 ${removed} 件を取り消し、登録者に知らせました。`);
        if (blockedByClass.length > 0)
          parts.push(`授業があるため登録できませんでした：${blockedByClass.join(" / ")}`);
        if (blockedOther.length > 0)
          parts.push(`すでに予定があり、先に入れたものが優先されます：${blockedOther.join(" / ")}`);

        setMsg({
          kind: done > 0 ? (blockedByClass.length || blockedOther.length ? "warn" : "ok") : "err",
          text: parts.join(" "),
        });
      } catch (e) {
        const err = e as { code?: string; message?: string };
        setMsg({
          kind: "err",
          text: isMissingTable(err)
            ? "データベースの更新がまだです。SQL を実行してください。"
            : (err.message ?? "登録できませんでした"),
        });
      } finally {
        setBusy(false);
      }
    },
    [kind, chosen, dates, periodIds, periods, courseId, courseName, classes, teacher, deptIds, grade, activityId, title, startAt, endAt],
  );

  /* ---------------- その日の予定を消す ---------------- */

  /**
   * 見ている日に入っている予定を読む。
   * 間違えて入れたものを消せるようにするためで、登録の直後にも読み直す。
   *
   * 何日ぶんも選べるが、読むのは一日ずつ。全部読むと重くなるうえ、
   * 「どの日の予定を消すのか」が分かりにくくなる。
   */
  const loadBooked = useCallback(async () => {
    if (!supabaseReady) return;
    const { data } = await createClient()
      .from("timetable")
      .select("id, room_id, kind, title, starts_at, ends_at, teacher, rooms(building_code, code, name), courses(name, class_name), club_activities(name)")
      .eq("on_date", shownDate)
      .order("starts_at");
    setBooked((data as unknown as Booked[]) ?? []);
  }, [shownDate]);

  useEffect(() => {
    void loadBooked();
  }, [loadBooked, bookedTick]);

  const removeBooked = useCallback(
    async (b: Booked) => {
      setMsg(null);
      const { error } = await createClient().from("timetable").delete().eq("id", b.id);
      if (error) {
        setMsg({ kind: "err", text: error.message });
        return;
      }
      // RLS で弾かれると、エラーにならず0件消えることがある。
      // 読み直して、本当に消えたかで判断する
      const before = booked.length;
      await loadBooked();
      setMsg(
        before > 0
          ? { kind: "ok", text: T("予定を消しました") }
          : { kind: "err", text: T("消せませんでした。権限が足りない可能性があります") },
      );
      setConfirmDelete(null);
    },
    [booked.length, loadBooked],
  );

  /**
   * その日の予定を、まとめて全部消す。
   *
   * 立てた本人でなくても消せるのは、副管理者といちばん上だけ。
   * 一件ずつ消す道は前からあるが、間違えて大量に入れたときに
   * 一件ずつでは終わらない。取り返しがつかないので二度たずねる。
   */
  const removeAllBooked = useCallback(async () => {
    if (booked.length === 0) return;
    const first = window.confirm(
      [
        `${shownDate} に入っている予定を、すべて消します。`,
        "",
        `  ${booked.length} 件（授業・イベント・課外活動すべて）`,
        "",
        "他の人が立てた予定も消えます。元には戻せません。",
        "続けますか？",
      ].join(BR),
    );
    if (!first) return;
    const second = window.confirm(
      `本当に消しますか？（${booked.length} 件）${BR}${BR}これが最後の確認です。`,
    );
    if (!second) return;

    setBusy(true);
    setMsg(null);
    try {
      const ids = booked.map((b) => b.id);
      const { error } = await createClient().from("timetable").delete().in("id", ids);
      if (error) throw error;
      const before = booked.length;
      await loadBooked();
      setMsg({ kind: "ok", text: `${before} 件の予定を消しました` });
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }, [booked, shownDate, loadBooked]);

  /* ---------------- 表示 ---------------- */

  if (loading) return <Shell>{T("読み込み中…")}</Shell>;

  if (!supabaseReady)
    return <Shell><p className="text-sm text-red-700">{T("サーバーに接続できません。")}</p></Shell>;

  if (!role)
    return (
      <Shell>
        <p className="text-sm text-slate-700">{T("ログインしていません。")}</p>
        <Link href="/login" className="mt-3 inline-block text-sm font-bold text-blue-600">
          {T("ログインへ")}
        </Link>
      </Shell>
    );

  // canEvent / canClass / canDeleteAny は上（状態のすぐ下）で決めてある。
  // 種類の読み替え（kind）が、それより前に要るため。

  if (!canEvent)
    return (
      <Shell>
        <p className="text-sm text-slate-700">{T("この画面は、いまの権限では使えません。")}</p>
        <Link href="/" className="mt-3 inline-block text-sm font-bold text-blue-600">{T("地図へ戻る")}</Link>
      </Shell>
    );

  return (
    <Shell wide>
      <AdminHeader title={T("予定の登録")} />
      <AdminMenu current="schedule" role={role} />

      {setupNeeded && (
        <div className="mb-3 rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-900">
          <b>{T("データベースの準備がまだ終わっていません。")}</b>
          <br />
          {T("学科・課外活動・イベントの表がまだ作られていないため、下の一覧は空のままです。")}
          <br />
          Supabase の SQL Editor で <code className="font-mono">supabase/setup.sql</code>{" "}
          {T("を貼り付けて実行すると、必要なものが一度にそろいます。")}
        </div>
      )}

      {/*
        何を登録するか。

        授業を入れられない人には、授業の欄そのものを出さない。
        押せないボタンを並べておくと、「押せるはずのものが押せない」と
        受け取られる。できることだけを並べるほうが分かりやすい。
        課外活動リーダー（Lv1）なら、イベントと課外活動の二つになる。

        守っているのはデータベース側（register_slots）で、
        ここは画面の出し分け。
      */}
      <div className={`mb-3 grid gap-1.5 ${kinds.length === 3 ? "grid-cols-3" : "grid-cols-2"}`}>
        {kinds.map((k) => (
          <button
            key={k}
            onClick={() => {
              setKindPick(k);
              setMsg(null);
              setPending(null);
            }}
            className={`rounded-xl py-2.5 text-sm font-bold transition ${
              kind === k
                ? "bg-slate-900 text-white"
                : "bg-slate-100 text-slate-700 hover:bg-slate-200"
            }`}
          >
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-3">
        {/*
          日にち。いくつでも選べる。

          授業は同じ組み合わせを毎週くり返すので、一日ずつ入れると
          15回ぶん同じ操作になる。一日押して「＋15週」で前期ぶんが埋まる。
        */}
        <Field label="日にち（いくつでも選べます）">
          <MultiDatePicker value={dates} onChange={setDates} />
          {kind === "class" && dates.length === 1 && (
            <p className="mt-1.5 rounded-lg bg-blue-50 px-2.5 py-1.5 text-[10px] leading-relaxed text-blue-900">
              毎週ある授業なら、上の<b>{T("「＋15週」")}</b>を押すと、同じ曜日が
              {T("15週ぶんまとめて選ばれます。")}
            </p>
          )}
        </Field>

        {/* ---- 教室。まとめて同じ予定を入れられるよう、いくつでも選べる ---- */}
        <Field label="場所（号館・グラウンド・テニスコート）">
          {/* 号館を選ぶ。番号を打たなくても押すだけで選べるようにする */}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-bold text-slate-500">{T("場所")}</span>
            <span className="text-[11px] font-bold text-slate-600">
              {roomIds.length > 0 ? `${roomIds.length}室を選択中` : "未選択"}
            </span>
          </div>

          {/*
            「使用中」の印は、見ている一日ぶんしか見ていない。
            何日も選んでいるときに、全部の日を知っているかのように
            見えると困るので、そう書いておく。
          */}
          {dates.length > 1 && (
            <p className="mt-1 rounded-lg bg-slate-50 px-2.5 py-1.5 text-[10px] leading-relaxed text-slate-500">
              「使用中」の印は <b>{niceDate(shownDate)}</b> のぶんです。
              {T("ほかの日で埋まっている教室は、登録したあとに日付つきでお知らせします。")}
            </p>
          )}

          {/*
            まとめて選ぶ道は、教授（レベル2）と副管理者・管理者だけ。
            課外活動リーダーが押すと、全号館ぶんの予定を一度に立てられてしまう。
          */}
          {canPickAllRooms(role) && (
            <div className="mt-1 flex gap-1.5">
              <button
                onClick={() => setBuildingCodes(usableBuildings)}
                disabled={usableBuildings.length === 0}
                className={`flex-1 rounded-lg px-2 py-2 text-[11px] font-bold transition disabled:bg-slate-100 disabled:text-slate-400 ${
                  buildingCodes.length === usableBuildings.length && usableBuildings.length > 0
                    ? "bg-slate-900 text-white"
                    : "bg-slate-200 text-slate-700 hover:bg-slate-300"
                }`}
              >
                {T("すべての場所")}（{usableBuildings.length}か所・{rooms.length}室）
              </button>
              <button
                onClick={() => {
                  setBuildingCodes([]);
                  setRoomIds([]);
                }}
                className="rounded-lg bg-white px-2 py-2 text-[11px] font-bold text-slate-500 shadow-sm transition hover:bg-slate-100"
              >
                {T("解除")}
              </button>
            </div>
          )}

          {/*
            号館を一つずつ。押しやすいよう、一つを大きめにしてある。
            教室が入っていない号館は押せない。数が 0 と見えていれば、
            入れ忘れていることがその場で分かる。
          */}
          <div className="mt-1.5 grid max-h-44 grid-cols-4 gap-1.5 overflow-y-auto rounded-xl bg-slate-50 p-1.5 sm:grid-cols-6">
            {allBuildings.map((b) => {
              const on = buildingCodes.includes(b.id);
              const n = roomCount.get(b.id) ?? 0;
              return (
                <button
                  key={b.id}
                  disabled={n === 0}
                  title={n === 0 ? `${b.label}には教室が登録されていません` : `${b.label} ${n} 室`}
                  onClick={() =>
                    setBuildingCodes((prev) =>
                      on ? prev.filter((x) => x !== b.id) : [...prev, b.id],
                    )
                  }
                  className={`flex flex-col items-center justify-center rounded-lg px-1 py-2.5 transition active:scale-95 ${
                    n === 0
                      ? "cursor-not-allowed bg-slate-100 text-slate-300"
                      : on
                        ? "bg-blue-600 text-white"
                        : "bg-white text-slate-700 shadow-sm hover:bg-slate-100"
                  }`}
                >
                  {/* 号館は番号だけ、グラウンドなどは名前をそのまま */}
                  <span
                    className={`font-bold leading-none ${
                      b.code ? "text-sm" : "text-[10px]"
                    }`}
                  >
                    {b.code || b.label}
                  </span>
                  <span
                    className={`mt-0.5 text-[9px] leading-none ${
                      n === 0 ? "text-slate-300" : on ? "text-blue-100" : "text-slate-400"
                    }`}
                  >
                    {n === 0 ? T("教室なし") : `${n}室`}
                  </span>
                </button>
              );
            })}
            {allBuildings.length === 0 && (
              <span className="col-span-full p-1 text-[10px] text-amber-700">
                {T("教室が登録されていません")}
              </span>
            )}
          </div>

          {/*
            部屋の種類でしぼる。

            予定を入れられるのは講義室だけではない。研究室でのゼミも、
            体育館や食堂での催しもある。号館を選んだら種類も出して、
            「講義室しか選べない」と思われないようにする。
            既定は「すべて」で、はじめから隠すものは無い。
          */}
          {buildingCodes.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {ROOM_KINDS.map((k) => {
                const n = kindCount.get(k.id) ?? 0;
                const on = roomKind === k.id;
                return (
                  <button
                    key={k.id || "all"}
                    onClick={() => setRoomKind(k.id)}
                    disabled={n === 0}
                    className={`rounded-lg px-2 py-1.5 text-[10px] font-bold transition active:scale-95 disabled:opacity-40 ${
                      on ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                    }`}
                  >
                    {T(k.label)}
                    <span className={`ml-1 font-normal ${on ? "text-slate-300" : "text-slate-400"}`}>
                      {n}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {roomsInScope.length > 0 && (
            <>
              <div className="mt-1.5 flex gap-1.5">
                {/* すでに使われている教室は、まとめて選ぶときも含めない。
                    まとめて選べるのは、上の「すべての号館」と同じ人だけ */}
                {canPickAllRooms(role) && (
                  <button
                    onClick={() =>
                      setRoomIds(roomsInScope.filter((r) => !takenRooms.has(r.id)).map((r) => r.id))
                    }
                    className="flex-1 rounded-lg bg-slate-200 px-2 py-2 text-[11px] font-bold text-slate-700 transition hover:bg-slate-300"
                  >
                    {T("空いている教室をすべて選ぶ（")}
                    {roomsInScope.filter((r) => !takenRooms.has(r.id)).length}室）
                  </button>
                )}
                <button
                  onClick={() => setRoomIds([])}
                  className={`rounded-lg bg-white px-2 py-2 text-[11px] font-bold text-slate-500 shadow-sm transition hover:bg-slate-100 ${
                    canPickAllRooms(role) ? "" : "flex-1"
                  }`}
                >
                  {T("全部外す")}
                </button>
              </div>

              {/* 全号館だと千を超えるので、並べるのは先頭だけにする。
                  「すべて選ぶ」は並べていない分も含める */}
              <ul className="mt-1.5 max-h-52 overflow-y-auto rounded-xl bg-slate-50 p-1.5">
                {roomsInScope.slice(0, 300).map((r) => {
                  const on = roomIds.includes(r.id);
                  const taken = takenRooms.get(r.id);
                  return (
                    <li key={r.id}>
                      <button
                        disabled={!!taken}
                        onClick={() =>
                          setRoomIds((prev) =>
                            on ? prev.filter((x) => x !== r.id) : [...prev, r.id],
                          )
                        }
                        className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition ${
                          taken
                            ? "cursor-not-allowed opacity-50"
                            : on
                              ? "bg-blue-600 text-white"
                              : "hover:bg-white"
                        }`}
                      >
                        <span
                          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-bold ${
                            taken
                              ? "bg-slate-200 text-slate-400"
                              : on
                                ? "bg-white text-blue-600"
                                : "bg-white text-transparent ring-1 ring-slate-300"
                          }`}
                        >
                          {taken ? "×" : "✓"}
                        </span>
                        {buildingCodes.length > 1 && (
                          <span
                            className={`w-14 shrink-0 truncate text-[10px] ${on && !taken ? "text-blue-100" : "text-slate-400"}`}
                          >
                            {placeLabel.get(r.building_id) ?? `${r.building_code}号館`}
                          </span>
                        )}
                        <span className="w-14 shrink-0 text-xs font-bold">{r.code}</span>
                        <span
                          className={`min-w-0 flex-1 truncate text-[11px] ${on && !taken ? "text-blue-100" : "text-slate-500"}`}
                        >
                          {taken
                            ? `使用中：${KIND_LABEL[taken.kind]}`
                            : r.name || "（部屋名なし）"}
                        </span>
                        {/* 種類。講義室以外も入れられることが、並びから分かるように */}
                        {!taken && roomKind === "" && (
                          <span
                            className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold ${
                              on ? "bg-blue-500 text-blue-50" : "bg-slate-200 text-slate-500"
                            }`}
                          >
                            {T(ROOM_KIND_LABEL[r.category] ?? "その他")}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
                {roomsInScope.length > 300 && (
                  <li className="px-2 py-1.5 text-[10px] text-slate-500">
                    ほか {roomsInScope.length - 300} 室（「すべて選ぶ」にはこれらも含まれます）
                  </li>
                )}
              </ul>
            </>
          )}

          {chosen.length > 0 && (
            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-600">
              <b>{T("選択中：")}</b>
              {chosen
                .slice(0, 12)
                .map((r) => `${r.code}`)
                .join(" ／ ")}
              {chosen.length > 12 && ` ほか ${chosen.length - 12} 室`}
            </p>
          )}

          {chosen.length >= 100 && (
            <p className="mt-1 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[10px] leading-relaxed text-amber-800">
              {chosen.length}室にまとめて登録します。数が多いので、日付と時間を確かめてください。
            </p>
          )}
        </Field>

        {/* ---- 授業 ---- */}
        {kind === "class" && (
          <>
            <Field label="時限（いくつでも選べます）">
              {/*
                時限は複数選べる。同じ科目を1限と2限で続けて行う入れ方があり、
                一つずつ登録し直すのは手間なので、まとめて入れられるようにする。
              */}
              <div className="mb-1.5 flex gap-1.5">
                <button
                  onClick={() =>
                    setPeriodIds(
                      periodIds.length === periods.length ? [] : periods.map((p) => p.id),
                    )
                  }
                  className="rounded-lg bg-slate-200 px-2 py-1.5 text-[10px] font-bold text-slate-700 transition hover:bg-slate-300 active:scale-95"
                >
                  {periodIds.length === periods.length ? T("全部外す") : T("1限から5限まで")}
                </button>
                {periodIds.length > 0 && (
                  <span className="self-center text-[10px] font-bold text-slate-500">
                    {periodIds.length} {T("時限を選択中")}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-5 gap-1.5">
                {periods.map((p) => (
                  <button
                    key={p.id}
                    onClick={() =>
                      setPeriodIds((prev) =>
                        prev.includes(p.id) ? prev.filter((x) => x !== p.id) : [...prev, p.id],
                      )
                    }
                    className={`rounded-xl py-2 text-xs font-bold transition ${
                      periodIds.includes(p.id)
                        ? "bg-slate-900 text-white"
                        : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                    }`}
                  >
                    {p.label}
                    <span className="mt-0.5 block text-[9px] font-normal opacity-70">
                      {hhmm(p.starts_at)}
                    </span>
                  </button>
                ))}
              </div>
            </Field>

            {/*
              どの学科の授業か。いくつでも選べる。

              教養や共通の科目は、学科をまたいで同じ時間に同じ教室で行う。
              一つしか選べないと、そういう科目がどこか一つの学科の
              時間割にしか出なかった。

              学部ごとにまとめて並べ、押して選ぶ形にしてある。
              選んだものは上に大きく出して、その場で外せるようにする。
            */}
            <Field label="どの学科の授業か（いくつでも選べます）">
              {deptIds.length > 0 ? (
                <div className="mb-1.5 flex flex-wrap gap-1">
                  {deptIds.map((id) => {
                    const d = depts.find((x) => x.id === id);
                    return (
                      <button
                        key={id}
                        onClick={() => setDeptIds((p) => p.filter((x) => x !== id))}
                        className="flex items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1.5 text-[11px] font-bold text-white transition hover:bg-blue-700 active:scale-95"
                      >
                        {d?.name ?? id}
                        <span className="text-blue-200">×</span>
                      </button>
                    );
                  })}
                  <button
                    onClick={() => setDeptIds([])}
                    className="rounded-lg px-2 py-1.5 text-[11px] font-bold text-red-600 transition hover:bg-red-50 active:scale-95"
                  >
                    {T("全部外す")}
                  </button>
                </div>
              ) : (
                <p className="mb-1.5 text-[11px] font-bold text-amber-700">
                  {T("学科を選んでください")}
                </p>
              )}

              <div className="max-h-40 overflow-y-auto rounded-xl bg-slate-50 p-1.5">
                {facs.map((f) => {
                  const list = depts.filter((d) => d.faculty_id === f.id);
                  if (list.length === 0) return null;
                  const allOn = list.every((d) => deptIds.includes(d.id));
                  return (
                    <div key={f.id} className="mb-1.5 last:mb-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] font-bold text-slate-500">{f.name}</span>
                        <button
                          onClick={() =>
                            setDeptIds((p) =>
                              allOn
                                ? p.filter((x) => !list.some((d) => d.id === x))
                                : [...new Set([...p, ...list.map((d) => d.id)])],
                            )
                          }
                          className="rounded px-1.5 py-0.5 text-[9px] font-bold text-slate-500 transition hover:bg-slate-200"
                        >
                          {allOn ? T("この学部を外す") : T("この学部をすべて")}
                        </button>
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {list.map((d) => {
                          const on = deptIds.includes(d.id);
                          return (
                            <button
                              key={d.id}
                              onClick={() => {
                                setDeptIds((p) =>
                                  on ? p.filter((x) => x !== d.id) : [...p, d.id],
                                );
                                setCourseId(null);
                              }}
                              className={`rounded-lg px-2 py-1.5 text-[11px] font-bold transition active:scale-95 ${
                                on
                                  ? "bg-blue-600 text-white"
                                  : "bg-white text-slate-600 shadow-sm hover:bg-slate-100"
                              }`}
                            >
                              {d.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
                {/* 準備が済んでいないときは上の帯で伝えているので、ここでは繰り返さない */}
                {!setupNeeded && facs.length === 0 && (
                  <p className="p-1 text-[10px] text-amber-700">{T("学科が登録されていません")}</p>
                )}
              </div>
            </Field>

            {/*
              何年生の授業か。

              時間割は学生の学年で絞って出しているので、ここを入れておくと
              その学年の人にだけ出る。分からないときは「すべての学年」。
            */}
            <Field label="何年生の授業か">
              <div className="grid grid-cols-5 gap-1.5">
                {[0, 1, 2, 3, 4].map((g) => (
                  <button
                    key={g}
                    onClick={() => setGrade(g)}
                    className={`rounded-xl py-2 text-xs font-bold transition active:scale-95 ${
                      grade === g
                        ? "bg-slate-900 text-white"
                        : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                    }`}
                  >
                    {g === 0 ? T("すべて") : `${g}年`}
                  </button>
                ))}
              </div>
            </Field>

            <Field label="授業名">
              <select
                value={courseId ?? ""}
                onChange={(e) => setCourseId(e.target.value ? Number(e.target.value) : null)}
                className="w-full rounded-xl bg-slate-100 px-3 py-2.5 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
              >
                <option value="">{T("新しく登録する")}</option>
                {courses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.class_name ? `（${c.class_name}）` : ""}
                  </option>
                ))}
              </select>
              {courseId === null && (
                <input
                  value={courseName}
                  onChange={(e) => setCourseName(e.target.value)}
                  placeholder={T("授業名")}
                  className="mt-1.5 w-full rounded-xl bg-slate-100 px-3 py-2.5 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
                />
              )}

              {/*
                クラス。いくつでも選べる。

                同じ授業を CC1 と CC2 が一緒に受ける、ということがある。
                打ち込む欄だけだと、区切り記号を毎回書くことになり、
                「CC1,CC2」「CC1・CC2」と書き方が揃わない。
                押して選ぶ形にして、しまう形はこちらで揃える。

                「すべて」は空にする。空はもともと「分かれていない」の
                意味で使っていて、時間割にも何も出ない。
              */}
              {courseId === null && (
                <div className="mt-2">
                  <div className="text-[10px] font-bold text-slate-500">
                    {T("クラス（いくつでも選べます）")}
                  </div>

                  {/*
                    いま選んでいるクラス。

                    前は説明文の中に小さく「いま選んでいるのは …」と
                    書いていただけで、選んだかどうかが分かりにくかった。
                    大きく並べて、押せばその場で外せるようにする。
                  */}
                  <div className="mt-1 rounded-xl bg-slate-50 p-2">
                    <div className="text-[10px] font-bold text-slate-500">
                      {T("選んでいるクラス")}
                    </div>
                    {classes.length === 0 ? (
                      <p className="mt-0.5 text-xs font-bold text-slate-700">
                        {T("すべて")}
                        <span className="ml-1 text-[10px] font-normal text-slate-400">
                          （{T("分かれていない")}）
                        </span>
                      </p>
                    ) : (
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        {classes.map((c) => (
                          <button
                            key={c}
                            onClick={() => setClasses((p) => p.filter((x) => x !== c))}
                            title={T("押すと外せます")}
                            className="flex items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1.5 text-xs font-bold text-white transition hover:bg-blue-700 active:scale-95"
                          >
                            {c}
                            <span className="text-blue-200">×</span>
                          </button>
                        ))}
                        <button
                          onClick={() => setClasses([])}
                          className="rounded-lg px-2 py-1.5 text-[11px] font-bold text-red-600 transition hover:bg-red-50 active:scale-95"
                        >
                          {T("全部外す")}
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <button
                      onClick={() => setClasses([])}
                      className={`rounded-lg px-2.5 py-1.5 text-[11px] font-bold transition active:scale-95 ${
                        classes.length === 0
                          ? "bg-slate-900 text-white"
                          : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                      }`}
                    >
                      {T("すべて")}
                    </button>
                    {classChoices.map((c) => {
                      const on = classes.includes(c);
                      return (
                        <button
                          key={c}
                          onClick={() =>
                            setClasses((prev) =>
                              prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c],
                            )
                          }
                          className={`rounded-lg px-2.5 py-1.5 text-[11px] font-bold transition active:scale-95 ${
                            on
                              ? "bg-blue-600 text-white"
                              : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                          }`}
                        >
                          {c}
                        </button>
                      );
                    })}
                  </div>

                  {/* 並んでいないクラスは、打ち込んで足す */}
                  <div className="mt-1.5 flex gap-2">
                    <input
                      value={classDraft}
                      onChange={(e) => setClassDraft(e.target.value.toUpperCase())}
                      placeholder={deptCode ? `${deptCode}9` : "CC9"}
                      className="w-28 rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
                    />
                    <button
                      onClick={() => {
                        const v = classDraft.trim();
                        if (!v) return;
                        setClasses((prev) => (prev.includes(v) ? prev : [...prev, v]));
                        setClassDraft("");
                      }}
                      disabled={!classDraft.trim()}
                      className="rounded-lg bg-slate-100 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 transition hover:bg-slate-200 active:scale-95 disabled:text-slate-300"
                    >
                      {T("足す")}
                    </button>
                  </div>
                </div>
              )}
              {courseId === null && (
                <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
                  {T("クラスは、同じ科目を分けて受ける組のこと。")}
                  {deptCode
                    ? `この学科の記号は ${deptCode} なので、${deptCode}1・${deptCode}2 のように並びます。`
                    : "KM1・CC2 のように、学科の記号と組の番号で書きます。"}
                  <br />
                  何も選ばなければ<b>{T("すべて")}</b>（分かれていない）になります。
                </p>
              )}
            </Field>

            <Field label="登録者・担当">
              <input
                value={teacher}
                onChange={(e) => setTeacher(e.target.value)}
                placeholder={T("担当の先生の名前")}
                className="w-full rounded-xl bg-slate-100 px-3 py-2.5 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
              />
              <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
                {T("ここに書いた名前が、時間割に出ます。")}
                {T("担当の先生が別の人なら、その名前に書き換えてください。")}
                <br />
                登録した人（{email}）は、これとは別に記録されます。
              </p>
            </Field>
          </>
        )}

        {/* ---- イベント・課外活動 ---- */}
        {kind !== "class" && (
          <>
            <Field label="何時から何時まで">
              <div className="flex items-center gap-2">
                <input
                  type="time"
                  value={startAt}
                  onChange={(e) => setStartAt(e.target.value)}
                  className="flex-1 rounded-xl bg-slate-100 px-3 py-2.5 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
                />
                <span className="text-xs font-bold text-slate-500">〜</span>
                <input
                  type="time"
                  value={endAt}
                  onChange={(e) => setEndAt(e.target.value)}
                  className="flex-1 rounded-xl bg-slate-100 px-3 py-2.5 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </Field>

            {kind === "activity" && (
              <Field label="団体">
                <select
                  value={catId ?? ""}
                  onChange={(e) => {
                    setCatId(e.target.value ? Number(e.target.value) : null);
                    setActivityId(null);
                  }}
                  className="w-full rounded-xl bg-slate-100 px-3 py-2.5 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">{T("系統を選ぶ")}</option>
                  {cats.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                {catId !== null && (
                  <select
                    value={activityId ?? ""}
                    onChange={(e) => setActivityId(e.target.value ? Number(e.target.value) : null)}
                    className="mt-1.5 w-full rounded-xl bg-slate-100 px-3 py-2.5 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">{T("団体を選ぶ")}</option>
                    {actsInCat.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                )}
                {!setupNeeded && cats.length === 0 && (
                  <p className="mt-1 text-[10px] text-amber-700">{T("課外活動が登録されていません")}</p>
                )}
              </Field>
            )}

            <Field label={kind === "event" ? "イベント名" : "活動の内容（任意）"}>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={kind === "event" ? "オープンキャンパス" : "練習・打ち合わせ など"}
                className="w-full rounded-xl bg-slate-100 px-3 py-2.5 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-blue-500"
              />
            </Field>
          </>
        )}

        {/* ---- 確認。日と教室ごとに、何が消えるのかを並べて一度だけ尋ねる ---- */}
        {pending && (
          <div className="rounded-xl bg-amber-50 p-3">
            <p className="text-xs font-bold text-amber-900">
              次の{pending.length}件には、すでに予定が入っています。
            </p>
            <ul className="mt-1.5 flex flex-col gap-1.5">
              {pending.map(({ date: d, room: rm, conflicts }) => (
                <li key={`${d}-${rm.id}`} className="text-[11px] text-amber-800">
                  <b>
                    {niceDate(d)} {rm.code}
                  </b>
                  <ul className="mt-0.5 pl-3">
                    {conflicts.map((c) => (
                      <li key={c.id}>
                        ・{KIND_LABEL[c.kind]}「{c.title || "（名称なし）"}」{hhmm(c.starts_at)}〜
                        {hhmm(c.ends_at)}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-[11px] leading-relaxed text-amber-900">
              {KIND_LABEL[kind]}を登録すると、上の予定は取り消されます。
              {T("登録した人には知らせが届きます。よろしいですか？")}
            </p>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => {
                  /*
                   * 日ごとにまとめ直してから渡す。
                   * すでに入った日と教室はもう一度なぞらない。
                   */
                  /* 日と時限の組ごとにまとめ直す。時限が違えば別の予定 */
                  const byStep = new Map<string, { date: string; periodId: number | null; rooms: Room[] }>();
                  for (const p of pending) {
                    const key = `${p.date}#${p.periodId ?? ""}`;
                    const cur = byStep.get(key) ?? { date: p.date, periodId: p.periodId, rooms: [] };
                    cur.rooms.push(p.room);
                    byStep.set(key, cur);
                  }
                  void submit(true, [...byStep.values()]);
                }}
                disabled={busy}
                className="flex-1 rounded-xl bg-amber-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-amber-700 disabled:bg-slate-300"
              >
                {T("はい、取り消して登録する")}
              </button>
              <button
                onClick={() => setPending(null)}
                className="rounded-xl bg-white px-4 py-2.5 text-sm font-bold text-slate-600 shadow-sm"
              >
                {T("やめる")}
              </button>
            </div>
          </div>
        )}

        {msg && (
          <p
            className={`rounded-xl p-3 text-xs leading-relaxed ${
              msg.kind === "ok"
                ? "bg-emerald-50 text-emerald-900"
                : msg.kind === "warn"
                  ? "bg-amber-50 text-amber-900"
                  : "bg-red-50 text-red-800"
            }`}
          >
            {msg.text}
          </p>
        )}

        {/*
          登録する前に、どの日に入るのかをカレンダーで見せる。

          何週もまとめて入れられるようになってから、
          「押したあとで、思っていた日と違うと気づく」ことが増えた。
          入る日を色で塗ったカレンダーを出して、見ながら決めてもらう。
          取り消すには入ったものを一つずつ消すしかないので、
          入れる前のここで止めるほうが早い。
        */}
        {!pending && ask && (
          <div className="rounded-xl border-2 border-blue-300 bg-blue-50 p-3">
            <div className="text-xs font-bold text-blue-900">{T("この内容で登録します")}</div>

            <ul className="mt-1.5 grid gap-0.5 text-[11px] leading-relaxed text-blue-900">
              <li>
                <b>{T("種類")}</b>：{KIND_LABEL[kind]}
              </li>
              <li>
                <b>{T("教室")}</b>：{chosen.length} {T("室")}
                {chosen.length > 0 && (
                  <span className="ml-1 text-blue-700">
                    （{chosen.slice(0, 6).map((r) => r.code).join("・")}
                    {chosen.length > 6 ? ` ほか${chosen.length - 6}` : ""}）
                  </span>
                )}
              </li>
              {kind === "class" && (
                <li>
                  <b>{T("時限")}</b>：
                  {periods
                    .filter((p) => periodIds.includes(p.id))
                    .map((p) => p.label)
                    .join("・") || T("（選ばれていません）")}
                </li>
              )}
              <li>
                <b>{T("日にち")}</b>：{dates.length} {T("日")}
              </li>
              <li className="font-bold">
                {T("あわせて")}{" "}
                {chosen.length * dates.length * (kind === "class" ? Math.max(1, periodIds.length) : 1)}{" "}
                {T("件が入ります")}
              </li>
            </ul>

            <div className="mt-2 rounded-xl bg-white p-2">
              <div className="mb-1 text-[10px] font-bold text-slate-500">
                {T("色の付いた日に入ります")}
              </div>
              <MiniCalendar dates={dates} />
            </div>

            <div className="mt-2 flex gap-2">
              <button
                onClick={() => {
                  setAsk(false);
                  void submit(false);
                }}
                disabled={busy}
                className="flex-1 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-blue-700 disabled:bg-slate-300"
              >
                {busy ? T("登録中…") : T("この内容で登録する")}
              </button>
              <button
                onClick={() => setAsk(false)}
                className="rounded-xl bg-white px-4 py-2.5 text-sm font-bold text-slate-600 shadow-sm"
              >
                {T("やめる")}
              </button>
            </div>
          </div>
        )}

        {!pending && !ask && (
          <button
            onClick={() => {
              setMsg(null);
              setAsk(true);
            }}
            disabled={busy || dates.length === 0}
            className="rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold text-white transition hover:bg-blue-700 disabled:bg-slate-300"
          >
            {busy
              ? "登録中…"
              : dates.length === 0
                ? "日にちを選んでください"
                : dates.length === 1
                  ? `${KIND_LABEL[kind]}を登録する`
                  : `${dates.length}日ぶんの${KIND_LABEL[kind]}を登録する（${chosen.length}室 × ${dates.length}日）`}
          </button>
        )}

        {/* 入れたものを、日ごとに見に行く道 */}
        <Link
          href="/admin/plan"
          className="rounded-xl bg-slate-100 px-4 py-3 text-center text-xs font-bold text-slate-700 transition hover:bg-slate-200"
        >
          {T("登録されている予定を確認する")}
        </Link>

        <p className="border-t border-slate-100 pt-3 text-[10px] leading-relaxed text-slate-400">
          {T("一つの教室の一つの時間に入るのは一つだけです。学科が違っても重ねられません。")}
          {T("優先順位は 授業 ＞ イベント ＞ 課外活動。")}
          {T("同じ強さどうしは、先に入れたものが残ります。")}
        </p>

        {/* ---- この日に入っている予定。間違えて入れたものを消せる ---- */}
        <div className="border-t border-slate-100 pt-3">
          {/*
            何日ぶんも選べるので、見る日を選び直せるようにする。
            全部の日をいっぺんに出すと、どの日のものを消すのか分からなくなる。
          */}
          {dates.length > 1 && (
            <div className="mb-2">
              <div className="text-[10px] font-bold text-slate-500">{T("どの日の予定を見るか")}</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {dates.map((d) => (
                  <button
                    key={d}
                    onClick={() => setViewDate(d)}
                    className={`rounded-full px-2 py-1 text-[10px] font-bold transition active:scale-95 ${
                      shownDate === d
                        ? "bg-slate-900 text-white"
                        : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                    }`}
                  >
                    {niceDate(d)}
                  </button>
                ))}
              </div>
            </div>
          )}

          <p className="mb-2 text-[11px] font-bold text-slate-500">
            {shownDate} に入っている予定（{booked.length}件）
            {/* 他人が立てたものも含めてまとめて消せるのは、副管理者と管理者だけ */}
            {canDeleteAny && booked.length > 0 && (
              <button
                onClick={() => void removeAllBooked()}
                disabled={busy}
                className="ml-2 rounded-lg bg-red-600 px-2 py-1 text-[10px] font-bold text-white transition hover:bg-red-700 disabled:bg-slate-300"
              >
                {T("この日をすべて消す")}
              </button>
            )}
          </p>

          {booked.length === 0 ? (
            <p className="rounded-xl bg-slate-50 p-3 text-[11px] text-slate-500">
              {T("まだ何も入っていません。")}
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {booked.map((b) => {
                const label =
                  b.kind === "class"
                    ? `${b.courses?.name ?? "授業"}${b.courses?.class_name ? `（${b.courses.class_name}）` : ""}`
                    : b.kind === "activity"
                      ? (b.club_activities?.name ?? "課外活動")
                      : b.title || "イベント";
                return (
                  <li key={b.id} className="rounded-xl bg-slate-50 p-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold text-white ${
                              b.kind === "class"
                                ? "bg-slate-800"
                                : b.kind === "event"
                                  ? "bg-amber-600"
                                  : "bg-violet-600"
                            }`}
                          >
                            {KIND_LABEL[b.kind]}
                          </span>
                          <span className="truncate text-sm font-bold text-slate-900">{label}</span>
                        </div>
                        <div className="mt-0.5 text-[11px] text-slate-600">
                          {b.rooms?.code ?? "教室未定"}
                          <span className="ml-2 text-slate-500">
                            {hhmm(b.starts_at)}〜{hhmm(b.ends_at)}
                          </span>
                          {b.teacher && <span className="ml-2 text-slate-500">{b.teacher}</span>}
                        </div>
                      </div>
                      <button
                        onClick={() => setConfirmDelete(b)}
                        className="shrink-0 rounded-lg bg-white px-2.5 py-1.5 text-[11px] font-bold text-red-600 shadow-sm transition hover:bg-red-50"
                      >
                        {T("削除")}
                      </button>
                    </div>

                    {/* 押し間違いで消えないよう、一度だけ確かめる */}
                    {confirmDelete?.id === b.id && (
                      <div className="mt-2 rounded-lg bg-red-50 p-2.5">
                        <p className="text-[11px] font-bold text-red-800">
                          {T("この予定を消しますか？元には戻せません。")}
                        </p>
                        <div className="mt-1.5 flex gap-2">
                          <button
                            onClick={() => void removeBooked(b)}
                            className="flex-1 rounded-lg bg-red-600 px-3 py-2 text-[11px] font-bold text-white transition hover:bg-red-700"
                          >
                            {T("はい、消す")}
                          </button>
                          <button
                            onClick={() => setConfirmDelete(null)}
                            className="rounded-lg bg-white px-3 py-2 text-[11px] font-bold text-slate-600 shadow-sm"
                          >
                            {T("やめる")}
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <p className="mt-2 text-[10px] leading-relaxed text-slate-400">
            {T("消せるのは、自分で入れたもの。授業は教授も消せます。")}
          </p>
        </div>
      </div>
    </Shell>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-bold text-slate-500">{label}</div>
      {children}
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

/**
 * 入る日を塗っただけの、小さなカレンダー。
 *
 * 登録の前に「どの日に入るのか」を見せるためのもの。
 * 押せない。押せると、選び直す欄が二つあることになって迷う。
 * 選び直すのは上のカレンダーで。
 *
 * 何か月にもまたがることがあるので、月ごとに並べる。
 * ただし出すのは先頭の3か月まで。15週なら4か月ぶんになるが、
 * 「思っていた日と違う」に気づくのは、たいてい初めのほうで足りる。
 */
function MiniCalendar({ dates }: { dates: string[] }) {
  const set = new Set(dates);
  const all = [...new Set(dates.map((d) => d.slice(0, 7)))].sort();
  const months = all.slice(0, 3);
  const hidden = all.length - months.length;

  if (dates.length === 0)
    return <p className="text-[10px] text-slate-400">日にちが選ばれていません</p>;

  return (
    <div className="grid gap-2">
      {months.map((ym) => {
        const [y, m] = ym.split("-").map(Number);
        const first = new Date(y, m - 1, 1);
        const days = new Date(y, m, 0).getDate();
        const cells: (number | null)[] = Array(first.getDay()).fill(null);
        for (let d = 1; d <= days; d++) cells.push(d);
        const n = dates.filter((d) => d.startsWith(ym)).length;
        return (
          <div key={ym}>
            <div className="text-[10px] font-bold text-slate-600">
              {y}年 {m}月<span className="ml-1 font-normal text-slate-400">（{n}日）</span>
            </div>
            <div className="mt-0.5 grid grid-cols-7 gap-0.5">
              {["日", "月", "火", "水", "木", "金", "土"].map((w, i) => (
                <div
                  key={w}
                  className={`text-center text-[8px] font-bold ${
                    i === 0 ? "text-red-300" : i === 6 ? "text-blue-300" : "text-slate-300"
                  }`}
                >
                  {w}
                </div>
              ))}
              {cells.map((d, i) => {
                if (d === null) return <div key={`x${i}`} />;
                const key = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
                /* 入る日は青。入らない日は、祝日と日曜だけ赤くする */
                const tone = dayColor(key);
                return (
                  <div
                    key={d}
                    title={holidayName(key) ?? undefined}
                    className={`flex h-5 items-center justify-center rounded text-[9px] font-bold ${
                      set.has(key)
                        ? "bg-blue-600 text-white"
                        : tone === "holiday"
                          ? "text-red-400"
                          : tone === "sat"
                            ? "text-blue-400"
                            : "text-slate-400"
                    }`}
                  >
                    {d}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      {hidden > 0 && (
        <p className="text-[10px] text-slate-500">ほか {hidden} か月ぶんにも入ります</p>
      )}
    </div>
  );
}
