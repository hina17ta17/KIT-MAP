"use client";

/**
 * 管理画面の見出しと、行き先のボタン。
 *
 * 画面ごとに小さな文字の並びで行き来していたが、押しにくく、
 * どこへ行けるのかも分かりにくかった。
 * 見出しの右上には必ず「地図へ」を置き、行き先は上から縦に並べる。
 *
 * 権限が足りないものは出さない。押せないものが並んでいても迷うだけなので、
 * その人が使えるものだけを見せる。
 */

import Link from "next/link";
import {
  canManage,
  canManageAll,
  canManageCafeteria,
  canReadFeedback,
  canReadRoster,
  type Role,
} from "@/lib/auth";
import { useAdminLang, useAdminT } from "@/lib/adminLang";

export type AdminPageId =
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
  | "edit";

type Entry = {
  id: AdminPageId;
  href: string;
  icon: string;
  label: string;
  sub: string;
  allowed: (role: Role | null) => boolean;
};

const ENTRIES: Entry[] = [
  /*
   * kit-agent の様子。承認・権限の上に置く。
   *
   * 承認しに来た人が最初に知りたいのは「agent がもう見たのか」。
   * 見ていれば、残っているのは人が決めるものだけ。
   * 見ていなければ、待てば減る。順番を取り違えないよう、いちばん上。
   */
  {
    id: "agent",
    href: "/admin/agent",
    icon: "🤖",
    label: "kit-agent の様子",
    sub: "働いているか、誰を通して誰をはじいたか",
    allowed: canManageAll,
  },
  {
    id: "approve",
    href: "/admin",
    icon: "✓",
    label: "承認・権限の管理",
    sub: "利用申請の承認と、権限の変更",
    allowed: canManage,
  },
  {
    id: "roster",
    href: "/admin/roster",
    icon: "📒",
    label: "名簿",
    sub: "入れてある名簿を、一人ずつ見る",
    /*
     * 見るだけの画面。入れる・消す・ドメインを変えるは
     * 「大学の情報登録」へ移した。
     * 教授（レベル2）は学生の名簿だけ見られるので、ここは
     * canReadRoster にしてある。
     */
    allowed: canReadRoster,
  },
  {
    id: "campus",
    href: "/admin/campus",
    icon: "🏫",
    label: "大学の情報登録",
    sub: "教室・学科・ドメイン・ログインしている人",
    allowed: canManageAll,
  },
  {
    id: "schedule",
    href: "/admin/schedule",
    icon: "📘",
    label: "予定の登録",
    sub: "授業・イベント・課外活動",
    allowed: (r) => r === "admin_l1" || r === "admin_l2" || canManageAll(r),
  },
  {
    id: "plan",
    href: "/admin/plan",
    icon: "📅",
    label: "予定の確認",
    sub: "登録されている授業を、日ごとに見る",
    // 予定を入れられる人と、教授。入れたものを確かめる欄なので同じ顔ぶれ
    allowed: (r) => r === "admin_l1" || r === "admin_l2" || canManageAll(r),
  },
  {
    id: "cafeteria",
    href: "/admin/cafeteria",
    icon: "🍚",
    label: "食堂のメニュー",
    sub: "その日の提供状況と品名",
    allowed: canManageCafeteria,
  },
  {
    id: "feedback",
    href: "/admin/feedback",
    icon: "✉",
    label: "みんなの感想",
    sub: "使っている人から届いた声。名前は分かりません",
    allowed: canReadFeedback,
  },
  /*
   * 履歴。感想のすぐ下に置く。
   *
   * 前は地図の脇に置いていたが、管理の行き先はここに
   * まとまっていたほうが探しやすい。地図の脇に増やしていくと、
   * 地図を見るための画面が管理の道で埋まる。
   */
  {
    id: "history",
    href: "/admin/history",
    icon: "🕘",
    label: "履歴",
    sub: "いつ・誰が・何をしたか。エラーも残ります",
    allowed: canManageAll,
  },
  /*
   * 作図ツールは、手元でだけ動かす道具。
   *
   * 以前はここに項目を書き、出すかどうかを allowed の中で決めていた。
   * それだと画面には出ないが、名前も行き先も配信されるファイルに残り、
   * 中身を読める人には「/edit という道具が在る」と分かってしまう。
   *
   * 条件を配列を作るところに移す。`process.env.NODE_ENV` は
   * 組み立てのときに文字へ置き換わるので、公開ビルドでは
   * この中身ごと消える（消えていることは build のあとに確かめる）。
   */
  ...(process.env.NODE_ENV === "development"
    ? [
        {
          id: "edit" as const,
          href: "/edit",
          icon: "✏️",
          label: "作図ツール",
          sub: "建物・出入口・通路を描き直す",
          allowed: (r: Role | null) => canManageAll(r),
        },
      ]
    : []),
];

/**
 * 画面の見出し。右上には必ず地図へ戻る道と、言葉の切り替えを置く。
 *
 * 切り替えをここに置いたのは、管理画面のどこを開いていても
 * 同じ場所にあるようにするため。覚える場所は地図と同じなので、
 * どちらで切り替えても両方に効く。
 */
export function AdminHeader({ title }: { title: string }) {
  const T = useAdminT();
  const [lang, setLang] = useAdminLang();
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <h1 className="text-lg font-bold text-slate-900">{title}</h1>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          onClick={() => setLang(lang === "ja" ? "en" : "ja")}
          title={lang === "ja" ? "English" : "日本語"}
          className="rounded-full bg-slate-100 px-3 py-2 text-xs font-bold text-slate-700 transition hover:bg-slate-200 active:scale-95"
        >
          {lang === "ja" ? "A" : "あ"}
        </button>
        <Link
          href="/"
          className="rounded-full bg-slate-900 px-4 py-2 text-xs font-bold text-white shadow-sm transition hover:bg-slate-800 active:scale-95"
        >
          {T("地図へ")}
        </Link>
      </div>
    </div>
  );
}

/**
 * 行き先を上から縦に並べる。
 *
 * 使える権限のあるものだけを出す。current を渡さなければ、
 * どこも「開いている」扱いにしない（ログイン画面から使うときなど）。
 */
export function AdminMenu({
  current,
  role,
}: {
  current?: AdminPageId;
  role: Role | null;
}) {
  const T = useAdminT();
  const usable = ENTRIES.filter((e) => e.allowed(role));
  if (usable.length === 0) return null;

  return (
    <nav className="mb-4 flex flex-col gap-2">
      {usable.map((e) => {
        const here = e.id === current;

        if (here) {
          return (
            <div
              key={e.id}
              className="flex items-center gap-3 rounded-xl bg-slate-900 px-3 py-3 text-left"
            >
              <span className="text-lg">{e.icon}</span>
              <span className="min-w-0">
                <span className="block text-sm font-bold text-white">{T(e.label)}</span>
                <span className="block text-[10px] text-slate-300">{T("いま開いています")}</span>
              </span>
            </div>
          );
        }

        return (
          <Link
            key={e.id}
            href={e.href}
            className="flex items-center gap-3 rounded-xl bg-slate-100 px-3 py-3 text-left transition hover:bg-slate-200 active:scale-95"
          >
            <span className="text-lg">{e.icon}</span>
            <span className="min-w-0">
              <span className="block text-sm font-bold text-slate-800">{T(e.label)}</span>
              <span className="block text-[10px] text-slate-500">{T(e.sub)}</span>
            </span>
            <span className="ml-auto shrink-0 text-slate-400">›</span>
          </Link>
        );
      })}
    </nav>
  );
}
