/**
 * xlsx を書く。必要な範囲だけ。
 *
 * ■ なぜ自前で書いたか
 *   読むほう（lib/xlsx.ts）と同じ理由。よく使われる SheetJS には
 *   直っていない「高」の脆弱性があり、名簿を出し入れするためだけに
 *   それを抱え込むのは割に合わない。
 *
 *   こちらが書く必要があるのは「文字が並んだ表」だけ。
 *   数式も書式も色も要らない。それなら短く書ける。
 *
 * ■ どう作るか
 *   xlsx は ZIP。中に決まった名前の XML を入れる。
 *
 *     [Content_Types].xml        何が入っているかの目録
 *     _rels/.rels                入口
 *     xl/workbook.xml            シートの名前と並び
 *     xl/_rels/workbook.xml.rels シートの実体への道
 *     xl/worksheets/sheetN.xml   升目
 *
 *   圧縮はしない（ZIP の「そのまま入れる」形）。名簿の大きさなら
 *   数百KB で収まるし、圧縮を挟むと失敗する道が一つ増える。
 *
 * ■ 中身はすべて文字として書く
 *   数として書くと、頭の 0 が落ちる。「08」が「8」になると、
 *   学籍番号や 8桁の番号が別のものになってしまう。
 *   読むほうは数字に直せるので、書くほうは文字のままでよい。
 */

/** 一枚ぶん。rows の一つ目が見出しの行 */
export type Sheet = {
  name: string;
  rows: string[][];
};

/* ---------------- ZIP ---------------- */

/** CRC32 の表。ZIP の目録に入れる検査値に要る */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

type Item = { name: string; data: Uint8Array };

/**
 * ZIP にまとめる。圧縮はしない（method 0）。
 *
 * 目次（central directory）を末尾に置く形。読むほうもそこから辿る。
 */
function zip(items: Item[]): Blob {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const dirs: Uint8Array[] = [];
  let at = 0;

  for (const it of items) {
    const name = enc.encode(it.name);
    const crc = crc32(it.data);
    const n = it.data.length;

    // ファイルの手前の見出し（PK\03\04）
    const lh = new Uint8Array(30 + name.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // 要る版
    lv.setUint16(6, 0, true); // 目印
    lv.setUint16(8, 0, true); // 圧縮しない
    lv.setUint16(10, 0, true); // 時刻
    lv.setUint16(12, 0, true); // 日付
    lv.setUint32(14, crc, true);
    lv.setUint32(18, n, true);
    lv.setUint32(22, n, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    lh.set(name, 30);

    // 目次の一行（PK\01\02）
    const dh = new Uint8Array(46 + name.length);
    const dv = new DataView(dh.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(8, 0, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, 0, true);
    dv.setUint16(14, 0, true);
    dv.setUint32(16, crc, true);
    dv.setUint32(20, n, true);
    dv.setUint32(24, n, true);
    dv.setUint16(28, name.length, true);
    dv.setUint16(30, 0, true);
    dv.setUint16(32, 0, true);
    dv.setUint16(34, 0, true);
    dv.setUint16(36, 0, true);
    dv.setUint32(38, 0, true);
    dv.setUint32(42, at, true); // その中身がどこから始まるか
    dh.set(name, 46);

    locals.push(lh, it.data);
    dirs.push(dh);
    at += lh.length + n;
  }

  const dirSize = dirs.reduce((s, d) => s + d.length, 0);
  // 目次の終わりの印（PK\05\06）
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, items.length, true);
  ev.setUint16(10, items.length, true);
  ev.setUint32(12, dirSize, true);
  ev.setUint32(16, at, true);

  /*
   * BlobPart へ渡すために、一本につなぐ。
   * 断片のまま渡すと、端末によっては並びの型が合わないと言われる。
   */
  const total = locals.reduce((s, b) => s + b.length, 0) + dirSize + end.length;
  const all = new Uint8Array(total);
  let at2 = 0;
  for (const b of [...locals, ...dirs, end]) {
    all.set(b, at2);
    at2 += b.length;
  }

  return new Blob([all.buffer as ArrayBuffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

/* ---------------- XML ---------------- */

function esc(s: string): string {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    /*
     * XML に入れられない字を落とす。
     * 名前に紛れ込んだ制御文字で、ファイルごと開けなくなるのを防ぐ。
     */
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

/** 0 → "A"、26 → "AA" */
function colName(n: number): string {
  let s = "";
  let i = n;
  do {
    s = String.fromCharCode(65 + (i % 26)) + s;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return s;
}

/**
 * シートの名前を、Excel が受け取れる形に直す。
 *   使えない字（: \ / ? * [ ]）を落とし、31 字までにする。
 */
function sheetName(s: string, i: number): string {
  const t = (s ?? "").replace(/[:\\/?*[\]]/g, "").slice(0, 31);
  return t === "" ? `シート${i + 1}` : t;
}

function sheetXml(rows: string[][]): string {
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>',
  ];
  rows.forEach((cells, r) => {
    out.push(`<row r="${r + 1}">`);
    cells.forEach((v, c) => {
      if (v === "" || v === null || v === undefined) return;
      // すべて文字として書く（頭の 0 を落とさないため）
      out.push(
        `<c r="${colName(c)}${r + 1}" t="inlineStr"><is><t xml:space="preserve">${esc(
          String(v),
        )}</t></is></c>`,
      );
    });
    out.push("</row>");
  });
  out.push("</sheetData></worksheet>");
  return out.join("");
}

/* ---------------- 入口 ---------------- */

/**
 * シートの並びから xlsx を作る。
 *
 * 一枚目の行がそのまま一行目（見出し）になる。
 * 中身をどう並べるかは、呼ぶ側が決める。
 */
export function buildXlsx(sheets: Sheet[]): Blob {
  const enc = new TextEncoder();
  const list = sheets.length > 0 ? sheets : [{ name: "シート1", rows: [[""]] }];

  const items: Item[] = [];

  items.push({
    name: "[Content_Types].xml",
    data: enc.encode(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        list
          .map(
            (_, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join("") +
        "</Types>",
    ),
  });

  items.push({
    name: "_rels/.rels",
    data: enc.encode(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        "</Relationships>",
    ),
  });

  items.push({
    name: "xl/workbook.xml",
    data: enc.encode(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
        ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        list
          .map(
            (s, i) =>
              `<sheet name="${esc(sheetName(s.name, i))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
          )
          .join("") +
        "</sheets></workbook>",
    ),
  });

  items.push({
    name: "xl/_rels/workbook.xml.rels",
    data: enc.encode(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        list
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
          )
          .join("") +
        "</Relationships>",
    ),
  });

  list.forEach((s, i) => {
    items.push({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: enc.encode(sheetXml(s.rows)),
    });
  });

  return zip(items);
}

/** 作った xlsx を、その場で保存させる */
export function saveXlsx(sheets: Sheet[], fileName: string): void {
  const url = URL.createObjectURL(buildXlsx(sheets));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // すぐ消すと、端末によっては保存が始まる前に消えてしまう
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
