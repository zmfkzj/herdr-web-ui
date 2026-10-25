import { SETTINGS_JA } from "./i18n/settings.ja.ts";
import { TERMINAL_JA } from "./i18n/terminal.ja.ts";
import { COMPOSER_JA } from "./i18n/composer.ja.ts";
import { CHAT_JA } from "./i18n/chat.ja.ts";
import { SIDEBAR_JA } from "./i18n/sidebar.ja.ts";
import { MACHINES_JA } from "./i18n/machines.ja.ts";
import { WORKSPACE_JA } from "./i18n/workspace.ja.ts";
import { FILES_JA } from "./i18n/files.ja.ts";
import { DEVICES_JA } from "./i18n/devices.ja.ts";
import { USAGE_JA } from "./i18n/usage.ja.ts";
import { UPDATES_JA } from "./i18n/updates.ja.ts";
import { PALETTE_JA } from "./i18n/palette.ja.ts";

/**
 * Japanese for every `t("…")` in src/ that no part in lib/i18n/ holds: keys more than one feature
 * uses, and the app shell's. JA at the end is this and the parts together. The English string is
 * the key. Grouped by where the text
 * shows; within a group, roughly in the order it appears. Register: labels and buttons as concise
 * nouns or verbs, sentences in です・ます調. Fixed terms: ペイン, ワークスペース, エージェント,
 * ターミナル, チャット, ペアリング, デバイス, セッション, 入力欄, キー (SSH key; 秘密鍵 for private
 * key), デフォルト (not 既定). Product names (herdr, Tailscale, Codex, Claude Code, GitHub), GitHub
 * labels (Star, Issue), acronyms (SSH, CLI, HTTPS, QR) and names like Markdown, Enter, Skill ツール stay
 * in English. Placeholders in braces keep their English names.
 */
const BASE: Record<string, string> = {
  "Save": "保存",
  "Zoom in": "拡大",
  "Zoom out": "縮小",
  "Attached image": "添付画像",
  "Running": "実行中",
  "Image unavailable": "画像を表示できません",
  "Disconnect": "切断",
  "Add a comment before creating feedback.": "フィードバックの作成前にコメントを追加してください。",
  "The message box is not available right now.": "今はメッセージ入力欄を使えません。",
  "Add center comment": "中央にコメントを追加",
  "Cancelled": "キャンセル済み",
  "Certificate SHA-256": "証明書のSHA-256",
  "Click to pin, drag to select an area. Feedback is added to the draft, never sent automatically.": "クリックでピン、ドラッグで範囲を追加します。フィードバックは下書きに追加され、自動送信されません。",
  "Comment {n}": "コメント {n}",
  "Completed": "完了",
  "Create feedback draft": "フィードバック下書きを作成",
  "Desktop disconnected": "デスクトップ接続が切断されました",
  "Discard unsaved image comments?": "未保存の画像コメントを破棄しますか？",
  "Image annotation area": "画像注釈領域",
  "Image comments": "画像コメント",
  "Image is too large to annotate.": "画像が大きすぎるため注釈を作成できません。",
  "Interrupted": "中断",
  "No recorded orche jobs in this Pi branch.": "このPi分岐にはorcheジョブの記録がありません。",
  "Observe only": "表示のみ",
  "One-time viewer password": "一時ビューアーパスワード",
  "Open private desktop": "専用デスクトップを開く",
  "Desktop viewing is off for this PC.": "このPCのデスクトップ表示をオフにしました。",
  "Desktop viewing is on for this PC.": "このPCのデスクトップ表示をオンにしました。",
  "Desktop viewing is turning on: this PC's bridge restarts (herdr sessions keep running). Follow it in the PC list, then open the desktop again.": "デスクトップ表示をオンにしています。このPCのブリッジが再起動します(herdrセッションは動き続けます)。PC一覧で進行状況を確認してから、デスクトップを開き直してください。",
  "Pi's completion list was open when Enter was pressed, and it offers {other} for {worker} too: Pi may have opened that one. Press Esc before Enter, or send /gui view {worker} from the message box.": "Enterを押したときPiの補完リストが開いていて、{worker}に対して{other}も候補にあります。Piがそちらを開いた可能性があります。Enterの前にEscを押すか、メッセージ欄から/gui view {worker}を送ってください。",
  "Run /gui view W1 in this pane (typed into the terminal or sent from the message box) to open that worker's desktop here at once.": "このペインで/gui view W1を実行すると(ターミナルに直接入力するか、メッセージ欄から送信)、そのワーカーのデスクトップがすぐここに開きます。",
  "Turn off desktop viewing for this PC": "このPCのデスクトップ表示をオフにする",
  "Turn on desktop viewing for this PC": "このPCのデスクトップ表示をオンにする",
  "Pi session changed; reopen visual tools": "Piセッションが変わりました。ビジュアルツールを開き直してください。",
  "This PC cannot find pi-gui viewers by itself (it needs Linux). Enter the fields /gui view printed in Pi's terminal.": "このPCはpi-guiビューアを自分で見つけられません(Linuxが必要です)。Piのターミナルに/gui viewが表示した接続情報を入力してください。",
  "No GUI desktop named {worker} in this Pi session. Check the name in /gui view list.": "このPiセッションに{worker}という名前のGUIデスクトップはありません。/gui view listで名前を確認してください。",
  "{worker} has no running viewer. Pi's terminal shows why /gui view did not start it.": "{worker}に実行中のビューアがありません。/gui viewが起動できなかった理由はPiのターミナルに表示されます。",
  "Enter {worker}'s one-time password from the /gui view output in Pi's terminal.": "Piのターミナルの/gui view出力にある{worker}のワンタイムパスワードを入力してください。",
  "The bridge update started. Follow it in the PC list, then open the desktop again.": "ブリッジの更新を開始しました。PC一覧で進行状況を確認してから、デスクトップを開き直してください。",
  "{worker}'s private desktop": "{worker}の専用デスクトップ",
  "Waiting for {worker}'s viewer from /gui view…": "/gui viewが起動する{worker}のビューアを待っています…",
  "Connected. Pause the worker before taking control.": "接続しました。操作する前にワーカーの作業を止めてください。",
  "Pause the worker before taking control.": "操作する前にワーカーの作業を止めてください。",
  "Install Pi visual bridge": "Piビジュアルブリッジをインストール",
  "Shift+Escape leaves screen focus. Closing this viewer keeps Pi and its desktop running. Switch input takes or hands back control without reconnecting; a reconnect asks for the password again.": "Shift+Escapeで画面のフォーカスから抜けます。ビューアを閉じてもPiとデスクトップは動き続けます。入力切り替えで、再接続せずに操作を始めたり戻したりできます。再接続するとパスワードを再び求められます。",
  "Switch input": "入力切り替え",
  "Switching input…": "入力を切り替え中…",
  "Input on: mouse and keyboard reach the desktop": "入力中：マウスとキーボードがデスクトップに届きます",
  "View only: input is blocked": "表示のみ：入力はブロックされています",
  "Input is on. Do not use the desktop while the worker is acting on it.": "入力がオンです。ワーカーが作業している間はデスクトップを操作しないでください。",
  "The desktop kept its input mode.": "デスクトップは入力モードを変えませんでした。",
  "The desktop did not confirm view-only mode, so this viewer disconnected to stop input.": "デスクトップが表示のみへの切り替えを確認しなかったため、入力を止めるためにこのビューアを切断しました。",
  "The desktop did not confirm the input switch. Its PC may run an older Pi visual bridge: install this server's bridge there, or reconnect with Observe only unchecked.": "デスクトップが入力の切り替えを確認しませんでした。そのPCのPi visualブリッジが古い可能性があります。このサーバーのブリッジをそのPCにインストールするか、「表示のみ」を外して再接続してください。",
  "{worker}'s desktop": "{worker}のデスクトップ",
  "Original Pi · recorded orche state; refreshes while open": "オリジナルPi · 記録されたorche状態、パネル表示中に更新",
  "Pi workers and desktop": "Piワーカーとデスクトップ",
  "Please revise the marked image using these comments:": "次のコメントに従ってマークした画像を修正してください：",
  "Private desktop": "専用デスクトップ",
  "Private desktop screen": "専用デスクトップ画面",
  "Queued": "待機中",
  "RDP port": "RDPポート",
  "Recent jobs only; complete history remains in Pi records.": "最近のジョブのみ表示します。全履歴はPiの記録に残っています。",
  "Recorded sub-workers": "記録されたサブワーカー",
  "Resolved": "解決済み",
  "Result": "結果",
  "Run /gui view W1 or /gui view main in Pi, then enter its connection fields. Pause the worker before taking control.": "Piで /gui view W1 または /gui view main を実行し、接続情報を入力してください。操作前にワーカーを停止してください。",
  "Save failed": "保存に失敗しました",
  "Saved": "保存済み",
  "Unknown": "不明",
  "Use /orche commands for control; existing Pi approval rules are unchanged.": "操作には /orche コマンドを使用してください。既存のPi承認ルールは変更されません。",

  "Back": "戻る",
  "Scroll pane up": "ペインを上にスクロール",
  "Scroll pane down": "ペインを下にスクロール",
  "Find in terminal": "ターミナル内を検索",
  "Previous match": "前の一致",
  "Next match": "次の一致",
  "Close search": "検索を閉じる",
  "No matches": "一致なし",
  "{current} of {total}": "{total}件中{current}件目",
  "Recent folders": "最近のフォルダー",
  "Dismiss": "閉じる",
  "Input line": "入力欄",
  // ---- settings ----
  "Settings": "設定",
  "Chat": "チャット",
  "Agent default": "エージェントの既定",
  "Phone & devices": "スマートフォンとデバイス",
  "Install app": "アプリをインストール",

  // ---- shortcuts (lib/shortcuts.ts labels) ----
  "Command palette": "コマンドパレット",
  "Switch chat / terminal": "チャット / ターミナルを切り替え",
  "Focus pane input": "ペインの入力欄にフォーカス",
  "Toggle sidebar": "サイドバーの切り替え",
  "New workspace": "新しいワークスペース",
  "Previous pane": "前のペイン",
  "Next pane": "次のペイン",

  // ---- agent status words (lib/status.ts) ----
  "READY": "待機",
  "RUN": "実行中",
  "INPUT": "入力待ち",
  "DONE": "完了",
  "BG": "BG待ち",
  "—": "—",

  // ---- app header and shell ----
  "Opening link…": "リンクを開いています…",
  "Connecting to Ovis…": "Ovis に接続しています…",
  "Close workspace list": "ワークスペース一覧を閉じる",
  "Open workspace list": "ワークスペース一覧を開く",
  "Show workspace list": "ワークスペース一覧を表示",
  "Hide workspace list": "ワークスペース一覧を非表示",
  "Pane closed": "ペインは閉じられました",
  "Show the terminal": "ターミナルを表示",
  "Show the chat": "チャットを表示",
  "Close this half": "この半分を閉じる",
  "Toggle sidebar (⌘⇧B)": "サイドバーの切り替え (⌘⇧B)",
  "Chat transcript (⌘⇧J)": "チャット履歴 (⌘⇧J)",
  "Live terminal (⌘⇧J)": "ライブターミナル (⌘⇧J)",
  "Live terminal: coming to Windows PCs once herdr can attach there": "ライブターミナル: herdr が Windows でアタッチに対応したら使えます",
  "soon": "近日",
  "Terminal": "ターミナル",
  "herdr {version} · protocol {protocol}": "herdr {version} · プロトコル {protocol}",
  "live": "接続中",
  "disconnected": "切断",
  "reconnecting": "再接続中",
  "connecting": "接続しています",
  "herdr offline": "herdr オフライン",
  "Status unknown": "状態不明",
  "herdr unavailable": "herdr 応答なし",
  "The last health check failed. Last seen: herdr {version} · protocol {protocol}": "直近の状態確認に失敗しました。最後に確認した状態: herdr {version} · プロトコル {protocol}",
  "The health check failed": "状態確認に失敗しました",
  "Start herdr on this PC, or check HERDR_SOCKET.": "この PC で herdr を起動するか、HERDR_SOCKET を確認してください。",
  "The other PC's answer was larger than this app accepts": "別の PC の応答が、このアプリで受け取れるサイズを超えています",
  "The other PC's answer could not be read": "別の PC の応答を読み取れませんでした",
  "Browse files": "ファイルを参照",
  "Copy link": "リンクをコピー",
  "Link copied": "リンクをコピーしました",
  "That agent has closed: its workspace is open": "そのエージェントは閉じられました。代わりにワークスペースを開きました",
  "That link's workspace is closed": "そのリンクのワークスペースは閉じられています",
  "That link's PC is not set up here": "そのリンクの PC はここに設定されていません",
  "Command palette (⌘⇧K)": "コマンドパレット (⌘⇧K)",
  "Could not sign out. Try again.": "サインアウトできませんでした。もう一度お試しください。",
  "Retry": "再試行",
  "Notify me when a pane needs input or finishes": "ペインが入力を待っているときや完了したときに通知します",
  "On, pushed to this device": "オン、この端末にプッシュ",
  "Alerts on, pushed to this device, even with the app closed. Tap to turn them off": "通知オン。このデバイスにプッシュされます。アプリを閉じていても届きます。タップするとオフになります",
  "Off on this device": "この端末ではオフ",
  "More": "その他",
  "More · alerts are off": "その他 · 通知オフ",
  "Alerts off on this device. Tap to turn them on": "このデバイスでは通知がオフです。タップするとオンになります",
  "On in this tab": "このタブでオン",
  "Alerts on while this tab is open. Tap to turn them off": "このタブを開いている間は通知が届きます。タップするとオフになります",
  "On in the app": "アプリ内でオン",
  "Alerts on in the app. Tap to allow them when it is closed too": "アプリ内の通知はオンです。タップすると、アプリを閉じてるときにも許可できます",
  "Alerts on in the app. Tap to turn them off": "アプリ内の通知はオンです。タップするとオフになります",
  "Alerts on while this tab is open (closed-app alerts need https, and on iPhone the home-screen app). Tap to turn them off": "このタブを開いている間は通知が届きます (アプリを閉じた後の通知には https が必要で、iPhone ではホーム画面のアプリである必要があります)。タップするとオフになります",

  // ---- sidebar ----
  "Rename pane": "ペインの名前を変更",
  "Branch": "ブランチ",
  "Opening…": "開いています…",
  "Detached HEAD": "分離した HEAD",
  "Delete": "削除",
  "Close": "閉じる",
  "Rename failed: {reason}": "名前を変更できませんでした: {reason}",

  // ---- PCs sidebar ----
  "Connecting…": "接続しています…",
  "Connected": "接続済み",
  "Reconnecting…": "再接続しています…",
  "Add PC": "PC を追加",
  "Connect": "接続",
  "Step {n} of {total}": "ステップ {n} / {total}",
  "{done} of {total}": "{done} / {total}",

  // ---- command palette ----
  "Refresh": "更新",
  "Search panes and actions": "ペインと操作を検索",

  // ---- new workspace ----
  "Browse": "参照",
  "Cancel": "キャンセル",
  "Starting…": "起動しています…",
  "Start": "開始",
  // the launch's model, effort, first message and skills (lib/agentLaunchMode.ts, lib/newSession.ts)

  // ---- folder browser ----
  "No matching folders": "一致するフォルダーはありません",
  "This folder cannot be opened.": "このフォルダーは開けません。",
  "Folders could not be loaded.": "フォルダーを読み込めませんでした。",

  // ---- files ----
  "Files": "ファイル",
  "This image is {size}; download it to view.": "この画像は {size} です。表示するにはダウンロードしてください。",
  "Download": "ダウンロード",
  "Open {path}": "{path} を開く",

  // ---- PC dialog ----
  "Continue": "続行",

  // ---- updates ----
  "Reload app": "アプリを再読み込み",
  "Details": "詳細",


  // ---- prompt card ----
  "Submit": "送信",
  "Recommended": "推奨",


  // ---- composer ----
  "Drag to resize · double-click to reset": "ドラッグでサイズ変更 · ダブルクリックでリセット",
  "Failed": "失敗",
  "Send now": "今すぐ送信",

  // ---- chat view ----
  "Copied": "コピーしました",
  "Worked for {duration}": "{duration} 作業しました",
  "Copy message": "メッセージをコピー",
  "terminal ended": "ターミナルが終了しました",
  "{m}m": "{m}分",
  "{h}h {m}m": "{h}時間 {m}分",

  // ---- terminal ----
  "The question on screen changed; check it and answer again.": "画面上の質問が変わりました。確認してもう一度回答してください。",
  "Reconnect": "再接続",
  "Discard": "破棄",
  "Held message — review and send": "保持中のメッセージ。確認して送信してください",


  // ---- voice input ----
  "Dictate (hold)": "音声入力（長押し）",
  "Microphone permission was denied": "マイクの使用が許可されませんでした",
  "Voice input needs HTTPS": "音声入力には HTTPS が必要です",
  // ---- errors (lib/userError.ts) ----
  "This browser is not signed in to this PC any more. Pair it again in Settings → Phone & devices.": "このブラウザーはもうこの PC にサインインしていません。設定 → スマートフォンとデバイスでもう一度ペアリングしてください。",
  "That item no longer exists on the PC. Refresh and try again.": "その項目は PC にもうありません。更新してからもう一度お試しください。",
  "It changed on the PC while you were acting. Check it and try again.": "操作中に PC 側で変更されました。確認してからもう一度お試しください。",
  "The PC took too long to answer. Try again.": "PC の応答に時間がかかりすぎました。もう一度お試しください。",
  "OpenCode did not confirm the answer. Check the question before sending again.": "OpenCode から回答の受信確認が届きませんでした。再送する前に質問を確認してください。",
  "The PC could not do that. Try again; if it keeps failing, restart Ovis on the PC.": "PC でその操作を実行できませんでした。もう一度お試しください。失敗が続く場合は PC で Ovis を再起動してください。",
  "Can't reach the PC. Check your connection, then try again.": "PC に接続できません。接続を確認してからもう一度お試しください。",
  "Something went wrong. Try again.": "問題が発生しました。もう一度お試しください。",
  "Not signed in to this PC": "この PC にサインインしていません",
  "It no longer exists on the PC": "PC にはもうありません",
  "It changed on the PC": "PC 側で変更されました",
  "The PC took too long": "PC の応答が遅すぎました",
  "Can't reach the PC": "PC に接続できません",
  "PC disk is full": "PC のディスクがいっぱいです",
  "No permission on the PC": "PC で権限がありません",
  "Pair it again in Settings → Phone & devices.": "設定 → スマートフォンとデバイスでもう一度ペアリングしてください。",
  "Refresh and try again.": "更新してからもう一度お試しください。",
  "Check it and try again.": "確認してからもう一度お試しください。",
  "Check your connection, then try again.": "接続を確認してからもう一度お試しください。",
  "Try again; if it keeps failing, restart Ovis on the PC.": "もう一度お試しください。失敗が続く場合は PC で Ovis を再起動してください。",
  "The server cannot save settings: check that its state folder is writable.": "サーバーが設定を保存できません。サーバーの状態フォルダーに書き込めるか確認してください。",


  // ---- devices ----
  "Loading…": "読み込んでいます…",
  "Done": "完了",

  // ---- phone ----
  "Copy": "コピー",
  "…": "…",
  "Alerts": "通知",
  "Sending…": "送信中…",
  "Needs input": "入力が必要",
  "Finished": "完了",
  "Open pane": "ペインを開く",
  "Quick replies": "クイック返信",
  "Skills": "スキル",
  "Not sent: send or discard the held input first.": "未送信: 先に保持した入力を送信するか破棄してください。",
  "Queue could not be saved. Keep this tab open or copy the messages before reloading.": "キューを保存できませんでした。このタブを開いたままにするか、再読み込みする前にメッセージをコピーしてください。",
  "Queued messages": "キュー内のメッセージ",
  "Not confirmed. Check the terminal before sending again.": "送信を確認できませんでした。再送信する前にターミナルを確認してください。",
  "Too large to attach: {name} ({size}). A file can be up to {limit}.": "添付するには大きすぎます: {name}（{size}）。ファイルは {limit} まで添付できます。",
  // ---- subscription usage ----
  "Move {name} up": "{name} を上へ移動",
  "Move {name} down": "{name} を下へ移動",
  "Subscription usage": "サブスクリプション使用量",
  "Resets in {time}": "{time}後にリセット",
  "{n} background task": "バックグラウンドタスク {n} 件",
  "{n} background tasks": "バックグラウンドタスク {n} 件",
  "Try again": "再試行",
  // tabs: the strip over the pane, and the New tab dialog
  "New tab": "新しいタブ",
  "Zoom pane": "ペインをズーム",
  "Unzoom pane": "ズームを解除",
  "This PC's bridge does not offer this yet": "このPCのブリッジはまだこの機能に対応していません。",
  "Split pane right": "ペインを右に分割",
  "Split pane down": "ペインを下に分割",
  "Plan: {done} of {total} done": "計画: {total} 件中 {done} 件完了",
  "Plan": "計画",
  "Something went wrong": "問題が発生しました",
  "The app hit an error and stopped drawing. Your terminals keep running in herdr.": "アプリでエラーが発生し、表示できなくなりました。ターミナルは herdr で動き続けています。",
  "Copy details": "詳細をコピー",
  "This pane can't be shown.": "このペインを表示できません。",
  "The sidebar can't be shown.": "サイドバーを表示できません。",
  "Diff layout": "差分の表示形式",
  "Unified": "1列",
  "Split": "並べて表示",
  // t3code ports (a)
  // t3code ports (d)
  "Change PC": "PCを切り替え",
  "Selected": "選択中",
};

/** The parts JA is made of; src/lib/i18n.test.ts fails when a key is in two parts, since a spread keeps only the last. */
export const JA_PARTS: Record<string, Record<string, string>> = {
  base: BASE,
  settings: SETTINGS_JA,
  terminal: TERMINAL_JA,
  composer: COMPOSER_JA,
  chat: CHAT_JA,
  sidebar: SIDEBAR_JA,
  machines: MACHINES_JA,
  workspace: WORKSPACE_JA,
  files: FILES_JA,
  devices: DEVICES_JA,
  usage: USAGE_JA,
  updates: UPDATES_JA,
  palette: PALETTE_JA,
};

export const JA: Record<string, string> = Object.assign({}, ...Object.values(JA_PARTS));
