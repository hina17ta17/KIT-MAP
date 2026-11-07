/**
 * 自前で書いた xlsx の読み書き（lib/xlsx.ts・lib/xlsxOut.ts）。
 *
 * 書いたものを読み戻して、同じ表に戻るかを見る。
 * 名簿で困るのは「頭の 0 が落ちる」「日本語や記号が化ける」「空の升がずれる」なので、それを入れておく。
 */
import { describe, expect, it } from "vitest";
import { readXlsx } from "@/lib/xlsx";
import { buildXlsx } from "@/lib/xlsxOut";

const asFile = async (blob: Blob, name = "名簿.xlsx") => new File([await blob.arrayBuffer()], name);

describe("xlsx", () => {
  it("書いて読み戻すと、同じ表になる", async () => {
    const rows = [
      ["学籍番号", "氏名", "学年", "メモ"],
      ["c1234567", "金沢 太郎", "08", "<b>&\"'</b>"],
      ["", "野々市 花子", "1", "番号はまだ"], // 先頭の空の升で、列がずれないか
    ];
    const got = await readXlsx(await asFile(buildXlsx([{ name: "学生", rows }])));
    // 最後の空の升は、読む側では詰めてよい
    expect(got.map((r) => r.join("|").replace(/\|+$/, ""))).toEqual(rows.map((r) => r.join("|").replace(/\|+$/, "")));
  });

  it("頭の 0 を落とさない（数として書かない）", async () => {
    const got = await readXlsx(await asFile(buildXlsx([{ name: "番号", rows: [["00123456"], ["08"]] }])));
    expect(got.map((r) => r[0])).toEqual(["00123456", "08"]);
  });

  it("シートが複数あるときは、上から順につないで返す", async () => {
    const blob = buildXlsx([
      { name: "一枚目", rows: [["a"], ["b"]] },
      { name: "二枚目", rows: [["c"]] },
    ]);
    expect((await readXlsx(await asFile(blob))).map((r) => r[0])).toEqual(["a", "b", "c"]);
  });

  it("xlsx ではないものは、理由を言って断る", async () => {
    await expect(readXlsx(new File(["a,b"], "名簿.csv"))).rejects.toThrow(".xlsx を選んでください");
    await expect(readXlsx(new File(["not a zip"], "名簿.xlsx"))).rejects.toThrow();
  });
});
