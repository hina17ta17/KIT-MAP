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
 * ■ 中身は一切変えない
 *   以前は座標を7桁に丸めていた。読み込む量は減るが、
 *   下書きと公開データが別物になる。作った通りのものを置く。
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

/** 受け取ってよいファイルの名前。ここに無いものは書かない */
const NAMES = ["campus", "buildings", "paths", "checkpoints", "links"] as const;
type Name = (typeof NAMES)[number];

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
    const text = JSON.stringify(v);
    await writeFile(path.join(dir, `${name}.geojson`), text, "utf8");
    wrote.push({ name, features: count(v), bytes: text.length });
  }

  if (wrote.length === 0) {
    return NextResponse.json({ error: "書き込むものがありませんでした" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, wrote });
}
