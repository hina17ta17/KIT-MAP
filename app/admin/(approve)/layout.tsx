import { guardAdminPage } from "@/lib/adminGuard";

/**
 * 承認・権限の管理（/admin）。送る前にサーバーで確かめる（lib/adminGuard.ts）。
 *
 * この画面だけ「(approve)」の組に入れてある。app/admin/page.tsx のままだと、
 * 確かめを置ける枠が、ほかの管理の画面と共通の app/admin/layout.tsx しかない。
 * 共通の枠は画面を行き来しても作り直されないので、確かめが走らないことがある。
 * 組の名前は URL に出ない（URL は /admin のまま）。
 */
export default async function Layout({ children }: { children: React.ReactNode }) {
  await guardAdminPage("approve");
  return <>{children}</>;
}
