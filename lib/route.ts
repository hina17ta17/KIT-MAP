/**
 * 経路探索。
 *
 * チェックポイントを節点、接続を辺とするグラフを A* で解く。
 * 節点98・辺153程度なので、外部ライブラリを使わず自前で持つ。
 * 依存が減るぶん、型の食い違いやビルドの失敗も起きない。
 */

import type { Position } from "geojson";
import type { AppData } from "./appdata";
import { metersBetween } from "./geo";
import { placeName, type Lang } from "./i18n";
import type { CheckpointFeature } from "./features";

export type Graph = {
  pos: Map<string, Position>;
  /** 節点ID → [相手のID, コスト, 実距離(m)][] */
  adj: Map<string, { to: string; cost: number; meters: number }[]>;
  cp: Map<string, CheckpointFeature>;
};

/**
 * 経路の網を組む。
 *
 * outdoorOnly を立てると、建物の中の点（レベル2以上）を外して組む。
 * 「中を通らない道すじ」を出すために使う。中を通れないぶん遠回りになり、
 * 行き先によっては道が無くなる（実測で 409 通り中 83 通りは出せない）。
 */
export function buildGraph(data: AppData, opts?: { outdoorOnly?: boolean }): Graph {
  const all = data.checkpoints.features as CheckpointFeature[];
  const cps = opts?.outdoorOnly ? all.filter((c) => c.properties.level < 2) : all;
  const pos = new Map<string, Position>();
  const cp = new Map<string, CheckpointFeature>();
  for (const c of cps) {
    pos.set(c.properties.id, c.geometry.coordinates);
    cp.set(c.properties.id, c);
  }

  const adj = new Map<string, { to: string; cost: number; meters: number }[]>();
  const add = (a: string, b: string, cost: number, meters: number) => {
    const list = adj.get(a);
    if (list) list.push({ to: b, cost, meters });
    else adj.set(a, [{ to: b, cost, meters }]);
  };

  for (const l of data.links) {
    if (!l.enabled) continue; // 案内に使わない区間は入れない
    const a = pos.get(l.from);
    const b = pos.get(l.to);
    if (!a || !b) continue;
    const m = metersBetween(a, b);
    // いちばん短い距離で行ける経路を出す。
    // 種別ごとの重みはデータに持っているが、探索では使わない
    // （使うと「少し遠回りでも大通り」になり、最短ではなくなる）。
    add(l.from, l.to, m, m);
    add(l.to, l.from, m, m);
  }

  /*
   * 親子関係は、歩ける道として足さない。
   *
   * 親子は「どの入口から入れるか」の指定であって、道ではない。
   * 実際、親子の組 1380 本のうち線が引いてあるのは 29 本だけで、
   * 距離は中央値 47m・最長 141m ある。
   *
   * これを直線の辺として入れていたため、建物の中の点から
   * 遠くの入口へ 77m まっすぐ飛ぶ、といった道すじが選ばれていた。
   * 画面では「途中が飛ばされた」ように見える。
   *
   * 歩ける道は、引いてある接続だけ。親子はそちらで表す。
   * 4177 点すべてが接続だけでひと続きになっていることは確かめてある。
   */

  return { pos, adj, cp };
}

/** 指定した位置にいちばん近い節点。maxMeters より遠ければ null */
export function nearestNode(
  graph: Graph,
  at: Position,
  maxMeters = 50,
): { id: string; meters: number } | null {
  let best: string | null = null;
  let bestD = maxMeters;
  for (const [id, p] of graph.pos) {
    const d = metersBetween(at, p);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best ? { id: best, meters: bestD } : null;
}

/** A* で最短経路を求める。見つからなければ null */
export function findPath(graph: Graph, from: string, to: string): string[] | null {
  if (from === to) return [from];
  const goal = graph.pos.get(to);
  if (!goal || !graph.pos.has(from)) return null;

  const h = (id: string) => {
    const p = graph.pos.get(id);
    return p ? metersBetween(p, goal) : 0;
  };

  const g = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, string>();
  const done = new Set<string>();
  // 節点数が少ないので、優先度付きキューは使わず毎回いちばん小さいものを探す
  const open = new Map<string, number>([[from, h(from)]]);

  while (open.size) {
    let cur = "";
    let curF = Infinity;
    for (const [id, f] of open) {
      if (f < curF) {
        curF = f;
        cur = id;
      }
    }
    if (cur === to) break;
    open.delete(cur);
    done.add(cur);

    for (const e of graph.adj.get(cur) ?? []) {
      if (done.has(e.to)) continue;
      const ng = (g.get(cur) ?? Infinity) + e.cost;
      if (ng < (g.get(e.to) ?? Infinity)) {
        g.set(e.to, ng);
        prev.set(e.to, cur);
        open.set(e.to, ng + h(e.to));
      }
    }
  }

  if (!g.has(to)) return null;
  const path: string[] = [to];
  let cur = to;
  while (cur !== from) {
    const p = prev.get(cur);
    if (!p) return null;
    path.unshift(p);
    cur = p;
  }
  return path;
}

/**
 * 出入口が複数あるとき、いちばん短くなる組み合わせを選ぶ。
 *
 * ■ なぜ要るか
 *   建物には出入口がいくつもある。直線でいちばん近い出入口が、
 *   道なりでも近いとはかぎらない。壁や建物を回り込むと、
 *   遠く見えた出入口のほうが早く着くことがある。
 *   直線で決め打つと、そこで最短を取り逃す。
 *
 * ■ 進め方
 *   出発側の出入口すべてを距離0として同時に広げる（多点始点）。
 *   一度広げれば、すべての点への最短距離が分かるので、
 *   そこから目的側の出入口のうち最短のものを選ぶ。
 *   出入口の数が増えても探索は一度で済む。
 *
 *   ここでは推定値を使わない素直な広げ方（ダイクストラ）にしている。
 *   行き先が複数あると推定値の置き方が難しくなるうえ、
 *   648点では速さの差が出ないため。
 */
export function findBestPath(
  graph: Graph,
  fromIds: string[],
  toIds: string[],
): { path: string[]; meters: number } | null {
  const starts = fromIds.filter((id) => graph.pos.has(id));
  const goals = new Set(toIds.filter((id) => graph.pos.has(id)));
  if (starts.length === 0 || goals.size === 0) return null;

  const dist = new Map<string, number>();
  const prev = new Map<string, string>();
  const done = new Set<string>();
  const open = new Map<string, number>();
  for (const s of starts) {
    dist.set(s, 0);
    open.set(s, 0);
  }

  while (open.size) {
    // 節点が少ないので、優先度付きキューは使わず毎回いちばん小さいものを探す
    let cur = "";
    let curD = Infinity;
    for (const [id, d] of open) {
      if (d < curD) {
        curD = d;
        cur = id;
      }
    }
    open.delete(cur);
    done.add(cur);

    for (const e of graph.adj.get(cur) ?? []) {
      if (done.has(e.to)) continue;
      const nd = curD + e.cost;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, cur);
        open.set(e.to, nd);
      }
    }
  }

  // 目的側の出入口のうち、いちばん近いもの
  let best: string | null = null;
  let bestD = Infinity;
  for (const g of goals) {
    const d = dist.get(g);
    if (d != null && d < bestD) {
      bestD = d;
      best = g;
    }
  }
  if (!best) return null;

  const path = [best];
  let cur = best;
  for (;;) {
    const p = prev.get(cur);
    if (!p) break;
    path.unshift(p);
    cur = p;
  }
  return { path, meters: bestD };
}

/* ---------------- 案内文 ---------------- */

export type Step = {
  /** 「北へ」「右折して」など */
  turn: string;
  /** この手順で進む距離(m) */
  meters: number;
  /** 目印にする建物名。無ければ空 */
  landmark: string;
  /**
   * 建物の出入りを告げるだけの手順か。
   *
   * 短い区間は直前の手順に足してまとめるが、これに足すと
   * 「◯号館 に入る」の文が距離の文に置き換わって消えてしまう。
   * 足す相手から外すために印を持たせる。
   */
  door: boolean;
  /**
   * この手順が建物の中を進むものか。
   *
   * 中を通る道すじ（レベル2以上の点）を引いてあるのに、
   * 外を歩くときと同じ「◯号館の角を」と言っていた。
   * 中と外で言い方を変えるために持たせる。
   */
  inside: boolean;
  text: string;
};

const COMPASS = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"];
const COMPASS_EN = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];

/** 曲がり方の言い方。日本語と英語で語順が違うので、対で持つ */
const TURN: Record<string, string> = {
  "Uターンして": "make a U-turn and ",
  "右後方へ": "turn sharp right and ",
  "左後方へ": "turn sharp left and ",
  "右折して": "turn right and ",
  "左折して": "turn left and ",
  "右斜め前へ": "bear right and ",
  "左斜め前へ": "bear left and ",
};

/** 2点間の方位（度・北が0・時計回り） */
function bearing(a: Position, b: Position): number {
  const toRad = Math.PI / 180;
  const y = Math.sin((b[0] - a[0]) * toRad) * Math.cos(b[1] * toRad);
  const x =
    Math.cos(a[1] * toRad) * Math.sin(b[1] * toRad) -
    Math.sin(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.cos((b[0] - a[0]) * toRad);
  return (Math.atan2(y, x) / toRad + 360) % 360;
}

/** 曲がり角の言い方。30度未満は曲がりとみなさない */
function turnWord(delta: number): string | null {
  const d = ((delta + 540) % 360) - 180; // -180〜180
  const a = Math.abs(d);
  if (a < 30) return null; // 直進に統合する
  if (a > 150) return "Uターンして";
  if (a > 120) return d > 0 ? "右後方へ" : "左後方へ";
  if (a > 60) return d > 0 ? "右折して" : "左折して";
  return d > 0 ? "右斜め前へ" : "左斜め前へ";
}

/**
 * 経路の節点列から手順の文章を作る。
 *
 * 素直に辿ると「5m直進、右に3度、8m直進…」と細切れになるので、
 * ・30度未満の曲がりは直進に統合
 * ・10m未満の区間は前後にくっつける
 * ・近くの建物名を目印にする
 */
export function buildSteps(
  graph: Graph,
  path: string[],
  data: AppData,
  destName: string,
  lang: Lang = "ja",
): { steps: Step[]; meters: number; minutes: number } {
  const pts = path.map((id) => graph.pos.get(id)!).filter(Boolean);
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += metersBetween(pts[i - 1], pts[i]);

  const round10 = (m: number) => Math.max(10, Math.round(m / 10) * 10);
  const en = lang === "en";
  /** 建物の名前。英語のときは言い換える */
  const nm = (s: string) => (s ? placeName(lang, s) : s);

  const format = (s: Step) => {
    const m = round10(s.meters);
    if (!en) {
      return s.inside
        ? `${s.landmark}の中を ${s.turn}${m}m 進む`
        : `${s.landmark ? `${s.landmark}の角を ` : ""}${s.turn}${m}m 進む`;
    }
    // 英語は「どこで」「どう曲がって」「何m」の順にする
    const where = s.inside
      ? `Inside ${nm(s.landmark)}, `
      : s.landmark
        ? `At ${nm(s.landmark)}, `
        : "";
    return `${where}${s.turn}go ${m} m`;
  };

  /*
   * 各点が、どの建物の中にあるか（外なら空）。
   *
   * 建物の中を通る道すじが引いてあっても、案内の文では外と区別が
   * つかなかった。入る・出るをはさみ、中を進む区間は言い方を変える。
   */
  const inB = pts.map((p) => insideBuilding(p, data));

  const steps: Step[] = [];

  if (pts.length >= 2) {
    let segStart = 0;
    let prevB = bearing(pts[0], pts[1]);
    // 最初の区間だけは方角で言う（「北へ 60m」）
    const heading = (b: number) =>
      en
        ? `head ${COMPASS_EN[Math.round(b / 45) % 8]} and `
        : `${COMPASS[Math.round(b / 45) % 8]}へ `;
    let segTurn = heading(prevB);

    /** segStart〜endIdx をひとつの手順にまとめて積む */
    const emit = (endIdx: number, nextTurn: string) => {
      let m = 0;
      for (let i = segStart + 1; i <= endIdx; i++) m += metersBetween(pts[i - 1], pts[i]);
      if (m >= 1) {
        const last = steps[steps.length - 1];
        if (m < 10 && last && !last.door) {
          // 10m未満の区間は独立させず、直前の手順に足す。
          // ただし出入りの手順には足さない（その文が消えてしまう）
          last.meters += m;
          last.text = format(last);
        } else {
          const here = inB[segStart];
          const s: Step = {
            turn: segTurn,
            meters: m,
            landmark: here || nearLandmark(pts[segStart], data),
            inside: !!here,
            door: false,
            text: "",
          };
          s.text = format(s);
          steps.push(s);
        }
      }
      segStart = endIdx;
      segTurn = nextTurn;
    };

    for (let i = 1; i < pts.length - 1; i++) {
      // 建物の内と外が入れ替わるところで区切り、出入りを1手順として挟む
      if (inB[i] !== inB[i - 1]) {
        emit(i, "");
        const name = inB[i] || inB[i - 1];
        steps.push({
          turn: "",
          meters: 0,
          landmark: name,
          inside: !!inB[i],
          door: true,
          text: en
            ? inB[i]
              ? `Enter ${nm(name)}`
              : `Leave ${nm(name)}`
            : inB[i]
              ? `${name} に入る`
              : `${name} から出る`,
        });
        // 区切った直後は、また方角で言い直す
        segTurn = heading(bearing(pts[i], pts[i + 1]));
      }
      const b = bearing(pts[i], pts[i + 1]);
      const word = turnWord(b - prevB);
      if (word) emit(i, en ? (TURN[word] ?? word) : word); // 30度以上曲がるところで区切る
      prevB = b;
    }
    emit(pts.length - 1, "");
  }

  steps.push({
    turn: "",
    meters: 0,
    landmark: "",
    inside: false,
    door: true,
    text: en ? `Arrive at ${destName}` : `${destName} に到着`,
  });

  return {
    steps,
    meters: Math.round(total),
    // 分速80m（不動産表示の基準）。切り上げ
    minutes: Math.max(1, Math.ceil(total / 80)),
  };
}

/**
 * その点が入っている建物の名前。外なら空。
 *
 * 建物の中を通る道すじを、案内の文で言い分けるために使う。
 * 点が輪の内側かどうかを、辺との交差の数で決める（奇数なら内側）。
 */
function insideBuilding(at: Position, data: AppData): string {
  for (const b of data.buildings.features) {
    const ring = b.geometry.coordinates[0];
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > at[1] !== yj > at[1] && at[0] < ((xj - xi) * (at[1] - yi)) / (yj - yi) + xi) {
        hit = !hit;
      }
    }
    if (hit) return b.properties.name || (b.properties.code ? `${b.properties.code}号館` : "");
  }
  return "";
}

/** 指定した点の近くにある建物名。50m以内でいちばん近いもの */
function nearLandmark(at: Position, data: AppData): string {
  let best = "";
  let bestD = 50;
  for (const b of data.buildings.features) {
    const ring = b.geometry.coordinates[0];
    for (const v of ring) {
      const d = metersBetween(at, v);
      if (d < bestD) {
        bestD = d;
        best = b.properties.name || (b.properties.code ? `${b.properties.code}号館` : "");
      }
    }
  }
  return best;
}
