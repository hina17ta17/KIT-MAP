/**
 * 写真を、送れる大きさに縮める。
 *
 * ■ なぜ縮めるか
 *   いまの端末で撮った写真は、一枚が数MB ある。
 *   そのまま入れると、その日のメニューを開くだけで
 *   見る人みんながその通信量を引き受けることになる。
 *   食堂の写真は小さく出すので、大きいまま持っていても意味がない。
 *
 * ■ どこまで縮めるか
 *   長辺 512 点、JPEG の質 0.72。
 *   一覧に出す大きさ（80点角ほど）に対して十分で、
 *   一枚 30〜60KB に収まる。
 *
 *   透けているところは白で塗る。JPEG は透けを持てないので、
 *   塗らないと黒くなる。
 *
 * ■ 縮めきれなかったら、入れない
 *   決まりの上限（400KB）を超えるものは、その旨を返して止める。
 *   黙って入れると、あとで誰かが重さを引き受ける。
 */

/** 長辺をここまで縮める（画面の点） */
const MAX_SIDE = 512;
/** これを超えたら入れない（データベース側の決まりと同じ） */
export const MAX_BYTES = 400_000;

export type PhotoResult =
  | { ok: true; data: string; bytes: number }
  | { ok: false; why: string };

/**
 * 選んだ写真を、data:image/jpeg の形にして返す。
 *
 * 画像として読めないもの（PDF など）は、その旨を返す。
 */
export async function shrinkPhoto(file: File): Promise<PhotoResult> {
  if (!/^image\//.test(file.type)) {
    return { ok: false, why: "画像ではありません。写真を選んでください。" };
  }

  let bmp: ImageBitmap | HTMLImageElement;
  try {
    if (typeof createImageBitmap === "function") {
      bmp = await createImageBitmap(file);
    } else {
      // 古いブラウザ用。読み終わるまで待つ
      const url = URL.createObjectURL(file);
      try {
        bmp = await new Promise<HTMLImageElement>((res, rej) => {
          const img = new Image();
          img.onload = () => res(img);
          img.onerror = () => rej(new Error("読めません"));
          img.src = url;
        });
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  } catch {
    return { ok: false, why: "この写真は読めませんでした。別のものでお試しください。" };
  }

  const w0 = "width" in bmp ? bmp.width : 0;
  const h0 = "height" in bmp ? bmp.height : 0;
  if (!w0 || !h0) return { ok: false, why: "この写真は読めませんでした。" };

  const scale = Math.min(1, MAX_SIDE / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));

  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d");
  if (!ctx) return { ok: false, why: "この端末では写真を縮められません。" };

  // JPEG は透けを持てない。塗らないと、透けていたところが黒くなる
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp as CanvasImageSource, 0, 0, w, h);
  if ("close" in bmp && typeof bmp.close === "function") bmp.close();

  /*
   * 質を少しずつ下げながら、収まるところを探す。
   * 一度で決め打つと、細かい写真だけが上限を超えて入らなくなる。
   */
  for (const q of [0.72, 0.6, 0.5, 0.4]) {
    const data = cv.toDataURL("image/jpeg", q);
    if (data.length <= MAX_BYTES) return { ok: true, data, bytes: data.length };
  }
  return {
    ok: false,
    why: "写真が大きすぎて入れられませんでした。もっと小さいものでお試しください。",
  };
}
