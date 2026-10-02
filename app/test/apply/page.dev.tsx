"use client";

/** 申請の欄だけを、ログイン無しで描いて確かめるための一時ページ */

import CampusPanel from "@/components/CampusPanel";

export default function TestApplyPage() {
  return (
    <div style={{ maxWidth: 390, height: 700, padding: 12 }}>
      <CampusPanel role="student" onNeedLogin={() => {}} />
    </div>
  );
}
