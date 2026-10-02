"use client";

/** カレンダーの見た目を確かめるためだけの画面。手元専用（/app/test/ は配らない） */

import { useState } from "react";
import MultiDatePicker, { niceDate, todayYmd } from "@/components/MultiDatePicker";

export default function CalPreview() {
  const [dates, setDates] = useState<string[]>([todayYmd()]);
  return (
    <main className="h-[100dvh] overflow-y-auto bg-slate-100 p-4">
      <div className="mx-auto max-w-lg rounded-2xl bg-white p-5 shadow-lg">
        <div className="mb-1 text-[11px] font-bold text-slate-500">日にち（いくつでも選べます）</div>
        <MultiDatePicker value={dates} onChange={setDates} />
        <p className="mt-3 rounded-lg bg-slate-50 p-2 font-mono text-[10px] text-slate-600">
          {dates.length} 日 / {dates.map(niceDate).join(", ") || "（なし）"}
        </p>
      </div>
    </main>
  );
}
