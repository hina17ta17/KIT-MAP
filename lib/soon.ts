/**
 * 副作用（useEffect）の中から、状態を変える関数を「一拍おいて」呼ぶ。
 *
 *     useEffect(() => soon(load), [load]);
 *     useEffect(() => (area === null ? undefined : soon(() => load(area))), [area, load]);
 *
 * ■ なぜ直接呼ばないか
 *   読み込みの関数は、たいてい最初に「読み込み中」へ切り替える（setState）。
 *   それを副作用の中ですぐ呼ぶと、描き終わった直後に、もう一度の描き直しが
 *   同じ流れの中で重なる（React の決まり react-hooks/set-state-in-effect が止める形）。
 *   一拍（マイクロタスク）おいて始めれば、描き直しは次の回にまとまる。
 *   待つのは今の処理が終わるまでの一瞬で、目に見える遅れは無い。
 *
 * ■ 返すもの
 *   取り消しの関数。useEffect にそのまま返すと、画面を閉じたときや
 *   見ている値が替わったときに、まだ始まっていない古い読み込みを止める。
 */
export function soon(fn: () => unknown): () => void {
  let on = true;
  queueMicrotask(() => {
    if (on) void fn();
  });
  return () => {
    on = false;
  };
}
