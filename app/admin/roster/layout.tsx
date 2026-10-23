import { guardAdminPage } from "@/lib/adminGuard";

/** 送る前にサーバーで確かめる（lib/adminGuard.ts）。使えない人には、この画面を送らない */
export default async function Layout({ children }: { children: React.ReactNode }) {
  await guardAdminPage("roster");
  return <>{children}</>;
}
