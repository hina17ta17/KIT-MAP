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
  "建物の中を通らない": "Avoid going inside",
  "建物の中も通る": "Allow going inside",
  "外だけでは行けないので、中を通っています":
    "There is no outdoor-only route, so this one goes inside.",
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

  /* 案内中の帯 */
  "{from} から 徒歩{n}分・{m}m": "{n} min walk from {from} · {m} m",
  "全体に戻す": "Whole campus",
  "地図を表示できません": "The map cannot be shown",
  "23号館 / 23 302 / 図書館": "Bldg. 23 / 23 302 / Library",
  "見つかりません": "Nothing found",
  "いまは建物どうしの案内だけ使えます。": "Right now only building-to-building routes work.",
  "教室（何号館の何階の何番）で探すには、": "To search by room (building, floor, number), ",
  "して管理者の承認を受けてください。": " and get approved by an administrator.",
  "{n}件": "{n}",

  /* 現在地の様子（続き） */
  "現在地を取得できませんでした": "Could not get your location",
  "キャンパス外・遠い": "Off campus · far",
  圏外: "Off campus",
  "取得中…": "Finding…",

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
  /* 描く土台が落ちたとき */
  "地図を読み込み直しています": "Reloading the map",
  "端末の空きが少なくなったため、地図の描画がいったん止まりました。すぐに戻ります。":
    "The map stopped drawing because the device ran low on memory. It will come back shortly.",
  "いますぐ出し直す": "Reload now",

  /* 学内の情報の引き出し */
  "みんなの感想": "Feedback",
  "使っている人から届いた声": "What people told us",

  /* 権限の呼び名（ROLE_LABEL / ROLE_SHORT）。
     同じ言葉が両方に出るものは、一つで足りる */
  "承認待ち": "Awaiting approval",
  "学生・教職員": "Student / staff",
  "食堂の担当": "Cafeteria staff",
  "課外活動リーダー": "Club leader",
  教授: "Professor",
  "副管理者（承認なし）": "Sub-admin (no approvals)",
  副管理者: "Sub-admin",
  管理者: "Administrator",
  // 「学生」は下（申請の欄）にすでにある
  食堂: "Cafeteria",
  課外活動: "Clubs",
  "副（承認なし）": "Sub (no approvals)",
  副: "Sub",
  "{r}でログイン中": "Signed in as {r}",

  /* 学内の情報（CampusPanel） */
  "サーバーに接続できていません。しばらくしてから開き直してください。":
    "Cannot reach the server. Please try opening this again in a moment.",
  "学内の情報は、管理者の承認を受けた学生・教職員だけが見られます。":
    "Campus information is only for students and staff approved by an administrator.",
  "ログイン / 利用を申請": "Sign in / apply",
  "← 戻る": "← Back",
  "食堂のメニュー": "Cafeteria menu",
  "その日の提供状況": "What is being served",
  時間割: "Timetable",
  "授業と課外活動": "Classes and clubs",
  空き教室: "Free rooms",
  "号館と時限から探す": "Search by building and period",
  "前の月": "Previous month",
  "次の月": "Next month",
  "{n}月": "{n}",
  "今日から始める": "Start from today",
  // 「日にちを押すと…」は下（説明のところ）にすでにある
  活動中: "Open",
  活動休止: "Closed",
  売り切れ: "Sold out",
  未登録: "Not set",
  // 「読み込み中…」は下（申請の欄）にすでにある
  "食堂の情報がまだ登録されていません。": "No cafeteria information has been entered yet.",
  "{n}円": "¥{n}",
  "何限を見ますか": "Which period?",
  "時限を選んでください。": "Choose a period.",
  "{n}年": "Year {n}",
  "全学年を見る": "Show all years",
  "{n}年だけに戻す": "Back to year {n} only",
  "他の学科": "Other departments",
  "この時限に登録された授業はありません。": "No classes are registered for this period.",
  "（科目名なし）": "(no title)",
  変更あり: "Changed",
  // 「クラス」は下（申請の欄）にすでにある
  担当未定: "Teacher not set",
  教室未定: "Room not set",
  "学科を選んでください": "Choose a department",
  "学科がまだ登録されていません。": "No departments have been entered yet.",
  "← 団体を選び直す": "← Pick another club",
  "← 系統を選び直す": "← Pick another category",
  なし: "None",
  "この日の活動予定はありません": "Nothing is scheduled for this day",
  "複数の教室（{n}か所）で活動します": "Meets in {n} rooms",
  "この系統の団体は登録されていません。": "No clubs are registered in this category.",
  "何系の活動ですか": "What kind of activity?",
  "課外活動がまだ登録されていません。": "No clubs have been entered yet.",
  "何号館を調べますか": "Which building?",
  号館: "Bldg.",
  "空欄なら全体": "Leave empty for all",
  時限: "Period",
  "空いている教室はありません。": "No rooms are free.",
  "{n} 室が空いています": "{n} rooms free",

  /* 管理画面（承認・名簿・教室・予定・食堂・感想） */
  "承認・権限の管理": "Approvals and roles",
  "利用申請の承認と、権限の変更": "Approve applications and change roles",
  "誰も選ばれていません": "No one is selected",
  "メールアドレスと氏名は入れたものの、": "They entered an email and a name, but",
  "本人だと確かめられていないので、ここからは権限を付けられません。": "they have not been verified, so no role can be given from here.",
  "本人が Microsoft Authenticator で本人確認を済ませ、所属を入れると、": "Once they verify with Microsoft Authenticator and enter their details,",
  "「申請」に移ります。": "they move to “Applied”.",
  "申請してきた人": "People who applied",
  /* リセット選択 */
  "リセット選択": "Choose who to reset",
  "消したい身分に印を付けてください。印を付けたものは、まとめて消えます。":
    "Tick the kinds of people you want to reset. Everything ticked is removed together.",
  "その人たちから、ログイン・パスワード・本人確認・大学の情報がすべて消え、申請の最初からやり直しになります。元には戻せません。":
    "They lose their login, password, verification and university details, and start again from the beginning. This cannot be undone.",
  "副管理者（2.1・2.2）と管理者、そしてあなた自身は消えません。":
    "Sub-admins (2.1 / 2.2), administrators and you yourself are never removed.",
  "この人たちを消すときは、先に権限を下げてください。":
    "To remove them, lower their role first.",
  "消す身分を選んでください": "Choose who to reset",
  選んだ: "Remove the",
  名を消す: "people you chose",
  "その身分の人がいません": "There is no one with that role",
  /* 名簿の中を見る */
  "名簿の中を見る": "Browse the roster",
  "この頁をすべて選ぶ": "Select this page",
  "印を付ける": "Mark",
  "印を付けた": "Delete the",
  "件を消す": "marked entries",
  "この内容にする": "Save these details",
  /* 予定の教室選び（部屋の種類） */
  研究室: "Lab",
  事務: "Office",
  設備: "Facility",
  "名簿を開く": "Open the roster",
  "学年（すべて）": "Year (all)",
  "学科（すべて）": "Department (all)",
  "クラス（すべて）": "Class (all)",
  "担当学科（すべて）": "Departments taught (all)",
  "探しています…": "Searching…",
  人: " people",
  "見つかりませんでした。": "Nothing found.",
  "この身分は、まだ名簿に入っていません。": "No one of this kind is in the roster yet.",
  /* 予定の教室選び */
  "すべての号館": "All buildings",
  教室なし: "no rooms",
  既存: "Existing",
  "この中の": "Of these,",
  "名は、まだ本人確認か所属の記入が済んでいません":
    " have not yet verified themselves or entered their details",
  "本人だと確かめられていないので、その人には権限を付けられません。":
    "They have not been verified, so they cannot be given a role.",
  "本人が Microsoft Authenticator で本人確認を済ませ、所属を入れると承認できるようになります。":
    "Once they verify with Microsoft Authenticator and enter their details, you can approve them.",
  "名前を押すと権限を変えられます": "Tap a name to change their role",
  名: " people",
  名に印: " marked",
  担当: "Teaches",
  "本人確認まだ": "Not verified yet",
  "所属まだ": "No details yet",
  "権限を変える": "Change role",
  "あなたのログインパスワード": "Your login password",
  "一度承認した人を変えるには、ご自身のログインパスワードが要ります": "Changing someone already approved needs your own login password",
  "あなたのログインパスワード（承認済みの人を変えるとき）": "Your login password (needed to change someone already approved)",
  "身分を直す": "Fix their details",
  "該当する人がいません": "No one matches",
  "学生と申請者から、ログイン・パスワード・本人確認・氏名・学年・クラス・": "Removes login, password, verification, name, year and class from students and applicants,",
  "消された人は申請の最初からやり直しです。元には戻せません。": "They start again from the beginning. This cannot be undone.",
  "管理者も含めて、すべての席を消す": "Delete every account, administrators included",
  "パスワード・本人確認・大学の情報がすべて無くなり、ログインの最初から": "Password, verification and university details are all cleared, and they start",
  "やり直しになります。": "again from the beginning.",
  "あなたがいちばん上でなければ、あなたも消えてログアウトされます。": "Unless you are the top administrator, you are removed and logged out too.",
  "管理者が入っていることがあります。数はボタンに出しています。": "Administrators may be included. The count is shown on the button.",
  "いちばん上の権限の人と、あなた自身は残ります。": "The top administrator and you yourself are kept.",
  "一覧で名前の左の印を付けてから押します。その人だけが、ログイン・": "Tick the mark to the left of a name, then press. Only those people lose their login,",
  "パスワード・本人確認・大学の情報を失い、申請の最初からやり直しになります。": "password, verification and university details, and start again from the beginning.",
  "いちばん上の権限の人と、あなた自身は選んでも消えません。": "The top administrator and you yourself are not removed even if ticked.",
  "印を外す": "Clear marks",
  "すべて": "All",
  "名簿": "Roster",
  "xlsx から学生・教授の名簿を取り込む": "Import students and staff from an xlsx file",
  "その人は名簿にいませんでした。": "That person was not in the roster.",
  "中身のある行がありませんでした": "No rows with content were found",
  "名簿を見られるのは、教授（レベル2）・副管理者（2.1・2.2）・管理者です。": "The roster can be viewed by professors (level 2), sub-admins (2.1 / 2.2) and administrators.",
  "入れる・消すのは、副管理者と管理者だけです。": "Only sub-admins and administrators can add or remove.",
  "ログインへ": "Go to log in",
  "教職員の名簿には8桁の番号が並ぶので、副管理者と管理者だけが見られます。": "The staff roster lists 8-digit numbers, so only sub-admins and administrators can see it.",
  "前": "Prev",
  "次": "Next",
  "名簿に入れる・消す、ドメインを変えるといった操作は、": "Adding to or removing from the roster, and changing domains,",
  "副管理者（2.1・2.2）と管理者だけができます。": "can only be done by sub-admins (2.1 / 2.2) and administrators.",
  "ドメインを見るか": "Check the domain?",
  "一つでも「なし」があると、席を作るところでもドメインを見ません": "If any is set to “off”, the domain is not checked when an account is created either",
  "（その時点では、まだ身分が分からないため）。": "(at that point we do not yet know which kind of person it is).",
  "いま決まっているもの": "Currently set to",
  "直す": "Change",
  "空にすると「決めていない」に戻ります。": "Leaving it empty means “not decided”.",
  "この設定は、これから席を作る人にだけ効きます。": "This applies only to accounts created from now on.",
  "（c1234567@… なら 1234567）。頭の一文字ごと書いてあっても構いません。": "(c1234567@… means 1234567). Writing the leading letter too is fine.",
  "見出しの行があっても構いません（A列が三択でないので自動で飛ばされます）。": "A header row is fine — it is skipped, because column A is not one of the three words.",
  "ファイルそのものはどこにも送りません。この端末で読み取った中身だけを送ります。": "The file itself is never uploaded. Only the rows read on this device are sent.",
  "メールアドレスに書いてある7桁の数字です。": "The 7 digits written in the email address.",
  "頭の一文字ごと（c1234567）打っても構いません。数字だけを取り出してしまいます。": "You may type the leading letter too (c1234567). Only the digits are kept.",
  "教授のドメインが、まだ決まっていません。このままだと入れられません。": "The professor domain is not set yet, so this cannot be added.",
  "学籍番号は7桁の数字です。このままだと入れられません。": "A student number is 7 digits, so this cannot be added.",
  "このままだと入れられません。": "This cannot be added as it is.",
  "メールアドレスの中に7桁の数字がありません。このままだと入れられません。": "There are no 7 digits in the email address, so this cannot be added.",
  "このアドレスを名簿から消す": "Remove this address from the roster",
  "予定の登録": "Schedule",
  "授業・イベント・課外活動": "Classes, events and clubs",
  "教室を選んでください": "Choose a room",
  "日にちを選んでください": "Choose a date",
  "授業名を入れてください": "Enter a class name",
  "時限を選んでください": "Choose a period",
  "団体を選んでください": "Choose a club",
  "イベント名を入れてください": "Enter an event name",
  "予定を消しました": "The entry was deleted",
  "消せませんでした。権限が足りない可能性があります": "Could not delete. You may not have permission.",
  "学科・課外活動・イベントの表がまだ作られていないため、下の一覧は空のままです。": "The department, club and event tables have not been created yet, so the lists below are empty.",
  "を貼り付けて実行すると、必要なものが一度にそろいます。": " and run it — that sets up everything at once.",
  "15週ぶんまとめて選ばれます。": "picks 15 weeks at once.",
  "ほかの日で埋まっている教室は、登録したあとに日付つきでお知らせします。": "Rooms taken on the other days are reported with their dates after you register.",
  "解除": "Clear",
  "空いている教室をすべて選ぶ（": "Select every free room (",
  "全部外す": "Clear all",
  "授業名": "Class name",
  "クラス（いくつでも選べます）": "Classes (choose as many as you like)",
  "足す": "Add",
  "クラスは、同じ科目を分けて受ける組のこと。": "A class is a group taking the same subject separately.",
  "担当の先生の名前": "Name of the teacher in charge",
  "ここに書いた名前が、時間割に出ます。": "The name written here appears in the timetable.",
  "担当の先生が別の人なら、その名前に書き換えてください。": "If someone else teaches it, replace it with their name.",
  "登録した人には知らせが届きます。よろしいですか？": "Whoever registered them will be notified. Is that all right?",
  "はい、取り消して登録する": "Yes, cancel them and register",
  "一つの教室の一つの時間に入るのは一つだけです。学科が違っても重ねられません。": "Only one entry fits one room at one time, even across different departments.",
  "優先順位は 授業 ＞ イベント ＞ 課外活動。": "Priority is classes > events > clubs.",
  "同じ強さどうしは、先に入れたものが残ります。": "Between equals, the one registered first stays.",
  "この日をすべて消す": "Delete everything on this day",
  "まだ何も入っていません。": "Nothing has been entered yet.",
  "削除": "Delete",
  "この予定を消しますか？元には戻せません。": "Delete this entry? It cannot be undone.",
  "はい、消す": "Yes, delete",
  "消せるのは、自分で入れたもの。授業は教授も消せます。": "You can delete what you entered. Professors can also delete classes.",
  "教室の登録": "Rooms",
  "何号館の何階に、どの教室があるか": "Which rooms are on which floor of which building",
  "（302→3階、B01→地下1階）。あとから直せます。": "(302 → 3F, B01 → B1). You can fix them later.",
  "まとめて追加": "Add them all",
  "名称（任意）": "Name (optional)",
  "階。地下は -1": "Floor. Use -1 for basement",
  "その日の提供状況と品名": "What is served that day, and its name",
  "名称を入れてください": "Enter a name",
  "食堂の設定ができるのは、食堂の担当だけです。": "Only cafeteria staff can change these settings.",
  "どの項目を設定しますか": "Which item?",
  "食堂の項目が登録されていません。": "No cafeteria items have been entered.",
  "この日の状態を選んでください": "Choose the state for this day",
  "この日の名称を入れてください": "Enter the name for this day",
  "味噌カツ丼": "Miso katsu bowl",
  "この日の登録を消す": "Delete this day’s entry",
  "使っている人から届いた声。名前は分かりません": "What people told us. Names are not shown",
  "目にあまるものだけ、既読の欄の「良くないコメント」から確かめられます。": "Only for the worst ones, “Bad comment” in the Read tab shows who wrote it.",
  "押したことと、押したのが誰かは記録に残ります。": "Pressing it, and who pressed it, is recorded.",
  "感想を押すと、既読へ移ります。": "Tap a comment to move it to Read.",
  "ぜんぶ既読にする": "Mark all as read",
  "左の丸を押して選ぶと、まとめて消せます。": "Tick the circles on the left to delete several at once.",
  "既読をぜんぶ消す": "Delete all read",
  "良くないコメント": "Bad comment",
  "押すと既読 →": "Tap to mark read →",
  "新規に戻す": "Back to new",
  "消す": "Delete",
  "地図へ": "To the map",
  "いま開いています": "You are here",
  "作図ツール": "Map editor",
  "建物・出入口・通路を描き直す": "Redraw buildings, entrances and paths",

  "ログインしていません。": "You are not logged in.",
  "この画面は、いまの権限では使えません。": "Your current role cannot use this screen.",
  "まだ本人確認か所属の記入が済んでいない人": "Not yet verified, or details not entered",
  "学生と申請者をやり直させる": "Make students and applicants start again",
  "管理者（食堂・課外活動・教授・副管理者・管理者）は全員残ります。": "Everyone with a role (cafeteria, clubs, professor, sub-admin, administrator) is kept.",
  "副管理者（2.1・2.2）も": "Sub-admins (2.1 / 2.2) too",
  "残るのは、いちばん上の権限の人だけです。": "Only the top administrator is kept.",
  "身分ごとに消す": "Delete by kind",
  "本人が選んだ身分": "The kind they chose",
  "選んだ人だけを消す": "Delete only the people you ticked",
  "いま入っている名簿": "Roster on file",
  "学生の名簿だけ": "the student roster only",
  "ログインしている人を見る": "See who is logged in",
  "学生だけ": "students only",
  "学部（すべて）": "Faculty (all)",
  "ドメイン名確認": "Domain settings",
  "「なし」": "“off”",
  "いまログインしている人は、変えても入ったままです。": "People already logged in stay logged in.",
  "xlsx から取り込む": "Import from xlsx",
  "A 身分（学生／教授／その他）・B メールアドレス・C 名前": "A kind (student / teacher / other), B email, C name",
  "D 学年・E クラス・F 名列番号・G 学籍番号": "D year, E class, F seat no., G student no.",
  "H 8桁の番号": "H 8-digit number",
  "G 学籍番号": "G student number",
  "は、アドレスに書いてある": " is the ",
  "7桁の数字": "7 digits in the address",
  "一人ずつ手で入れる": "Add one person by hand",
  "全部入りました。": "Everything went in.",
  "データベースの準備がまだ終わっていません。": "The database is not ready yet.",
  "「＋15週」": "“+15 weeks”",
  "教室が登録されていません": "No rooms have been registered",
  "選択中：": "Selected: ",
  "学科を選ぶ": "Choose a department",
  "学科が登録されていません": "No departments have been registered",
  "新しく登録する": "Register a new one",
  "系統を選ぶ": "Choose a category",
  "団体を選ぶ": "Choose a club",
  "課外活動が登録されていません": "No clubs have been registered",
  "どの日の予定を見るか": "Which day to look at",
  "建物": "Building",
  "階は番号から自動で判定": "the floor is worked out from the number",
  "まず日を選んでください": "Choose a date first",
  "選択中": "Selected",
  "円（任意）": "yen (optional)",
  "まだ星が付いた感想はありません。": "No comments with a star yet.",
  "出しません": "not shown",
  "これを書いた人": "Who wrote this",

  /* 申請のいちばん最初に訊く身分 */
  "あなたの身分": "Who are you?",
  "身分（学生・教授・その他）": "Student, teacher or other",
  学生: "Student",
  "教授・教員": "Teacher",
  "学年・クラス・名列番号があります": "You have a year, class and seat number",
  "授業を受け持っています": "You teach classes",
  "職員・関係者など": "Staff and others",
  "選んだ内容によって、このあと訊くことが変わります。ここで選んだものがそのまま権限になるわけではありません。":
    "What we ask next depends on this. Your choice here does not by itself grant any role.",
  "一つ戻る": "Back one step",
  "8桁の番号": "8-digit number",
  "8桁で入れてください": "Please enter 8 characters",
  "大学から配られている8桁の番号を入れてください。名簿と突き合わせます。":
    "Enter the 8-digit number the university gave you. We check it against the roster.",
  "これができたら、大学の情報を入れて申請します。":
    "After this you enter your university details and apply.",
  "申請は": "Sign-up takes ",
  "つの段どりで進みます。": " steps.",

  /* 直し方の案内。手順そのものは lib/browser.ts に英語版がある */
  直し方: "How to fix",
  "現在地の許可を直す": "Allow location again",
  "お使いのブラウザを選んでください": "Which browser are you using?",
  パソコン: "Computer",
  "HTTPS でないと位置情報は使えません。公開URL（https://）から開いてください":
    "Location needs HTTPS. Open the public https:// address.",
  "この端末では位置情報を扱えないようです。建物一覧から目的地を選べます":
    "This device cannot provide location. You can still pick a destination from the list.",

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
  // 英語では数のうしろに何も付けない（"3 件" → "3"）
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
  学科: "Department",
  クラス: "Class",
  組: "Group",
  名列番号: "Seat no.",
  "学年・クラス・名列番号をすべて入れてください": "Please enter year, class and seat number",
  "名列番号は1から200までの数字です": "The seat number must be between 1 and 200",
  "クラスは1から10までの数字です": "The class must be between 1 and 10",
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
  "続けて、認証アプリで本人確認をしてください。": "Next, verify with your authenticator app.",
  "スマートフォンに Microsoft Authenticator を入れておいてください。":
    "Install Microsoft Authenticator on your phone first.",
  "申請しました。管理者の承認をお待ちください。":
    "Application sent. Please wait for an administrator to approve it.",
  "申請は受け付けています。管理者が承認すると学内情報が見られるようになります。":
    "Your application is in. Campus information opens once an administrator approves it.",
  "承認済みです。下のボタンから使えます。": "Approved. Use the button below.",
  "このメールアドレスでは申請できません": "This email address cannot be used",
  "このメールアドレスは登録済みです。［ログイン］から入ってください":
    "This address is already registered. Please use Log in.",
  "すでに登録済みです。アプリに出ている6桁を入れてください":
    "Already registered. Enter the 6-digit code from your app.",
  "メールアドレスかパスワードが違います": "Wrong email or password",
  "パスワードの条件を満たしていません": "Password does not meet the requirement",
  "6桁の数字を入れてください": "Enter the 6-digit code",
  "6桁の数字が合いません。アプリの表示を確かめて、もう一度入れてください":
    "That code did not match. Check your app and try again.",
  "認証アプリの登録に失敗しました。もう一度お試しください":
    "Could not register the authenticator app. Please try again.",
  "しばらく待ってから、もう一度お試しください":
    "Email sending limit reached. Please wait a while and try again.",
  "サーバーに接続できません。": "Cannot reach the server.",
  "1号館": "Bldg. 1",
  /* 申請の段どり（4段）。順番は 記入 → 所属 → 本人確認 → パスワード */
  "メールアドレスと氏名": "Email address and name",
  "学年・クラス・名列番号": "Year, class and roll number",
  "学年・学科・クラス・名列番号": "Year, department, class and roll number",
  "8桁の番号と担当学科": "8-digit number and departments taught",
  担当学科: "Departments taught",
  "担当している学科を選んでください。いくつでも入れられます。":
    "Choose the departments you teach. You can add as many as you like.",
  "（外す）": "(remove)",
  "一つ以上選んでください": "Please choose at least one",
  "Microsoft Authenticator で本人確認": "Verify with Microsoft Authenticator",
  "パスワードを決めて申請": "Choose a password and apply",
  "次へ": "Next",
  "戻る": "Back",
  "これができたら、パスワードを決めて申請します。":
    "After this you choose a password and apply.",
  /* パスワードを忘れたとき */
  "パスワードを忘れた": "Forgot your password?",
  "申請のときに登録した": "We check you again with the ",
  "で、もう一度本人確認をします。": " you registered when you applied.",
  "上のメールアドレスを入れたうえで、アプリに出ている6桁と、新しいパスワードを入れてください。":
    "Enter your email address above, then the 6 digits from the app and a new password.",
  "新しいパスワード": "New password",
  "本人確認して、入れ直す": "Verify and set a new password",
  "認証アプリを消してしまった・端末を替えた場合は、ここからは入れ直せません。管理者にお知らせください。":
    "If you deleted the app or changed devices, you cannot reset it here. Please tell an administrator.",
  "新しいパスワードにしました。": "Your password has been changed.",
  "新しいパスワードにしました。ログインしてください。":
    "Your password has been changed. Please log in.",
  "入れ直せませんでした": "Could not change the password",
  "アドレスか、認証アプリの6桁が違います":
    "The address or the 6 digits from the app is wrong",
  "メールアドレスを入れてください": "Please enter your email address",
  "認証アプリの6桁を入れてください": "Please enter the 6 digits from the app",
  "この席には認証アプリが登録されていないため、ここからは入れ直せません。管理者にお知らせください。":
    "No authenticator app is registered for this account, so it cannot be reset here. Please tell an administrator.",
  "パスワードを決めてください": "Choose a password",
  "次からのログインに使います。": "You will use it to log in from next time.",
  "半角の英数字で8〜20字。数字を1文字以上入れてください。":
    "8 to 20 single-byte letters and digits, including at least one digit.",
  "申請する": "Apply",
  決める: "Set",
  "本人確認ができました。": "You have been verified.",
  "パスワードは半角8〜20字にしてください":
    "The password must be 8 to 20 single-byte characters",
  "半角の英数字だけで入力してください": "Use single-byte letters and digits only",
  "数字を1文字以上入れてください": "Include at least one digit",
  /* 現在地の状態 */
  "構内から 1km 以上離れています。この範囲では現在地を出しません":
    "You are more than 1 km from campus. Your location is not shown at this range.",
  "構内の外にいます": "You are outside the campus.",
  パスワード: "Password",
  "この端末ははじめてです": "This is a new device",
  "Microsoft Authenticator に出ている6桁を入れてください。次からは求めません。":
    "Enter the 6-digit code from Microsoft Authenticator. We will not ask again on this device.",
  "この端末を確かめました。次からは求めません。":
    "This device is verified. We will not ask again here.",
  // メールで確かめていた頃の言い換えは、まとめて外してある。
  // このアプリはメールを一通も送らない。本人確認は認証アプリ、
  // パスワードを忘れた人は管理者が supabase/set_password.sql で決め直す。
  // 使われない文でも、辞書に置いておくと配信されるファイルに載ってしまう。
  // メールで入る道と、画面からのパスワード再設定は無くした。
  // その頃の言い換えは、画面のどこからも使われないので外してある。
  // 忘れた人は管理者が supabase/set_password.sql で決め直して本人に伝える。
  // 申請の段どり。メールは送らないので、届くのを待たせない
  "この端末を、次から確かめるのに使います。":
    "It will be used to confirm this device from next time.",
  "Microsoft Authenticator でQRを読み取り、出てきた6桁を入れてください。":
    "Scan the QR with Microsoft Authenticator and enter the 6-digit code.",
  "接続先が設定されていないため、ログインと申請を受け付けられません。":
    "The server is not configured, so log in and applications are unavailable.",

  /* 申請（教職課程・課外活動リーダー）と、kit-agent の確認 */
  申請: "Apply",
  "教職課程・課外活動リーダー": "Teaching course / Club leader",
  "← 申請にもどる": "← Back to Apply",
  "申請すると、kit-agent が名簿と照らして、その場で決めます。":
    "When you apply, kit-agent checks the roster and decides on the spot.",
  "通らなくても、いままでの使い方は何も変わりません。":
    "If it does not go through, nothing about your current use changes.",
  "kit-agent が確認しています…": "kit-agent is checking…",
  できました: "Done",
  できませんでした: "Could not do it",
  "こちらで直すことです。しばらく待つか、管理する人にお知らせください。":
    "This is on our side. Please wait a little, or tell an administrator.",
  いまの様子: "Where you stand",
  まだ申請していません: "Not applied yet",
  "申請しましたが、通っていません": "Applied, but not accepted",
  通っています: "Accepted",
  もう一度たしかめる: "Check again",
  先に本人確認をしてください: "Please verify yourself first",
  "認証アプリの登録が済んでいないと、{x}の申請はできません。":
    "You cannot apply for {x} until the authenticator app is set up.",
  ログインの画面へ: "Go to the login screen",
  "まだ利用の承認を待っています。承認されたら、ここから申請できます。":
    "Your account is still awaiting approval. Once approved, you can apply here.",
  "ログインの様子が読み取れませんでした。入り直してからお試しください。":
    "We could not read your login. Please sign in again and try once more.",

  /* 教職課程 */
  教職: "the teaching course",
  教職の申請: "Teaching course",
  "教職課程を履修している人": "For students taking the teaching course",
  "教職課程を履修している人だけが使える欄です。":
    "This is only for people taking the teaching course.",
  "申請すると、名簿の教職の欄と突き合わせて、その場で決まります。":
    "Your application is matched against the teaching column of the roster, right away.",
  教職として通っています: "Accepted for the teaching course",
  教職課程を申請する: "Apply for the teaching course",
  教職の申請を取り消す: "Cancel the teaching application",
  "名簿の教職の欄に印が無いと、申請は通りません。":
    "Without a mark in the teaching column of the roster, the application will not pass.",
  "履修しているのに通らないときは、管理者にお知らせください。":
    "If you are taking it but it does not pass, please tell an administrator.",
  "教職として通っても、いままでの使い方は何も変わりません。":
    "Being accepted changes nothing about how you already use the app.",

  /* 課外活動リーダー */
  リーダー: "club leader",
  課外活動リーダー申請: "Club leader",
  "部やプロジェクトの長をしている人": "For people who lead a club or project",
  "部・サークル・プロジェクトの長をしている人だけが使える欄です。":
    "This is only for people who lead a club, circle or project.",
  "8桁の番号と団体を、kit-agent がリーダーの名簿と照らします。":
    "kit-agent checks your 8-character number and club against the leader roster.",
  "通ると、自分の団体の予定を入れられるようになります。":
    "Once accepted, you can add your club's plans.",
  リーダーとして通っています: "Accepted as a leader",
  "のリーダーとして通っています": " — accepted as its leader",
  // 「8桁の番号」は上（申請の欄）にもう入っている
  "学生証の番号（例：c1234567）": "Number on your ID card (e.g. c1234567)",
  "学生証・職員証に書いてある番号を、そのまま入れてください。":
    "Enter the number printed on your student or staff ID card.",
  "8桁になっています。": "That is 8 characters.",
  "いま {n}桁です。8桁で入れてください。":
    "That is {n} characters. Please enter 8.",
  選んでください: "Please choose",
  先に系統を選んでください: "Choose a category first",
  どこのリーダーですか: "Which club do you lead?",
  リーダーとして申請する: "Apply as a leader",
  リーダーの申請を取り消す: "Cancel the leader application",
  "リーダーの名簿に載っていないと、申請は通りません。":
    "Without a row in the leader roster, the application will not pass.",
  "長をしているのに通らないときは、管理者にお知らせください。":
    "If you do lead one but it does not pass, please tell an administrator.",
  "人の番号を入れても通りません。番号がご本人のものかを先に見ています。":
    "Someone else's number will not work — we check the number is yours first.",

  /* ニュース */
  お知らせ: "News",
  "横に送って見られます": "Swipe sideways",
  "ニュースを入れる": "Post news",
  済んだものをまとめて消す: "Clear finished ones",
  "写真と開く先を決めて申請する": "Choose a photo and a link, then apply",
  "ニュースを入れられるのは、学生と承認待ち以外の人です。":
    "Only people other than students and those awaiting approval can post news.",
  "写真を一枚と、押したときに開く先を決めて申請します。":
    "Choose one photo and the page it opens, then apply.",
  "通ると、学内の情報のいちばん上に出ます。通すのは副管理者（2.2）と管理者です。":
    "Once approved it appears at the top of Campus info. Sub-admins (2.2) and administrators approve it.",
  写真: "Photo",
  "押したときに開く先": "Where it opens when tapped",
  "元の頁がある知らせは、そちらへ送ってください。ここで書き写すと、直したときに食い違います。":
    "If the notice already has a page, link to it. Copying the text here means the two can drift apart.",
  "一言（無くてもよい）": "A short line (optional)",
  "工大祭のお知らせ": "About the campus festival",
  "いつからいつまで出すか": "From when until when",
  "終わりの日が、始まりより前になっています。": "The end date is before the start date.",
  "送っています…": "Sending…",
  "出したもの": "What you posted",
  "まだ出していません。": "You have not posted anything yet.",
  "取り下げる": "Withdraw",
  "出ています": "Live",
  "断られました": "Turned down",
  "取り下げました": "Withdrawn",
  "この端末で小さくしてから送ります。地図を開いた人みんなが読み込むので、軽くしておきます。":
    "Shrunk on this device before sending — everyone who opens the map loads it, so it is kept small.",
  "ニュースの承認": "News approvals",
  "いま待っているものはありません。": "Nothing is waiting.",
  "出るようにする": "Publish it",
  断る: "Turn down",
  "（名前なし）": "(no name)",

  /* ニュースの写真の差し替え */
  "写真を差し替える": "Replace the photo",
  "写真を替える": "Change the photo",
  "写真を替えて出し直す": "Change the photo and apply again",
  "この写真に差し替えるところです。通るまでは、いまの写真が出ます。":
    "Waiting to change to this photo. Until it is approved, the current photo stays up.",
  "写真は、出したあとでも差し替えられます。出ているものは、通るまで今の写真のままです。":
    "Photos can be replaced after posting. For live ones, the current photo stays up until the change is approved.",
  /* kit-agent の履歴の絞りこみ */
  身分: "Standing",
  "絞りをやめる": "Clear filters",
  "名前・アドレス・8桁の番号で探す": "Search by name, address or 8-digit number",
  "どの学年も": "Any year",
  "どの学科も": "Any department",
  "どのクラスも": "Any class",
  "どの身分も": "Any standing",
  "この絞りこみに当たるものはありません。": "Nothing matches these filters.",
  "絞りを外すと、ぜんぶ出ます。": "Clear the filters to see everything.",
  "学年・学科・クラス・身分での絞りこみは、データベースに base/34_agent_find.sql を入れると使えるようになります。":
    "Filtering by year, department, class and standing needs base/34_agent_find.sql in the database.",
  "席が消えた人は、学年や学科では出てきません（アドレスでは探せます）。":
    "People whose account is gone cannot be filtered by year or department (you can still search their address).",
  "写真の差し替え": "Photo changes",
  "いまの写真": "Now",
  "新しい写真": "New",
  "差し替えを通す": "Approve the change",
  "差し替えを待っているものはありません。": "No photo changes are waiting.",
  "通るまでは、いまの写真が出ています。": "Until it is approved, the current photo stays up.",
  "写真の差し替えは、まだ使えません。データベースに base/33_news_photo.sql を入れると使えるようになります。":
    "Photo replacement is not available yet — add base/33_news_photo.sql to the database to turn it on.",

  /* 課外活動のお気に入り */
  "お気に入りに入れる": "Add to favorites",
  "お気に入りから外す": "Remove from favorites",
  予定: "Schedule",
  "入れる": "Add",

  /* 8桁の番号と、名簿から選ぶ */
  "ぜんぶ集める": "Collect everyone",
  "保存する": "Save",
  "名簿から選ぶ": "Pick from the roster",
  番: " ",
  "氏名・学籍番号・アドレスで探す": "Search by name, student number or address",
  "名簿に見つかりません。先に名簿へ入れてください。":
    "Not in the roster. Please add them to the roster first.",
  "8桁の番号（数字だけ）": "8-digit number (digits only)",
  "学生証・職員証の8桁の番号です。すべて数字で、アドレスの前の部分とは別のものです。":
    "The 8-digit number on the student or staff card. All digits — not the part before the @ in the address.",
  "すべて数字です。メールアドレスの前の部分とは別のものです。":
    "All digits. Not the part before the @ in your address.",
  "すべて数字の8桁で入れてください": "Enter 8 digits",

  /* kit-agent の様子 */
  "kit-agent の様子": "kit-agent status",
  "働いているか、誰を通して誰をはじいたか": "Whether it is working, and who it let through or turned away",
  "働いています": "Working",
  "待っています": "Waiting",
  "詰まっています": "Stuck",
  "待っている人": "Waiting",
  "見ている最中": "Being checked",
  "この1時間": "Past hour",
  きょう: "Today",
  通した: "Let through",
  はじいた: "Turned away",
  "人に回した": "Passed to a person",
  "最後に動いたのは": "Last activity",
  ぜんぶ: "All",
  "まだ何も残っていません。": "Nothing has been recorded yet.",
  "kit-agent が誰かを見ると、ここに出ます。": "When kit-agent checks someone, it appears here.",
  "申請が溜まっているのに、しばらく何もしていません。":
    "Applications are piling up but nothing has happened for a while.",
  "20秒ごとに見直しています。": "Refreshed every 20 seconds.",
  "kit-agent の様子を見られるのは、レベル2.1・2.2・管理者だけです。":
    "Only levels 2.1, 2.2 and administrators can see kit-agent’s status.",

  /* 書き出しの、身分えらび */
  "出す身分": "Which people to save",

  /* 申請の様子と、やり直し */
  "席をつくった": "Account created",
  "情報を入れた": "Details entered",
  "申請が出そろった": "Application complete",
  "kit-agent が確認しました": "kit-agent has checked this",
  "kit-agent が確認しています": "kit-agent is checking",
  "kit-agent はまだ見ていません": "kit-agent has not looked yet",
  リセット: "Start over",
  "消しています…": "Clearing…",
  "データを一度最初からにする？": "Clear what you entered and start over?",
  "入れ間違えたときは、ここから入れ直せます。":
    "If you entered something wrong, you can start again here.",
  "消えるのは自分で入れた中身だけで、ログインと本人確認は残ります。":
    "Only what you entered is cleared — your login and verification stay.",

  /* ドメインの設定の、身分ごとの説明 */
  "教職員・職員": "Faculty / staff",
  "このドメインの人だけを学生として扱います。アドレスに入っている7桁の数字が学籍番号になり、名簿の学籍番号と合っているかを見ます。":
    "Only people on this domain are treated as students. The 7 digits in the address become the student number, and it is checked against the roster.",
  "このドメインの人だけを教授として扱います。空のあいだは、教授の行を取り込まず、教授の申請は人に回します（追い返しません）。":
    "Only people on this domain are treated as professors. While it is empty, professor rows are not imported and professor applications are passed to a person (they are not turned away).",
  "職員・関係者。空にしておくとドメインを見ません（外部のアドレスの人がいるため）。入れると、そのドメインだけを通します。":
    "Staff and others. Left empty, the domain is not checked (some have outside addresses). Filled in, only that domain is accepted.",
  "いまは「なし」です。ドメインが合っていなくても通ります。":
    "Currently set to “none”. People get through even if the domain does not match.",

  /* 学内の情報の、課外活動を探す欄 */
  "名前で探して、どこでやっているかを見る": "Search by name and see where it meets",
  "課外活動の名前で探すと、いつ・どこでやっているかが出ます。":
    "Search a club by name to see when and where it meets.",
  "吹奏楽、ロボット、テニス…": "Brass band, robotics, tennis…",
  "この先ひと月に、この団体の予定は入っていません。":
    "Nothing is scheduled for this club in the next month.",

  /* 教授の、自分の授業 */
  "自分の授業": "My classes",
  "この日に、あなたが担当する授業は入っていません。":
    "You have no classes scheduled on this day.",
  "担当者の名前で照らしています。出てこないときは、予定の担当の書き方をお確かめください。":
    "Matched on the teacher’s name. If something is missing, check how the teacher is written on the schedule.",

  /* 食堂の写真 */
  "写真（任意）": "Photo (optional)",
  "写真を大きく見る": "View the photo larger",
  "どこかを押すと閉じます": "Tap anywhere to close",
  "小さくしています…": "Shrinking…",
  "この端末で小さくしてから送ります（長辺512点）":
    "Shrunk on this device before sending (longest side 512px)",

  /* 名簿の、課外活動リーダーとログインしている人 */
  "リーダーを見る": "See the leaders",
  "その名前の課外活動は見つかりませんでした。": "No club by that name was found.",
  "この団体だけ": "This club only",
  "すべての団体": "All clubs",
  "リーダーが登録されていません。": "No leaders have been entered.",
  "並びは、分類 → 団体 → 番号の順です。": "Sorted by category, then club, then number.",
  "入れる・消すは「大学の情報登録」から。":
    "Adding and removing is done in “University information”.",
  "ログインしている人": "People logged in",
  "教授（レベル2）が見られるのは学生だけです。": "Professors (level 2) can only see students.",
  "ここに出るのは、席があって権限が付いている人です。名簿に居ても、まだ使っていない人は出ません。":
    "These are people who have a login and a role. Someone in the roster who has not signed up yet will not appear.",
  "xlsx に保存するのは「大学の情報登録」から。":
    "Saving to xlsx is done in “University information”.",

  /* xlsx に書き出す */
  "集めています…": "Collecting…",
  "xlsx に保存する（kit(people).xlsx）": "Save as xlsx (kit(people).xlsx)",
  "身分ごとにシートを分けて出します。1行目が見出しで、そこから1行に1人です。":
    "One sheet per kind of person. Row 1 is the header, then one row per person.",
  "取り込むときと同じ形なので、直してそのまま入れ直せます。":
    "It is the same shape the importer reads, so you can edit it and load it straight back.",

  /* 履歴 */
  履歴: "History",
  "いつ・誰が・何をしたか。エラーも残ります": "Who did what, when — errors are kept too",
  できごと: "Event",
  エラー: "Error",
  そのほか: "Other",
  "取り込み・申請・画面のできごと": "Imports, applications, and things that happened on screen",
  "うまくいかなかったこと（すべての分類から）": "Things that went wrong (across every group)",
  "出た言葉、そのまま": "Exactly as it was reported",
  表なし: "no table",
  "＊が付いた列は、見出しでは分からなかったので中身から当てたものです。":
    "Columns marked ＊ could not be read from the header, so they were worked out from the contents.",

  /* 管理画面の、xlsx から取り込む欄 */
  見出しから読み取りました: "Read from the header row",
  "見出しが見つからないので、A列から順に当てました":
    "No header row found, so columns were taken in order from A",
  "A身分 B メール C氏名 D学年 E学科 Fクラス G名列番号 H学籍番号 I〜N担当学科 O8桁 P教職":
    "A kind, B email, C name, D year, E department, F class, G seat no., H student no., I–N departments taught, O 8-char number, P teaching",
  "下の中身が思ったとおりでなければ、1行目に見出しを入れてから読ませてください。":
    "If the rows below are not what you expect, add a header row and read the file again.",
  "学生 {n} 行のうち {m} 行で、名列番号が空です。":
    "{m} of {n} student rows have no seat number.",
  "列がずれている可能性があります。下の中身を見て確かめてください。":
    "The columns may be shifted. Please check the rows below.",
  "P 教職（学生と教授。履修していれば T。空なら履修していない）":
    "P teaching (students and professors; T if enrolled, blank if not)",
  "1行目に見出しを入れておくと、その言葉で列を読み取ります。":
    "With a header row, columns are read by name.",
  "列を足しても、順を入れ替えても構いません。見出しが無いときだけ、A列から順に当てます。":
    "You may add columns or reorder them. Only without a header are columns taken in order from A.",

  /*
   * 管理画面の、課外活動の情報。
   *
   * はじめはリーダーの名簿だけだったので「課外活動リーダーの名簿」。
   * 団体そのものを増やす欄が入ったので、呼び方を変えた。
   * 古いほうも残してある。どこかで拾い残していても、
   * 英語のときに日本語のまま出るということにならない。
   */
  課外活動の情報: "Club information",
  課外活動リーダーの名簿: "Club leader roster",
  開く: "Open",
  "ここに載っている番号の人だけが、課外活動リーダーの申請で通ります。":
    "Only the numbers listed here pass the club leader application.",
  "空のあいだは、kit-agent は誰も通しません。":
    "While it is empty, kit-agent lets nobody through.",
  課外活動そのものを増やす: "Add a club itself",
  課外活動の名前: "Club name",
  この課外活動を増やす: "Add this club",
  "増やすと、リーダーの名簿・予定の登録・学内の情報の三つに出てきます。":
    "Once added, it appears in the leader roster, the schedule form and the campus info.",
  一人足す: "Add one person",
  どこの団体ですか: "Which club?",
  "8桁の番号（例：c1234567）": "8-character number (e.g. c1234567)",
  "氏名（無くてもよい）": "Name (optional)",
  "入れています…": "Adding…",
  この人を名簿に入れる: "Add this person to the roster",
  "番号・氏名・団体で探す": "Search by number, name or club",
  "団体（すべて）": "Club (all)",
  外す: "Remove",
  "まだ一人も入っていません。": "Nobody has been added yet.",

  /* kit-agent が返す段の見出し */
  ログインの席: "Your login seat",
  本人確認: "Identity check",
  番号はご本人のものか: "Is the number yours",
  リーダーの名簿: "Leader roster",
  学生の名簿: "Student roster",
  教職員の名簿: "Staff roster",
  教職の欄: "Teaching column",
};

/** 建物の名前のうち、号館ではないもの */
const EN_PLACE: Record<string, string> = {
  グラウンド: "Athletic Field",
  テニスコート: "Tennis Courts",
  "金沢工業大学前バス停": "KIT-mae Bus Stop",
  "野々市工大前バス停": "Nonoichi-Kodai-mae Bus Stop",
  "野々市工大前駅": "Nonoichi-Kodai-mae Station",
  バス停: "Bus Stop",
  "バス停八束穂行き": "Bus Stop (for Yatsukaho)",
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

/**
 * 英語の名前から、日本語へ戻すための表。
 *
 * ★なぜ要るか
 *
 *   英語で使っているときに目的地を選ぶと、そのとき画面に出ていた
 *   名前——つまり英語の名前——が案内に控えられる。
 *   そのあと日本語に戻しても、控えたほうは英語のまま。
 *   訳す向きが片道しかなかったので、戻せなかった。
 *
 *   お気に入りも同じ。英語で登録すると、英語の名前が端末に残る。
 *   戻す道があれば、あとから日本語に切り替えても正しく出る。
 */
const PLACE_BACK: Record<string, string> = {};
for (const [k, v] of Object.entries(EN_PLACE)) PLACE_BACK[loose(v).toLowerCase()] = k;

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
  if (!name) return name;

  /*
   * 日本語に戻すとき。
   *
   * 英語で選んだ目的地や、英語で登録したお気に入りには、
   * 英語の名前が控えられている。そのまま返すと、日本語に
   * 切り替えても英語のままになる。分かるものは戻す。
   *
   * 付け替えた名前（カスタマイズ）はこの表に無いので、
   * ここには当たらない。そのまま返る。
   */
  if (lang === "ja") {
    const back = PLACE_BACK[loose(name).toLowerCase()];
    if (back) return back;
    // 「Bldg. 23」→「23号館」
    return name.replace(/Bldg\.\s*(\d+)/g, "$1号館");
  }

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
