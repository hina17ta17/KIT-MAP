"use client";

/**
 * 作図ツールの、地図と一緒に動く部分。
 *
 * ■ なぜ別の部品にしたか
 *   地図を1コマ動かすたびに、この中の座標を計算し直す必要がある。
 *   これを作図ツール本体に置いていたときは、その1コマごとに
 *   左の一覧（8,000要素あり、その大半は隠れているタブの中）まで
 *   React が作り直していた。実測で1コマ127ms、約8fpsだった。
 *
 *   動くものだけをここに分ける。地図を動かしても、作り直すのは
 *   この部品の中だけで済む。
 *
 * ■ なぜ MapLibre の層を使わないか
 *   この地図では層が絵にならない。建物のソースに不透明度0.9の色を
 *   足しても何も出ないことを確かめてある。だから点も線も敷地も、
 *   ここで SVG と DOM に自前で描く。
 */

import { memo, useEffect, useMemo, useState } from "react";
import type { Map as MlMap } from "maplibre-gl";
import type { Feature, Polygon } from "geojson";
import {
  buildingLabel,
  categoryOf,
  checkpointKindOf,
  isNamed,
  pathKindOf,
  ringCenter,
  type BuildingFeature,
  type CheckpointFeature,
  type MapData,
} from "@/lib/features";

/**
 * 画面に一度に出すCP名の上限。
 *
 * これを超えたら名前は出さない。648個ぜんぶ出していたときは
 * 文字が重なって読めないうえ、描き直しも重かった。
 * 読めない文字のために滑らかさを捨てる意味がない。
 */
const LABEL_MAX = 140;

type Props = {
  map: MlMap | null;
  ready: boolean;
  data: MapData;
  selected: string | null;
  linkFrom: string | null;
  showBuildingLabels: boolean;
  showCpLabels: boolean;
  /** 敷地の外を沈めるか */
  focus: boolean;
};

function EditorOverlayInner({
  map,
  ready,
  data,
  selected,
  linkFrom,
  showBuildingLabels,
  showCpLabels,
  focus,
}: Props) {
  /**
   * MapLibre のレイヤ経由の描画が反映されないため、
   * CPと接続だけは地図の上に SVG を重ねて自前で描く。
   * 地図が動くたびに座標を計算し直す。
   */
  const [viewTick, setViewTick] = useState(0);

  useEffect(() => {
    if (!map || !ready) return;

    /*
     * 描き直しの合図は、1フレームに1回までにまとめる。
     *
     * 指で拡大縮小しているあいだ、MapLibre は move と zoom を
     * どちらも毎フレーム出す。そのまま受けると1フレームに2回、
     * 点と線を全部描き直すことになる。
     */
    let raf = 0;
    const bump = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setViewTick((v) => v + 1);
      });
    };
    for (const ev of ["move", "zoom", "rotate", "resize", "load"] as const) {
      map.on(ev, bump);
    }
    bump();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      for (const ev of ["move", "zoom", "rotate", "resize", "load"] as const) {
        map.off(ev, bump);
      }
    };
  }, [map, ready]);

  /**
   * 画面座標に変換したCPと接続。viewTick が変わるたびに作り直す。
   *
   * 画面の外にあるものは省く。以前は持っている点と線を全部描いていたため、
   * 648点・729本では毎フレーム 2,900 個ほどの図形を組み直していた。
   * 寄って作業しているときは、そのほとんどが画面の外にある。
   *
   * 線は「両端とも画面の外」のときだけ省く。片方でも入っていれば、
   * 画面をまたぐ線として描く必要がある。
   */
  const overlay = useMemo(() => {
    if (!map || !ready) return null;
    void viewTick; // 地図が動いたら作り直すための依存

    const box = map.getContainer();
    // 少しはみ出したところまで描く。端で線が切れて見えないように
    const M = 200;
    const W = box.clientWidth + M;
    const H = box.clientHeight + M;
    const onScreen = (p: { x: number; y: number }) =>
      p.x > -M && p.y > -M && p.x < W && p.y < H;

    const all = data.checkpoints.features as CheckpointFeature[];
    const pos = new Map<string, { x: number; y: number }>();
    const cps: CheckpointFeature[] = [];
    for (const c of all) {
      const [lon, lat] = c.geometry.coordinates;
      const q = map.project([lon, lat]);
      const p = { x: q.x, y: q.y };
      // 線を引くには画面外の端点の座標も要るので、位置は全部覚えておく
      pos.set(c.properties.id, p);
      if (onScreen(p)) cps.push(c);
    }

    const lines = data.links.flatMap((l) => {
      const a = pos.get(l.from);
      const b = pos.get(l.to);
      if (!a || !b) return [];
      if (!onScreen(a) && !onScreen(b)) return [];
      return [{ l, a, b }];
    });

    const hier = all.flatMap((c) =>
      c.properties.parents.flatMap((pid) => {
        const a = pos.get(pid);
        const b = pos.get(c.properties.id);
        if (!a || !b) return [];
        if (!onScreen(a) && !onScreen(b)) return [];
        return [{ a, b, key: `${pid}-${c.properties.id}` }];
      }),
    );

    /*
     * 敷地の輪を画面の座標に直す。
     *
     * 画面の外に出た角も落とさない。輪は閉じた形なので、
     * 途中の点を抜くと形が変わってしまう。点数は数十なので数えても軽い。
     */
    const campus = (data.campus.features as Feature<Polygon, unknown>[]).flatMap((f) =>
      f.geometry.coordinates.map((ring) =>
        ring.map((p) => {
          const q = map.project(p as [number, number]);
          return { x: q.x, y: q.y };
        }),
      ),
    );

    /* 建物のラベルの位置。画面から外れたものは持たない */
    const bLabels = (data.buildings.features as BuildingFeature[]).flatMap((f) => {
      const q = map.project(ringCenter(f.geometry.coordinates[0]) as [number, number]);
      if (!onScreen(q)) return [];
      return [{ f, x: q.x, y: q.y }];
    });

    return {
      cps,
      pos,
      lines,
      hier,
      campus,
      bLabels,
      w: box.clientWidth,
      h: box.clientHeight,
    };
  }, [
    data.checkpoints.features,
    data.links,
    data.campus.features,
    data.buildings.features,
    map,
    ready,
    viewTick,
  ]);

  /**
   * 見た目の同じものを、1本の <path> にまとめる。
   *
   * 以前は接続1本ごとに <g> と <line> 2本、CP1つごとに <circle> を作っていた。
   * 648点・729本では 2,900 個ほどになり、地図を動かすたびに
   * その全部を組み直していた。点や線を増やすほど重くなる作りだった。
   *
   * 描く中身は同じでも、まとめてしまえば十数個で済む。
   * 線の形は「M 始点 L 終点」を並べるだけ、丸は円弧2つで描ける。
   */
  const shapes = useMemo(() => {
    if (!overlay) return null;
    const xy = (p: { x: number; y: number }) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
    const seg = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      `M${xy(a)}L${xy(b)}`;

    /*
     * 敷地。
     *
     *   campusD  … 輪をつないだ一本の道すじ。縁を描くのに使う
     *   outsideD … 画面いっぱいの四角に、その輪を穴として空けたもの。
     *              fill-rule="evenodd" で、輪の内側だけが塗り残される。
     *              敷地の外だけを沈められる
     *   corners  … 打った角。最後の点は最初と同じなので落とす
     */
    const campusD = overlay.campus
      .map((ring) => ring.map((p, i) => (i === 0 ? `M${xy(p)}` : `L${xy(p)}`)).join("") + "Z")
      .join("");
    const outsideD = campusD ? `M0 0H${overlay.w}V${overlay.h}H0Z${campusD}` : "";
    const corners = overlay.campus.flatMap((ring) =>
      ring.length > 1 ? ring.slice(0, -1) : ring,
    );

    /* 接続。縁取りは太さごと、中身は色と太さと点線の別ごとにまとめる */
    const casing = new Map<number, string[]>();
    const core = new Map<string, { color: string; width: number; dash?: string; d: string[] }>();
    for (const { l, a, b } of overlay.lines) {
      const k = pathKindOf(l.kind);
      const w = k.width + 2.5;
      const s = seg(a, b);

      const cw = w + 4;
      const c = casing.get(cw);
      if (c) c.push(s);
      else casing.set(cw, [s]);

      const color = l.id === selected ? "#f97316" : !l.enabled ? "#94a3b8" : k.color;
      const dash = l.enabled ? undefined : "6 4";
      const key = `${color}|${w}|${dash ?? ""}`;
      const g = core.get(key);
      if (g) g.d.push(s);
      else core.set(key, { color, width: w, dash, d: [s] });
    }

    /* チェックポイント。選んでいるものだけは上に重ねたいので分けておく */
    const dots = new Map<string, { fill: string; stroke: string; d: string[] }>();
    const picked: { key: string; x: number; y: number }[] = [];
    for (const c of overlay.cps) {
      const p = overlay.pos.get(c.properties.id);
      if (!p) continue;
      if (c.properties.id === selected || c.properties.id === linkFrom) {
        picked.push({ key: c.properties.id, x: p.x, y: p.y });
        continue;
      }
      const k = checkpointKindOf(c.properties.kind);
      const first = c.properties.level === 1;
      const r = first ? 6 : 4.5;
      const fill = k.color;
      const stroke = first ? "#ffffff" : "#7c3aed";
      // 円弧を2つつないで丸を描く
      const d = `M${(p.x - r).toFixed(1)} ${p.y.toFixed(1)}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0`;
      const key = `${fill}|${stroke}|${r}`;
      const g = dots.get(key);
      if (g) g.d.push(d);
      else dots.set(key, { fill, stroke, d: [d] });
    }

    /*
     * ラベル。
     *
     * 画面に出ているものだけを作る。さらに、出しすぎると重くなるうえ、
     * 文字が重なって読めなくなるので数で打ち切る。
     * 打ち切ったときも、いま選んでいるものだけは出す。
     * 何を押したのか分からなくなるため。
     */
    const many = overlay.cps.length > LABEL_MAX;
    const cpLabels = overlay.cps.flatMap((c) => {
      const on = c.properties.id === selected || c.properties.id === linkFrom;
      if (many && !on) return [];
      const p = overlay.pos.get(c.properties.id);
      if (!p) return [];
      const k = checkpointKindOf(c.properties.kind);
      return [
        {
          key: c.properties.id,
          text: c.properties.name || c.properties.id,
          x: p.x,
          y: p.y - 14,
          bg: on ? "#ea580c" : "rgba(255,255,255,0.92)",
          border: on ? "#ea580c" : k.color,
          color: on ? "#ffffff" : k.color,
        },
      ];
    });

    const bLabels = overlay.bLabels.map(({ f, x, y }) => {
      const cat = categoryOf(f.properties.category);
      const named = isNamed(f.properties);
      return {
        key: f.properties.tempId,
        text: buildingLabel(f.properties),
        x,
        y,
        // 名称が入っているものは種別色で塗り、未入力のものは白地にして区別する
        bg: named ? cat.color : "rgba(255,255,255,0.7)",
        border: cat.lineColor,
        color: named ? cat.textColor : cat.lineColor,
      };
    });

    return {
      campusD,
      outsideD,
      corners,
      cpLabels,
      bLabels,
      cpLabelsCut: many ? overlay.cps.length : 0,
      hier: overlay.hier.map(({ a, b }) => seg(a, b)).join(""),
      casing: [...casing].map(([width, d]) => ({ width, d: d.join("") })),
      core: [...core].map(([key, g]) => ({ key, color: g.color, width: g.width, dash: g.dash, d: g.d.join("") })),
      dots: [...dots].map(([key, g]) => ({ key, fill: g.fill, stroke: g.stroke, d: g.d.join("") })),
      picked,
    };
  }, [overlay, selected, linkFrom]);

  return (
    <>
      {/* CPと接続を地図の上に直接描く。MapLibre のレイヤに依存しない */}
      {shapes && (
        <svg
          className="pointer-events-none absolute inset-0"
          style={{ zIndex: 5 }}
          width="100%"
          height="100%"
        >
          {/*
            敷地。いちばん下に敷く。
            上に置くと、縁の白い下地が敷地ぎわのCPを覆ってしまう。
          */}
          {shapes.campusD && (
            <>
              {/* 外を沈める。敷地の中だけ写真がそのまま見える */}
              {focus && (
                <path d={shapes.outsideD} fillRule="evenodd" fill="#0f172a" opacity={0.55} />
              )}
              {/* にじみ。遠目でも緑の帯として気づける */}
              {focus && (
                <path
                  d={shapes.campusD}
                  fill="none"
                  stroke="#22c55e"
                  strokeWidth={18}
                  opacity={0.35}
                  strokeLinejoin="round"
                />
              )}
              {/* 白い下地。写真の明暗にかかわらず縁が立つ */}
              <path
                d={shapes.campusD}
                fill="none"
                stroke="#ffffff"
                strokeWidth={8}
                opacity={0.95}
                strokeLinejoin="round"
              />
              {/* 本線。破線にして通路の線と見分ける */}
              <path
                d={shapes.campusD}
                fill="none"
                stroke="#15803d"
                strokeWidth={4}
                strokeDasharray="12 7"
                strokeLinejoin="round"
              />
              {/* 打った角 */}
              {shapes.corners.map((p, i) => (
                <circle
                  key={i}
                  cx={p.x}
                  cy={p.y}
                  r={4.5}
                  fill="#ffffff"
                  stroke="#15803d"
                  strokeWidth={2.5}
                />
              ))}
            </>
          )}

          {/* 親子関係。通らないと入れない道すじ */}
          {shapes.hier && (
            <path
              d={shapes.hier}
              fill="none"
              stroke="#7c3aed"
              strokeWidth={2.5}
              strokeDasharray="4 3"
            />
          )}

          {/* 接続。案内が通る区間。
              濃紺の縁取りを先に全部敷いてから中身を描く。写真の上でも見える */}
          {shapes.casing.map((g) => (
            <path
              key={g.width}
              d={g.d}
              fill="none"
              stroke="#0f172a"
              strokeWidth={g.width}
              strokeLinecap="round"
              opacity={0.9}
            />
          ))}
          {shapes.core.map((g) => (
            <path
              key={g.key}
              d={g.d}
              fill="none"
              stroke={g.color}
              strokeWidth={g.width}
              strokeLinecap="round"
              strokeDasharray={g.dash}
            />
          ))}

          {/* チェックポイント。選んでいるものは最後に描いて隠れないようにする */}
          {shapes.dots.map((g) => (
            <path key={g.key} d={g.d} fill={g.fill} stroke={g.stroke} strokeWidth={2.5} />
          ))}
          {shapes.picked.map((p) => (
            <circle
              key={p.key}
              cx={p.x}
              cy={p.y}
              r={9}
              fill="#ea580c"
              stroke="#ea580c"
              strokeWidth={2.5}
            />
          ))}
        </svg>
      )}

      {/*
        ラベル。MapLibre のマーカーは使わない。
        マーカーは画面の外にあるものまで含めて、1コマごとに全部の位置を
        書き換える。ここでは画面に出ているものだけを置く。
      */}
      {shapes && (
        <div className="pointer-events-none absolute inset-0 overflow-hidden" style={{ zIndex: 6 }}>
          {showBuildingLabels &&
            shapes.bLabels.map((l) => (
              <div
                key={l.key}
                className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] font-bold leading-none shadow-sm"
                style={{
                  left: l.x,
                  top: l.y,
                  backgroundColor: l.bg,
                  borderColor: l.border,
                  color: l.color,
                }}
              >
                {l.text}
              </div>
            ))}
          {showCpLabels &&
            shapes.cpLabels.map((l) => (
              <div
                key={l.key}
                className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded border px-1 py-0.5 text-[10px] font-bold leading-none shadow-sm"
                style={{
                  left: l.x,
                  top: l.y,
                  backgroundColor: l.bg,
                  borderColor: l.border,
                  color: l.color,
                }}
              >
                {l.text}
              </div>
            ))}
        </div>
      )}

      {/* 名前を伏せたときは、その理由を出す。押しても出ないと故障に見える */}
      {showCpLabels && shapes && shapes.cpLabelsCut > 0 && (
        <div className="pointer-events-none absolute bottom-6 left-1/2 z-10 -translate-x-1/2 rounded-full bg-slate-900/85 px-3 py-1.5 text-[11px] font-bold text-white shadow-lg">
          CP名は伏せています（画面に {shapes.cpLabelsCut} 個・拡大すると出ます）
        </div>
      )}
    </>
  );
}

export const EditorOverlay = memo(EditorOverlayInner);
