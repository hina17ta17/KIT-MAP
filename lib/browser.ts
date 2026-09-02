/**
 * 現在地が拒否されたときの、直し方の案内。
 *
 * ■ なぜブラウザを選ばせるか
 *   直し方はブラウザごとにまったく違う。以前は iPhone の Safari だけを
 *   前提に一行だけ出していたので、Chrome を使っている人には
 *   書いてある場所が見つからず、直しようがなかった。
 *
 *   見分けは自動でも当てにならない。iPhone の Chrome は中身が Safari と
 *   同じで、名乗りも紛らわしい。最初の候補だけ自動で決めて、
 *   違っていれば本人が選び直せる形にする。
 *
 * ■ 端末（iPhone／Android／パソコン）は自動で決める
 *   ここは名乗りで十分に分かるうえ、本人にとっては選ぶまでもない。
 */

export type BrowserKind = "safari" | "chrome";
export type Platform = "ios" | "android" | "desktop";

/**
 * どちらのブラウザで開いているか、最初の候補を決める。
 *
 * iPhone の Chrome は "CriOS"、Android の Chrome は "Chrome" と名乗る。
 * Safari も "Chrome" の文字を含む名乗りをすることがあるので、
 * Chrome かどうかを先に見て、そうでなければ Safari とみなす。
 */
export function guessBrowser(ua?: string): BrowserKind {
  const s = ua ?? (typeof navigator === "undefined" ? "" : navigator.userAgent);
  if (/CriOS|EdgiOS|FxiOS/i.test(s)) return /CriOS/i.test(s) ? "chrome" : "safari";
  if (/Chrome|Chromium|CrMo/i.test(s) && !/OPR|Edg\//i.test(s)) return "chrome";
  return "safari";
}

export function guessPlatform(ua?: string): Platform {
  const s = ua ?? (typeof navigator === "undefined" ? "" : navigator.userAgent);
  if (/Android/i.test(s)) return "android";
  if (/iPhone|iPad|iPod/i.test(s)) return "ios";
  // iPad は「Mac」と名乗ることがある。指で触れるなら iPad とみなす
  if (/Macintosh/i.test(s) && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1)
    return "ios";
  return "desktop";
}

/**
 * 直し方の手順。
 *
 * 押す場所の名前は、その画面に実際に出ている言葉をそのまま書く。
 * 「権限の設定を確認」のような言い換えをすると、探しても見つからない。
 */
export function locationSteps(browser: BrowserKind, platform: Platform): string[] {
  if (browser === "safari") {
    if (platform === "ios")
      return [
        "「設定」アプリ →「プライバシーとセキュリティ」→「位置情報サービス」をオンに",
        "同じ画面を下へ →「Safari Webサイト」→「このAppの使用中」に",
        "Safari に戻り、アドレスバー左の「ぁあ」→「Webサイトの設定」→「位置情報」→「許可」",
        "このページを再読み込み",
      ];
    return [
      "画面上の「Safari」メニュー →「設定」→「Webサイト」→「位置情報」",
      "左の一覧から kit-map.vercel.app を選び「許可」に",
      "「システム設定」→「プライバシーとセキュリティ」→「位置情報サービス」で Safari をオンに",
      "このページを再読み込み",
    ];
  }

  if (platform === "android")
    return [
      "アドレスバー左の 鍵 か ⚙ を押す →「権限」→「位置情報」→「許可」",
      "端末の「設定」→「位置情報」がオンか確かめる",
      "「設定」→「アプリ」→「Chrome」→「権限」→「位置情報」を許可に",
      "このページを再読み込み",
    ];

  if (platform === "ios")
    return [
      "「設定」アプリ →「Chrome」→「位置情報」→「このAppの使用中」に",
      "Chrome に戻り、アドレスバー左の「ぁあ」→「位置情報」→「許可」",
      "このページを再読み込み",
    ];

  return [
    "アドレスバー左の 鍵 か ⓘ を押す →「サイトの設定」",
    "「位置情報」を「許可する」に",
    "このページを再読み込み",
  ];
}

/** 英語のときの手順 */
export function locationStepsEn(browser: BrowserKind, platform: Platform): string[] {
  if (browser === "safari") {
    if (platform === "ios")
      return [
        "Settings app → Privacy & Security → Location Services → turn it on",
        "Scroll down → Safari Websites → choose While Using the App",
        "Back in Safari, tap AA in the address bar → Website Settings → Location → Allow",
        "Reload this page",
      ];
    return [
      "Safari menu → Settings → Websites → Location",
      "Select kit-map.vercel.app and set it to Allow",
      "System Settings → Privacy & Security → Location Services → turn Safari on",
      "Reload this page",
    ];
  }

  if (platform === "android")
    return [
      "Tap the lock or ⚙ in the address bar → Permissions → Location → Allow",
      "Check that Location is on in the device Settings",
      "Settings → Apps → Chrome → Permissions → allow Location",
      "Reload this page",
    ];

  if (platform === "ios")
    return [
      "Settings app → Chrome → Location → While Using the App",
      "Back in Chrome, tap AA in the address bar → Location → Allow",
      "Reload this page",
    ];

  return [
    "Tap the lock or ⓘ in the address bar → Site settings",
    "Set Location to Allow",
    "Reload this page",
  ];
}
