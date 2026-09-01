/**
 * 作図ツールの下書きを、そのまま公開データに書き込む。
 *
 * ■ なぜ要るか
 *   これまでは［入出力］から4つのファイルを落とし、それを手で
 *   public/data へ置いていた。手数が多いうえ、落としたのが
 *   いつの下書きなのか分からなくなる。実際に、5時間前の書き出しを
 *   最新だと思って公開してしまった。
 *
 *   いま画面に出ている下書きを、そのまま書き込めるようにする。
 *
 * ■ 手元でだけ動く
 *   ファイル名が route.dev.ts なので、next.config.ts の pageExtensions に
 *   よって公開ビルドには入らない（経路そのものが作られない）。
 *   念のため、中でも開発中かどうかを見ている。
 *
 * ■ 座標は7桁に丸める
 *   下書きの座標は小数点以下13桁ある。7桁は約1cm で、GPS の誤差より
 *   ずっと細かい。丸めても実測でいちばん動くもので 7mm。
 *   そのままだと利用者が読み込む量が1.5倍になる。
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

/** 受け取ってよいファイルの名前。ここに無いものは書かない */
const NAMES = ["campus", "buildings", "paths", "checkpoints", "links"] as const;
type Name = (typeof NAMES)[number];

/** 座標だけを7桁に丸める */
function round(o: unknown): unknown {
  if (Array.isArray(o)) return o.map((x) => (typeof x === "number" ? Number(x.toFixed(7)) : round(x)));
  if (o && typeof o === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) out[k] = round(v);
    return out;
  }
  return o;
}

function count(v: unknown): number {
  if (v && typeof v === "object" && Array.isArray((v as { features?: unknown[] }).features))
    return (v as { features: unknown[] }).features.length;
  return 0;
}

export async function POST(req: Request) {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "手元でだけ使えます" }, { status: 404 });
  }

  let body: Partial<Record<Name, unknown>>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "中身を読めませんでした" }, { status: 400 });
  }

  const dir = path.join(process.cwd(), "public", "data");
  const wrote: { name: string; features: number; bytes: number }[] = [];

  for (const name of NAMES) {
    const v = body[name];
    if (v === undefined) continue;
    const text = JSON.stringify(round(v));
    await writeFile(path.join(dir, `${name}.geojson`), text, "utf8");
    wrote.push({ name, features: count(v), bytes: text.length });
  }

  if (wrote.length === 0) {
    return NextResponse.json({ error: "書き込むものがありませんでした" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, wrote });
}
