import { SETTINGS_ZH } from "./i18n/settings.zh.ts";
import { TERMINAL_ZH } from "./i18n/terminal.zh.ts";
import { COMPOSER_ZH } from "./i18n/composer.zh.ts";
import { CHAT_ZH } from "./i18n/chat.zh.ts";
import { SIDEBAR_ZH } from "./i18n/sidebar.zh.ts";
import { MACHINES_ZH } from "./i18n/machines.zh.ts";
import { WORKSPACE_ZH } from "./i18n/workspace.zh.ts";
import { FILES_ZH } from "./i18n/files.zh.ts";
import { DEVICES_ZH } from "./i18n/devices.zh.ts";
import { USAGE_ZH } from "./i18n/usage.zh.ts";
import { UPDATES_ZH } from "./i18n/updates.zh.ts";
import { PALETTE_ZH } from "./i18n/palette.zh.ts";

/**
 * Simplified Chinese for every `t("…")` in src/ that no part in lib/i18n/ holds: keys more than
 * one feature uses, and the app shell's. ZH at the end is this and the parts together. The English
 * string is the key. Grouped by where
 * the text shows; within a group, roughly in the order it appears. Register: zh-CN software UI
 * (like VS Code 简体中文): concise labels and buttons, plain declarative sentences, full-width
 * punctuation in Chinese sentences, a half-width space between Chinese and Latin words. Fixed
 * terms: 窗格 (pane; 面板 only in 命令面板), 工作区 (workspace), 终端 (terminal), 聊天 (chat),
 * 配对 (pairing), 设备 (device), 会话 (session), 输入框 (composer). Terms Chinese developers read
 * in English stay English: Agent, Token, Skill, Star, bridge, Issue, CLI, SSH, Markdown, Shell;
 * product names (herdr, Tailscale, Codex, Claude Code, GitHub) and key caps stay as they are.
 * Placeholders in braces keep their English names.
 */
const BASE: Record<string, string> = {
  "Save": "保存",
  "Zoom in": "放大",
  "Zoom out": "缩小",
  "Attached image": "附加的图片",
  "Running": "运行中",
  "Image unavailable": "无法显示图片",
  "Disconnect": "断开连接",
  "Add a comment before creating feedback.": "请先添加评论再创建反馈。",
  "The message box is not available right now.": "当前无法使用消息输入框。",
  "Add center comment": "在中心添加评论",
  "Cancelled": "已取消",
  "Certificate SHA-256": "证书 SHA-256",
  "Click to pin, drag to select an area. Feedback is added to the draft, never sent automatically.": "点击添加标记，拖动选择区域。反馈仅加入草稿，不会自动发送。",
  "Comment {n}": "评论 {n}",
  "Completed": "已完成",
  "Create feedback draft": "创建反馈草稿",
  "Desktop disconnected": "桌面连接已断开",
  "Discard unsaved image comments?": "丢弃未保存的图片评论？",
  "Image annotation area": "图片标注区域",
  "Image comments": "图片评论",
  "Image is too large to annotate.": "图片过大，无法标注。",
  "Interrupted": "已中断",
  "No recorded orche jobs in this Pi branch.": "此 Pi 分支没有 orche 任务记录。",
  "Observe only": "仅查看",
  "One-time viewer password": "一次性查看密码",
  "Open private desktop": "打开独立桌面",
  "Desktop viewing is off for this PC.": "已关闭此 PC 的桌面查看。",
  "Desktop viewing is on for this PC.": "已开启此 PC 的桌面查看。",
  "Desktop viewing is turning on: this PC's bridge restarts (herdr sessions keep running). Follow it in the PC list, then open the desktop again.": "正在开启桌面查看：此 PC 的桥接将重启（herdr 会话会继续运行）。请在 PC 列表中查看进度，然后重新打开桌面。",
  "Pi's completion list was open when Enter was pressed, and it offers {other} for {worker} too: Pi may have opened that one. Press Esc before Enter, or send /gui view {worker} from the message box.": "按下 Enter 时 Pi 的补全列表处于打开状态，且它也为 {worker} 提供了 {other}：Pi 可能打开了那个。请在 Enter 前按 Esc，或从消息框发送 /gui view {worker}。",
  "Run /gui view W1 in this pane (typed into the terminal or sent from the message box) to open that worker's desktop here at once.": "在此窗格中运行 /gui view W1（直接在终端中输入或从消息框发送），即可在此处立即打开该工作者的桌面。",
  "Turn off desktop viewing for this PC": "关闭此 PC 的桌面查看",
  "Turn on desktop viewing for this PC": "开启此 PC 的桌面查看",
  "Pi session changed; reopen visual tools": "Pi 会话已更改，请重新打开可视化工具。",
  "This PC cannot find pi-gui viewers by itself (it needs Linux). Enter the fields /gui view printed in Pi's terminal.": "此 PC 无法自行找到 pi-gui 查看器（需要 Linux）。请输入 /gui view 在 Pi 终端中显示的连接信息。",
  "No GUI desktop named {worker} in this Pi session. Check the name in /gui view list.": "此 Pi 会话中没有名为 {worker} 的 GUI 桌面。请在 /gui view list 中确认名称。",
  "{worker} has no running viewer. Pi's terminal shows why /gui view did not start it.": "{worker} 没有正在运行的查看器。/gui view 未能启动它的原因显示在 Pi 终端中。",
  "Enter {worker}'s one-time password from the /gui view output in Pi's terminal.": "请输入 Pi 终端中 /gui view 输出里 {worker} 的一次性密码。",
  "The bridge update started. Follow it in the PC list, then open the desktop again.": "已开始更新桥接。请在 PC 列表中查看进度，然后重新打开桌面。",
  "{worker}'s private desktop": "{worker} 的独立桌面",
  "Waiting for {worker}'s viewer from /gui view…": "正在等待 /gui view 启动 {worker} 的查看器…",
  "Connected. Pause the worker before taking control.": "已连接。接管控制前请先暂停该工作者。",
  "Pause the worker before taking control.": "接管控制前请先暂停该工作者。",
  "Install Pi visual bridge": "安装 Pi 可视化桥接",
  "Shift+Escape leaves screen focus. Closing this viewer keeps Pi and its desktop running. Switch input takes or hands back control without reconnecting; a reconnect asks for the password again.": "Shift+Escape 可离开画面焦点。关闭此查看器后，Pi 及其桌面会继续运行。使用切换输入可在不重新连接的情况下接管或交还控制；重新连接需要再次输入密码。",
  "Switch input": "切换输入",
  "Switching input…": "正在切换输入…",
  "Input on: mouse and keyboard reach the desktop": "输入已开启：鼠标和键盘会传到桌面",
  "View only: input is blocked": "仅查看：输入已阻止",
  "Input is on. Do not use the desktop while the worker is acting on it.": "输入已开启。工作者操作桌面时，请不要同时操作。",
  "The desktop kept its input mode.": "桌面未更改输入模式。",
  "The desktop did not confirm view-only mode, so this viewer disconnected to stop input.": "桌面未确认切换为仅查看，为停止输入，此查看器已断开连接。",
  "The desktop did not confirm the input switch. Its PC may run an older Pi visual bridge: install this server's bridge there, or reconnect with Observe only unchecked.": "桌面未确认输入切换。该电脑的 Pi 可视化桥接可能较旧：请在该电脑上安装此服务器的桥接，或取消勾选“仅查看”后重新连接。",
  "{worker}'s desktop": "{worker} 的桌面",
  "Original Pi · recorded orche state; refreshes while open": "原版 Pi · orche 记录状态，面板打开时刷新",
  "Pi workers and desktop": "Pi 工作节点与桌面",
  "Please revise the marked image using these comments:": "请根据以下评论修改已标记的图片：",
  "Private desktop": "独立桌面",
  "Private desktop screen": "独立桌面画面",
  "Queued": "排队中",
  "RDP port": "RDP 端口",
  "Recent jobs only; complete history remains in Pi records.": "仅显示最近任务，完整历史保留在 Pi 记录中。",
  "Recorded sub-workers": "已记录的子工作节点",
  "Resolved": "已解决",
  "Result": "结果",
  "Run /gui view W1 or /gui view main in Pi, then enter its connection fields. Pause the worker before taking control.": "在 Pi 中运行 /gui view W1 或 /gui view main，然后输入连接信息。接管前请暂停工作节点。",
  "Save failed": "保存失败",
  "Saved": "已保存",
  "Unknown": "未知",
  "Use /orche commands for control; existing Pi approval rules are unchanged.": "使用 /orche 命令进行控制，现有 Pi 审批规则保持不变。",

  "Back": "返回",
  "Scroll pane up": "向上滚动面板",
  "Scroll pane down": "向下滚动面板",
  "Find in terminal": "在终端中查找",
  "Previous match": "上一个匹配",
  "Next match": "下一个匹配",
  "Close search": "关闭搜索",
  "No matches": "无匹配",
  "{current} of {total}": "第 {current} 个，共 {total} 个",
  "Recent folders": "最近的文件夹",
  "Dismiss": "关闭",
  "Input line": "输入框",
  // ---- settings ----
  "Settings": "设置",
  "Chat": "聊天",
  "Agent default": "代理默认",
  "Phone & devices": "手机和设备",
  "Install app": "安装应用",

  // ---- shortcuts (lib/shortcuts.ts labels) ----
  "Command palette": "命令面板",
  "Switch chat / terminal": "切换聊天 / 终端",
  "Focus pane input": "聚焦面板输入框",
  "Toggle sidebar": "切换侧边栏",
  "New workspace": "新建工作区",
  "Previous pane": "上一个窗格",
  "Next pane": "下一个窗格",

  // ---- agent status words (lib/status.ts) ----
  "READY": "就绪",
  "RUN": "运行",
  "INPUT": "输入",
  "DONE": "完成",
  "BG": "后台",
  "—": "—",

  // ---- app header and shell ----
  "Opening link…": "正在打开链接…",
  "Connecting to Ovis…": "正在连接 Ovis…",
  "Close workspace list": "关闭工作区列表",
  "Open workspace list": "打开工作区列表",
  "Show workspace list": "显示工作区列表",
  "Hide workspace list": "隐藏工作区列表",
  "Pane closed": "窗格已关闭",
  "Show the terminal": "显示终端",
  "Show the chat": "显示聊天",
  "Close this half": "关闭这一半",
  "Toggle sidebar (⌘⇧B)": "切换侧边栏 (⌘⇧B)",
  "Chat transcript (⌘⇧J)": "聊天记录 (⌘⇧J)",
  "Live terminal (⌘⇧J)": "实时终端 (⌘⇧J)",
  "Live terminal: coming to Windows PCs once herdr can attach there": "实时终端：待 herdr 支持在 Windows 上附加终端后开放",
  "soon": "即将",
  "Terminal": "终端",
  "herdr {version} · protocol {protocol}": "herdr {version} · 协议 {protocol}",
  "live": "已连接",
  "disconnected": "已断开",
  "reconnecting": "正在重连",
  "connecting": "正在连接",
  "herdr offline": "herdr 离线",
  "Status unknown": "状态未知",
  "herdr unavailable": "herdr 无响应",
  "The last health check failed. Last seen: herdr {version} · protocol {protocol}": "最近一次状态检查失败。上次确认：herdr {version} · 协议 {protocol}",
  "The health check failed": "状态检查失败",
  "Start herdr on this PC, or check HERDR_SOCKET.": "请在此电脑上启动 herdr，或检查 HERDR_SOCKET。",
  "The other PC's answer was larger than this app accepts": "另一台电脑的响应超出了此应用可接受的大小",
  "The other PC's answer could not be read": "无法读取另一台电脑的响应",
  "Browse files": "浏览文件",
  "Copy link": "复制链接",
  "Link copied": "已复制链接",
  "That agent has closed: its workspace is open": "该代理已关闭，已改为打开其工作区",
  "That link's workspace is closed": "该链接的工作区已关闭",
  "That link's PC is not set up here": "该链接的电脑未在此处设置",
  "Command palette (⌘⇧K)": "命令面板 (⌘⇧K)",
  "Could not sign out. Try again.": "无法退出登录，请重试。",
  "Retry": "重试",
  "Notify me when a pane needs input or finishes": "窗格需要输入或完成时通知我",
  "On, pushed to this device": "已开启，推送到此设备",
  "Alerts on, pushed to this device, even with the app closed. Tap to turn them off": "提醒已开启，推送到此设备。即使关闭应用也会收到。点按可关闭",
  "Off on this device": "此设备已关闭",
  "More": "更多",
  "More · alerts are off": "更多 · 提醒已关闭",
  "Alerts off on this device. Tap to turn them on": "此设备上的提醒已关闭。点按可开启",
  "On in this tab": "在此标签页开启",
  "Alerts on while this tab is open. Tap to turn them off": "此标签页打开期间会收到提醒。点按可关闭",
  "On in the app": "在应用内开启",
  "Alerts on in the app. Tap to allow them when it is closed too": "应用内提醒已开启。点按可允许在应用关闭时也收到提醒",
  "Alerts on in the app. Tap to turn them off": "应用内提醒已开启。点按可关闭",
  "Alerts on while this tab is open (closed-app alerts need https, and on iPhone the home-screen app). Tap to turn them off": "此标签页打开期间会收到提醒（关闭应用后的提醒需要 https，在 iPhone 上还需使用主屏幕应用）。点按可关闭",

  // ---- sidebar ----
  "Rename pane": "重命名窗格",
  "Branch": "分支",
  "Opening…": "正在打开…",
  "Detached HEAD": "游离 HEAD",
  "Delete": "删除",
  "Close": "关闭",
  "Rename failed: {reason}": "重命名失败：{reason}",

  // ---- PCs sidebar ----
  "Connecting…": "正在连接…",
  "Connected": "已连接",
  "Reconnecting…": "正在重连…",
  "Add PC": "添加 PC",
  "Connect": "连接",
  "Step {n} of {total}": "第 {n} 步，共 {total} 步",
  "{done} of {total}": "{done} / {total}",

  // ---- command palette ----
  "Refresh": "刷新",
  "Search panes and actions": "搜索窗格和操作",

  // ---- new workspace ----
  "Browse": "浏览",
  "Cancel": "取消",
  "Starting…": "正在启动…",
  "Start": "启动",
  // the launch's model, effort, first message and skills (lib/agentLaunchMode.ts, lib/newSession.ts)

  // ---- folder browser ----
  "No matching folders": "没有匹配的文件夹",
  "This folder cannot be opened.": "无法打开此文件夹。",
  "Folders could not be loaded.": "无法加载文件夹。",

  // ---- files ----
  "Files": "文件",
  "This image is {size}; download it to view.": "此图片大小为 {size}；请下载后查看。",
  "Download": "下载",
  "Open {path}": "打开 {path}",

  // ---- PC dialog ----
  "Continue": "继续",

  // ---- updates ----
  "Reload app": "重新加载应用",
  "Details": "详情",


  // ---- prompt card ----
  "Submit": "提交",
  "Recommended": "推荐",


  // ---- composer ----
  "Drag to resize · double-click to reset": "拖动以调整大小 · 双击重置",
  "Failed": "失败",
  "Send now": "立即发送",

  // ---- chat view ----
  "Copied": "已复制",
  "Worked for {duration}": "工作了 {duration}",
  "Copy message": "复制消息",
  "terminal ended": "终端已结束",
  "{m}m": "{m} 分钟",
  "{h}h {m}m": "{h} 小时 {m} 分",

  // ---- terminal ----
  "The question on screen changed; check it and answer again.": "屏幕上的问题已变化。请查看后重新回答。",
  "Reconnect": "重新连接",
  "Discard": "丢弃",
  "Held message — review and send": "保留的消息。请检查后发送",


  // ---- voice input ----
  "Dictate (hold)": "听写（按住）",
  "Microphone permission was denied": "麦克风权限已被拒绝",
  "Voice input needs HTTPS": "语音输入需要 HTTPS",
  // ---- errors (lib/userError.ts) ----
  "This browser is not signed in to this PC any more. Pair it again in Settings → Phone & devices.": "此浏览器已不再登录此电脑。请在设置 → 手机和设备中重新配对。",
  "That item no longer exists on the PC. Refresh and try again.": "该项目在电脑上已不存在。请刷新后重试。",
  "It changed on the PC while you were acting. Check it and try again.": "你操作期间电脑上的内容已更改。请检查后重试。",
  "The PC took too long to answer. Try again.": "电脑响应时间过长。请重试。",
  "OpenCode did not confirm the answer. Check the question before sending again.": "未收到 OpenCode 的回答接收确认。请先检查问题，再决定是否重新发送。",
  "The PC could not do that. Try again; if it keeps failing, restart Ovis on the PC.": "电脑无法完成该操作。请重试；如果一直失败，请在电脑上重启 Ovis。",
  "Can't reach the PC. Check your connection, then try again.": "无法连接到电脑。请检查网络连接后重试。",
  "Something went wrong. Try again.": "出了点问题。请重试。",
  "Not signed in to this PC": "未登录此电脑",
  "It no longer exists on the PC": "电脑上已不存在",
  "It changed on the PC": "电脑上的内容已更改",
  "The PC took too long": "电脑响应太慢",
  "Can't reach the PC": "无法连接到电脑",
  "PC disk is full": "电脑磁盘已满",
  "No permission on the PC": "电脑上没有权限",
  "Pair it again in Settings → Phone & devices.": "请在设置 → 手机和设备中重新配对。",
  "Refresh and try again.": "请刷新后重试。",
  "Check it and try again.": "请检查后重试。",
  "Check your connection, then try again.": "请检查网络连接后重试。",
  "Try again; if it keeps failing, restart Ovis on the PC.": "请重试；如果一直失败，请在电脑上重启 Ovis。",
  "The server cannot save settings: check that its state folder is writable.": "服务器无法保存设置：请检查其状态文件夹是否可写。",


  // ---- devices ----
  "Loading…": "正在加载…",
  "Done": "完成",

  // ---- phone ----
  "Copy": "复制",
  "…": "…",
  "Alerts": "提醒",
  "Sending…": "正在发送…",
  "Needs input": "需要输入",
  "Finished": "已完成",
  "Open pane": "打开窗格",
  "Quick replies": "快捷回复",
  "Skills": "Skill",
  "Not sent: send or discard the held input first.": "未发送：请先发送或丢弃保留的输入。",
  "Queue could not be saved. Keep this tab open or copy the messages before reloading.": "无法保存队列。请保持此标签页打开，或在重新加载前复制这些消息。",
  "Queued messages": "排队的消息",
  "Not confirmed. Check the terminal before sending again.": "未确认。重新发送前请检查终端。",
  "Too large to attach: {name} ({size}). A file can be up to {limit}.": "文件过大，无法附加：{name}（{size}）。单个文件最大为 {limit}。",
  // ---- subscription usage ----
  "Move {name} up": "将 {name} 上移",
  "Move {name} down": "将 {name} 下移",
  "Subscription usage": "订阅用量",
  "Resets in {time}": "{time}后重置",
  "{n} background task": "{n} 个后台任务",
  "{n} background tasks": "{n} 个后台任务",
  "Try again": "重试",
  // tabs: the strip over the pane, and the New tab dialog
  "New tab": "新建标签页",
  "Zoom pane": "放大窗格",
  "Unzoom pane": "取消放大",
  "This PC's bridge does not offer this yet": "此电脑的桥接尚未提供此功能。",
  "Split pane right": "向右拆分窗格",
  "Split pane down": "向下拆分窗格",
  "Plan: {done} of {total} done": "计划：已完成 {done}/{total}",
  "Plan": "计划",
  "Something went wrong": "出了点问题",
  "The app hit an error and stopped drawing. Your terminals keep running in herdr.": "应用出错，无法继续显示。你的终端仍在 herdr 中运行。",
  "Copy details": "复制详细信息",
  "This pane can't be shown.": "无法显示此窗格。",
  "The sidebar can't be shown.": "无法显示侧边栏。",
  "Diff layout": "差异布局",
  "Unified": "单栏",
  "Split": "并排",
  // t3code ports (a)
  // t3code ports (d)
  "Change PC": "切换电脑",
  "Selected": "已选择",
};

/** The parts ZH is made of; src/lib/i18n.test.ts fails when a key is in two parts, since a spread keeps only the last. */
export const ZH_PARTS: Record<string, Record<string, string>> = {
  base: BASE,
  settings: SETTINGS_ZH,
  terminal: TERMINAL_ZH,
  composer: COMPOSER_ZH,
  chat: CHAT_ZH,
  sidebar: SIDEBAR_ZH,
  machines: MACHINES_ZH,
  workspace: WORKSPACE_ZH,
  files: FILES_ZH,
  devices: DEVICES_ZH,
  usage: USAGE_ZH,
  updates: UPDATES_ZH,
  palette: PALETTE_ZH,
};

export const ZH: Record<string, string> = Object.assign({}, ...Object.values(ZH_PARTS));
