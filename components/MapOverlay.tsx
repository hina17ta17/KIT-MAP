"use client";

/**
 * 地図の上に重ねる、動く部分だけをまとめたもの。
 *
 * ■ なぜ分けたか
 *   地図を動かすと毎フレーム描き直しが要る。以前はその合図を
 *   案内画面（2,200行）が受けていたので、指を動かしているあいだじゅう
 *   検索欄・建物一覧・サイドバー・経路の案内文まで、画面のすべてを
 *   毎フレーム組み直していた。動くのは名前と線だけなのに、
 *   関係のない部分まで作り直していたことになる。
 *
 *   合図をこちらで受け取るようにすれば、地図を動かしても
 *   組み直すのはこの中だけで済む。
 *
 * ■ 描き方
 *   MapLibre のレイヤは使わず、map.project() で画面の位置に直して
 *   SVG と div を重ねる。レイヤ経由だと描画に反映されないことがあったため。
 */

import { memo, useEffect, useMemo, useState, type RefObject } from "react";
import type { Map as MlMap } from "maplibre-gl";
import type { Position } from "geojson";
import { categoryOf } from "@/lib/features";
import type { AppData, SearchHit } from "@/lib/appdata";
import type { Graph } from "@/lib/route";

/** 精度がこれ以下なら、現在地の点をはっきり出す */
const ACC_TRUST = 20;

/** 画面の上での名前の置き場所。左上を起点にした四角 */
export type LabelBox = { x: number; y: number; w: number; h: number };

/**
 * 名前がどれだけの場所を取るかの見積もり。
 *
 * 本当の幅は描いてみないと分からないが、毎回測ると描き直しが増える。
 * 11px の太字なら、全角はほぼ文字の高さ分、半角はその6割ほどの幅になる。
 * 左右の余白 16px を足したものを、その名前の占める幅とみなす。
 */
export function labelBox(text: string, x: number, y: number): LabelBox {
  let w = 16;
  for (const ch of text) w += /[ -~｡-ﾟ]/.test(ch) ? 6.6 : 11;
  const h = 19;
  return { x: x - w / 2, y: y - h / 2, w, h };
}

/** 二つの名前がぶつかるか。詰まって見えないよう少し隙間を見込む */
function overlaps(a: LabelBox, b: LabelBox, gap = 3): boolean {
  return (
    a.x < b.x + b.w + gap &&
    b.x < a.x + a.w + gap &&
    a.y < b.y + b.h + gap &&
    b.y < a.y + a.h + gap
  );
}

/**
 * リングの平均座標。名前の置き場所に使う（厳密な重心でなくてよい）。
 *
 * 末尾は最初の点の繰り返しなので外す。含めるとその一点だけ二重に数えられ、
 * 名前の位置がそちらへ寄る。
 */
function centroid(ring: Position[]): Position {
  const pts = ring.slice(0, -1);
  const s = pts.reduce<[number, number]>((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0]);
  return [s[0] / pts.length, s[1] / pts.length];
}

/** メートルを画面上の長さに直す。誤差の円を実距離で描くため */
function radiusPx(map: MlMap, at: Position, meters: number): number {
  const a = map.project([at[0], at[1]]);
  const b = map.project([at[0], at[1] + meters / 111320]);
  return Math.abs(a.y - b.y);
}

/**
 * 押されたときに見る、名前の位置と大きさ。
 *
 * 位置は画面の点ではなく緯度経度で持つ。画面の点で持つと、
 * 地図が動いているあいだ（建物を押して寄っている最中など）に
 * 一つ前の描画のときの位置が残り、押した先がずれる。
 * 押された時点で緯度経度から画面の点へ直せば、必ず今の位置になる。
 *
 * 幅と高さも持つ。中心からの距離だけで見ていたころは、
 * 「金沢工業大学前バス停」のような長い名前の端を押しても届かなかった。
 */
export type LabelHit = {
  id: string;
  label: string;
  ring: Position[];
  /** 名前を置いている場所（緯度経度） */
  at: Position;
  w: number;
  h: number;
};

type Props = {
  map: MlMap | null;
  ready: boolean;
  data: AppData | null;
  /** 経路。error のときは描かない */
  route:
    | { path: string[]; goal: { geometry: { coordinates: Position } }; startId: string }
    | { error: string }
    | null;
  graph: Graph | null;
  fix: { pos: Position; accuracy: number } | null;
  /** 守備範囲より遠い。現在地を出さない */
  tooFar: boolean;
  /** 方位。分からなければ null */
  heading: number | null;
  /** 目立たせる建物 */
  highlight: Set<string>;
  /** 建物の広さ。大きいものから場所を取る */
  areaOf: Map<string, number>;
  /** 出発地として押されている建物 */
  pickedFrom: SearchHit | null;
  /** 遠くの場所を出し始める縮尺 */
  zoomOnlyAt: number;
  /** 寄ったときだけ出す名前 */
  zoomOnlyNames: Set<string>;
  /** 名前の言い換え（英語表示） */
  placeName: (s: string) => string;
  /** 短い語の言い換え */
  t: (s: string) => string;
  /** 押された判定に使う位置。呼び出し元が読む */
  hitRef: RefObject<LabelHit[]>;
};

function MapOverlayInner({
  map,
  ready,
  data,
  route,
  graph,
  fix,
  tooFar,
  heading,
  highlight,
  areaOf,
  pickedFrom,
  zoomOnlyAt,
  zoomOnlyNames,
  placeName,
  t,
  hitRef,
}: Props) {
  const [tick, setTick] = useState(0);

  /*
   * 描き直しの合図。1フレームに1回までにまとめる。
   *
   * 指で拡大縮小しているあいだ、MapLibre は move と zoom を
   * どちらも毎フレーム出す。そのまま受けると1フレームに2回になる。
   */
  useEffect(() => {
    if (!map) return;
    let raf = 0;
    const bump = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setTick((v) => v + 1);
      });
    };
    const events = ["move", "zoom", "rotate", "resize", "load"] as const;
    for (const ev of events) map.on(ev, bump);
    bump();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      for (const ev of events) map.off(ev, bump);
    };
  }, [map]);

  const view = useMemo(() => {
    if (!map || !ready || !data) return null;
    void tick;
    const p = (c: Position) => {
      const q = map.project([c[0], c[1]]);
      return { x: q.x, y: q.y };
    };

    /*
     * 建物は枠線を描かず、名前だけ地図に置く。
     *
     * 縮尺を下げると名前どうしが画面の上で重なって読めなくなる。
     * 大事なものから順に場所を取っていき、すでに置いた名前と
     * ぶつかるものは出さない。拡大すれば場所が空いて出てくる。
     */
    const canvas = map.getContainer();
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    const zoom = map.getZoom();

    const taken: LabelBox[] = [];
    const buildings: {
      f: NonNullable<AppData["buildings"]["features"][number]>;
      c: { x: number; y: number };
      at: Position;
      box: LabelBox;
    }[] = [];

    const cands = data.buildings.features
      .map((f) => {
        const at = centroid(f.geometry.coordinates[0]);
        return {
          f,
          at,
          c: p(at),
          text: f.properties.name || f.properties.code || "",
        };
      })
      // 画面の外は判定にも描画にも要らない。少しはみ出す分だけ余裕を持たせる
      .filter(
        (x) =>
          x.text &&
          (zoom >= zoomOnlyAt || !zoomOnlyNames.has(x.f.properties.name ?? "")) &&
          x.c.x > -80 &&
          x.c.y > -40 &&
          x.c.x < W + 80 &&
          x.c.y < H + 40,
      )
      .sort((a, b) => {
        // 選んでいる建物と経路の両端は、何を押したか分からなくなるので必ず出す
        const ah = highlight.has(a.f.properties.tempId) ? 1 : 0;
        const bh = highlight.has(b.f.properties.tempId) ? 1 : 0;
        if (ah !== bh) return bh - ah;
        // あとは大きい建物から。小さな小屋より号館の方が目印になる
        return (areaOf.get(b.f.properties.tempId) ?? 0) - (areaOf.get(a.f.properties.tempId) ?? 0);
      });

    for (const x of cands) {
      const box = labelBox(x.text, x.c.x, x.c.y);
      if (taken.some((tk) => overlaps(tk, box))) continue;
      taken.push(box);
      buildings.push({ f: x.f, c: x.c, at: x.at, box });
    }

    const drawn = route && !("error" in route) ? route : null;
    return {
      buildings,
      routePts: drawn && graph ? drawn.path.map((id) => p(graph.pos.get(id)!)) : [],
      goal: drawn ? p(drawn.goal.geometry.coordinates) : null,
      start: drawn && graph ? p(graph.pos.get(drawn.startId)!) : null,
      // 守備範囲より遠くにいる人の点は打たない
      me: fix && !tooFar ? p(fix.pos) : null,
      meR: fix && !tooFar ? radiusPx(map, fix.pos, fix.accuracy) : 0,
    };
  }, [map, ready, data, tick, route, graph, fix, tooFar, highlight, areaOf, zoomOnlyAt, zoomOnlyNames]);

  /* 押されたときに見る値を、毎回の描画で入れ直す */
  hitRef.current =
    view?.buildings.map(({ f, at, box }) => ({
      id: f.properties.tempId,
      label: f.properties.name || f.properties.code,
      ring: f.geometry.coordinates[0],
      at,
      w: box.w,
      h: box.h,
    })) ?? [];

  if (!view) return null;
  const routeLine = view.routePts.map((q) => `${q.x},${q.y}`).join(" ");

  return (
    <>
      {/* 経路・現在地・目的地 */}
      <svg
        className="pointer-events-none absolute inset-0"
        style={{ zIndex: 5 }}
        width="100%"
        height="100%"
      >
        {/* 経路。薄い青を4枚重ねて、光っているように見せる */}
        {view.routePts.length > 1 && (
          <>
            <polyline points={routeLine} fill="none" stroke="#7dd3fc" strokeWidth={30} strokeOpacity={0.18} strokeLinecap="round" strokeLinejoin="round" />
            <polyline points={routeLine} fill="none" stroke="#7dd3fc" strokeWidth={20} strokeOpacity={0.3} strokeLinecap="round" strokeLinejoin="round" />
            <polyline points={routeLine} fill="none" stroke="#bae6fd" strokeWidth={12} strokeOpacity={0.65} strokeLinecap="round" strokeLinejoin="round" />
            <polyline points={routeLine} fill="none" stroke="#38bdf8" strokeWidth={6} strokeOpacity={0.95} strokeLinecap="round" strokeLinejoin="round" />
          </>
        )}

        {view.start && (
          <circle cx={view.start.x} cy={view.start.y} r={8} fill="#ffffff" stroke="#38bdf8" strokeWidth={4} />
        )}

        {view.me && (
          <>
            <circle cx={view.me.x} cy={view.me.y} r={view.meR} fill="#38bdf8" fillOpacity={0.12} />
            <circle
              cx={view.me.x}
              cy={view.me.y}
              r={9}
              fill="#38bdf8"
              stroke="#ffffff"
              strokeWidth={3.5}
              opacity={fix && fix.accuracy <= ACC_TRUST ? 1 : 0.55}
            />

            {/* 向いている方角。地図を回していても正しい方角を指すよう、地図の向きを差し引く */}
            {heading != null && (
              <g transform={`translate(${view.me.x},${view.me.y}) rotate(${heading - (map?.getBearing() ?? 0)})`}>
                <path d="M -13 -16 A 20 20 0 0 1 13 -16 L 0 -40 Z" fill="#38bdf8" opacity={0.22} />
                <path d="M 0 -20 L 7 -8 L 0 -11 L -7 -8 Z" fill="#38bdf8" stroke="#ffffff" strokeWidth={2} strokeLinejoin="round" />
              </g>
            )}
          </>
        )}

        {/* 目的地。ひと目で分かるよう、赤いピンを大きく立てる */}
        {view.goal && (
          <g transform={`translate(${view.goal.x},${view.goal.y})`}>
            <ellipse cx={0} cy={1} rx={10} ry={4} fill="#0f172a" opacity={0.28} />
            <path
              d="M0 0 C -7 -13, -18 -22, -18 -34 A 18 18 0 1 1 18 -34 C 18 -22, 7 -13, 0 0 Z"
              fill="#ef4444"
              stroke="#ffffff"
              strokeWidth={3.5}
              strokeLinejoin="round"
            />
            <circle cx={0} cy={-34} r={6.5} fill="#ffffff" />
          </g>
        )}
      </svg>

      {/*
        建物の名前。
        指は地図が受け取るので、こちらは触れないようにしておく。
        left/top ではなく transform で動かす。配置の計算が起きないため。
      */}
      <div className="pointer-events-none absolute inset-0" style={{ zIndex: 6 }}>
        {view.buildings.map(({ f, c }) => {
          const on = highlight.has(f.properties.tempId);
          const cat = categoryOf(f.properties.category);
          const label = f.properties.name || f.properties.code;
          if (!label) return null;
          const from = pickedFrom?.buildingId === f.properties.tempId;
          return (
            <div
              key={f.properties.tempId}
              className={`absolute left-0 top-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold shadow-sm ${
                from
                  ? "bg-blue-600 text-white ring-2 ring-blue-300"
                  : on
                    ? "bg-orange-500 text-white"
                    : "bg-white/85 text-slate-800"
              }`}
              style={{
                transform: `translate3d(${c.x}px, ${c.y}px, 0) translate(-50%, -50%)`,
                borderColor: cat.lineColor,
              }}
            >
              {from && <span className="mr-1 opacity-80">{t("出発")}</span>}
              {placeName(label)}
            </div>
          );
        })}
      </div>
    </>
  );
}

const MapOverlay = memo(MapOverlayInner);
export default MapOverlay;
