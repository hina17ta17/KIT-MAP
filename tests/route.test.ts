/**
 * 道案内の計算（lib/route.ts）。
 *
 * 前半は、点が数個だけの小さな網で、決まりどおりに動くかを見る。
 * 後半は、本物の地図データ（public/data/）で、README に書いた数と性質が本当かを見る。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AppData } from "@/lib/appdata";
import { buildGraph, findBestPath, findPath, nearestNode, type Graph } from "@/lib/route";

/* ---------------------------------------------------------------- 小さな網 */

type P = [id: string, lng: number, lat: number, level?: number];
type L = [from: string, to: string, enabled?: boolean];

/** 点と接続から、地図データの形を作る（経路の計算が見る項目だけ） */
function tiny(points: P[], links: L[]): AppData {
  return {
    campus: { type: "FeatureCollection", features: [] },
    buildings: { type: "FeatureCollection", features: [] },
    checkpoints: {
      type: "FeatureCollection",
      features: points.map(([id, lng, lat, level = 1]) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [lng, lat] },
        properties: { id, level, parents: [], kind: "waypoint", name: id, linkedTo: "", radius: 5, note: "" },
      })),
    },
    links: links.map(([from, to, enabled = true], i) => ({
      id: `L-${i}`, from, to, enabled, kind: "walk", roofed: false, note: "",
    })),
    rooms: [],
  } as unknown as AppData;
}

/*
 *   D ─────── E        A→C は下の道（A-B-C）が近い。
 *   │         │        上の道（A-D-E-C）は遠回り。
 *   A ── B ── C
 */
const O = 136.6266; // 構内のあたり
const N = 36.5303;
const POINTS: P[] = [
  ["A", O, N],
  ["B", O + 0.001, N],
  ["C", O + 0.002, N],
  ["D", O, N + 0.001],
  ["E", O + 0.002, N + 0.001],
];
const LINKS: L[] = [["A", "B"], ["B", "C"], ["A", "D"], ["D", "E"], ["E", "C"]];

/** 道すじの長さ（m）。隣どうしの距離を足す */
function lengthOf(g: Graph, path: string[]): number {
  let m = 0;
  for (let i = 1; i < path.length; i++) {
    const e = g.adj.get(path[i - 1])?.find((x) => x.to === path[i]);
    if (!e) throw new Error(`${path[i - 1]} と ${path[i]} はつながっていない`);
    m += e.meters;
  }
  return m;
}

describe("小さな網で", () => {
  it("いちばん短い道を選ぶ", () => {
    const g = buildGraph(tiny(POINTS, LINKS));
    const r = findBestPath(g, ["A"], ["C"]);
    expect(r?.path).toEqual(["A", "B", "C"]);
    // 経度 0.002 度は、この緯度でおよそ 179m
    expect(r?.meters).toBeGreaterThan(170);
    expect(r?.meters).toBeLessThan(190);
  });

  it("案内に使わない区間は通らない", () => {
    const g = buildGraph(tiny(POINTS, LINKS.map(([a, b]): L => [a, b, !(a === "A" && b === "B")])));
    expect(findBestPath(g, ["A"], ["C"])?.path).toEqual(["A", "D", "E", "C"]);
  });

  it("「中を通らない」では、建物の中の点（レベル2以上）を外す", () => {
    const pts = POINTS.map((p): P => (p[0] === "B" ? [p[0], p[1], p[2], 2] : p));
    expect(findBestPath(buildGraph(tiny(pts, LINKS)), ["A"], ["C"])?.path).toEqual(["A", "B", "C"]);
    expect(findBestPath(buildGraph(tiny(pts, LINKS), { outdoorOnly: true }), ["A"], ["C"])?.path)
      .toEqual(["A", "D", "E", "C"]);
  });

  it("出入口が複数あるときは、道なりでいちばん近い組み合わせを選ぶ", () => {
    // 出発側の出入口 A・D、目的側の出入口 C・E。いちばん近いのは D→E（179m）
    const g = buildGraph(tiny(POINTS, LINKS));
    expect(findBestPath(g, ["A", "D"], ["C", "E"])?.path).toEqual(["D", "E"]);
  });

  it("行けないときは null を返す", () => {
    const g = buildGraph(tiny(POINTS, [["A", "B"]]));
    expect(findBestPath(g, ["A"], ["E"])).toBeNull();
    expect(findPath(g, "A", "E")).toBeNull();
    // 網に無い点を渡しても落ちない
    expect(findBestPath(g, ["Z"], ["A"])).toBeNull();
  });

  it("いちばん近い点を探す（遠すぎれば null）", () => {
    const g = buildGraph(tiny(POINTS, LINKS));
    expect(nearestNode(g, [O + 0.00095, N])?.id).toBe("B");
    expect(nearestNode(g, [O + 0.01, N + 0.01], 50)).toBeNull();
  });
});

/* ---------------------------------------------------------------- 本物の地図データ */

const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`../public/data/${name}`, import.meta.url), "utf8"));

function realData(): AppData {
  return {
    campus: read("campus.geojson"),
    buildings: read("buildings.geojson"),
    checkpoints: read("checkpoints.geojson"),
    links: read("links.geojson").features.map((f: { properties: unknown }) => f.properties),
    rooms: [],
  } as AppData;
}

describe("本物の地図データで", () => {
  const data = realData();
  const g = buildGraph(data);
  const ids = [...g.pos.keys()];

  it("README に書いた数（歩ける点 4,177・つながり 4,414）と同じ", () => {
    expect(data.checkpoints.features).toHaveLength(4177);
    expect(data.links).toHaveLength(4414);
  });

  it("すべての点が、つながりだけでひと続きになっている", () => {
    const seen = new Set([ids[0]]);
    const stack = [ids[0]];
    while (stack.length) {
      for (const e of g.adj.get(stack.pop()!) ?? []) {
        if (!seen.has(e.to)) {
          seen.add(e.to);
          stack.push(e.to);
        }
      }
    }
    expect(seen.size).toBe(ids.length);
  });

  it("速い探し方（二分ヒープ）と、素直な探し方（A*）が同じ距離を出す", () => {
    // 毎回同じ組み合わせになるよう、決まった並びの乱数を使う
    let seed = 20260801;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 200; i++) {
      const a = ids[Math.floor(rand() * ids.length)];
      const b = ids[Math.floor(rand() * ids.length)];
      const fast = findBestPath(g, [a], [b]);
      const slow = findPath(g, a, b);
      expect(fast).not.toBeNull();
      expect(slow).not.toBeNull();
      expect(fast!.meters).toBeCloseTo(lengthOf(g, slow!), 6);
      expect(fast!.meters).toBeCloseTo(lengthOf(g, fast!.path), 6);
    }
  });

  it("建物どうしは、どの組み合わせでも道が出る（建物の中も通れる網）", () => {
    const entrances = new Map<string, string[]>();
    for (const c of data.checkpoints.features) {
      const b = c.properties.linkedTo;
      if (b) entrances.set(b, [...(entrances.get(b) ?? []), c.properties.id]);
    }
    const bs = [...entrances.keys()];
    expect(bs.length).toBeGreaterThan(20);
    for (const from of bs) {
      for (const to of bs) {
        if (from !== to) expect(findBestPath(g, entrances.get(from)!, entrances.get(to)!)).not.toBeNull();
      }
    }
  });

  it("「中を通らない」道は、中を通る道より短くならない", () => {
    const out = buildGraph(data, { outdoorOnly: true });
    const outer = [...out.pos.keys()];
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 100; i++) {
      const a = outer[Math.floor(rand() * outer.length)];
      const b = outer[Math.floor(rand() * outer.length)];
      const inside = findBestPath(g, [a], [b]);
      const outside = findBestPath(out, [a], [b]);
      if (outside && inside) expect(outside.meters).toBeGreaterThanOrEqual(inside.meters - 1e-6);
    }
  });
});
