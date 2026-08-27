/**
 * 経路をやり直すための「土台」を作る。
 *
 * いまの地図から、通過点（waypoint）と接続の線をすべて取り除いたものを
 * public/data/base/ に書き出す。建物・敷地・出入口はそのまま残るので、
 * 建物を描き直すことなく、歩く道すじだけを一から引き直せる。
 *
 *   node scripts/make-base-data.mjs
 *
 * 元の public/data/ には触らない。案内画面が読むのは今まで通りそちら。
 * 作図ツールの「経路なしの土台を取り込む」がここを読む。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FROM = join(process.cwd(), "public", "data");
const TO = join(FROM, "base");

/** 消す種別。「通過点」は道すじを表すための点で、道すじごと引き直す */
const DROP_KIND = "waypoint";

function read(name) {
  return JSON.parse(readFileSync(join(FROM, `${name}.geojson`), "utf8"));
}

function write(name, value) {
  writeFileSync(join(TO, `${name}.geojson`), `${JSON.stringify(value)}\n`, "utf8");
}

mkdirSync(TO, { recursive: true });

const campus = read("campus");
const buildings = read("buildings");
const checkpoints = read("checkpoints");
const links = read("links");

/* 通過点を落とす */
const kept = checkpoints.features.filter((f) => f.properties.kind !== DROP_KIND);
const keptIds = new Set(kept.map((f) => f.properties.id));

/*
 * 消えた点を親に指したままの参照を落とす。
 * 残っていると、その子には「入れない場所」として扱われてしまう。
 */
let cleaned = 0;
const features = kept.map((f) => {
  const parents = f.properties.parents ?? [];
  const alive = parents.filter((id) => keptIds.has(id));
  if (alive.length === parents.length) return f;
  cleaned += parents.length - alive.length;
  return { ...f, properties: { ...f.properties, parents: alive } };
});

/* 敷地と建物はそのまま。出入口は残し、接続だけ空にする */
write("campus", campus);
write("buildings", buildings);
write("checkpoints", { type: "FeatureCollection", features });
write("links", { type: "FeatureCollection", features: [] });

const dropped = checkpoints.features.length - kept.length;
const byKind = {};
for (const f of features) {
  const k = f.properties.kind || "(なし)";
  byKind[k] = (byKind[k] ?? 0) + 1;
}

console.log(`書き出し先: ${TO}`);
console.log(`  敷地        ${campus.features.length} 件（そのまま）`);
console.log(`  建物        ${buildings.features.length} 件（そのまま）`);
console.log(
  `  チェックポイント ${features.length} 件（${Object.entries(byKind)
    .map(([k, n]) => `${k} ${n}`)
    .join(" / ")}）— 通過点 ${dropped} 件を削除`,
);
console.log(`  接続        0 件（${links.features.length} 件を削除）`);
if (cleaned > 0) console.log(`  消えた点を指していた親の参照 ${cleaned} 件を掃除しました`);
