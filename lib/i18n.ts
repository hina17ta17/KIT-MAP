/**
 * 表示の言葉を切り替える。
 *
 * 既定は日本語。英語に切り替えると、画面の文字と建物の名前が英語になる。
 *
 * 対応表は「日本語の文言そのもの」を鍵にしている。
 * 別に鍵を作ると、日本語のまま使う場所と対応表がずれても気づけない。
 * 対応表に無い言葉は、そのまま日本語で出す（消えるより読めるほうがよい）。
 */

export type Lang = "ja" | "en";

/** 覚えておく名前 */
export const LANG_KEY = "kitmap.lang";

const EN: Record<string, string> = {
  /* ボタンと見出し */
  現在地: "My location",
  案内: "Route",
  "案内をはじめる": "Start",
  "案内を消す": "Clear route",
  "案内を終える": "Finish",
  "地図に戻る": "Back to map",
  お気に入り: "Favorites",
  "★ お気に入り": "★ Favorites",
  建物一覧: "Buildings",
  出発地: "From",
  目的地: "To",
  出発: "From",
  "現在地を使う": "Use my location",
  閉じる: "Close",
  やめる: "Cancel",
  施設: "Facilities",
  その他: "Others",
  "学内の情報": "Campus info",
  ログイン: "Log in",
  "ログイン画面へ": "Go to log in",
  "目的地を選んでください": "Choose a destination",
  "次に目的地のラベルを押してください": "Now tap the destination",

  /* 到着 */
  到着しました: "You have arrived",
  "建物の中では": "Inside the building",
  "ここから中に入って、この階へ向かってください": "Go inside and head to this floor",
  "建物の前に着きました": "You are at the entrance",

  /* 現在地の状態 */
  "現在地を取得中…（初回は30秒ほどかかります）": "Finding your location… (up to 30s)",
  "精度を上げています…": "Improving accuracy…",
  "衛星で測れています（GPS・みちびき等）": "Using satellites (GPS, QZSS…)",
  "いまは Wi-Fi や基地局からの推定です。空の見える場所で少し待つと、衛星に切り替わります":
    "Estimated from Wi-Fi / cell towers. Move where you can see the sky and wait.",
  "圏外（キャンパス外）": "Outside campus",
  "現在地が拒否されています": "Location is blocked",
  "測位できませんでした": "Could not get your location",
  "もう一度試す": "Try again",
  "許可し直したら押す": "Tap after allowing",
  "この接続では現在地を使えません": "Location needs a secure connection",
  "この端末では現在地を使えません": "Location is not available on this device",
  "屋内では取得しにくくなります。窓際か屋外でお試しください":
    "Hard to get indoors. Try near a window or outside.",
  "iPhone：設定 → プライバシー → 位置情報サービス → Safari を「確認」か「許可」に":
    "iPhone: Settings → Privacy → Location Services → Safari → Ask or Allow",

  /* 案内の途中 */
  "計算中…": "Calculating…",
  正門: "Main gate",

  /* うまくいかないとき */
  "経路の起点が見つかりません": "No starting point found",
  "出発地の入口が登録されていません": "No entrance registered for the start",
  "目的地の入口が登録されていません": "No entrance registered for the destination",
  "経路が見つかりませんでした": "No route found",

  /* 説明 */
  "よく行く場所に★を付けると、案内の入力欄と建物一覧のいちばん上に出ます。":
    "Star the places you visit often. They appear at the top of the search and the building list.",
  "大学のアカウントのみ利用できます。承認された学生・教職員が対象です。":
    "University accounts only, once approved by an administrator.",
  "閲覧には管理者の承認が必要です。": "Requires administrator approval.",
  "日にちを押すと、その日の情報が開きます": "Tap a date to open that day",
  "金沢工業大学 扇が丘キャンパス": "Kanazawa Institute of Technology, Ogigaoka Campus",

  /* 表示のカスタマイズ */
  "表示のカスタマイズ": "Appearance",
  "名前の色": "Label color",
  "地図に出る名前の色です。どれも薄い色にしてあります。航空写真の上でも文字が読めるようにするためです。":
    "The color of the place names on the map. All are pale so the text stays readable over the aerial photo.",
  "いま選んでいるのは": "Selected:",
  "です。お気に入りは色に関わらず黄色く光ります。":
    "Favorites always glow amber, whatever color you pick.",
  "ダークモード": "Dark mode",
  "ボタンや一覧など、地図の上に重ねている部分を黒くします。":
    "Darkens the buttons and lists layered over the map.",
  "地図（航空写真）はそのままです。写真を暗くすると何が写っているか分からなくなり、地図として使えなくなるためです。":
    "The aerial photo itself is left alone — darkening it would make the map unreadable.",
  "名前の付け替え": "Rename places",
  "自分に分かりやすい呼び方に変えられます。地図にはその名前だけが出ます。もとの名前はこの画面で確かめられます。":
    "Give places your own names. Only your name shows on the map; the original is kept here.",
  "変えたもの": "Renamed",
  "件": "",
  "すべてもとの名前に戻す": "Reset all names",
  "名前で絞り込む": "Filter by name",
  "もとに戻す": "Undo",
  "見つかりませんでした": "No matches",

  /* 名前の色（薄い色に塗るが、選ぶときの呼び名は分かりやすくする） */
  白: "White",
  赤: "Red",
  橙: "Orange",
  黄: "Yellow",
  緑: "Green",
  青緑: "Teal",
  水色: "Sky",
  青: "Blue",
  紫: "Purple",
  桃: "Pink",

  /* ログインと申請 */
  ログアウト: "Log out",
  "地図へ戻る": "Back to map",
  "利用を申請": "Apply",
  "メールアドレス": "Email",
  氏名: "Full name",
  学年: "Year",
  クラス: "Class",
  組: "Group",
  名列番号: "Seat no.",
  "学年・クラス・名列番号をすべて入れてください": "Please enter year, class and seat number",
  "名列番号は1から200までの数字です": "The seat number must be between 1 and 200",
  "処理中…": "Working…",
  "送信中…": "Sending…",
  "確認中…": "Checking…",
  "準備中…": "Preparing…",
  "読み込み中…": "Loading…",
  "でログイン中": "signed in",
  "認証アプリ": "Authenticator",
  "認証アプリで本人確認": "Verify with Authenticator",
  "認証アプリ（Authenticator）で本人確認": "Verify with an authenticator app",
  "認証アプリを登録する": "Register authenticator",
  "認証アプリで読み取るQR": "QR code for your authenticator app",
  "読み取れない場合は、この文字列を手で入れてください":
    "If the QR will not scan, type this key instead",
  "アプリに出た6桁": "6-digit code",
  "本人確認をする": "Verify",
  "申請を完了する": "Submit application",
  "本人確認ができました。最後に所属を入れてください。":
    "Verified. Last step: tell us where you belong.",
  "続けて、認証アプリで本人確認をしてください。": "Next, verify with your authenticator app.",
  "これができたら、所属の記入に進めます。": "After this you can enter your details.",
  "スマートフォンに Google Authenticator などを入れておいてください。":
    "Install an app such as Google Authenticator on your phone first.",
  "申請しました。管理者の承認をお待ちください。":
    "Application sent. Please wait for an administrator to approve it.",
  "申請は受け付けています。管理者が承認すると学内情報が見られるようになります。":
    "Your application is in. Campus information opens once an administrator approves it.",
  "承認済みです。下のボタンから使えます。": "Approved. Use the button below.",
  "メールアドレスと氏名の両方が要ります": "Both email and full name are required",
  "このメールアドレスでは申請できません": "This email address cannot be used",
  "このメールアドレスは登録済みです。［ログイン］から入ってください":
    "This address is already registered. Please use Log in.",
  "すでに登録済みです。アプリに出ている6桁を入れてください":
    "Already registered. Enter the 6-digit code from your app.",
  "メールアドレスかパスワードが違います": "Wrong email or password",
  "パスワードの条件を満たしていません": "Password does not meet the requirement",
  "学年・クラス・組をすべて選んでください": "Please choose year, class and group",
  "所属を入れてください": "Please enter your details",
  "6桁の数字を入れてください": "Enter the 6-digit code",
  "6桁の数字が合いません。アプリの表示を確かめて、もう一度入れてください":
    "That code did not match. Check your app and try again.",
  "認証アプリの登録に失敗しました。もう一度お試しください":
    "Could not register the authenticator app. Please try again.",
  "メールの送信上限に達しています。しばらく待ってからお試しください":
    "Email sending limit reached. Please wait a while and try again.",
  "サーバーに接続できません。": "Cannot reach the server.",
  "1号館": "Bldg. 1",
  "メールで本人確認": "Verify by email",
  "メールに届いた6桁": "6-digit code from the email",
  "メールに届いた6桁を入れてください。": "Enter the 6-digit code from the email.",
  "入力したメールアドレスへ確認のメールを送りました。届いた6桁の数字を入れてください。":
    "We sent a verification email to that address. Enter the 6-digit code from it.",
  "メールに数字がなくリンクだけのときは、そのリンクを開けば同じように進めます。":
    "If the email has a link instead of a code, opening the link works the same way.",
  "送り直す": "Send again",
  "送り直しました。メールを確かめてください。": "Sent again. Please check your inbox.",
  "届かないときは、迷惑メールに入っていないか確かめてください。数分かかることもあります。":
    "If it has not arrived, check your spam folder. It can take a few minutes.",
  "それでも届かない場合は、管理者に連絡してください。管理者の側で確認済みにできます。":
    "Still nothing? Contact an administrator — they can verify you instead.",
  パスワード: "Password",
  "メールを確かめました。所属を入れてください。": "Email confirmed. Now enter your details.",
  "最後に、認証アプリで本人確認をしてください。": "Last step: verify with your authenticator app.",
  "認証が完了しました。管理者の承認をお待ちください。":
    "Verification complete. Please wait for an administrator to approve you.",
  "これを終えると認証が完了し、管理者の承認待ちになります。":
    "Once this is done your verification is complete and an administrator will review it.",
  決める: "Set",
  "新しいパスワード": "New password",
  "新しいパスワードを決めてください。": "Choose a new password.",
  "パスワードを忘れた（メールで入る）": "Forgot your password? Sign in by email",
  "先にメールアドレスを入れてください": "Enter your email address first",
  "パスワードを決め直しました。": "Your password has been changed.",
  "大学から配られたメールアドレスと氏名を入れて［START］を押すと、本人確認のメールが届きます。":
    "Enter the email address the university gave you and your name, then press START. A verification email will arrive.",
  "パスワードは8桁ちょうどにしてください": "The password must be exactly 8 characters",
  "半角の英数字・記号だけで入力してください": "Use single-byte letters, numbers and symbols only",
  "［START］のあと、認証アプリ（Authenticator）で本人確認をします。":
    "After START you will verify with an authenticator app.",
  "スマートフォンの認証アプリでQRを読み取り、出てきた6桁を入れてください。Google Authenticator や Microsoft Authenticator が使えます。":
    "Scan the QR with your authenticator app and enter the 6-digit code. Google Authenticator and Microsoft Authenticator both work.",
  "接続先が設定されていないため、ログインと申請を受け付けられません。":
    "The server is not configured, so log in and applications are unavailable.",
};

/** 建物の名前のうち、号館ではないもの */
const EN_PLACE: Record<string, string> = {
  グラウンド: "Athletic Field",
  テニスコート: "Tennis Courts",
  "金沢工業大学前バス停": "KIT-mae Bus Stop",
  "野々市工大前バス停": "Nonoichi-Kodai-mae Bus Stop",
  "野々市工大前駅": "Nonoichi-Kodai-mae Station",
  バス停: "Bus Stop",
  "自転車(北)": "Bicycle Parking (N)",
  "自転車(北2)": "Bicycle Parking (N2)",
  "自転車(東)": "Bicycle Parking (E)",
  "自転車(東2)": "Bicycle Parking (E2)",
  "自転車(西)": "Bicycle Parking (W)",
  "自転車(南)": "Bicycle Parking (S)",
  "LC(6号館)": "LC (Bldg. 6)",
};

/** 全角半角の括弧ゆれを吸収して引く */
const loose = (s: string) => s.replace(/[（）()\s]/g, "");
const PLACE_LOOSE: Record<string, string> = {};
for (const [k, v] of Object.entries(EN_PLACE)) PLACE_LOOSE[loose(k)] = v;

/** 画面の文言を訳す。対応表に無ければ日本語のまま返す */
export function t(lang: Lang, ja: string): string {
  if (lang === "ja") return ja;
  return EN[ja] ?? ja;
}

/**
 * 建物の名前を訳す。
 *
 * 「23号館」のように番号で決まるものは、対応表に載せずに組み立てる。
 * 47棟ぶん並べても、増えたときに書き足し忘れるだけなので。
 */
export function placeName(lang: Lang, name: string): string {
  if (lang === "ja" || !name) return name;

  const known = PLACE_LOOSE[loose(name)];
  if (known) return known;

  const m = /^(\d+)\s*号館$/.exec(name.trim());
  if (m) return `Bldg. ${m[1]}`;

  // 「LC(6号館)」のように、名前の中に号館を含むもの
  return name.replace(/(\d+)\s*号館/g, "Bldg. $1");
}

/** 「3階」「地下1階」を訳す */
export function floorLabelIn(lang: Lang, sub: string): string {
  if (lang === "ja" || !sub) return sub;
  const b = /^地下(\d+)階$/.exec(sub);
  if (b) return `B${b[1]}F`;
  const f = /^(\d+)階$/.exec(sub);
  if (f) return `${f[1]}F`;
  return sub;
}
