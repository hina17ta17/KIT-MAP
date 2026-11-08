import { describe, expect, it } from "vitest";
import { beforeSend } from "@/lib/analytics";

const view = (url: string) => ({ type: "pageview" as const, url });

describe("アクセス解析に送る前のふるい", () => {
  it("ふつうのページは、道だけを送る", () => {
    expect(beforeSend(view("https://kit-map.example/"))).toEqual(view("https://kit-map.example/"));
    expect(beforeSend(view("https://kit-map.example/login"))?.url).toBe("https://kit-map.example/login");
  });

  it("? と # から後ろは消す（ログインの戻りの番号などを送らない）", () => {
    expect(beforeSend(view("https://kit-map.example/login?code=abc&next=/admin#token=x"))?.url).toBe(
      "https://kit-map.example/login",
    );
  });

  it("管理の画面は送らない", () => {
    expect(beforeSend(view("https://kit-map.example/admin"))).toBeNull();
    expect(beforeSend(view("https://kit-map.example/admin/rooms?x=1"))).toBeNull();
  });

  it("admin で始まるだけの別の道は送る", () => {
    expect(beforeSend(view("https://kit-map.example/administration"))?.url).toBe(
      "https://kit-map.example/administration",
    );
  });

  it("読めない住所は送らない", () => {
    expect(beforeSend(view("not a url"))).toBeNull();
  });
});
