/**
 * 案内画面が読み込む地図データ。
 *
 * public/data/ に置いた静的ファイルを取得するだけ。
 * データベースもAPIキーも使わない。
 */

import type { FeatureCollection, LineString, Point, Polygon } from "geojson";
import type {
  BuildingProps,
  CampusProps,
  CheckpointProps,
  LinkProps,
  Room,
} from "./features";

export type AppData = {
  campus: FeatureCollection<Polygon, CampusProps>;
  buildings: FeatureCollection<Polygon, BuildingProps>;
  checkpoints: FeatureCollection<Point, CheckpointProps>;
  /** links.geojson は線として書き出してあるが、経路探索は properties だけ使う */
  links: LinkProps[];
  rooms: Room[];
};

const EMPTY: AppData = {
  campus: { type: "FeatureCollection", features: [] },
  buildings: { type: "FeatureCollection", features: [] },
  checkpoints: { type: "FeatureCollection", features: [] },
  links: [],
  rooms: [],
};

/**
 * 教室をデータベースから読む。
 *
 * rooms は承認された人だけが読める。未ログインなら RLS が空を返すので、
 * ここでは特別な分岐をしなくても自然に「教室なし」になる。
 */
export async function loadRooms(): Promise<Room[]> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return [];

  try {
    const { createClient } = await import("./supabase/client");
    const { data, error } = await createClient()
      .from("rooms")
      .select("id, building_id, floor, code, name, category, hint");
    if (error || !data) return [];
    return data.map((r) => ({
      id: String(r.id),
      buildingId: r.building_id as string,
      code: (r.code as string) ?? "",
      name: (r.name as string) ?? "",
      floor: (r.floor as number) ?? 0,
      category: (r.category as Room["category"]) ?? "other",
      hint: (r.hint as string) ?? "",
    }));
  } catch {
    return [];
  }
}

/**
 * 地図データを読み、読めなかったファイルも一緒に返す。
 *
 * 案内画面は「読めなければ何も出ない」で構わないが、作図ツールでは
 * なぜ取り込めなかったのかが分からないと直しようがない。
 * どのファイルがどう駄目だったかを、そのまま画面に出せるようにする。
 *
 * @param dir どの組を読むか。案内画面は既定の `/data`。
 *            作図ツールは、経路を引き直すための `/data/base` も読む。
 */
export async function loadMapSet(
  dir = "/data",
): Promise<{ data: AppData; missing: string[] }> {
  const missing: string[] = [];

  const grab = async <T>(name: string, fallback: T): Promise<T> => {
    const path = `${dir}/${name}.geojson`;
    try {
      /*
       * no-store ではなく no-cache。
       *
       * 地図データは合わせて 3.9MB ある。no-store だと毎回まるごと
       * 取り直しになり、開くたびに 3.9MB 落として組み立て直していた。
       * 電波の細い所や、プライベートモードのように手元に置ける量が
       * 少ないところでは、ここで待たされる。
       *
       * no-cache は「毎回サーバに確かめるが、変わっていなければ
       * 手元のものを使う」。配信元は ETag を返すので、変わっていなければ
       * 304 が返り、本文は流れない（実際に 304 が返ることを確認済み）。
       * 新しく publish すれば ETag が変わるので、古いものを掴んだまま
       * になることはない。
       */
      const res = await fetch(path, { cache: "no-cache" });
      if (!res.ok) {
        missing.push(`${path}（${res.status}）`);
        return fallback;
      }
      return (await res.json()) as T;
    } catch {
      missing.push(`${path}（つながりません）`);
      return fallback;
    }
  };

  const [campus, buildings, checkpoints, linkFc] = await Promise.all([
    grab("campus", EMPTY.campus),
    grab("buildings", EMPTY.buildings),
    grab("checkpoints", EMPTY.checkpoints),
    grab<FeatureCollection<LineString, LinkProps>>("links", {
      type: "FeatureCollection",
      features: [],
    }),
  ]);

  return {
    data: {
      campus,
      buildings,
      checkpoints,
      links: linkFc.features.map((f) => f.properties),
      rooms: [],
    },
    missing,
  };
}

/**
 * 地図データだけを読む。
 * 教室は権限で見え方が変わるので、別に読んであとから足す。
 */
export async function loadAppData(dir = "/data"): Promise<AppData> {
  return (await loadMapSet(dir)).data;
}

/* ---------------- 検索 ---------------- */

export type SearchHit = {
  /** 目的地の建物 */
  buildingId: string;
  /** 一覧に出す見出し。例: "23号館 302" */
  title: string;
  /** 補足。例: "3階" */
  sub: string;
  /** 並べ替え用。小さいほど良い */
  score: number;
};

/**
 * 表記ゆれを潰す。
 * `23・302` `23-302` `23 302` `23302` をすべて `23302` にする。
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[^0-9a-z぀-ヿ一-鿿]/g, "");
}

/**
 * 入力した語がその名前に当たるか。
 *
 * 検索一覧と同じ当たり方で、お気に入りの絞り込みにも使う。
 * 別々に書くと、片方だけ出る／消えるという食い違いが起きる。
 */
export function matchesQuery(text: string, query: string): boolean {
  const q = normalize(query);
  if (!q) return true; // 何も入れていないうちは全部見せる
  return normalize(text).includes(q);
}

/**
 * 建物名・号館番号・部屋番号から目的地を探す。
 *
 * 完全一致 → 前方一致 → 部分一致 の順に並べる。
 * あいまい検索のライブラリを使わずに済むよう、表記ゆれは normalize で吸収する。
 */
export function search(data: AppData, query: string, limit = 8): SearchHit[] {
  const q = normalize(query);
  if (!q) return [];

  const hits: SearchHit[] = [];
  const rank = (target: string) => {
    if (!target) return -1;
    if (target === q) return 0;
    if (target.startsWith(q)) return 1;
    if (target.includes(q)) return 2;
    return -1;
  };

  for (const b of data.buildings.features) {
    const p = b.properties;
    const cands = [p.name, p.code, p.code ? `${p.code}号館` : ""].filter(Boolean);
    let best = -1;
    for (const c of cands) {
      const r = rank(normalize(c));
      if (r >= 0 && (best < 0 || r < best)) best = r;
    }
    if (best >= 0) {
      hits.push({ buildingId: p.tempId, title: p.name || `${p.code}号館`, sub: "", score: best });
    }
  }

  const buildingName = new Map(
    data.buildings.features.map((b) => [
      b.properties.tempId,
      b.properties.name || `${b.properties.code}号館`,
    ]),
  );

  for (const r of data.rooms) {
    const bn = buildingName.get(r.buildingId);
    if (!bn) continue;
    // 「23302」「302」「情報演習室」「23号館302」のどれでも当たるようにする
    const cands = [r.code, r.name, `${bn}${r.code}`, `${bn}${r.name}`].filter(Boolean);
    let best = -1;
    for (const c of cands) {
      const rk = rank(normalize(c));
      if (rk >= 0 && (best < 0 || rk < best)) best = rk;
    }
    if (best >= 0) {
      hits.push({
        buildingId: r.buildingId,
        // 部屋番号は "23-220" のように号館まで含むので、号館名を重ねない
        title: r.code ? `${r.code} ${r.name}`.trim() : `${bn} ${r.name}`,
        sub: floorText(r.floor),
        // 部屋は建物より少し後ろに出す
        score: best + 0.5,
      });
    }
  }

  return hits.sort((a, b) => a.score - b.score || a.title.localeCompare(b.title, "ja")).slice(0, limit);
}

export function floorText(floor: number): string {
  if (!floor) return "";
  return floor < 0 ? `地下${-floor}階` : `${floor}階`;
}
