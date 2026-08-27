import MapEditor from "@/components/MapEditor";

/**
 * 作図ツール — 公開中の地図をそのまま直す作業台。
 *
 * この画面は手元でだけ動く。next.config.ts の pageExtensions により、
 * `page.dev.tsx` は `next dev` のときしかページとして扱われないので、
 * 公開ビルドには経路も JavaScript も入らない。
 *
 * 道すじを一から引き直すときは `/edit/base` を使う。
 */
export const metadata = { title: "作図ツール — KIT MAP" };

export default function EditPage() {
  return (
    <main className="h-full w-full">
      <MapEditor source="live" />
    </main>
  );
}
