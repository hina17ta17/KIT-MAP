/**
 * 日本の祝日（lib/holidays.ts）。
 *
 * 表で持たずに決まりから出しているので、
 * 日が動く祝日・春分と秋分・振替休日・国民の休日が、暦どおりに出るかを見る。
 */
import { describe, expect, it } from "vitest";
import { dayColor, holidayName, isHoliday } from "@/lib/holidays";

/** 2026年の祝日すべて（内閣府の発表どおり） */
const Y2026: Record<string, string> = {
  "2026-01-01": "元日",
  "2026-01-12": "成人の日", // 1月の第2月曜
  "2026-02-11": "建国記念の日",
  "2026-02-23": "天皇誕生日",
  "2026-03-20": "春分の日",
  "2026-04-29": "昭和の日",
  "2026-05-03": "憲法記念日", // 日曜
  "2026-05-04": "みどりの日",
  "2026-05-05": "こどもの日",
  "2026-05-06": "振替休日", // 3日（日曜）の振替。4日・5日も祝日なので6日まで進む
  "2026-07-20": "海の日", // 7月の第3月曜
  "2026-08-11": "山の日",
  "2026-09-21": "敬老の日", // 9月の第3月曜
  "2026-09-22": "国民の休日", // 敬老の日と秋分の日に挟まれた日
  "2026-09-23": "秋分の日",
  "2026-10-12": "スポーツの日", // 10月の第2月曜
  "2026-11-03": "文化の日",
  "2026-11-23": "勤労感謝の日",
};

/** その年のすべての日付 */
function daysOf(y: number): string[] {
  const out: string[] = [];
  for (let d = new Date(y, 0, 1); d.getFullYear() === y; d.setDate(d.getDate() + 1)) {
    out.push(`${y}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  }
  return out;
}

describe("祝日", () => {
  it("2026年の祝日が、多すぎず少なすぎず、名前も合っている", () => {
    const got = Object.fromEntries(daysOf(2026).filter(isHoliday).map((d) => [d, holidayName(d)]));
    expect(got).toEqual(Y2026);
  });

  it("日曜と重なった祝日は、次の平日が振替休日になる", () => {
    expect(holidayName("2025-02-24")).toBe("振替休日"); // 天皇誕生日（2/23）が日曜
    expect(holidayName("2025-11-24")).toBe("振替休日"); // 勤労感謝の日（11/23）が日曜
  });

  it("春分・秋分の日は、年によって日が動く", () => {
    expect(holidayName("2024-09-22")).toBe("秋分の日");
    expect(holidayName("2025-09-23")).toBe("秋分の日");
    expect(holidayName("2027-03-21")).toBe("春分の日");
    expect(holidayName("2028-03-20")).toBe("春分の日");
  });

  it("祝日でない日は null", () => {
    expect(holidayName("2026-01-05")).toBeNull();
    expect(holidayName("2026-12-25")).toBeNull();
    expect(holidayName("abcd-01-01")).toBeNull();
  });

  it("カレンダーの色：祝日と日曜は赤、土曜は青", () => {
    expect(dayColor("2026-01-01")).toBe("holiday"); // 木曜の祝日
    expect(dayColor("2026-11-08")).toBe("holiday"); // 日曜
    expect(dayColor("2026-11-07")).toBe("sat");
    expect(dayColor("2026-11-06")).toBe("plain");
  });
});
