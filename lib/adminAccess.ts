/**
 * 管理の画面ごとに、誰が使えるか。
 *
 * ■ 一か所にまとめた理由
 *   メニュー（components/AdminNav.tsx）と、画面を送る前のサーバーの確かめ
 *   （lib/adminGuard.ts）の両方がここを見る。別々に書くと、
 *   「メニューには出ないのに開ける」「メニューに出るのに開けない」がいつか起きる。
 *
 * ■ ここは画面とサーバーの出し分けだけ
 *   守っているのはデータベース（行ごとの決まりと関数の確かめ）。ここが
 *   間違っていても、データは権限の無い人には返らない。
 *
 * サーバーからも読むので、"use client" は付けない。
 */

import {
  canManage,
  canManageAll,
  canManageCafeteria,
  canReadFeedback,
  canReadRoster,
  type Role,
} from "@/lib/auth";

/** 管理の画面。/edit は手元だけの道具なので、ここには入れない */
export type AdminArea =
  | "approve"
  | "roster"
  | "rooms"
  | "schedule"
  | "cafeteria"
  | "campus"
  | "plan"
  | "feedback"
  | "history"
  | "agent"
  | "news";

/** 予定を入れられる人。課外活動リーダー・教授・副管理者・管理者 */
const canPlan = (r: Role | null) => r === "admin_l1" || r === "admin_l2" || canManageAll(r);

export const ADMIN_ACCESS: Record<AdminArea, (role: Role | null) => boolean> = {
  /* 承認・権限の管理。人の権限に触れるのは 2.2 と管理者だけ */
  approve: canManage,
  /* 名簿。教授は学生の名簿を見るだけ。入れる・消すは大学の情報登録のほう */
  roster: canReadRoster,
  /* 教室の登録。大学の情報登録から入る */
  rooms: canManageAll,
  schedule: canPlan,
  plan: canPlan,
  cafeteria: canManageCafeteria,
  campus: canManageAll,
  feedback: canReadFeedback,
  history: canManageAll,
  agent: canManageAll,
  /* ニュースを出せるのは、学生と承認待ち以外のぜんぶ */
  news: (r) => r === "admin_l0" || r === "admin_l1" || r === "admin_l2" || canManageAll(r),
};
