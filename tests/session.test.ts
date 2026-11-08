import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * 全員をログインし直させる仕掛け（lib/session.ts）。
 * ブラウザの代わりに、保存場所とクッキーを手で用意して試す。
 */
const signOut = vi.fn();
vi.mock("@/lib/supabase/client", () => ({
  supabaseReady: true,
  createClient: () => ({ auth: { signOut } }),
}));

import { enforceEpoch, hasSavedLogin, SESSION_EPOCH } from "@/lib/session";
import { TRUSTED_KEY } from "@/lib/device";

function fakeStorage(init: Record<string, string> = {}, blocked = false) {
  const m = new Map(Object.entries(init));
  const guard = () => {
    if (blocked) throw new Error("SecurityError");
  };
  return {
    get length() { guard(); return m.size; },
    key: (i: number) => { guard(); return [...m.keys()][i] ?? null; },
    getItem: (k: string) => { guard(); return m.get(k) ?? null; },
    setItem: (k: string, v: string) => { guard(); m.set(k, v); },
    removeItem: (k: string) => { guard(); m.delete(k); },
    map: m,
  };
}

let storage: ReturnType<typeof fakeStorage>;
const doc = { cookie: "" };

function setup(cookie: string, init: Record<string, string> = {}, blocked = false) {
  storage = fakeStorage(init, blocked);
  doc.cookie = cookie;
  vi.stubGlobal("window", { localStorage: storage });
  vi.stubGlobal("document", doc);
}

beforeEach(() => {
  signOut.mockReset();
  // ふつうは、ログアウトするとクッキーが消える
  signOut.mockImplementation(async () => {
    doc.cookie = "";
    return { error: null };
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("ログインの控えがあるか", () => {
  it("Supabase のクッキー（分かれたものも）を見つける", () => {
    setup("theme=dark; sb-abc-auth-token=x");
    expect(hasSavedLogin()).toBe(true);
    setup("sb-abc-auth-token.0=x; sb-abc-auth-token.1=y");
    expect(hasSavedLogin()).toBe(true);
  });

  it("ログインの途中の印（code-verifier）だけでは、控えとみなさない", () => {
    setup("sb-abc-auth-token-code-verifier=x");
    expect(hasSavedLogin()).toBe(false);
  });

  it("何も無ければ false", () => {
    setup("theme=dark");
    expect(hasSavedLogin()).toBe(false);
  });
});

describe("版がずれたときの動き", () => {
  it("初めて開いた人は、読み込み直さない（版だけ覚える）", async () => {
    setup("", { [TRUSTED_KEY]: "old" });
    expect(await enforceEpoch()).toBe(false);
    expect(signOut).not.toHaveBeenCalled();
    expect(storage.map.get("kitmap.epoch")).toBe(String(SESSION_EPOCH));
    expect(storage.map.has(TRUSTED_KEY)).toBe(false);
  });

  it("前の版のログインが残っている人は、ログアウトして読み込み直す", async () => {
    setup("sb-abc-auth-token=x", { "kitmap.epoch": "1" });
    expect(await enforceEpoch()).toBe(true);
    expect(signOut).toHaveBeenCalledOnce();
    expect(storage.map.get("kitmap.epoch")).toBe(String(SESSION_EPOCH));
  });

  it("版が合っていれば何もしない", async () => {
    setup("sb-abc-auth-token=x", { "kitmap.epoch": String(SESSION_EPOCH) });
    expect(await enforceEpoch()).toBe(false);
    expect(signOut).not.toHaveBeenCalled();
  });

  it("ログアウトできなかったときは、読み込み直さず、版も覚えない（次に開いたときにもう一度）", async () => {
    setup("sb-abc-auth-token=x");
    signOut.mockRejectedValueOnce(new Error("offline"));
    expect(await enforceEpoch()).toBe(false);
    expect(storage.map.has("kitmap.epoch")).toBe(false);
  });

  it("保存場所が使えないブラウザでも、初めての人を読み込み直し続けない", async () => {
    setup("", {}, true);
    expect(await enforceEpoch()).toBe(false);
  });
});
