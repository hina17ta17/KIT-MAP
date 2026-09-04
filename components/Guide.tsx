"use client";

/**
 * KIT map — 案内画面。
 *
 * 地図のタイルだけ MapLibre に描かせ、建物・経路・現在地は
 * SVG を重ねて自前で描く。MapLibre のレイヤ経由の描画が
 * 反映されない問題があったため、確実に出る方式に寄せてある。
 *
 * 建物の名前は地図に出さない（画面が文字で埋まるため）。
 * 建物の判別は検索と、選択中のハイライトで行う。
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Map as MlMap, NavigationControl, ScaleControl, setWorkerUrl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Position } from "geojson";
import { BASES, GSI_ATTRIBUTION, INITIAL_VIEW } from "@/lib/gsi";
import { type CheckpointFeature } from "@/lib/features";
import {
  loadAppData,
  loadRooms,
  matchesQuery,
  search,
  type AppData,
  type SearchHit,
} from "@/lib/appdata";
import { ROLE_LABEL, ROLE_SHORT, canReadFeedback, canViewCampusInfo, type Role } from "@/lib/auth";
import { LANG_KEY, floorLabelIn, placeName, t, type Lang } from "@/lib/i18n";
import { buildGraph, findBestPath, nearestNode } from "@/lib/route";
import CampusPanel from "./CampusPanel";
import MapOverlay, { type LabelHit } from "./MapOverlay";
import { PerfHud } from "./PerfHud";
import Customize from "./Customize";
import { EMPTY_CUSTOM, colorOf, loadCustom, saveCustom, type Custom } from "@/lib/custom";
import { GROUP_LABEL, compareOrder, orderKey } from "@/lib/order";
import { metersBetween, metersToRing } from "@/lib/geo";
import {
  guessBrowser,
  guessPlatform,
  locationSteps,
  locationStepsEn,
  type BrowserKind,
  type Platform,
} from "@/lib/browser";

/**
 * ここまでを「このアプリの守備範囲」とする距離（メートル）。
 *
 * 敷地のへりから測る。案内できるのは構内だけだが、
 * 駅や周りの停留所から歩いてくる人もいるので、少し外まで見せる。
 *
 * ・現在地は、この中にいるときだけ出す
 * ・地図も、この外へは動かせない
 */
const RANGE_M = 1000;

/*
 * 地図の「別スレッド」の置き場所を、こちらから教える。
 *
 * ■ 教えないとどうなるか（実際に起きていたこと）
 *
 *   MapLibre は、別スレッドで動くファイルの場所を自分で決めている。
 *
 *     let e = import.meta.url;
 *     if (!/^https?:/.test(e)) return "";        ← ここで空になる
 *
 *   Next.js（Turbopack）がひとまとめにすると、import.meta.url は
 *   http で始まる住所ではなくなる。すると空の文字列が返り、
 *
 *     new Worker("", { type: "module" })
 *
 *   になる。空の住所はページ自身を指すので、ブラウザは HTML を
 *   JavaScript として読もうとして失敗する。
 *
 *     Failed to load module script:
 *     The server responded with a non-JavaScript MIME type of "text/html".
 *
 *   別スレッドが立ち上がらないので、地図は読み込みの途中で止まる。
 *   load も来ないから ready が立たず、タイルも建物の名前も出ない。
 *   残るのはボタンだけの「白い地図」。
 *
 *   ★本番のサイトを 6 回続けて開いて、6 回ともこうなっていた。
 *     「たまに白い画面になる」と言われていたものの正体がこれ。
 *
 * ■ 直し方
 *
 *   場所を当てにさせず、こちらから渡す。
 *   ファイルは組み立てのたびに node_modules から public/maplibre/ へ
 *   写している（scripts/copy-maplibre-worker.mjs）。
 *   写しているので、MapLibre を上げても古いものが残らない。
 *
 * ■ ここで呼ぶ理由
 *
 *   地図を作る前に一度だけ効いていればよい。読み込まれた時点で
 *   済ませておけば、あとから作られる地図にも必ず効く。
 */
if (typeof window !== "undefined") {
  setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");
}

/** 精度の扱い。推測で決めず3段階に分ける */
const ACC_TRUST = 20;
const ACC_ROUGH = 50;
/**
 * これだけ動いていなければ、位置が変わったとみなさない（メートル）。
 *
 * 止まっていても衛星の位置は細かく揺れる。その揺れを毎回受け取ると
 * 画面ぜんぶを組み直すことになり、指の操作に割り込む。
 */
const FIX_MIN_MOVE = 2;

/** 現在地からこの距離以内に経路の節点が無ければ案内できない */
const SNAP_MAX = 50;

/**
 * 誤差が大きいときに、節点を探す輪をどこまで広げてよいか（メートル）。
 *
 * 建物の中にいると、いちばん近い通路の節点まで数十m離れる。
 * 50m で切ると節点が見つからず、案内が門からに切り替わってしまう。
 * 誤差の大きさに応じて広げ、ここを上限にする。
 */
const SNAP_MAX_FAR = 150;

/**
 * 構内かどうかを決めるときに、誤差を織り込む上限（メートル）。
 *
 * 建物の中では誤差が数十mに広がり、点が敷地の外へ出る。
 * その誤差ぶんは大目に見るが、際限なく認めるとどこにいても
 * 構内になってしまうので上限を置く。
 */
const CAMPUS_SLACK_MAX = 120;

/* 到着とみなす条件。入口の半径が 5m でも、測位の誤差ぶんは緩める */
/** これより狭くは判定しない */
const ARRIVE_MIN = 20;
/** 誤差が大きくても、これより広くは判定しない */
const ARRIVE_MAX = 60;
/** この時間だけ入り続けたら到着 */
const ARRIVE_HOLD = 3000;
/** 起動時の縮尺。建物を押して寄ったあと、ここへ戻す */
const HOME_ZOOM = 17;

/** お気に入りを覚えておく名前 */
const FAV_KEY = "kitmap.favorites";

/**
 * ラベルを押したとみなす距離（画面の点）。
 *
 * 名前の見た目そのものより広く取る。指の腹は太く、11pxの文字を
 * ぴったり突くのは難しいため。広げすぎると隣を誤って選ぶので、
 * 押した場所にいちばん近いものを1つだけ選ぶ形にしてある。
 */
const TAP_NEAR = 30;

/**
 * 名前の四角から、どれだけ外まで押したとみなすか（画面の点）。
 *
 * 指の腹は太い。文字のふちぴったりを狙わせると外れるので、
 * まわりに少し余裕を持たせる。広げすぎると隣を誤って選ぶため、
 * 重なったときは中心がより近いほうを選ぶ。
 */
const TAP_PAD = 10;

/**
 * 起動時に画面へ収めるときの余白（画面上の点）。
 *
 * 地図の中心と画面の中心は一致しない。上にボタンの列、下に建物一覧の帯が
 * 重なっているので、そのぶんを空けた内側に収める。
 */
const HOME_PAD = { top: 140, bottom: 80, left: 24, right: 24 };


/** 右上の狭い場所に出す用の、短い権限名 */
const SHORT_ROLE = ROLE_SHORT;

/**
 * 起動したときの見え方に戻すボタン。
 *
 * 二本指で回したり傾けたりできるが、戻し方が分からないと
 * そのままになってしまう。向きと傾きだけでなく、場所と縮尺も
 * 起動したときへ戻す。迷ったらこれを押せば必ず元に戻る。
 *
 * MapLibre の部品として足すのは、位置を自前で決めずに済むため。
 * 同じ隅に足したものは足した順に下へ並ぶので、縮尺の下に収まる。
 */
class ResetView {
  private box: HTMLDivElement | null = null;
  private off: (() => void) | null = null;

  /** 押されたときにやること。起動時の枠合わせを外から渡す */
  constructor(private readonly home: () => void) {}

  onAdd(map: MlMap) {
    const box = document.createElement("div");
    box.className = "maplibregl-ctrl maplibregl-ctrl-group";

    const b = document.createElement("button");
    b.type = "button";
    b.title = "起動したときの見え方に戻す";
    b.setAttribute("aria-label", "起動したときの見え方に戻す");
    b.style.cssText =
      "width:29px;height:29px;display:flex;align-items:center;justify-content:center;font-size:15px;line-height:1";

    const arrow = document.createElement("span");
    arrow.textContent = "▲";
    arrow.style.cssText = "display:block;color:#ef4444;transition:transform 120ms linear";
    b.appendChild(arrow);

    // 北がどちらを向いているかを、針の傾きで見せる
    const sync = () => {
      const deg = -map.getBearing();
      arrow.style.transform = `rotate(${deg}deg)`;
      // まっすぐなときは目立たせない
      const straight = Math.abs(map.getBearing()) < 0.5 && Math.abs(map.getPitch()) < 0.5;
      arrow.style.color = straight ? "#94a3b8" : "#ef4444";
    };
    sync();
    map.on("rotate", sync);
    map.on("pitch", sync);
    this.off = () => {
      map.off("rotate", sync);
      map.off("pitch", sync);
    };

    // 場所と縮尺は起動時の枠合わせに任せる。向きと傾きもそこで戻す
    b.onclick = () => this.home();

    box.appendChild(b);
    this.box = box;
    return box;
  }

  onRemove() {
    this.off?.();
    this.box?.remove();
    this.box = null;
  }
}

type Fix = { pos: Position; accuracy: number; at: number };
/** 出発地。現在地か、検索で選んだ場所 */
type Origin = { kind: "me" } | { kind: "place"; hit: SearchHit };

export default function Guide() {
  const boxRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const [ready, setReady] = useState(false);

  const [data, setData] = useState<AppData | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  /**
   * 地図を作り直すための番号。
   *
   * これを進めると、地図を作る処理がもう一度走る。
   * 描く土台（WebGL）が落ちて戻ってきたときに使う。
   */
  const [mapKey, setMapKey] = useState(0);
  /** いま土台が落ちているか。落ちているあいだは、その旨を出す */
  const [glLost, setGlLost] = useState(false);

  const [fix, setFix] = useState<Fix | null>(null);
  /** 向いている方角。真北を0として時計回りの度数。分からなければ null */
  const [heading, setHeading] = useState<number | null>(null);
  /** 方位磁針をもう読み始めたか */
  const compassOn = useRef(false);
  const [geoState, setGeoState] = useState<
    "idle" | "asking" | "on" | "rough" | "denied" | "timeout" | "unavailable" | "insecure"
  >("idle");
  const watchId = useRef<number | null>(null);
  /** 応答が無いまま黙るのを防ぐための見張り */
  const retryTimer = useRef<number | null>(null);
  /** 現在地へ一度寄せたか。やめたら戻す */
  const centeredRef = useRef(false);
  /** 起動時の見え方へ戻す処理。地図の部品から呼ぶので、ここで持ち回す */
  const fitHomeRef = useRef<() => void>(() => {});

  /** 起動時のタイトル画面。0.4秒かけて上下に割れる */
  const [splash, setSplash] = useState<"open" | "closing" | "done">("open");

  const closeSplash = useCallback(() => {
    setSplash((s) => {
      if (s !== "open") return s;
      window.setTimeout(() => setSplash("done"), 400);
      return "closing";
    });
  }, []);

  /** 少し見せてから自動で開く。触れば即座に開く */
  useEffect(() => {
    const t = window.setTimeout(closeSplash, 900);
    return () => clearTimeout(t);
  }, [closeSplash]);
  /** 左のサイドバーを開いているか */
  const [side, setSide] = useState(false);
  /** ログイン画面を開いているか */
  const [login, setLogin] = useState(false);
  /** 一覧から選んで注目している建物 */
  const [focusId, setFocusId] = useState<string | null>(null);
  /** 建物一覧を開いているか */
  const [listOpen, setListOpen] = useState(false);
  /** お気に入りの建物（tempId）。この端末に覚えさせる */
  const [favs, setFavs] = useState<string[]>([]);
  /** 地図の名前を黄色にする判定に使う。毎回作り直さないようまとめておく */
  const favSet = useMemo(() => new Set(favs), [favs]);

  /** 表示の好み（名前の色・付け替え・夜の見え方）。この端末にだけ覚える */
  const [custom, setCustom] = useState<Custom>(EMPTY_CUSTOM);
  const [customOpen, setCustomOpen] = useState(false);
  useEffect(() => {
    setCustom(loadCustom());
  }, []);
  const updateCustom = useCallback((next: Custom) => {
    setCustom(next);
    saveCustom(next);
  }, []);
  const labelColor = useMemo(() => colorOf(custom.color), [custom.color]);
  /** お気に入りを選ぶ画面を開いているか */
  const [favPanel, setFavPanel] = useState(false);
  /** 地図のラベルで最初に押した建物。次に押した建物が目的地になる */
  const [pickedFrom, setPickedFrom] = useState<SearchHit | null>(null);
  /** 表示の言葉。既定は日本語 */
  const [lang, setLang] = useState<Lang>("ja");
  /** 一覧をスワイプで開閉するための、指を置いた位置 */
  const touchY = useRef<number | null>(null);
  /** ログインしている人の権限。未ログインなら null */
  const [role, setRole] = useState<Role | null>(null);
  /** ログインしている人のメールアドレス。未ログインなら null */
  const [email, setEmail] = useState<string | null>(null);
  /** 経路検索のパネルを開いているか */
  const [panel, setPanel] = useState(false);
  const [origin, setOrigin] = useState<Origin>({ kind: "me" });
  const [dest, setDest] = useState<SearchHit | null>(null);
  /** 実際に案内中の組み合わせ。[スタート]を押して確定する */
  const [trip, setTrip] = useState<{ origin: Origin; dest: SearchHit } | null>(null);
  const [arrived, setArrived] = useState(false);
  /** 到着の数え直しを促す合図。現在地が更新されなくても数え終われるように */
  const [recheck, setRecheck] = useState(0);
  const inRangeSince = useRef<number | null>(null);

  /* ---------------- 地図 ---------------- */

  useEffect(() => {
    if (!boxRef.current || mapRef.current) return;
    boxRef.current.innerHTML = "";
    let map: MlMap;
    /** 細かさの上げ下げを片づけるための口 */
    let pixelOff: (() => void) | null = null;
    /** タイルが来なくても名前を出すための、待ちの上限 */
    let readyTimer = 0;
    try {
      map = new MlMap({
        container: boxRef.current,
        center: INITIAL_VIEW.center,
        zoom: HOME_ZOOM,
        maxZoom: 21,
        // これ以上引いても構内の案内には使えない。
        // 引ききった先で二本指を動かすと、地図が受け取らなくなった指の動きを
        // ブラウザがページの拡大とみなしてしまうため、行き止まりを作らない
        minZoom: 15,
        /*
         * 押したとみなす、指のぶれ幅（画面の点）。既定は 3。
         *
         * 3px はマウスを想定した値で、指には狭すぎる。押したつもりでも
         * わずかに滑ると「動かした」と判断され、click そのものが出ない。
         * ラベルを押しても無反応なことがあったのは、これが一因。
         * 8px なら多少ぶれても押したと受け取れ、地図を動かす操作とも混ざらない。
         */
        clickTolerance: 8,
        /*
         * タイルの入れ替わりを、じわっと重ねない。
         *
         * 既定では新しいタイルを 300ms かけて重ねながら出す。
         * 拡大縮小のあいだは縮尺が変わり続けるので、その重ね描きが
         * 毎コマ走り、指の動きに追いつかなくなる。
         * 入れ替わりが少し硬くなるが、動きのほうを取る。
         */
        fadeDuration: 0,
        // 既定の出典表示は畳まれて「ⓘ」ボタンになる。
        // ボタンを消したいが出典表示は地理院タイルの利用条件で必須なので、
        // 自前で「畳まない」ものを付け直して、小さな文字として常時出す。
        attributionControl: false,
        style: {
          version: 8,
          sources: {
            photo: {
              type: "raster",
              tiles: [BASES.photo.url],
              tileSize: BASES.photo.tileSize,
              maxzoom: BASES.photo.maxzoom,
              attribution: GSI_ATTRIBUTION,
            },
          },
          layers: [{ id: "photo", type: "raster", source: "photo" }],
        },
      });
    } catch (err) {
      setFatal(err instanceof Error ? err.message : String(err));
      return;
    }

    // 下の建物一覧に隠れないよう、地図の操作系は右上寄りに置く。
    // 出典表示は MapLibre に任せず自前で出す（一覧に隠れると条件を満たせないため）
    map.addControl(new NavigationControl({ visualizePitch: false }), "top-right");
    map.addControl(new ScaleControl({ maxWidth: 90, unit: "metric" }), "top-right");
    // 縮尺の下に置きたいので、縮尺のあとに足す。
    // 同じ隅に足したものは、足した順に下へ並ぶ。
    // 押されたときの中身は毎回の描画で入れ直すので、常に最新が動く
    map.addControl(new ResetView(() => fitHomeRef.current()), "top-right");

    /* 描き直しの合図は MapOverlay が自分で受け取る。
       ここで受けると、地図を動かすたびに画面ぜんぶを組み直すことになる */

    /*
     * 建物の名前などを出してよい合図。
     *
     * ■ load だけを待ってはいけない
     *
     *   MapLibre の load は、こういう条件で出る。
     *
     *     loaded() = !_styleDirty && !_sourcesDirty && style.loaded()
     *
     *   _sourcesDirty は、タイルが届くまで下りない。
     *   つまり load は「タイルが1枚も来ていないうちは出ない」。
     *
     *   建物の名前・経路・現在地は、こちらが map.project() で
     *   自前に描いている。タイルとは何の関わりもないのに、
     *   load を待っていたせいで、電波が細いところでは
     *   「白いだけで何も出ない画面」になっていた。
     *   構内の端や地下では、これがそのまま起きる。
     *
     * ■ 何を待てばよいか
     *
     *   縮尺と中心は、地図を作った時点で決まっている（transform）。
     *   だから project() は最初から使える。
     *   様子を見るのは styledata まででよく、それすら来なくても
     *   1.5秒たったら出す。出して困るものが無いため。
     *
     *   setReady(true) は何度呼んでも同じなので、来た順に任せる。
     */
    const nowReady = () => setReady(true);
    map.on("load", nowReady);
    map.on("styledata", nowReady);
    if (map.isStyleLoaded()) nowReady();
    // タイルもスタイルも来なくても、名前だけは出す
    readyTimer = window.setTimeout(nowReady, 1500);

    /*
     * ラベルを押した判定。
     *
     * ラベル自身に押させると、その指が地図に届かなくなる。
     * 二本指の片方が乗っただけでピンチが崩れるので、受け取るのは地図にする。
     * 地図は指を滑らせたときには click を出さないので、
     * 地図を動かしたのか押したのかは向こうが見分けてくれる。
     *
     * 名前の「四角」で判定する。以前は中心からの距離だけを見ていたので、
     * 「金沢工業大学前バス停」（幅126px）のような長い名前は、
     * 見えている文字を押しても中心から63px 離れていて届かなかった。
     * 42件のうち11件が、押せない部分を持っていた。
     */
    const pickLabel = (x: number, y: number) => {
      let best: LabelHit | null = null;
      let bestD = Infinity;

      /*
       * 名前の位置は、押されたその時に緯度経度から画面の点へ直す。
       *
       * 一つ前の描画のときの点をそのまま使うと、地図が動いている
       * あいだ（建物を押して寄っている最中、現在地へ寄せている最中など）に
       * 位置がずれ、押しても何も選ばれない。「他の操作中に押せない」の正体。
       */
      const at = hitRef.current.map((h) => {
        const q = map.project([h.at[0], h.at[1]]);
        return { h, x: q.x, y: q.y };
      });

      // ① 名前の四角の中（指の太さぶん外まで）。重なっていたら中心が近いほう
      for (const a of at) {
        const dx = Math.abs(x - a.x) - a.h.w / 2;
        const dy = Math.abs(y - a.y) - a.h.h / 2;
        if (dx > TAP_PAD || dy > TAP_PAD) continue;
        const d = Math.hypot(x - a.x, y - a.y);
        if (d < bestD) {
          bestD = d;
          best = a.h;
        }
      }

      // ② どれにも当たらなければ、近いものを少しだけ拾う
      if (!best) {
        bestD = TAP_NEAR;
        for (const a of at) {
          const d = Math.hypot(x - a.x, y - a.y);
          if (d < bestD) {
            bestD = d;
            best = a.h;
          }
        }
      }

      if (best) tapLabelRef.current(best.id, best.label, best.ring);
    };

    map.on("click", (ev) => pickLabel(ev.point.x, ev.point.y));

    /**
     * 描画面の大きさを測り直す。
     *
     * iOS はアドレスバーの出入りで表示領域の高さが変わる。
     * URLを触って再読み込みしたときなど、地図を作った直後と
     * 実際の高さが食い違い、canvas が画面の半分のまま残ることがある。
     * 取りこぼしを無くすため、複数の合図で測り直す。
     */
    // resize() は "resize" の合図を出すので、重ね描きはそれで作り直される
    const fit = () => {
      map.resize();
    };

    /*
     * 大きさが本当に変わったときだけ測り直す。
     *
     * resize() は canvas の大きさを書き換えるので、そのまま呼び返すと
     * ResizeObserver がまた鳴る。1px でも揺れ続けると、測り直しと
     * 描き直しが延々と往復して止まらなくなる。
     */
    let lastW = 0;
    let lastH = 0;
    const onResize = () => {
      const el = boxRef.current;
      if (!el) return;
      const w = Math.round(el.clientWidth);
      const h = Math.round(el.clientHeight);
      if (w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;
      fit();
    };

    const ro = new ResizeObserver(onResize);
    ro.observe(boxRef.current);
    window.addEventListener("resize", fit);
    window.addEventListener("orientationchange", fit);
    window.visualViewport?.addEventListener("resize", fit);
    // 初回描画のあとレイアウトが確定することがあるので、少し遅らせても測る
    const timers = [80, 300, 900].map((ms) => window.setTimeout(fit, ms));

    /*
     * 描く細かさを、止まっているときと動かしているときで変える。
     *
     *   止まっているとき … 画面の細かさのまま（上限2倍）
     *   動かしているとき … 1倍
     *
     * 端末によっては画面の細かさが3倍ある。そのまま描くと1コマで
     * 9倍の点を塗ることになり、拡大縮小が追いつかない。
     * 上限を2倍にしただけでも 10fps → 57fps になったが、
     * 指を動かしているあいだの引っかかりはまだ残る。
     *
     * 動いている最中は、細かさが落ちても見た目にはほとんど分からない。
     * 指を離した時点で元に戻すので、読むときはくっきりしている。
     */
    /*
     * 描く細かさの上限を2倍までにする。
     *
     * 端末によっては画面の細かさが3倍ある。そのまま描くと1コマで
     * 9倍の点を塗ることになり、拡大縮小が追いつかない。
     * スマホ相当（細かさ3倍・CPU 6分の1）で測ると、
     *   3倍のまま  中央値 100.1ms   10.0 fps
     *   2倍に抑える 中央値  17.5ms   57.1 fps
     * 2倍でも文字と線は十分はっきり見える（一般的な地図アプリと同じ）。
     *
     * 「動かしている間だけ1倍に落とす」も試したが、戻す合図が
     * 当てにならず（moveend も idle も来ないことがある）、
     * 落としたまま戻らなくなった。確かめられた形だけ残す。
     */
    if (typeof window !== "undefined") {
      const still = Math.min(window.devicePixelRatio || 1, 2);
      if (still !== 1) map.setPixelRatio(still);

      /*
       * 指で動かしているあいだは、さらに1倍まで落とす。
       *
       * 上限2倍だけでも 10fps → 57fps になったが、指を動かしている
       * 最中の引っかかりは残っていた（9割点 55.9ms）。
       * 動かしている間だけ1倍にすると 22.8ms まで下がる。
       * 動いている最中は細かさが落ちても見た目には分からない。
       *
       * 合図に地図の move や zoom は使わない。
       * 細かさを変えると地図が測り直しになり、その拍子に move が出る。
       * それをまた合図として拾うので、下げる→戻す→下げる…と回り続け、
       * 結局1倍のまま戻らなくなった（実際にそうなった）。
       *
       * 指やホイールの操作そのものを合図にする。こちらは地図の都合では
       * 出ないので、堂々巡りにならない。戻すのは最後の操作から 350ms 後。
       * タイマーは必ず来るので、落としたままにはならない。
       *
       * ■ 触れた瞬間には落とさない
       *
       * はじめは touchstart でそのまま落としていた。これが
       * 「Chrome で押した感じが悪い」の正体だった。
       *
       * setPixelRatio は中で resize() を呼ぶ。canvas の裏側を作り直す
       * 重い処理で、Chrome では GPU の描画先ごと取り直しになる。
       * ただ押しただけでも、指が触れた瞬間と 400ms 後の二度これが走る。
       * 実際に Chrome（画面3倍・CPU 4分の1）で測ると、
       *   5回押しただけで 18 回 作り直していた。
       * 押しはじめの数コマがそれに食われるので、狙った所に当たらない。
       *
       * ■ 落とすのは「拡大縮小のとき」だけ
       *
       * はじめは、指が動いたら一本指でも落としていた。
       * これも測ってみると、一本指で動かしているだけの最中に
       * _resizeCanvas が出ていた（一本指で動かす30コマ中 12ms）。
       *
       * 一本指で動かすのは、地図としては絵をずらしているだけで重くない。
       * 実測でも 90番目のコマが 20ms、32ms を超えたのは 123コマ中 3コマ。
       * 落とす値打ちがないのに、作り直しの分だけ損をしていた。
       *
       * 重いのは拡大縮小のほう。縮尺が変わると絵を作り直すので、
       * 塗る点の数がそのまま効く。そこでだけ落とす。
       *
       *   ・二本目の指が触れた（＝拡大縮小）
       *   ・ホイールを回した
       *
       * 押すだけ、動かすだけなら作り直しは 0 回。
       * いちばんよく使う二つの操作が、どちらも作り直しなしになる。
       */
      {
        const cv = map.getCanvas();

        /** 最後に動かしてから、細かさを戻すまでの間 */
        const BACK_MS = 350;

        /*
         * ■ 落とすのは「縮尺が動き出してから」
         *
         *   ここは長いあいだ間違えていた。指が触れた時点や、
         *   触れてから 130ms 後に setPixelRatio(1) を呼んでいた。
         *
         *   setPixelRatio は中で map.resize() を呼ぶ。
         *   そして resize() は、地図がまだ動いていないときに
         *   map.stop() を呼ぶ（MapLibre の作り）。
         *   stop() は、いま触っている指の組をぜんぶ捨てる
         *   （HandlerManager.stop → 各 handler.reset）。
         *
         *   つまり「二本指を置いて 130ms」で、
         *   MapLibre が覚えていた二本指の組が消えていた。
         *   そのあとどれだけ指を動かしても、地図は
         *   「二本指の操作」として受け取らない。
         *
         *   実際に測ると、指の間を 300点から 200点まで縮めても
         *   縮尺は 18.000 のまま一つも動かなかった。
         *   指の間が広いほど効きはじめが遅いので、
         *   広く開くと「まったく反応しない」ことになる。
         *
         *   縮尺が動き出したあとなら、resize() は stop() を呼ばない
         *   （地図が動いている最中は止めない作りになっている）。
         *   だから合図を zoom にする。動き出してから落とせば、
         *   指の組は消えないし、軽くしたいのはまさにその最中。
         *
         *   ホイールも zoom を出すので、こちらだけで足りる。
         *   wheel を直に聞くと、上と同じ理由で回しはじめが消える。
         *
         * ■ 戻すのは、指が全部離れてから
         *
         *   戻すときも resize() が走る。指が残っているうちに戻すと、
         *   今度はそこで指の組が消える。長く止めたまま持ち替える人が
         *   いるので、時間だけを見て戻してはいけない。
         */
        let low = false;
        let back = 0;
        /** いま画面に触れている指の数。戻してよいかを決めるのに使う */
        let fingers = 0;
        /** ホイールを回していた時刻。ここまでは人が動かしているとみなす */
        let wheelUntil = 0;

        /*
         * 画面の細かさが 1 倍の端末では、落とす先が無い。
         * それでも setPixelRatio を呼ぶと resize() だけが走って、
         * 何も得ずに作り直すことになる。呼ばない。
         */
        const canDrop = still > 1;

        const later = () => {
          if (back) window.clearTimeout(back);
          back = window.setTimeout(() => {
            back = 0;
            if (!low) return;
            // 指が残っているうちは戻さない。戻すと操作が切れる
            if (fingers > 0) {
              later();
              return;
            }
            low = false;
            setRatio(still);
          }, BACK_MS);
        };

        /**
         * 細かさを変える。そのあいだだけ「操作を止めない」ようにする。
         *
         * ■ なぜ要るか
         *
         *   setPixelRatio は中で map.resize() を呼び、
         *   resize() は map.stop() を呼ぶ。stop() は、いま触っている
         *   指の組をぜんぶ捨てる（handlers.stop → 各 handler.reset）。
         *
         *   はじめは「縮尺が動き出してからなら安全」と考えたが、
         *   実際に測ると違った。指で動かしている最中の縮尺の変化では
         *   MapLibre の _moving は立たないので、resize() はやはり
         *   stop() を呼ぶ。指を置いて最初のひと動きで縮尺が少し動き、
         *   そこで組を捨てられ、あとはどれだけ動かしても効かない
         *   ——これが「拡大縮小できないことがある」の正体だった。
         *
         * ■ どう避けるか
         *
         *   この resize のあいだだけ、handlers.stop を何もしない関数に
         *   すり替える。止めてほしくないのは指の組だけで、
         *   ほかの後始末（絵の作り直し）はそのまま走る。
         *   すり替えは必ず元へ戻す。
         *
         * ■ すり替えられないときは、落とさない
         *
         *   MapLibre の作りが変わって handlers.stop が見つからない版では、
         *   細かさを落とさずに済ませる。少し重くなるだけで、
         *   拡大縮小が効かなくなるよりずっとよい。
         */
        type Handlers = { stop?: (allowEndAnimation?: boolean) => void };
        /*
         * 置き場所は版によって違う。6系は _handlers、それより前は handlers。
         * どちらも無ければ、細かさは触らない（下の canGuard）。
         */
        const m = map as unknown as { _handlers?: Handlers; handlers?: Handlers };
        const handlers = m._handlers ?? m.handlers;
        const canGuard = typeof handlers?.stop === "function";

        const setRatio = (v: number) => {
          if (!canGuard || !handlers) return;
          const real = handlers.stop;
          handlers.stop = () => {};
          try {
            map.setPixelRatio(v);
          } finally {
            handlers.stop = real;
          }
        };

        /**
         * 縮尺が動いた。指かホイールで動かしているときだけ落とす。
         *
         * ★人が動かしているときに限るのが大事。
         *
         *   ラベルを押すと fitBounds で 700ms かけて寄る。これも zoom を出す。
         *   そこで細かさを変えると、中の resize() が
         *   「走っている動き」を止めてしまい、寄る途中で固まる。
         *   上ですり替えているのは指の組のほうで、寄る動きは止まる。
         *
         *   落として得があるのは、人が指で動かし続けている最中だけ。
         *   自分で寄っているぶんは 700ms で終わるので、そのままでよい。
         */
        const onZoom = () => {
          const byHand = fingers >= 2 || Date.now() < wheelUntil;
          if (canDrop && canGuard && byHand && !low) {
            low = true;
            setRatio(1);
          }
          if (byHand) later();
        };

        /** ホイールを回した時刻。ここから少しのあいだは「人が動かしている」 */
        const onWheel = () => {
          wheelUntil = Date.now() + 400;
        };

        /**
         * つまむときの、効きはじめの近さを指の間隔から決める。
         *
         * ■ なぜ要るか
         *
         *   MapLibre は「指の間隔が何割変わったか」で効きはじめを決める
         *   （既定 0.1 ＝ 約 7.2%）。割合なので、指を広く開くほど、
         *   同じ 7.2% を作るのに動かす距離が伸びる。
         *
         *     間隔 100点 →  7点動かせば効く
         *     間隔 340点 → 23点動かさないと効かない
         *
         *   広く開いたときに「反応しない」と感じるのは、これが理由。
         *
         * ■ どう直すか
         *
         *   どの間隔でも、動かす距離がだいたい同じ（6点ほど）になるよう、
         *   指を置いた瞬間の間隔から割合を決め直す。
         *
         *     割合 ≒ 6 ÷ (間隔 × ln2)
         *
         *   狭いときに敏感になりすぎないよう、既定の 0.1 より
         *   きつくはしない。広いときも 0.02 で止める
         *   （それ以下だと、二本指で平行に動かしたときの
         *     わずかなぶれで縮尺が動いてしまう）。
         */
        const tuneThreshold = (e: TouchEvent) => {
          const a = e.touches[0];
          const b = e.touches[1];
          const gap = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
          if (!(gap > 0)) return;
          const want = 6 / (gap * Math.LN2);
          map.touchZoomRotate.setZoomThreshold(Math.min(0.1, Math.max(0.02, want)));
        };

        /**
         * 二本目の指が触れた＝拡大縮小のはじまり。
         *
         * ★走っている動きだけを止める。
         *
         *   ラベルを押すと fitBounds で 700ms かけて寄る。
         *   その途中や直後に指を置くと、地図は自分の動きを続けようとし、
         *   指の動きと引っ張り合う。押しても戻らない、戻ってもまた寄る、
         *   という「反応がとても悪い」感じになる。
         *
         *   ただし stop() は指の組も捨てるので、いつも呼んではいけない。
         *   寄っている最中（isEasing）のときだけにする。
         */
        /*
         * 「いま寄っている最中か」。
         *
         * MapLibre は持っているが、型には出していない。
         * 無い版に当たったときは「寄っていない」として扱う。
         * 止め損ねるだけで済み、指の組を捨てる側には転ばない。
         */
        const easing = () =>
          (map as unknown as { isEasing?: () => boolean }).isEasing?.() === true;

        const onTouchStart = (e: TouchEvent) => {
          fingers = e.touches.length;
          if (e.touches.length < 2) return;
          if (easing()) map.stop();
          tuneThreshold(e);
        };
        const onTouchMove = (e: TouchEvent) => {
          fingers = e.touches.length;
        };
        /* 指を離したら、そこから数えて戻す */
        const onTouchEnd = (e: TouchEvent) => {
          fingers = e.touches.length;
          if (low && fingers === 0) later();
        };

        map.on("zoom", onZoom);
        cv.addEventListener("touchstart", onTouchStart, { passive: true });
        cv.addEventListener("touchmove", onTouchMove, { passive: true });
        cv.addEventListener("wheel", onWheel, { passive: true });
        // 指が地図の外へ出ても必ず受け取れるよう、離す合図は窓で拾う
        window.addEventListener("touchend", onTouchEnd, { passive: true });
        window.addEventListener("touchcancel", onTouchEnd, { passive: true });

        pixelOff = () => {
          if (back) window.clearTimeout(back);
          map.off("zoom", onZoom);
          cv.removeEventListener("touchstart", onTouchStart);
          cv.removeEventListener("touchmove", onTouchMove);
          cv.removeEventListener("wheel", onWheel);
          window.removeEventListener("touchend", onTouchEnd);
          window.removeEventListener("touchcancel", onTouchEnd);
        };
      }
    }

    /*
     * 手元で調べものをするとき用。開発中だけ、窓から地図を触れるようにする。
     * 「動いている判定が戻らない」といった話は、外から中を見ないと分からない。
     */
    if (process.env.NODE_ENV === "development") {
      (window as unknown as { __kitMap?: MlMap }).__kitMap = map;
    }

    /*
     * 描く土台（WebGL）が落ちたときの手当て。
     *
     * ■ 何が起きるか
     *   地図は WebGL で描いている。端末の持ち物が足りなくなると、
     *   ブラウザはこの土台を取り上げる。取り上げられると地図だけが
     *   真っ白になり、そのままでは二度と戻らない。
     *   写真タイルを何百枚も持つ地図では、めずらしくない。
     *   Safari のプライベートモードのように使える量が少ない所では、なおさら。
     *
     * ■ preventDefault が要る
     *   これを呼ばないと、ブラウザは「戻さなくてよい」と判断する。
     *   呼んでおくと、余裕ができたときに戻す合図（restored）をくれる。
     *
     * ■ 戻ったら作り直す
     *   戻ってきた土台に、前の地図の中身は残っていない。
     *   作り直すのがいちばん確実なので、番号を進めて丸ごと組み直す。
     *   出発地・目的地・お気に入りといった、この画面が覚えているものは
     *   地図の外に置いてあるので、作り直しても消えない。
     */
    const cv = map.getCanvas();
    const onLost = (e: Event) => {
      e.preventDefault();
      setGlLost(true);
    };
    const onRestored = () => {
      setGlLost(false);
      setMapKey((k) => k + 1);
    };
    cv.addEventListener("webglcontextlost", onLost);
    cv.addEventListener("webglcontextrestored", onRestored);

    mapRef.current = map;
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", fit);
      window.removeEventListener("orientationchange", fit);
      window.visualViewport?.removeEventListener("resize", fit);
      cv.removeEventListener("webglcontextlost", onLost);
      cv.removeEventListener("webglcontextrestored", onRestored);
      timers.forEach(clearTimeout);
      if (readyTimer) window.clearTimeout(readyTimer);
      pixelOff?.();
      map.remove();
      mapRef.current = null;
    };
  }, [mapKey]);

  /**
   * ページ自体が拡大されるのを止める。
   *
   * iOS の Safari は viewport の `user-scalable=no` を無視する。
   * 二本指の動きが地図に届かなかったとき——引ききった先や、
   * 建物の名前など地図の上に重ねた部品から始めたとき——
   * Safari はそれをページの拡大とみなす。
   * するとページ全体の倍率が上がり、地図はそのままなのに
   * 名前やボタンだけが大きくなる。
   *
   * Safari だけが出すこの合図を断ると、拡大は起きない。
   */
  useEffect(() => {
    const stop = (e: Event) => e.preventDefault();
    const kinds = ["gesturestart", "gesturechange", "gestureend"];
    for (const k of kinds) document.addEventListener(k, stop, { passive: false });
    return () => {
      for (const k of kinds) document.removeEventListener(k, stop);
    };
  }, []);

  /** 起動画面が消えたあとにも測り直す（隠れている間に高さが変わることがある） */
  useEffect(() => {
    if (splash !== "done") return;
    const t = window.setTimeout(() => {
      // resize() が合図を出すので、重ね描きはそれで作り直される
      mapRef.current?.resize();
    }, 60);
    return () => clearTimeout(t);
  }, [splash]);

  useEffect(() => {
    void loadAppData().then(setData);
  }, []);

  /* お気に入りと言葉は端末に覚えさせる。ログインしなくても使えるようにするため */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(FAV_KEY);
      if (raw) setFavs(JSON.parse(raw) as string[]);
      const l = localStorage.getItem(LANG_KEY);
      if (l === "en" || l === "ja") setLang(l);
    } catch {
      // 壊れていたら無いものとして始める
    }
  }, []);

  /** 日本語と英語を入れ替える */
  const toggleLang = useCallback(() => {
    setLang((prev) => {
      const next = prev === "ja" ? "en" : "ja";
      try {
        localStorage.setItem(LANG_KEY, next);
      } catch {
        // 保存できなくても、この画面では切り替わるようにしておく
      }
      return next;
    });
  }, []);

  /** その言葉に直す。書くたびに lang を渡さなくて済むようにする */
  const T = useCallback((ja: string) => t(lang, ja), [lang]);
  const P = useCallback((name: string) => placeName(lang, name), [lang]);

  const toggleFav = useCallback((id: string) => {
    setFavs((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      try {
        localStorage.setItem(FAV_KEY, JSON.stringify(next));
      } catch {
        // 保存できなくても、この画面では使えるようにしておく
      }
      return next;
    });
  }, []);

  /**
   * ログイン状態と教室。
   *
   * 教室（rooms）は承認された人だけが読める。
   * 未ログインでは RLS が空を返すので、検索候補にも出てこない。
   */
  useEffect(() => {
    void (async () => {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      if (!url) return;
      try {
        const { createClient } = await import("@/lib/supabase/client");
        const supabase = createClient();
        const { data: u } = await supabase.auth.getUser();
        if (!u.user) return;
        setEmail(u.user.email ?? null);

        const read = async () =>
          (await supabase.from("profiles").select("role").eq("id", u.user!.id).single()).data;

        let p = await read();
        // 席はあるのに情報が無いことがある。その場で作り直してから読み直す
        if (!p) {
          await supabase.rpc("ensure_profile");
          p = await read();
        }

        const r = (p?.role as Role) ?? null;
        setRole(r);
        if (!canViewCampusInfo(r)) return;

        const rooms = await loadRooms();
        setData((prev) => (prev ? { ...prev, rooms } : prev));
      } catch {
        // 未設定・未接続なら地図だけで動く
      }
    })();
  }, []);

  /* ---------------- 現在地 ---------------- */

  /** 位置を受け取ったときの共通処理 */
  const accept = useCallback((p: GeolocationPosition) => {
    const acc = p.coords.accuracy;
    const now = Date.now();
    const next: Fix = { pos: [p.coords.longitude, p.coords.latitude], accuracy: acc, at: now };
    setFix((prev) => {
      if (!prev) return next;
      // iOS/Android は最初に基地局やWi-Fiの粗い位置を返し、
      // 数秒〜十数秒かけて GPS の精度に上がっていく。
      // より精度の良いものだけ採用する。ただし古い値に居座られないよう、
      // 15秒経ったら無条件に入れ替える。
      const stale = now - prev.at > 15_000;
      if (!(acc <= prev.accuracy || stale)) return prev;

      /*
       * ほとんど動いていない位置は捨てる。
       *
       * 屋外や構内の外では衛星の見え方が安定せず、止まっていても
       * 位置が細かく揺れ続ける。そのたびに新しい値として受け取ると、
       * 画面ぜんぶを組み直すことになり、指で拡大縮小しているあいだに
       * 何度も割り込む。これが「GPSを入れると操作が鈍る」正体。
       *
       * 動いた距離が誤差よりずっと小さければ、それは揺れであって
       * 移動ではない。少なくとも2mは動いていることを求める。
       * 誤差が縮まったときは、揺れでも受け取る（表示が良くなるため）。
       */
      const moved = metersBetween(prev.pos, next.pos);
      const better = acc < prev.accuracy - 1;
      if (!stale && !better && moved < FIX_MIN_MOVE) return prev;
      return next;
    });
    // 進んでいるときは、位置から向きが分かることがある。
    // 止まっていると null や NaN が来るので、そのときは触らない
    const h = p.coords.heading;
    if (h != null && Number.isFinite(h) && (p.coords.speed ?? 0) > 0.5) {
      setHeading(h);
    }
    /*
     * 粗いあいだも位置は出す（円で誤差を正直に見せる）。
     *
     * 境目ちょうどで揺れると「粗い」と「良い」を行き来し、そのたびに
     * 画面を組み直す。行きと帰りで境目をずらして、へばりつかせる。
     */
    setGeoState((prev) => {
      if (prev !== "on" && prev !== "rough") return acc > ACC_ROUGH ? "rough" : "on";
      if (prev === "on" && acc > ACC_ROUGH + 10) return "rough";
      if (prev === "rough" && acc <= ACC_ROUGH) return "on";
      return prev;
    });
  }, []);

  /**
   * 端末の向き（方位磁針）を読み始める。
   *
   * 位置から分かる向きは歩いている間しか取れない。止まっていても
   * どちらを向いているか出したいので、方位磁針からも取る。
   *
   * iOS は許可を求める必要があり、その求め方はタップと同じ流れで
   * 呼ばないと拒まれる。現在地のボタンから一緒に呼ぶ。
   */
  const startCompass = useCallback(() => {
    if (compassOn.current) return;

    const onOrient = (ev: DeviceOrientationEvent) => {
      // iOS は真北からの角度をそのままくれる。
      // Android は alpha が反時計回りなので、向きを合わせる
      const ios = (ev as DeviceOrientationEvent & { webkitCompassHeading?: number })
        .webkitCompassHeading;
      if (ios != null && Number.isFinite(ios)) {
        setHeading(ios);
        return;
      }
      if (ev.absolute && ev.alpha != null && Number.isFinite(ev.alpha)) {
        setHeading((360 - ev.alpha) % 360);
      }
    };

    const attach = () => {
      compassOn.current = true;
      window.addEventListener("deviceorientationabsolute", onOrient as EventListener);
      window.addEventListener("deviceorientation", onOrient as EventListener);
    };

    const anyDOE = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<"granted" | "denied">;
    };
    if (typeof anyDOE?.requestPermission === "function") {
      // 断られても現在地そのものは使えるので、黙って諦める
      void anyDOE.requestPermission().then((r) => {
        if (r === "granted") attach();
      }).catch(() => {});
    } else if (typeof window !== "undefined" && "DeviceOrientationEvent" in window) {
      attach();
    }
  }, []);

  /**
   * 現在地の取得を始める。
   *
   * iOS Safari の落とし穴に合わせてある。
   *  ・許可を求める呼び出しは、タップと同じ処理の流れで行う必要がある
   *    （await をはさむと許可ダイアログが出ないことがある）
   *  ・watchPosition から始めると、一度も呼ばれないまま黙ることがある。
   *    まず getCurrentPosition で許可を取り、成功してから追従を始める
   *  ・一度失敗したあと押し直しても何も起きない状態になりやすいので、
   *    位置がまだ無いときは前の監視を止めて必ずやり直す
   */
  /**
   * 現在地をやめる。
   *
   * 追従を止めて、位置も向きも消す。
   * 出したままにしたくない場面（人に画面を見せるときなど）で使う。
   */
  const stopWatch = useCallback(() => {
    if (watchId.current != null) {
      navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
    }
    if (retryTimer.current != null) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    setFix(null);
    setHeading(null);
    setGeoState("idle");
    // 次に押したときは、また現在地へ寄せてよい
    centered.current = false;
  }, []);

  const startWatch = useCallback(() => {
    // すでに出ているなら、もう一度押したら消す
    if (fix || geoState === "on" || geoState === "rough" || geoState === "asking") {
      stopWatch();
      return;
    }

    // 自分から押したのだから、また知らせてよい
    setGeoMuted(false);

    // 押した時点で描画面を測り直す。
    // 許可ダイアログでアドレスバーの高さが変わり、地図が半分のまま残るのを防ぐ
    mapRef.current?.resize();
    // 向きの許可も、このタップと同じ流れで求める
    startCompass();

    if (typeof window !== "undefined" && !window.isSecureContext) {
      setGeoState("insecure");
      return;
    }
    if (!navigator.geolocation) {
      setGeoState("unavailable");
      return;
    }

    // ここへ来る時点で位置は取れていない（取れていれば上で止めている）。
    // 監視だけ残っているなら失敗しているので、止めてやり直す
    if (watchId.current != null) {
      navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
    }
    if (retryTimer.current != null) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }

    setGeoState("asking");

    const beginWatch = () => {
      if (watchId.current != null) return;
      watchId.current = navigator.geolocation.watchPosition(
        accept,
        (err) => {
          // 追従中の一時的な失敗で、取れている位置を消さない
          if (err.code === err.PERMISSION_DENIED) setGeoState("denied");
        },
        // 1秒前までの値なら使い回す。0 にすると毎回測り直し、
        // 揺れも届く回数も増えて、指の操作に割り込みやすくなる
        { enableHighAccuracy: true, maximumAge: 1_000, timeout: 30_000 },
      );
    };

    const fail = (err: GeolocationPositionError) => {
      if (err.code === err.PERMISSION_DENIED) {
        setGeoState("denied");
        return;
      }
      // 高精度が取れない場所（屋内・ビルの谷間）では粗い位置で妥協する
      navigator.geolocation.getCurrentPosition(
        (p) => {
          accept(p);
          beginWatch();
        },
        (e2) => setGeoState(e2.code === e2.TIMEOUT ? "timeout" : "unavailable"),
        { enableHighAccuracy: false, maximumAge: 60_000, timeout: 20_000 },
      );
    };

    // ★ここがタップと同じ流れで呼ばれることが重要。許可ダイアログはこれで出る
    navigator.geolocation.getCurrentPosition(
      (p) => {
        accept(p);
        beginWatch();
      },
      fail,
      // 衛星をつかむには時間がいる。初回は特に、電源を入れてすぐだと
      // 20〜30秒かかることがある。ここを短くすると、衛星を待たずに
      // Wi-Fi や基地局からの粗い位置に落ちてしまう
      { enableHighAccuracy: true, maximumAge: 0, timeout: 25_000 },
    );

    // 何も返らないときは、黙らせずに状態を出す。
    // 上の待ち時間より長くしないと、待っている最中に諦めたことになる
    retryTimer.current = window.setTimeout(() => {
      setFix((cur) => {
        if (!cur) setGeoState("timeout");
        return cur;
      });
    }, 32_000);
  }, [fix, geoState, accept, startCompass, stopWatch]);

  /**
   * 現在地を確実に動かす。すでに動いていれば何もしない。
   *
   * startWatch は現在地ボタン用の切り替えで、すでに取れているときは
   * 止める。案内を始めるところからそれを呼んでいたため、
   * 「現在地から案内する」と押した人の現在地を消していた。
   * 建物の中から一覧の［案内］を押したときも同じことが起きていた。
   *
   * 案内側からは、止める意味がない。始めるだけのこちらを使う。
   */
  const ensureWatch = useCallback(() => {
    if (fix || geoState === "on" || geoState === "rough" || geoState === "asking") return;
    startWatch();
  }, [fix, geoState, startWatch]);

  /**
   * 現在地を使わないと決めたか。
   *
   * 拒否のままだと知らせが出続け、地図の左上を占め続ける。
   * 「使わない」と決めた人には二度と出さない。
   * 現在地のボタンを押せば、また試せる。
   */
  const [geoMuted, setGeoMuted] = useState(false);
  /** 直し方を開いているか。既定は畳む（開いたままだと地図が隠れる） */
  const [geoHelp, setGeoHelp] = useState(false);
  /**
   * 直し方を、どのブラウザのぶんで出すか。
   *
   * 最初の候補は名乗りから決めるが、当てにはしない。
   * iPhone の Chrome は中身が Safari と同じで紛らわしいので、
   * 違っていれば本人が選び直せるようにしておく。
   */
  const [helpBrowser, setHelpBrowser] = useState<BrowserKind>("safari");
  const [helpPlatform, setHelpPlatform] = useState<Platform>("ios");
  /**
   * 名乗りから当てるのは、はじめて開いたときの一度だけ。
   * 二度目からは、本人が選び直した結果をそのまま残す。
   */
  const guessed = useRef(false);
  const toggleGeoHelp = useCallback(() => {
    if (!guessed.current) {
      guessed.current = true;
      setHelpBrowser(guessBrowser());
      setHelpPlatform(guessPlatform());
    }
    setGeoHelp((v) => !v);
  }, []);
  const geoMutedRef = useRef(false);
  geoMutedRef.current = geoMuted;

  /** 知らせを閉じ、位置を取りにいくのもやめる */
  const muteGeo = useCallback(() => {
    setGeoMuted(true);
    stopWatch();
  }, [stopWatch]);

  /** 許可の状態を先に調べて、拒否されているなら押す前に伝える */
  useEffect(() => {
    void navigator.permissions
      ?.query({ name: "geolocation" as PermissionName })
      .then((s) => {
        // 使わないと決めた人には、蒸し返さない
        if (s.state === "denied" && !geoMutedRef.current) setGeoState("denied");
        s.onchange = () => {
          if (s.state === "denied" && !geoMutedRef.current) setGeoState("denied");
        };
      })
      .catch(() => {
        // Safari の古い版は未対応。押したときに分かるので何もしない
      });
  }, []);

  useEffect(
    () => () => {
      if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current);
      if (retryTimer.current != null) clearTimeout(retryTimer.current);
    },
    [],
  );

  /* 起動時の画角合わせは fitHome にまとめてある（下の framed の効果）。
     以前ここにもう一つ同じ処理があり、駅を含む広い枠に一度合わせてから
     すぐ組み直していた。二重なので消した。 */

  /** 現在地へ一度だけ寄せたかの記録。寄せる処理は圏内判定のあとに置いてある */
  const centered = centeredRef;

  /**
   * 起動したら、構内の建物がひととおり入るところまで引く。
   *
   * 構内から離れた場所（野々市工大前駅など）は枠に入れない。
   * 駅は構内の西へ367m 離れており、含めると画角が大きく崩れて
   * 構内の建物が小さくなってしまう。
   *
   * 一度だけ。現在地が取れたり案内を始めたりしたら、そちらを優先する。
   */
  /** 起動時の画角に合わせる。ボタンからも呼べるようにしてある */
  const fitHome = useCallback(
    (duration = 0) => {
      const map = mapRef.current;
      if (!map || !data) return;

      const rings = data.buildings.features
        .filter((f) => !ZOOM_ONLY_NAMES.has(f.properties.name ?? ""))
        .map((f) => f.geometry.coordinates[0]);
      if (rings.length === 0) return;

      let w = Infinity,
        s = Infinity,
        e = -Infinity,
        n = -Infinity;
      for (const ring of rings) {
        for (const [lon, lat] of ring) {
          if (lon < w) w = lon;
          if (lon > e) e = lon;
          if (lat < s) s = lat;
          if (lat > n) n = lat;
        }
      }
      map.fitBounds(
        [
          [w, s],
          [e, n],
        ],
        { padding: HOME_PAD, maxZoom: 17, bearing: 0, pitch: 0, duration },
      );
    },
    [data],
  );

  const framed = useRef(false);
  useEffect(() => {
    if (!ready || !data || framed.current || fix || trip) return;
    framed.current = true;
    fitHome(0);
  }, [ready, data, fix, trip, fitHome]);

  /* ---------------- 圏内判定 ---------------- */

  /**
   * 敷地の外周。内外の判定にも、地図を動かせる範囲にも使う。
   *
   * 見るのは campus だけにする。data 全体を見ていると、
   * 教室を読み終えて data を差し替えたときにも作り直しになり、
   * 地図の範囲設定まで無駄にやり直していた。
   */
  const campusFc = data?.campus;
  const campusRings = useMemo(
    () =>
      (campusFc?.features ?? [])
        .map((f) => f.geometry.coordinates[0])
        .filter((p) => p && p.length > 2),
    [campusFc],
  );

  /**
   * 敷地のへりから現在地までの距離（メートル）。中にいれば 0。
   * 位置が無い、または敷地が読めていなければ null。
   */
  const distFromCampus = useMemo(() => {
    if (!fix || campusRings.length === 0) return null;
    // 敷地は一面とはかぎらない。どれかに入っていれば中とみなす
    if (campusRings.some((ring) => inRing(ring, fix.pos))) return 0;
    return Math.min(...campusRings.map((ring) => metersToRing(ring, fix.pos)));
  }, [campusRings, fix]);

  /**
   * 構内にいるか。誤差を織り込んで決める。
   *
   * 建物の中では衛星が見えにくく、誤差が数十mに広がる。厳密に
   * 敷地の線の内側かで決めると、23号館の中にいる人の点が外へ出て
   * 「圏外」になり、現在地からの案内も門からに切り替わってしまう。
   *
   * 誤差の輪が敷地に届いているなら、外にいるとは言い切れない。
   * そのときは中とみなす。ただし誤差そのものが大きいと、どこにいても
   * 中になってしまうので、織り込む幅には上限を置く。
   */
  const inCampus =
    distFromCampus == null || fix == null
      ? null
      : distFromCampus <= Math.min(fix.accuracy, CAMPUS_SLACK_MAX);

  /**
   * 守備範囲の外にいるか。
   *
   * ここに当たる人には現在地を出さない。敷地から 1km 以上離れていれば、
   * この地図に写っている場所には居ないので、点を打っても意味が無い。
   *
   * ただし、誤差そのものが 1km を超えている測り方のときは「遠い」と決めない。
   * 端末が基地局から大まかに割り出した位置は数km ずれることがあり、
   * 構内にいる人を構外と言い切ってしまうため。
   * 衛星に切り替われば誤差は数十mに落ちるので、そこで正しく判定される。
   */
  const tooFar =
    distFromCampus != null &&
    fix != null &&
    fix.accuracy <= RANGE_M &&
    distFromCampus > RANGE_M;

  /**
   * 現在地が取れたら一度だけ寄せる。やめたら false に戻す。
   *
   * 遠くにいるあいだは寄せない。構内から 1km 以上離れた場所へ
   * 地図を飛ばしても写るものが無いうえ、動かせる範囲の外なので
   * 端に張り付いたまま戻れなくなる。
   */
  useEffect(() => {
    if (!fix || centered.current) return;
    // 敷地がまだ読めていないうちは、遠いかどうかを決められない。次の位置で見直す
    if (distFromCampus == null || tooFar) return;
    centered.current = true;
    mapRef.current?.easeTo({ center: [fix.pos[0], fix.pos[1]], zoom: 18 });
  }, [fix, distFromCampus, tooFar, centered]);

  /**
   * 地図を動かせる範囲を、敷地から 1km までに閉じる。
   *
   * これまでは日本中どこへでも流れていけた。指が滑って構内を見失うと
   * 戻り方が分からなくなるうえ、遠くを写しても案内には使えない。
   *
   * MapLibre が受け取れるのは四角形なので、敷地を囲む四角を
   * 四方へ 1km ずつ広げたものを渡す。角は 1km より少し外まで入るが、
   * 「構内の周りだけ」という目的は満たせる。
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || campusRings.length === 0) return;

    let w = Infinity,
      s = Infinity,
      e = -Infinity,
      n = -Infinity;
    for (const ring of campusRings) {
      for (const [lon, lat] of ring) {
        if (lon < w) w = lon;
        if (lon > e) e = lon;
        if (lat < s) s = lat;
        if (lat > n) n = lat;
      }
    }

    // 1km を緯度経度の差に直す。経度は緯度が上がるほど詰まる
    const midLat = ((s + n) / 2) * (Math.PI / 180);
    const dLat = RANGE_M / 111_320;
    const dLon = RANGE_M / (111_320 * Math.cos(midLat));
    const west = w - dLon,
      south = s - dLat,
      east = e + dLon,
      north = n + dLat;

    map.setMaxBounds([
      [west, south],
      [east, north],
    ]);

    /*
     * 引ける下限を、範囲がちょうど画面を覆いきる縮尺まで引き上げる。
     *
     * ■ なぜ要るか
     *   MapLibre は「動かせる範囲が画面より小さい」と気づくと、
     *   中心を範囲の真ん中へ寄せたうえで、縮尺を強制的に押し戻す。
     *
     *     if (maxX - minX < screenWidth) scaleX = screenWidth / (maxX - minX);
     *     if (scale) { center = 範囲の中心; zoom += scaleZoom(scale); }
     *
     *   指で引くたびに押し返されるので、動かなくなったように見える。
     *   押し返しは毎フレーム起きるため、そのたびに画面も組み直していた。
     *
     *   範囲は 2.9km × 2.7km。縮尺15 では画面上の 1521 × 1408px にあたる。
     *   横に広い画面（1920px級）だと覆いきれず、この押し返しに入っていた。
     *
     * ■ どう直すか
     *   覆いきれる縮尺より引けなくする。そうすれば押し返しは一度も起きず、
     *   端では中心をずらすだけの軽い処理で済む。
     */
    // 世界全体を1としたときの、範囲の幅と高さ
    const mercY = (lat: number) =>
      (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
    const fx = (east - west) / 360;
    const fy = mercY(south) - mercY(north);
    /** MapLibre が世界の大きさを測る単位（worldSize = 512 × 2^縮尺） */
    const TILE = 512;

    const relimit = () => {
      const box = map.getContainer();
      /*
       * 画面より 1px だけ大きく覆えることを求める。
       *
       * ちょうど同じ大きさを狙うと、小数の丸めで「1px 足りない」側に
       * 転ぶことがある。MapLibre は 1px でも足りなければ押し返すので、
       * 余白を持たせて確実に覆いきる。
       */
      const need = Math.log2(
        Math.max((box.clientWidth + 1) / (fx * TILE), (box.clientHeight + 1) / (fy * TILE)),
      );
      // 15 はもとからの下限。これ以上引かせない
      const lo = Math.max(15, need);
      // 同じ値で呼び直すと、そのたびに縮尺の判定が走る
      if (Math.abs(map.getMinZoom() - lo) > 0.01) map.setMinZoom(lo);
    };
    relimit();
    // 画面が変われば覆えるかどうかも変わる（回転、アドレスバーの出入り）
    map.on("resize", relimit);
    return () => {
      map.off("resize", relimit);
    };
  }, [ready, campusRings]);

  /* ---------------- 経路 ---------------- */

  const graph = useMemo(() => (data ? buildGraph(data) : null), [data]);
  /**
   * 建物の中を通らない網。
   *
   * 中を通る道すじのほうが近いことは多いが、開いていない時間帯や
   * 入りたくない事情もある。外だけの道すじも出せるようにする。
   */
  const graphOut = useMemo(
    () => (data ? buildGraph(data, { outdoorOnly: true }) : null),
    [data],
  );
  /** 建物の中を通らない道すじを選んでいるか */
  const [avoidInside, setAvoidInside] = useState(false);

  /** 建物IDから、その場所の出入口CP一覧 */
  const entrancesOf = useCallback(
    (buildingId: string) =>
      ((data?.checkpoints.features ?? []) as CheckpointFeature[]).filter(
        (c) => c.properties.linkedTo === buildingId,
      ),
    [data],
  );

  /**
   * 現在地に寄せた起点の節点。
   *
   * 位置は数mおきに届く。そのたびに経路を丸ごと組み直していたため、
   * 実測で1回あたり 8.5ms（節点を探す 1.0 + 経路 5.6 + 手順の文 2.0）を
   * 使っていた。指で拡大縮小している最中にこれが割り込むと、
   * 動きが引っかかる。
   *
   * 経路が変わるのは「寄せた先の節点が変わったとき」だけ。
   * ここで節点だけを求めておき、経路のほうはその節点が変わったときに
   * 組み直す。数m動いただけでは組み直さない。
   */
  const meNode = useMemo(() => {
    if (!fix || tooFar) return { main: null as string | null, out: null as string | null };
    /*
     * 探す輪は誤差に合わせて広げる。建物の中にいると、いちばん近い
     * 通路の節点まで数十m離れることがあり、50m で切ると見つからない。
     */
    const snap = Math.min(Math.max(SNAP_MAX, fix.accuracy), SNAP_MAX_FAR);
    return {
      main: graph ? (nearestNode(graph, fix.pos, snap)?.id ?? null) : null,
      // 外だけの網は、選んでいるときしか要らない
      out: avoidInside && graphOut ? (nearestNode(graphOut, fix.pos, snap)?.id ?? null) : null,
    };
  }, [graph, graphOut, fix, tooFar, avoidInside]);

  const route = useMemo(() => {
    if (!data || !graph || !trip) return null;

    /* 起点。建物から出るときは、その建物の出入口すべてを候補にする */
    let startIds: string[] = [];
    let fromGate = false;
    if (trip.origin.kind === "me") {
      /*
       * 現在地に寄せた節点を起点にする（上の meNode で求めてある）。
       *
       * 見つからないときは門からの案内に切り替わる。
       * 「現在地から案内しているつもりが門から」にならないよう、
       * 使わないのは「遠すぎる」と言い切れるときだけにしてある。
       */
      const near = avoidInside && graphOut ? meNode.out : meNode.main;
      if (near) startIds = [near];
      // 現在地がまだ取れていなくても案内は出す。門を起点にして、そう伝える
      if (startIds.length === 0) {
        const gate = (data.checkpoints.features as CheckpointFeature[]).find(
          (c) => c.properties.kind === "gate",
        );
        if (gate) {
          startIds = [gate.properties.id];
          fromGate = true;
        }
      }
      if (startIds.length === 0) return { error: "経路の起点が見つかりません" as const };
    } else {
      const ents = entrancesOf(trip.origin.hit.buildingId);
      if (ents.length === 0) return { error: "出発地の入口が登録されていません" as const };
      startIds = ents.map((e) => e.properties.id);
    }

    /* 目的地の出入口すべて */
    const ents = entrancesOf(trip.dest.buildingId);
    if (ents.length === 0) return { error: "目的地の入口が登録されていません" as const };

    const goalIds = ents.map((e) => e.properties.id);

    /*
     * 出入口の組み合わせをすべて見比べて、道なりでいちばん短くなるものを選ぶ。
     * 直線で近い出入口が道なりでも近いとはかぎらない。
     *
     * 「外だけ」を選んでいるときは、建物の中の点を外した網で探す。
     * その網に無い出入口は起点・終点から除く。外だけでは行けない相手も
     * あるので（実測で83通り）、見つからなければ中を通る道すじに戻し、
     * そのことを画面で伝える。
     */
    const useOut = avoidInside && graphOut !== null;
    const g = useOut ? graphOut! : graph;
    const has = (id: string) => g.pos.has(id);
    let found =
      useOut
        ? findBestPath(g, startIds.filter(has), goalIds.filter(has))
        : findBestPath(g, startIds, goalIds);

    let usedGraph = g;
    let outdoorFailed = false;
    if (!found && useOut) {
      // 外だけでは行けない。中を通る道すじに戻す
      found = findBestPath(graph, startIds, goalIds);
      usedGraph = graph;
      outdoorFailed = true;
    }
    if (!found) return { error: "経路が見つかりませんでした" as const };

    const path = found.path;
    const startId = path[0];
    const goal = ents.find((e) => e.properties.id === path[path.length - 1]) ?? ents[0];

    /** この道すじが建物の中を通るか */
    const inside = path.some(
      (id) => (usedGraph.cp.get(id)?.properties.level ?? 1) >= 2,
    );

    /*
     * 距離と時間だけを数える。
     *
     * 以前は手順の文を作る buildSteps を呼んでいたが、その文は画面に
     * 出していない。中身では点ごとに43件の建物との内外判定をするので、
     * 1回あたり 2.0ms かかっていた。要るのは長さだけなので、足すだけにする。
     */
    let meters = 0;
    for (let i = 1; i < path.length; i++) {
      const a = usedGraph.pos.get(path[i - 1]);
      const b = usedGraph.pos.get(path[i]);
      if (a && b) meters += metersBetween(a, b);
    }
    // 分速80m（不動産表示の基準）。切り上げ
    const minutes = Math.max(1, Math.ceil(meters / 80));

    return {
      path,
      meters: Math.round(meters),
      minutes,
      goal,
      startId,
      fromGate,
      inside,
      outdoorFailed,
    };
  }, [data, graph, graphOut, avoidInside, trip, meNode, entrancesOf]);

  /* ---------------- 到着判定 ---------------- */

  useEffect(() => {
    // 出発地がどこであっても、目的地に着いたら知らせる。
    // 以前は現在地から始めた案内のときだけ見ていたので、
    // 地図のラベルや検索で出発地を指定した案内では到着が出なかった。
    // 判定に使うのは現在地なので、現在地が取れてさえいれば同じように分かる。
    if (!route || "error" in route || !fix) {
      inRangeSince.current = null;
      return;
    }

    /*
     * 「着いた」とみなす広さ。
     *
     * 入口に書いてある半径は 5m のものが多い。ところが現在地は
     * 屋外でも ±5〜30m ずれるので、5m の輪に入ったと判定されることは
     * ほとんど無い。実際、これが到着が出なかったいちばんの理由。
     * 測位の誤差ぶんは緩めないと、いつまでも着かないことになる。
     *
     * ただし誤差が大きいときに何でも到着にしては困るので、上限を置く。
     */
    const tol = Math.min(
      ARRIVE_MAX,
      Math.max(route.goal.properties.radius, fix.accuracy, ARRIVE_MIN),
    );

    const d = metersBetween(fix.pos, route.goal.geometry.coordinates);
    if (d > tol) {
      inRangeSince.current = null;
      return;
    }

    if (inRangeSince.current == null) inRangeSince.current = Date.now();
    const left = ARRIVE_HOLD - (Date.now() - inRangeSince.current);

    // 一瞬の誤差で誤判定しないよう、少しのあいだ入り続けたら到着とみなす
    if (left <= 0) {
      setArrived((was) => {
        // 画面を見ていなくても気づけるよう、初めて到着したときだけ振動させる
        if (!was) navigator.vibrate?.([120, 60, 120]);
        return true;
      });
      return;
    }

    /*
     * 現在地が更新されないと、この処理は動き直さない。
     * 精度の良い値が来ないあいだ fix は据え置かれるので、
     * 着いた場所に立ち止まったまま数え終われないことがあった。
     * 時間が来たら自分で見に来る。
     */
    const timer = window.setTimeout(() => setRecheck((v) => v + 1), left + 50);
    return () => clearTimeout(timer);
  }, [fix, route, trip, recheck]);

  /**
   * 経路が出たら、道すじ全体が入るところまで引く。
   *
   * 出発地に寄ったままだと、どこへ向かうのかが画面の外で分からない。
   * 同じ経路で何度も動かすと操作の邪魔になるので、
   * 道すじが変わったときだけ動かす。
   */
  const fittedFor = useRef<string | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!trip) {
      fittedFor.current = null;
      return;
    }
    if (!map || !route || "error" in route || !graph) return;

    const key = route.path.join(">");
    if (fittedFor.current === key) return;
    fittedFor.current = key;

    let w = Infinity,
      s = Infinity,
      e = -Infinity,
      n = -Infinity;
    const add = (c: Position) => {
      if (c[0] < w) w = c[0];
      if (c[0] > e) e = c[0];
      if (c[1] < s) s = c[1];
      if (c[1] > n) n = c[1];
    };
    for (const id of route.path) {
      const q = graph.pos.get(id);
      if (q) add(q);
    }
    add(route.goal.geometry.coordinates);
    if (!Number.isFinite(w)) return;

    map.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      {
        // 上はボタン、下は案内の帯と建物一覧が重なるので、その分を空ける
        padding: { top: 140, bottom: 200, left: 56, right: 56 },
        maxZoom: 18,
        duration: 800,
      },
    );
  }, [trip, route, graph]);

  /* ---------------- 画面座標 ---------------- */

  const highlight = useMemo(() => {
    const s = new Set<string>();
    if (trip?.dest) s.add(trip.dest.buildingId);
    if (trip?.origin.kind === "place") s.add(trip.origin.hit.buildingId);
    if (focusId) s.add(focusId);
    return s;
  }, [trip, focusId]);

  /**
   * 建物の広さ。名前をどれから先に置くかを決めるためだけに使う。
   *
   * 経緯度のまま計算するので実際の面積ではないが、
   * 大小の順さえ合っていればよい。動かすたびに計算し直さないよう一度だけ求める。
   */
  const areaOf = useMemo(() => {
    const m = new Map<string, number>();
    if (!data) return m;
    for (const f of data.buildings.features) {
      const ring = f.geometry.coordinates[0];
      let s = 0;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        s += a[0] * b[1] - b[0] * a[1];
      }
      m.set(f.properties.tempId, Math.abs(s) / 2);
    }
    return m;
  }, [data]);

  /**
   * 一覧に出す建物。号館を番号順、そのあと屋外・施設を指定の順で並べる。
   *
   * 名前は、付け替えたものがあればそちらを使う。地図の名前だけ変えても、
   * 一覧が元の名前のままでは同じ場所だと分からなくなるため。
   * 並び順は元の名前で決める（付け替えるたびに並びが変わると探せない）。
   */
  const listed = useMemo(() => {
    if (!data) return [];
    return [...data.buildings.features]
      .map((f) => {
        const original = f.properties.name || (f.properties.code ? `${f.properties.code}号館` : "");
        const mine = (custom.names[f.properties.tempId] ?? "").trim();
        return {
          f,
          label: mine || original,
          // 付け替えた名前は、そのまま出す。英語の言い換えにかけない
          renamed: mine.length > 0,
          key: orderKey(f.properties.name ?? "", f.properties.code ?? ""),
        };
      })
      .filter((x) => x.label)
      .sort((a, b) => compareOrder(a.key, b.key));
  }, [data, custom.names]);


  /** お気に入りだけを、登録した順に並べたもの */
  const favListed = useMemo(
    () =>
      favs
        .map((id) => listed.find((x) => x.f.properties.tempId === id))
        .filter((x): x is (typeof listed)[number] => !!x),
    [favs, listed],
  );

  /** 案内の入力欄に出すお気に入り */
  const favHits = useMemo<SearchHit[]>(
    () =>
      favListed.map(({ f, label }) => ({
        buildingId: f.properties.tempId,
        title: label,
        sub: "",
        score: -1,
      })),
    [favListed],
  );

  /**
   * 建物へ寄せる。押すたびに寄る／戻るが入れ替わる。
   *
   * 同じ建物をもう一度押したら、起動したときの見え方へ戻す。
   * 寄ったあと元に戻す手立てが無いと、指で縮めるしかなくなるため。
   */
  const focusBuilding = useCallback(
    (ring: Position[], id: string) => {
      const map = mapRef.current;
      if (!map) return;

      if (focusId === id) {
        setFocusId(null);
        // 中心は動かさず、縮尺だけ戻す。
        // 決まった場所へ引き戻すと、いま見ていた建物が画面から消えて
        // どこを見ていたか分からなくなる。押した建物を真ん中に置いたまま引く。
        map.easeTo({
          zoom: HOME_ZOOM,
          bearing: 0,
          pitch: 0,
          duration: 700,
        });
        return;
      }

      setFocusId(id);
      let w = Infinity,
        s = Infinity,
        e = -Infinity,
        n = -Infinity;
      for (const [lon, lat] of ring) {
        if (lon < w) w = lon;
        if (lon > e) e = lon;
        if (lat < s) s = lat;
        if (lat > n) n = lat;
      }
      map.fitBounds(
        [
          [w, s],
          [e, n],
        ],
        { padding: 120, maxZoom: 19, duration: 700 },
      );
    },
    [focusId],
  );

  /**
   * 地図のラベルを押したとき。
   *
   * 一つ目 … 出発地にする（そこへ寄る）
   * 同じもの … 取り消して、縮尺を戻す
   * 二つ目 … 目的地にして案内を始める
   */
  const tapLabel = useCallback(
    (id: string, label: string, ring: Position[]) => {
      const hit: SearchHit = { buildingId: id, title: label, sub: "", score: 0 };

      /*
       * 現在地が取れているなら、押した建物までそのまま案内する。
       * 自分がどこにいるか分かっている以上、出発地を選ばせるのは
       * 一手間よけいなだけ。二つ押させる形は、現在地が無いときに残す。
       */
      if (fix && !pickedFrom) {
        setTrip({ origin: { kind: "me" }, dest: hit });
        setOrigin({ kind: "me" });
        setDest(hit);
        setArrived(false);
        setFocusId(id);
        return;
      }

      if (!pickedFrom) {
        setPickedFrom(hit);
        setTrip(null);
        setArrived(false);
        focusBuilding(ring, id);
        return;
      }

      if (pickedFrom.buildingId === id) {
        // 同じものをもう一度。選び直せるように取り消す
        setPickedFrom(null);
        focusBuilding(ring, id); // 二度目なので縮尺が戻る
        return;
      }

      setTrip({ origin: { kind: "place", hit: pickedFrom }, dest: hit });
      setOrigin({ kind: "place", hit: pickedFrom });
      setDest(hit);
      setArrived(false);
      setPickedFrom(null);
      setFocusId(id);
    },
    [pickedFrom, fix, focusBuilding],
  );

  /**
   * 地図を押したときに使う、いまの画面上のラベルの位置。
   *
   * 地図の合図は一度しか登録しないので、その中から見える値は古いままになる。
   * 毎回の描画で入れ直して、押されたときには最新を見られるようにする。
   */
  const hitRef = useRef<LabelHit[]>([]);
  const tapLabelRef = useRef<(id: string, label: string, ring: Position[]) => void>(() => {});

  /* 押されたときに見る値を、毎回の描画で入れ直す */
  fitHomeRef.current = () => fitHome(500);
  tapLabelRef.current = tapLabel;

  /* ---------------- 表示 ---------------- */

  return (
    <div
      className={`kit-map relative w-full select-none ${custom.dark ? "kit-dark" : ""} ${email ? "kit-signed" : ""}`}
      style={{ height: "100dvh" }}
    >
      <div ref={boxRef} style={{ position: "absolute", inset: 0 }} />

      {/* 一番右上。表示のカスタマイズを開く */}
      <button
        onClick={() => setCustomOpen(true)}
        aria-label="表示のカスタマイズ"
        title="表示のカスタマイズ"
        className="absolute right-3 top-3 z-20 flex h-10 w-10 items-center justify-center rounded-full bg-white text-base shadow-md transition hover:bg-white active:scale-90"
      >
        🎨
      </button>

      <Customize
        t={T}
        lang={lang}
        open={customOpen}
        onClose={() => setCustomOpen(false)}
        data={data}
        value={custom}
        onChange={updateCustom}
      />

      {/* 起動時のタイトル。触ると上下に割れて地図が現れる */}
      {splash !== "done" && (
        <div
          onClick={closeSplash}
          role="button"
          aria-label="はじめる"
          className="fixed inset-0 z-50 cursor-pointer"
          style={{ animation: "kitFade 500ms ease-out" }}
        >
          {/* 上半分。中身は画面全体の高さを持たせ、割れ目で切り取る */}
          <div
            className="absolute inset-x-0 top-0 h-1/2 overflow-hidden bg-slate-950"
            style={{
              transition: "transform 400ms cubic-bezier(0.65,0,0.35,1)",
              transform: splash === "closing" ? "translateY(-100%)" : "none",
            }}
          >
            <div className="absolute inset-x-0 top-0 flex h-[100dvh] flex-col items-center justify-center">
              <SplashInner />
            </div>
          </div>

          {/* 下半分 */}
          <div
            className="absolute inset-x-0 bottom-0 h-1/2 overflow-hidden bg-slate-950"
            style={{
              transition: "transform 400ms cubic-bezier(0.65,0,0.35,1)",
              transform: splash === "closing" ? "translateY(100%)" : "none",
            }}
          >
            <div className="absolute inset-x-0 bottom-0 flex h-[100dvh] flex-col items-center justify-center">
              <SplashInner />
            </div>
          </div>

          {/* 割れ目に走る細い光 */}
          <div
            className="absolute inset-x-0 top-1/2 h-px bg-white/40"
            style={{
              transition: "opacity 400ms ease-out",
              opacity: splash === "closing" ? 0 : 1,
            }}
          />
        </div>
      )}

      {fatal && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-100 p-6">
          <div className="max-w-sm rounded-2xl bg-white p-5 text-sm shadow-xl ring-1 ring-red-300">
            <b className="text-red-700">地図を表示できません</b>
            <p className="mt-2 text-xs text-slate-700">{fatal}</p>
          </div>
        </div>
      )}

      {/*
        描く土台が落ちて、地図が白くなっているとき。

        ふつうは、余裕ができるとブラウザが自分で戻してくれて、
        こちらもそれを合図に作り直す。戻ってこないこともあるので、
        手で出し直せる道も出しておく。
        白いまま何も言わないのが、いちばん困る。
      */}
      {glLost && !fatal && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-100/95 p-6">
          <div className="max-w-xs rounded-2xl bg-white p-5 text-center shadow-xl">
            <b className="text-sm text-slate-900">{T("地図を読み込み直しています")}</b>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-600">
              {T(
                "端末の空きが少なくなったため、地図の描画がいったん止まりました。すぐに戻ります。",
              )}
            </p>
            <button
              onClick={() => {
                setGlLost(false);
                setMapKey((k) => k + 1);
              }}
              className="mt-3 w-full rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-bold text-white active:scale-95"
            >
              {T("いますぐ出し直す")}
            </button>
          </div>
        </div>
      )}

      {/* 建物の名前・経路・現在地。
          地図が動くたびの組み直しは、この中だけで起きる */}
      {/* ?perf=1 を付けて開いたときだけ、動きの重さを画面に出す */}
      <PerfHud />

      <MapOverlay
        map={mapRef.current}
        ready={ready}
        data={data}
        route={route}
        graph={graph}
        fix={fix}
        tooFar={tooFar}
        heading={heading}
        highlight={highlight}
        areaOf={areaOf}
        pickedFrom={pickedFrom}
        favs={favSet}
        labelBg={labelColor.bg}
        labelFg={labelColor.fg}
        customNames={custom.names}
        zoomOnlyAt={ZOOM_ONLY_AT}
        zoomOnlyNames={ZOOM_ONLY_NAMES}
        placeName={P}
        t={T}
        hitRef={hitRef}
      />

      {/*
        右上に、いま誰で入っているかを出す。

        ■ 学生は押せない
          押した先（/login）には管理の行き先が並ぶ。学生には使えるものが
          一つも無いので、行っても用のない画面を見るだけになる。
          「押せそうなのに何も起きない」より、はじめから押せない形にする。

        ■ 押せる人
          承認を待っている人（まだ手続きの途中）と、
          何かしら管理を任されている人。どちらもその先に用がある。

        押せるときは <a>、押せないときは <div>。見た目は同じにして、
        押せる合図（指の形・押したときの縮み）だけを外す。
      */}
      {email &&
        (() => {
          const canGo = role === "pending" || (role !== null && role !== "student");
          const look =
            "absolute right-3 top-20 z-10 flex max-w-[11rem] items-center gap-2 rounded-full bg-white py-1.5 pl-2 pr-3 shadow-md";
          const inner = (
            <>
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white ${
                  canViewCampusInfo(role) ? "bg-blue-600" : "bg-amber-500"
                }`}
              >
                {email.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[11px] font-bold leading-tight text-slate-800">
                  {email}
                </span>
                <span className="block truncate text-[9px] leading-tight text-slate-500">
                  {/* 言葉によって並びが変わるので、まるごと差し替える */}
                  {T("{r}でログイン中").replace("{r}", T(SHORT_ROLE[role ?? "pending"]))}
                </span>
              </span>
            </>
          );
          const title = `${email}（${T(ROLE_LABEL[role ?? "pending"])}）`;

          return canGo ? (
            <a href="/login" className={`${look} transition active:scale-95`} title={title}>
              {inner}
            </a>
          ) : (
            <div className={look} title={title}>
              {inner}
            </div>
          );
        })()}

      {/* 学内の情報。
          ボタンの列の中に入れると、列の幅と高さに縛られて
          下のほうが画面の外に出てしまう。上下を画面に留めた
          別の引き出しにして、中身は必ず送れるようにする */}
      {side && (
        <div
          className="absolute left-4 z-20 flex w-[min(21rem,calc(100vw-2rem))] flex-col rounded-2xl bg-white/95 p-3 shadow-2xl backdrop-blur"
          style={{ top: "1rem", bottom: "1rem" }}
        >
          <div className="mb-2 flex shrink-0 items-center justify-between">
            <span className="text-[11px] font-bold text-slate-500">学内の情報</span>
            <button
              onClick={() => setSide(false)}
              aria-label="閉じる"
              className="h-7 w-7 rounded-lg bg-slate-100 text-xs font-bold text-slate-600 transition hover:bg-slate-200"
            >
              ✕
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <CampusPanel role={role} onNeedLogin={() => setLogin(true)} lang={lang} />
          </div>

          {/*
            感想を読める人への入口。

            これまでは地図から直接は行けず、右上の小さな
            「〜でログイン中」を押して、そこからメニューをたどる
            必要があった。二回たどらないと届かないので、
            届いていることに気づけない。ここから一回で行けるようにする。

            読めない権限の人には出さない。押せない行き先が並んでいても
            迷うだけなので、その人が使えるものだけを見せる。
          */}
          {canReadFeedback(role) && (
            <a
              href="/admin/feedback"
              className="mt-2 flex shrink-0 items-center gap-2 rounded-xl bg-slate-100 px-3 py-2.5 transition hover:bg-slate-200 active:scale-95"
            >
              <span className="text-base">✉</span>
              <span className="min-w-0">
                <span className="block text-xs font-bold text-slate-800">
                  {T("みんなの感想")}
                </span>
                <span className="block text-[10px] text-slate-500">
                  {T("使っている人から届いた声")}
                </span>
              </span>
              <span className="ml-auto shrink-0 text-slate-400">›</span>
            </a>
          )}
        </div>
      )}

      {/* 左上に縦に積む。重なりが起きないよう1つの列にまとめる */}
      <div className="absolute left-4 top-4 z-10 flex w-fit max-w-[16rem] flex-col items-start gap-2">
        {/* 現在地と、その状態を横に並べる。
            状態を下の段に置くと、地図が見える面積を余計に削るため */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={startWatch}
            className="flex shrink-0 items-center gap-2 rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 shadow-md transition hover:bg-white active:scale-95"
          >
            <span
              className={`inline-block h-2.5 w-2.5 rounded-full ${
                geoState === "on"
                  ? "bg-blue-500"
                  : geoState === "asking"
                    ? "bg-amber-400"
                    : geoState === "rough"
                      ? "bg-amber-500"
                      : "bg-slate-300"
              }`}
            />
            {T("現在地")}
          </button>

          {/* 順調なあいだは短く。うまくいかないときだけ下に詳しく出す */}
          {geoState === "asking" && (
            <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-bold text-amber-600 shadow-sm">
              {lang === "en" ? "Finding…" : "取得中…"}
            </span>
          )}
          {(geoState === "on" || geoState === "rough") && (
            <span
              className={`rounded-full bg-white px-2.5 py-1 text-[11px] font-bold shadow-sm ${
                geoState === "on" ? "text-emerald-600" : "text-amber-600"
              }`}
              title={
                geoState === "on"
                  ? T("衛星で測れています（GPS・みちびき等）")
                  : T("いまは Wi-Fi や基地局からの推定です。空の見える場所で少し待つと、衛星に切り替わります")
              }
            >
              {geoState === "on" ? "🛰" : "📶"} ±{Math.round(fix?.accuracy ?? 0)}m
            </span>
          )}
          {/* 敷地の外。右上のログイン表示と重なるので短く出す。
              1km より遠いときは現在地そのものを出していないので、
              点が消えている理由が分かるよう「遠い」と添える */}
          {(geoState === "on" || geoState === "rough") && inCampus === false && (
            <span
              className={`rounded-full bg-white px-2.5 py-1 text-[11px] font-bold shadow-sm ${
                tooFar ? "text-rose-600" : "text-slate-500"
              }`}
              title={
                tooFar
                  ? T("構内から 1km 以上離れています。この範囲では現在地を出しません")
                  : T("構内の外にいます")
              }
            >
              {tooFar
                ? lang === "en"
                  ? "Off campus · far"
                  : "キャンパス外・遠い"
                : lang === "en"
                  ? "Off campus"
                  : "圏外"}
            </span>
          )}
        </div>

        <button
          onClick={() => setPanel(true)}
          className="rounded-full bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white shadow-md transition hover:bg-slate-800 active:scale-95"
        >
          {T("案内")}
        </button>

        {/* お気に入り。案内と学内の情報のあいだに置く */}
        <button
          onClick={() => setFavPanel(true)}
          aria-label="お気に入り"
          title="お気に入り"
          className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-lg shadow-md transition hover:bg-white active:scale-95"
        >
          <span className={favs.length ? "text-amber-500" : "text-slate-300"}>★</span>
        </button>

        {/* 学内の情報。四角いボタンを押すと横に開く */}
        <div className="flex items-start gap-2">
          <button
            onClick={() => setSide((v) => !v)}
            aria-label="学内の情報"
            className="flex h-11 w-11 shrink-0 flex-col items-center justify-center gap-1 rounded-xl bg-white shadow-md transition hover:bg-white active:scale-95"
          >
            <span className={`block h-0.5 w-5 rounded-full bg-slate-700 transition ${side ? "translate-y-[6px] rotate-45" : ""}`} />
            <span className={`block h-0.5 w-5 rounded-full bg-slate-700 transition ${side ? "opacity-0" : ""}`} />
            <span className={`block h-0.5 w-5 rounded-full bg-slate-700 transition ${side ? "-translate-y-[6px] -rotate-45" : ""}`} />
          </button>
        </div>

        {/* 言葉の切り替え。サイドバーの下に置く。
            英語のあいだは光らせて、いま切り替わっていることを見せる */}
        <button
          onClick={toggleLang}
          aria-label={lang === "ja" ? "Switch to English" : "日本語に切り替え"}
          className={`flex h-11 w-11 items-center justify-center rounded-xl text-[11px] font-bold shadow-md transition active:scale-95 ${
            lang === "en"
              ? "bg-blue-600 text-white shadow-blue-500/50 ring-2 ring-blue-300"
              : "bg-white/95 text-slate-700 hover:bg-white"
          }`}
        >
          {lang === "en" ? "EN" : "あ"}
        </button>

        {/* 出発地を押した直後。次に何をすればよいかを出す */}
        {pickedFrom && (
          <div className="flex max-w-[16rem] items-center gap-2 rounded-2xl bg-blue-600 px-3 py-2 text-[11px] font-bold text-white shadow-md">
            <span className="min-w-0">
              <span className="block truncate">出発：{pickedFrom.title}</span>
              <span className="block font-normal text-blue-100">
                {T("次に目的地のラベルを押してください")}
              </span>
            </span>
            <button
              onClick={() => setPickedFrom(null)}
              className="ml-auto shrink-0 rounded-full bg-blue-500 px-2 py-1 text-[10px] font-bold"
            >
              {T("やめる")}
            </button>
          </div>
        )}

        {/* うまくいかないときだけ、原因と次の手を詳しく出す。
            順調なあいだは現在地の横の短い表示だけで足りる */}
        {!geoMuted &&
          (geoState === "denied" ||
            geoState === "timeout" ||
            geoState === "unavailable" ||
            geoState === "insecure") && (
            <div className="flex max-w-[15rem] items-start gap-1.5 rounded-2xl bg-white py-1.5 pl-3 pr-1.5 text-[11px] font-medium leading-snug text-slate-600 shadow-sm">
              <div className="min-w-0 flex-1">
                {geoState === "denied" && "現在地が拒否されています"}
                {geoState === "timeout" && "測位できませんでした"}
                {geoState === "unavailable" && "現在地を取得できませんでした"}
                {geoState === "insecure" && "この接続では現在地を使えません"}

                {/* 詳しい説明は畳んでおく。開いたままだと地図が見えなくなる */}
                {geoHelp && (
                  <span className="mt-1 block text-[10px] leading-relaxed text-slate-400">
                    {geoState === "timeout" &&
                      T("屋内では取得しにくくなります。窓際か屋外でお試しください")}
                    {geoState === "insecure" &&
                      T("HTTPS でないと位置情報は使えません。公開URL（https://）から開いてください")}
                    {geoState === "unavailable" &&
                      T("この端末では位置情報を扱えないようです。建物一覧から目的地を選べます")}
                  </span>
                )}

                <span className="mt-1 flex flex-wrap items-center gap-1.5">
                  {geoState !== "insecure" && geoState !== "unavailable" && (
                    <button
                      onClick={startWatch}
                      className="rounded-full bg-slate-900 px-2.5 py-1 text-[10px] font-bold text-white active:scale-95"
                    >
                      {geoState === "denied" ? T("許可し直したら押す") : T("もう一度試す")}
                    </button>
                  )}
                  <button
                    onClick={toggleGeoHelp}
                    className="text-[10px] text-slate-400 underline active:scale-95"
                  >
                    {geoHelp && geoState !== "denied" ? T("閉じる") : T("直し方")}
                  </button>
                </span>
              </div>

              {/* 現在地はもう要らない、という人のための×。
                  押すと知らせを消し、取りにいくのもやめる */}
              <button
                onClick={muteGeo}
                aria-label="現在地を使わない"
                title="現在地を使わない"
                className="-mt-0.5 shrink-0 rounded-full px-1.5 py-0.5 text-[13px] font-bold leading-none text-slate-400 hover:bg-slate-100 hover:text-slate-700 active:scale-90"
              >
                ×
              </button>
            </div>
          )}
      </div>

      {/*
        現在地を拒否されたときの直し方。
        手順はブラウザごとに別物なので、まずどちらかを選んでもらう。
        狭い吹き出しに詰め込むと読めないので、開いたら前面に出す。
      */}
      {geoHelp && geoState === "denied" && !geoMuted && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
          <div className="max-h-full w-full max-w-xs overflow-y-auto rounded-2xl bg-white p-4 shadow-2xl">
            <h2 className="text-sm font-bold tracking-tight text-slate-900">
              {T("現在地の許可を直す")}
            </h2>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
              {T("お使いのブラウザを選んでください")}
            </p>

            <div className="mt-2 grid grid-cols-2 gap-1.5">
              {(["safari", "chrome"] as const).map((b) => (
                <button
                  key={b}
                  onClick={() => setHelpBrowser(b)}
                  className={`rounded-xl px-3 py-2 text-xs font-bold transition active:scale-95 ${
                    helpBrowser === b
                      ? "bg-slate-900 text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {b === "safari" ? "Safari" : "Google Chrome"}
                </button>
              ))}
            </div>

            {/* 端末は名乗りから決めているが、外れることがあるので選び直せる */}
            <div className="mt-1.5 flex gap-1.5">
              {(
                [
                  ["ios", "iPhone / iPad"],
                  ["android", "Android"],
                  ["desktop", T("パソコン")],
                ] as const
              ).map(([p, label]) => (
                <button
                  key={p}
                  onClick={() => setHelpPlatform(p)}
                  className={`flex-1 rounded-lg px-1 py-1.5 text-[10px] font-bold transition active:scale-95 ${
                    helpPlatform === p
                      ? "bg-blue-600 text-white"
                      : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <ol className="mt-3 flex flex-col gap-2">
              {(lang === "en" ? locationStepsEn : locationSteps)(helpBrowser, helpPlatform).map(
                (s, i) => (
                  <li key={i} className="flex gap-2 text-[11px] leading-relaxed text-slate-700">
                    <span className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-slate-900 text-[9px] font-bold text-white">
                      {i + 1}
                    </span>
                    <span className="min-w-0">{s}</span>
                  </li>
                ),
              )}
            </ol>

            <div className="mt-4 flex gap-1.5">
              <button
                onClick={() => {
                  setGeoHelp(false);
                  startWatch();
                }}
                className="flex-1 rounded-xl bg-slate-900 px-3 py-2.5 text-xs font-bold text-white active:scale-95"
              >
                {T("許可し直したら押す")}
              </button>
              <button
                onClick={() => setGeoHelp(false)}
                className="rounded-xl bg-slate-100 px-3 py-2.5 text-xs font-bold text-slate-600 active:scale-95"
              >
                {T("閉じる")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ログイン。フェーズ2で実際に動くようにする */}
      {login && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-xs rounded-2xl bg-white p-5 shadow-2xl">
            <h2 className="text-base font-bold tracking-tight text-slate-900">ログイン</h2>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
              大学のアカウントのみ利用できます。承認された学生・教職員が対象です。
            </p>
            <a
              href="/login"
              className="mt-3 block w-full rounded-xl bg-blue-600 px-4 py-2.5 text-center text-sm font-bold text-white transition hover:bg-blue-700"
            >
              ログイン画面へ
            </a>
            <button
              onClick={() => setLogin(false)}
              className="mt-2 w-full rounded-xl px-4 py-2 text-xs font-semibold text-slate-500 transition hover:bg-slate-100"
            >
              閉じる
            </button>
          </div>
        </div>
      )}

      {/* お気に入りを選ぶ。ここで付けたものが、案内の候補と一覧の先頭に出る */}
      {favPanel && (
        <div className="absolute inset-0 z-30 flex items-start justify-center bg-slate-900/30 p-4 backdrop-blur-sm">
          <div className="mt-4 flex max-h-[calc(100dvh-4rem)] w-full max-w-md flex-col rounded-2xl bg-white p-4 shadow-2xl">
            <div className="mb-2 flex shrink-0 items-center justify-between">
              <h2 className="text-base font-bold text-slate-900">{T("お気に入り")}</h2>
              <button
                onClick={() => setFavPanel(false)}
                className="rounded-full px-3 py-1 text-sm font-medium text-slate-500 transition hover:bg-slate-100"
              >
                {T("閉じる")}
              </button>
            </div>
            <p className="mb-2 shrink-0 text-[11px] leading-relaxed text-slate-500">
              よく行く場所に★を付けると、案内の入力欄と建物一覧のいちばん上に出ます。
              {favs.length > 0 && <span className="ml-1 font-bold text-slate-700">{favs.length}件</span>}
            </p>
            <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {listed.map(({ f, label, renamed }) => {
                const on = favs.includes(f.properties.tempId);
                return (
                  <li key={f.properties.tempId}>
                    <button
                      onClick={() => toggleFav(f.properties.tempId)}
                      className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition ${
                        on ? "bg-amber-50" : "hover:bg-slate-50"
                      }`}
                    >
                      <span className={`text-lg ${on ? "text-amber-500" : "text-slate-300"}`}>★</span>
                      <span
                        className={`min-w-0 truncate text-sm ${
                          on ? "font-bold text-slate-900" : "text-slate-700"
                        }`}
                      >
                        {renamed ? label : P(label)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}

      {/* 建物一覧。下からせり上がって広がる */}
      {listed.length > 0 && (
        <div
          className="absolute inset-x-0 bottom-0 z-10 overflow-hidden rounded-t-3xl bg-white shadow-2xl"
          style={{
            height: listOpen ? "58dvh" : "3.25rem",
            transition: "height 350ms cubic-bezier(0.32,0.72,0,1)",
          }}
        >
          <button
            onClick={() => setListOpen((v) => !v)}
            // 上下のスワイプ／ホイールでも開閉できるようにする
            onWheel={(e) => setListOpen(e.deltaY < 0)}
            onTouchStart={(e) => {
              touchY.current = e.touches[0].clientY;
            }}
            onTouchMove={(e) => {
              if (touchY.current == null) return;
              const dy = touchY.current - e.touches[0].clientY;
              if (Math.abs(dy) < 24) return; // 誤反応を防ぐ
              setListOpen(dy > 0); // 上へ動かせば開く
              touchY.current = null;
            }}
            onTouchEnd={() => {
              touchY.current = null;
            }}
            className="w-full px-4 pb-2 pt-2.5 transition hover:bg-slate-50"
          >
            <span className="mx-auto mb-1.5 block h-1 w-10 rounded-full bg-slate-300" />
            <span className="flex items-center justify-center gap-1.5 text-[12px] font-bold text-slate-700">
              {T("建物一覧")}
              <span className="font-normal text-slate-400">{listed.length}</span>
              <span
                className="text-slate-400 transition"
                style={{ transform: listOpen ? "rotate(180deg)" : "none" }}
              >
                ▲
              </span>
            </span>
          </button>

          {/* 開いているときだけ中身を出す。2列にして一覧性を上げる */}
          <div
            className="h-[calc(58dvh-3.25rem)] overflow-y-auto overscroll-contain px-3 pb-4"
            style={{ opacity: listOpen ? 1 : 0, transition: "opacity 200ms" }}
          >
            <ul className="grid grid-cols-2 gap-1 sm:grid-cols-3">
              {/* お気に入りがあれば、いちばん上にまとめて出す */}
              {favListed.length > 0 && (
                <li className="col-span-full pb-1 text-[10px] font-bold text-amber-600">
                  {T("★ お気に入り")}
                </li>
              )}
              {favListed.map(({ f, label, renamed }) => {
                const on = focusId === f.properties.tempId;
                return (
                  <li key={`fav-${f.properties.tempId}`}>
                    <div
                      className={`flex overflow-hidden rounded-lg ring-1 ${
                        on ? "bg-orange-500 ring-orange-500" : "bg-amber-50 ring-amber-200"
                      }`}
                    >
                      <button
                        onClick={() =>
                          focusBuilding(f.geometry.coordinates[0], f.properties.tempId)
                        }
                        className={`min-w-0 flex-1 truncate px-3 py-2 text-left text-[12px] font-medium transition ${
                          on ? "text-white" : "text-slate-800 hover:bg-amber-100"
                        }`}
                      >
                        {renamed ? label : P(label)}
                      </button>
                      <button
                        onClick={() => {
                          const d = {
                            buildingId: f.properties.tempId,
                            title: label,
                            sub: "",
                            score: 0,
                          };
                          setOrigin({ kind: "me" });
                          setDest(d);
                          setTrip({ origin: { kind: "me" }, dest: d });
                          setArrived(false);
                          setFocusId(f.properties.tempId);
                          setListOpen(false);
                          ensureWatch();
                        }}
                        className={`shrink-0 px-2.5 text-[11px] font-bold transition ${
                          on
                            ? "bg-orange-600 text-white hover:bg-orange-700"
                            : "bg-amber-200 text-amber-900 hover:bg-blue-600 hover:text-white"
                        }`}
                      >
                        {T("案内")}
                      </button>
                    </div>
                  </li>
                );
              })}

              {listed.map(({ f, label, renamed, key }, i) => {
                const on = focusId === f.properties.tempId;
                // 区切りが変わったところに見出しを挟む。
                // 列をまたいで一行使いたいので col-span-full にする
                const head =
                  key[0] !== listed[i - 1]?.key[0] ? GROUP_LABEL[key[0]] : undefined;
                return (
                  <Fragment key={f.properties.tempId}>
                    {head && (
                      <li className="col-span-full mt-2 first:mt-0">
                        <div className="border-t border-slate-200 pb-1 pt-2 text-[10px] font-bold text-slate-400">
                          {head}
                        </div>
                      </li>
                    )}
                  <li>
                    <div
                      className={`flex overflow-hidden rounded-lg ${
                        on ? "bg-orange-500" : "bg-slate-100"
                      }`}
                    >
                      {/* 名前を押すとその場所へ寄る */}
                      <button
                        onClick={() =>
                          focusBuilding(f.geometry.coordinates[0], f.properties.tempId)
                        }
                        className={`min-w-0 flex-1 truncate px-3 py-2 text-left text-[12px] font-medium transition ${
                          on ? "text-white" : "text-slate-700 hover:bg-slate-200"
                        }`}
                      >
                        {renamed ? label : P(label)}
                      </button>
                      {/* ［案内］を押すだけでそこへの案内が始まる */}
                      <button
                        onClick={() => {
                          const dest = {
                            buildingId: f.properties.tempId,
                            title: label,
                            sub: "",
                            score: 0,
                          };
                          setOrigin({ kind: "me" });
                          setDest(dest);
                          setTrip({ origin: { kind: "me" }, dest });
                          setArrived(false);
                          setFocusId(f.properties.tempId);
                          setListOpen(false);
                          ensureWatch();
                        }}
                        className={`shrink-0 px-2.5 text-[11px] font-bold transition ${
                          on
                            ? "bg-orange-600 text-white hover:bg-orange-700"
                            : "bg-slate-200 text-slate-600 hover:bg-blue-600 hover:text-white"
                        }`}
                      >
                        {T("案内")}
                      </button>
                    </div>
                  </li>
                  </Fragment>
                );
              })}
            </ul>
          </div>
        </div>
      )}

      {/* 出典表示。地理院タイルの利用条件で必須。一覧に隠れない位置に置く */}
      <span className="absolute bottom-0.5 right-1.5 z-30 rounded bg-white/70 px-1 text-[9px] text-slate-600">
        地理院タイル
      </span>

      {/* 到着。見逃さないよう画面の中央に大きく出す */}
      {arrived && trip && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-900/40 p-6 backdrop-blur-sm">
          <div
            className="w-full max-w-xs rounded-3xl bg-white p-6 text-center shadow-2xl"
            style={{ animation: "kitPop 320ms cubic-bezier(0.16,1,0.3,1)" }}
          >
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500 text-2xl text-white">
              ✓
            </div>
            <p className="mt-3 text-[11px] font-semibold tracking-widest text-emerald-600">
              {T("到着しました")}
            </p>
            <p className="mt-1 text-lg font-bold leading-snug text-slate-900">
              {P(trip.dest.title)}
            </p>

            {/* 建物の前まで来ただけなので、中の何階かをここで大きく伝える。
                案内はここで終わりで、あとは階を頼りに進んでもらう */}
            {trip.dest.sub ? (
              <div className="mt-3 rounded-2xl bg-emerald-50 px-3 py-3">
                <p className="text-[10px] font-bold tracking-widest text-emerald-700">
                  {T("建物の中では")}
                </p>
                <p className="mt-0.5 text-2xl font-bold text-emerald-900">{floorLabelIn(lang, trip.dest.sub)}</p>
                <p className="mt-0.5 text-[11px] text-emerald-700">
                  {T("ここから中に入って、この階へ向かってください")}
                </p>
              </div>
            ) : (
              <p className="mt-2 text-[11px] text-slate-500">{T("建物の前に着きました")}</p>
            )}
            <button
              onClick={() => {
                setArrived(false);
                setTrip(null);
              }}
              className="mt-4 w-full rounded-xl bg-slate-900 px-4 py-3 text-sm font-bold text-white transition hover:bg-slate-800"
            >
              {T("案内を終える")}
            </button>
            <button
              onClick={() => setArrived(false)}
              className="mt-1.5 w-full rounded-xl px-4 py-2 text-xs font-semibold text-slate-500 transition hover:bg-slate-100"
            >
              {T("地図に戻る")}
            </button>
          </div>
        </div>
      )}

      {/* 経路検索のパネル */}
      {panel && data && (
        <div className="absolute inset-0 z-20 flex items-start justify-center bg-slate-900/30 p-4 backdrop-blur-sm">
          <div className="mt-4 w-full max-w-md rounded-2xl bg-white p-4 shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <h1 className="text-base font-bold tracking-tight text-slate-900">KIT map</h1>
              <button
                onClick={() => setPanel(false)}
                className="rounded-full px-3 py-1 text-sm font-medium text-slate-500 transition hover:bg-slate-100"
              >
                {T("閉じる")}
              </button>
            </div>

            <Field
              label={T("出発地")}
              data={data}
              value={origin.kind === "me" ? "現在地" : origin.hit.title}
              allowMe
              onMe={() => setOrigin({ kind: "me" })}
              onPick={(h) => setOrigin({ kind: "place", hit: h })}
              favs={favHits}
              lang={lang}
            />
            <div className="h-2" />
            <Field
              label={T("目的地")}
              data={data}
              value={dest?.title ?? ""}
              onPick={(h) => setDest(h)}
              favs={favHits}
              lang={lang}
            />

            {/* 教室は承認された人だけが見られる。未ログインには理由を伝える */}
            {!canViewCampusInfo(role) && (
              <p className="mt-2 rounded-xl bg-slate-100 p-2.5 text-[10px] leading-relaxed text-slate-500">
                いまは<b>建物どうしの案内</b>だけ使えます。
                教室（何号館の何階の何番）で探すには、
                <a href="/login" className="font-bold text-blue-600 underline">
                  ログイン
                </a>
                して管理者の承認を受けてください。
              </p>
            )}

            <button
              disabled={!dest}
              onClick={() => {
                if (!dest) return;
                if (origin.kind === "me") ensureWatch();
                setTrip({ origin, dest });
                setArrived(false);
                setPanel(false);
              }}
              className="mt-4 w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-blue-700 active:scale-[0.99] disabled:bg-slate-200 disabled:text-slate-400"
            >
              {dest ? "案内をはじめる" : "目的地を選んでください"}
            </button>
          </div>
        </div>
      )}

      {/* 案内中。手順の一覧は出さず、地図の道と最小限の情報だけ見せる */}
      {trip && (
        <div className="absolute bottom-16 left-4 z-20 w-[min(18rem,calc(100%-2rem))]">
          <div className="flex items-center gap-2 rounded-full bg-white py-2 pl-4 pr-2 shadow-md">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-bold leading-tight text-slate-900">
                {P(trip.dest.title)}
              </div>
              <div className="truncate text-[11px] leading-tight text-slate-500">
                {route && !("error" in route)
                  ? `${route.fromGate ? "正門" : trip.origin.kind === "me" ? "現在地" : trip.origin.hit.title} から 徒歩${route.minutes}分・${route.meters}m`
                  : route && "error" in route
                    ? route.error
                    : "計算中…"}
              </div>
            </div>
            {/* 「✕」だけでは何が消えるのか分からないので、言葉で書く */}
            <button
              onClick={() => {
                setTrip(null);
                setArrived(false);
                setFocusId(null);
                setPickedFrom(null);
                setAvoidInside(false);
              }}
              className="shrink-0 rounded-full bg-slate-900 px-3 py-2 text-xs font-bold text-white transition hover:bg-slate-800 active:scale-95"
            >
              {T("案内を消す")}
            </button>
          </div>

          {/* 目的地の階は、着く前から見えるようにしておく。
              建物の前で初めて知るより、道中で分かっていたほうが動きやすい */}
          {trip.dest.sub && (
            <div className="mt-1.5 flex w-fit items-center gap-1.5 rounded-full bg-emerald-600 px-3 py-1 text-[11px] font-bold text-white shadow">
              <span className="opacity-80">{T("建物の中では")}</span>
              <span className="text-[13px]">{floorLabelIn(lang, trip.dest.sub)}</span>
            </div>
          )}

          {/*
            建物の中を通る道すじのときだけ、外だけで行く道すじに替えられる。
            中を通らない道すじなら出す意味が無いので出さない。
          */}
          {route && !("error" in route) && (route.inside || avoidInside) && (
            <button
              onClick={() => setAvoidInside((v) => !v)}
              className={`mt-1.5 flex w-fit items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold shadow-md transition active:scale-95 ${
                avoidInside ? "bg-sky-600 text-white" : "bg-white text-slate-700"
              }`}
            >
              <span className="text-[13px]">{avoidInside ? "🚶" : "🏢"}</span>
              {avoidInside ? T("建物の中も通る") : T("建物の中を通らない")}
            </button>
          )}
          {route && !("error" in route) && route.outdoorFailed && (
            <div className="mt-1.5 w-fit rounded-full bg-amber-100 px-3 py-1 text-[11px] font-bold text-amber-900 shadow">
              {T("外だけでは行けないので、中を通っています")}
            </div>
          )}

          {/* 経路を追って動かしたあと、最初の画角へ戻す。
              案内は消さずに地図だけ戻すので、全体を見てから続きを追える */}
          <button
            onClick={() => fitHome(500)}
            className="mt-1.5 flex w-fit items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-[11px] font-bold text-slate-700 shadow-md transition hover:bg-white active:scale-95"
          >
            <span className="text-[13px]">⤢</span>
            {lang === "en" ? "Whole campus" : "全体に戻す"}
          </button>
        </div>
      )}
    </div>
  );
}

/** 起動画面の中身。上下の半分に同じものを置き、割れ目で切り取って1つに見せる */
function SplashInner() {
  return (
    <>
      <div
        className="text-4xl font-light tracking-[0.18em] text-white"
        style={{ animation: "kitRise 900ms cubic-bezier(0.16,1,0.3,1)" }}
      >
        KIT<span className="ml-2 font-semibold">map</span>
      </div>
      {/* 起動画面は言葉を切り替える前に出るので、日本語のまま */}
      <div className="mt-10 text-[10px] tracking-wider text-white/25">
        金沢工業大学 扇が丘キャンパス
      </div>
    </>
  );
}

/* ---------------- 場所を選ぶ欄 ---------------- */

function Field({
  label,
  data,
  value,
  allowMe,
  onMe,
  onPick,
  favs,
  lang,
}: {
  label: string;
  data: AppData;
  value: string;
  allowMe?: boolean;
  onMe?: () => void;
  onPick: (h: SearchHit) => void;
  favs: SearchHit[];
  lang: Lang;
}) {
  const T = (ja: string) => t(lang, ja);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const hits = useMemo(() => (q ? search(data, q) : []), [data, q]);

  /**
   * 出すお気に入り。
   *
   * 何も打っていないうちは全部出す。打ち始めたら、その語に当たるものだけ残す。
   * 当たらないお気に入りが居座ると、探しているものが埋もれるため。
   */
  const shownFavs = useMemo(
    () => favs.filter((f) => matchesQuery(f.title, q)),
    [favs, q],
  );

  return (
    <div>
      <label className="mb-1 block text-[11px] font-semibold text-slate-500">{label}</label>
      <input
        value={open ? q : value}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          setQ("");
          setOpen(true);
        }}
        placeholder="23号館 / 23 302 / 図書館"
        className="w-full rounded-xl bg-slate-100 px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:bg-white focus:ring-2 focus:ring-blue-500"
      />
      {open && (
        <ul className="mt-1 max-h-48 overflow-y-auto rounded-xl bg-white shadow-lg ring-1 ring-slate-200">
          {/* 出発地では「現在地」を必ず先頭に。お気に入りはその下 */}
          {allowMe && (
            <li>
              <button
                onClick={() => {
                  onMe?.();
                  setOpen(false);
                }}
                className="w-full px-4 py-2.5 text-left text-sm font-semibold text-blue-600 transition hover:bg-slate-50"
              >
                {T("現在地を使う")}
              </button>
            </li>
          )}
          {shownFavs.length > 0 && (
            <li className="bg-amber-50 px-4 py-1 text-[10px] font-bold text-amber-700">
              {T("★ お気に入り")}
            </li>
          )}
          {shownFavs.map((h) => (
            <li key={`fav-${h.buildingId}`}>
              <button
                onClick={() => {
                  onPick(h);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm transition hover:bg-amber-50"
              >
                <span className="text-amber-500">★</span>
                <span className="font-semibold text-slate-900">{h.title}</span>
              </button>
            </li>
          ))}
          {shownFavs.length > 0 && hits.length > 0 && (
            <li className="border-t border-slate-100" />
          )}
          {hits.map((h, i) => (
            <li key={`${h.buildingId}-${i}`}>
              <button
                onClick={() => {
                  onPick(h);
                  setOpen(false);
                }}
                className="w-full px-4 py-2.5 text-left text-sm transition hover:bg-slate-50"
              >
                <span className="font-semibold text-slate-900">{h.title}</span>
                {h.sub && <span className="ml-2 text-xs text-slate-500">{h.sub}</span>}
              </button>
            </li>
          ))}
          {q && hits.length === 0 && (
            <li className="px-4 py-3 text-xs text-slate-400">見つかりません</li>
          )}
        </ul>
      )}
    </div>
  );
}

/**
 * 点が輪の中にあるか。辺との交差数が奇数なら中にいる。
 * 敷地が複数あるので、面ごとにこれで確かめる。
 */
function inRing(poly: Position[], at: Position): boolean {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > at[1] !== yj > at[1] && at[0] < ((xj - xi) * (at[1] - yi)) / (yj - yi) + xi) {
      ins = !ins;
    }
  }
  return ins;
}

/**
 * 拡大したときだけ地図に名前を出す建物。
 *
 * 構内から離れた場所なので、引いた状態では出さない。
 * 出しっぱなしにすると、遠くの名前が構内の名前と場所を取り合ってしまう。
 * 建物の一覧にはいつでも出す。
 */
const ZOOM_ONLY_NAMES = new Set(["野々市工大前駅", "バス停"]);
/** この縮尺より寄ったら、上の名前も出す */
const ZOOM_ONLY_AT = 17.5;


/* ---------------- 補助 ---------------- */

