import MapEditor from "@/components/MapEditor";

/**
 * 作図ツール — 経路なしの土台を直す作業台。
 *
 * いまの地図から通過点と接続の線だけを外した状態から始める。
 * 敷地・建物・出入口は残っているので、歩く道すじだけを引き直せる。
 *
 * 下書きは `/edit`（公開中の地図）とは別に覚えるので、
 * 行き来しても互いの作りかけは消えない。
 *
 * 手元でだけ動く。公開ビルドには入らない（page.dev.tsx）。
 */
export const metadata = { title: "作図ツール（土台）— KIT MAP" };

export default function EditBasePage() {
  return (
    <main className="h-full w-full">
      <MapEditor source="base" />
    </main>
  );
}
