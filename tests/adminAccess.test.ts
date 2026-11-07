/**
 * 管理の画面に、誰が入れるか（lib/adminAccess.ts）。
 *
 * メニューの出し分けと、サーバーで画面を送る前の確かめ（lib/adminGuard.ts）の両方がこの表を見る。
 * 表が変わったら、ここも直す（うっかり広げたときに気づけるように）。
 * なお、データそのものを守っているのはデータベースの行ごとの決まりで、これは画面の出し分け。
 */
import { describe, expect, it } from "vitest";
import { ADMIN_ACCESS, type AdminArea } from "@/lib/adminAccess";
import type { Role } from "@/lib/auth";

const ROLES: (Role | null)[] = [
  null, "pending", "student", "admin_l0", "admin_l1", "admin_l2", "admin_l21", "admin_l22", "admin_l3",
];

/** 画面ごとに、入れる権限 */
const EXPECTED: Record<AdminArea, Role[]> = {
  approve: ["admin_l22", "admin_l3"],
  roster: ["admin_l2", "admin_l21", "admin_l22", "admin_l3"],
  rooms: ["admin_l21", "admin_l22", "admin_l3"],
  schedule: ["admin_l1", "admin_l2", "admin_l21", "admin_l22", "admin_l3"],
  plan: ["admin_l1", "admin_l2", "admin_l21", "admin_l22", "admin_l3"],
  cafeteria: ["admin_l0", "admin_l21", "admin_l22", "admin_l3"],
  campus: ["admin_l21", "admin_l22", "admin_l3"],
  feedback: ["admin_l2", "admin_l21", "admin_l22", "admin_l3"],
  history: ["admin_l21", "admin_l22", "admin_l3"],
  agent: ["admin_l21", "admin_l22", "admin_l3"],
  news: ["admin_l0", "admin_l1", "admin_l2", "admin_l21", "admin_l22", "admin_l3"],
};

describe("管理の画面に入れる権限", () => {
  it("表の画面が、すべて決まっている", () => {
    expect(Object.keys(ADMIN_ACCESS).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [area, allowed] of Object.entries(EXPECTED) as [AdminArea, Role[]][]) {
    it(`${area}：${allowed.join("・")} だけ`, () => {
      const got = ROLES.filter((r) => ADMIN_ACCESS[area](r));
      expect(got).toEqual(allowed);
    });
  }

  it("ログインしていない人・承認待ち・学生は、どの管理の画面にも入れない", () => {
    for (const r of [null, "pending", "student"] as (Role | null)[]) {
      expect(Object.values(ADMIN_ACCESS).some((ok) => ok(r))).toBe(false);
    }
  });
});
