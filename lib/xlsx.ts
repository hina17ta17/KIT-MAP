/**
 * xlsx を読む。必要な範囲だけ。
 *
 * ■ なぜ自前で書いたか
 *   よく使われる SheetJS（npm の xlsx）は、npm に出ている版に
 *   「高」の脆弱性が2件あり、直った版が npm に出ていない。
 *     ・Prototype Pollution
 *     ・正規表現による処理の停止（ReDoS）
 *   名簿を読むだけのために、直せない穴を抱え込むのは割に合わない。
 *
 *   こちらが読む必要があるのは「A〜H列に文字か数字が並んだ表」だけ。
 *   数式も書式も色も要らない。それなら短く書ける。
 *
 * ■ xlsx の中身
 *   xlsx は ZIP。中に XML が入っている。
 *     xl/worksheets/sheet1.xml   … 升目
 *     xl/sharedStrings.xml       … 文字列は番号で参照される
 *   ZIP を解くのは、ブラウザに入っている DecompressionStream に任せる。
 *
 * ■ 読めないもの
 *   古い .xls（形式がまったく違う）、暗号化されたファイル。
 *   どちらも、その旨を出して止める。黙って空を返さない。
 */

/** 一行ぶん。A列から順に、文字にして入れる */
export type Row = string[];

/* ---------------- ZIP を解く ---------------- */

type Entry = { name: string; data: Uint8Array };

function u16(b: Uint8Array, i: number) {
  return b[i] | (b[i + 1] << 8);
}
function u32(b: Uint8Array, i: number) {
  return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
}

/**
 * ZIP の中身を取り出す。
 *
 * 末尾の「目次」（central directory）から辿る。
 * 先頭から順に舐めると、書き方の違いで位置がずれることがある。
 */
async function unzip(buf: ArrayBuffer, want: (name: string) => boolean): Promise<Entry[]> {
  const b = new Uint8Array(buf);

  // 目次の終わりの印（PK\05\06）を、末尾から探す
  let end = -1;
  for (let i = b.length - 22; i >= 0 && i > b.length - 66000; i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("xlsx として読めません（ZIP の形になっていません）");

  const count = u16(b, end + 10);
  let p = u32(b, end + 16);

  const out: Entry[] = [];
  for (let n = 0; n < count; n++) {
    if (u32(b, p) !== 0x02014b50) break; // 目次の印（PK\01\02）
    const method = u16(b, p + 10);
    const sizeC = u32(b, p + 20);
    const nameLen = u16(b, p + 28);
    const extraLen = u16(b, p + 30);
    const commentLen = u16(b, p + 32);
    const localAt = u32(b, p + 42);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (!want(name)) continue;

    // 中身の位置は、そのファイルの手前の見出しから求める
    if (u32(b, localAt) !== 0x04034b50) continue; // PK\03\04
    const lNameLen = u16(b, localAt + 26);
    const lExtraLen = u16(b, localAt + 28);
    const start = localAt + 30 + lNameLen + lExtraLen;
    const raw = b.subarray(start, start + sizeC);

    if (method === 0) {
      out.push({ name, data: raw });
      continue;
    }
    if (method !== 8) throw new Error("この xlsx は読めません（圧縮の形が違います）");

    if (typeof DecompressionStream === "undefined") {
      throw new Error("このブラウザでは xlsx を開けません。別のブラウザでお試しください");
    }
    // slice で写しを作る。subarray のままだと元の並びを巻き込む
    const ds = new DecompressionStream("deflate-raw");
    const stream = new Blob([raw.slice().buffer as ArrayBuffer]).stream().pipeThrough(ds);
    const data = new Uint8Array(await new Response(stream).arrayBuffer());
    out.push({ name, data });
  }
  return out;
}

/* ---------------- XML から升目を取り出す ---------------- */

/** &amp; などを戻す */
function unesc(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

/** <t>…</t> をつないで一つの文字列にする（書式で分かれていることがある） */
function textOf(xml: string): string {
  let out = "";
  const re = /<t[^>]*>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out += unesc(m[1]);
  return out;
}

function sharedStrings(xml: string): string[] {
  const out: string[] = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(textOf(m[1]));
  return out;
}

/** "C12" → 2（0 から数えた列） */
function colOf(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

function sheetRows(xml: string, shared: string[]): Row[] {
  const rows: Row[] = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let r: RegExpExecArray | null;

  while ((r = rowRe.exec(xml))) {
    const cells: string[] = [];
    const cellRe = /<c\b([^>]*)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let c: RegExpExecArray | null;

    while ((c = cellRe.exec(r[1]))) {
      const attr = c[1] ?? c[2] ?? "";
      const body = c[3] ?? "";
      const ref = /r="([A-Z]+\d+)"/.exec(attr)?.[1] ?? "";
      const type = /t="([^"]+)"/.exec(attr)?.[1] ?? "";
      const at = ref ? colOf(ref) : cells.length;

      let v = "";
      if (type === "inlineStr") {
        v = textOf(body);
      } else {
        const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "";
        if (type === "s") v = shared[Number(raw)] ?? "";
        else v = unesc(raw);
      }
      while (cells.length < at) cells.push("");
      cells[at] = v.trim();
    }
    rows.push(cells);
  }
  return rows;
}

/* ---------------- 入口 ---------------- */

/**
 * xlsx を読んで、行の並びにして返す。
 *
 * すべてのシートを、上から順につないで返す。
 * 見出しの行はここでは落とさない。落とすかどうかは受け取る側で決める
 * （何行目が何だったかを言えるようにしておきたいため）。
 */
export async function readXlsx(file: File): Promise<Row[]> {
  if (!/\.xlsx$/i.test(file.name)) {
    throw new Error(".xlsx を選んでください（.xls や .csv は読めません）");
  }
  const buf = await file.arrayBuffer();
  const files = await unzip(
    buf,
    (n) => n === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(n),
  );
  if (files.length === 0) throw new Error("中身が空か、xlsx ではありません");

  const dec = new TextDecoder();
  const ss = files.find((f) => f.name === "xl/sharedStrings.xml");
  const shared = ss ? sharedStrings(dec.decode(ss.data)) : [];

  const sheets = files
    .filter((f) => f.name.startsWith("xl/worksheets/"))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const rows: Row[] = [];
  for (const s of sheets) rows.push(...sheetRows(dec.decode(s.data), shared));
  return rows;
}
