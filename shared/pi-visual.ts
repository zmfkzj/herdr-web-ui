/** Original Pi + zmfkzj/oh-my-pi-extensions. Not Oh My Pi (omp). */
export interface PiVisualIdentity { session: string; sessionId: string }
export type WorkerState = "running" | "done" | "failed" | "cancelled" | "interrupted" | "queued" | "unknown";
export interface PiVisualWorker {
  job: string; worker: string; role: string; state: WorkerState;
  request: string; summary: string; started: number; ended?: number;
  model?: string; thinking?: string; lastTool?: string; updated?: number;
  children: { id: string; role: string; model?: string }[];
}
export interface PiVisualWorkers extends PiVisualIdentity {
  observedAt: number; workers: PiVisualWorker[]; truncated: boolean;
  /** Recorded state, not a replacement for Pi's runtime or approval protocol. */
  source: "original-pi-orche-records";
}
export type ReviewSource = { kind: "conversation"; ref: string } | { kind: "file"; path: string };
export interface ImageAnnotation {
  id: string; x: number; y: number; width: number; height: number;
  text: string; resolved: boolean;
}
export interface ImageReviewDocument {
  id: string; session: string; revision: number; name: string; mime: string;
  annotations: ImageAnnotation[]; updated: number;
}
export interface PiDesktopRequest { session: string; port: number; password: string; fingerprint: string; readOnly: boolean; width: number; height: number }
export interface PiDesktopTicket { ticket: string; expiresAt: number }
/**
 * `/gui view <worker>` opened in this app: the backend of the PC that runs Pi finds the pi-gui viewer
 * (krdp) that Pi process started for that worker and uses its connection fields itself. Only the
 * worker name and the viewer's pid travel from the browser; the password never does.
 */
export interface PiDesktopAutoRequest { session: string; worker: string; viewerPid: number; readOnly: boolean; width: number; height: number; command?: PiDesktopCommand }
/**
 * The `/gui view` a connection server saw this browser run, as it passes the desktop request on to
 * the PC's bridge: the name as typed (null: no name) and how long ago, so that the PC applies the
 * same checks on its own clock. Only a connection server's request carries it; a browser's is refused.
 */
export interface PiDesktopCommand { worker: string | null; ageMs: number }
/** Bumped when the bridge-side pi-visual routes change incompatibly. */
export const PI_VISUAL_PROTOCOL = 1;
/** The bundle feature a bridge built from this branch carries (manifest, bundle.json, /api/bridge). */
export const PI_VISUAL_BUNDLE_FEATURE = "pi-visual";
/**
 * What /api/bridge says about the pi-visual routes. Upstream and older bridges leave it out.
 * `desktop`: the bridge was started with desktop viewing on (HERDR_PI_GUACD_ENABLED=1), which a
 * connection server does only for a PC whose desktop viewing its user turned on.
 */
export interface PiVisualBridge { protocol: number; desktop?: boolean }
/** A pi-gui viewer of this Pi process, as discovered on its PC. Nothing in it is secret. */
export interface PiGuiViewer { worker: string; port: number; display: string; pid: number; startedAt: number; fingerprint: string }
export type PiDesktopState = "ready" | "disabled" | "guacd_missing" | "guacd_incompatible" | "unsupported";
/**
 * `action`: what the panel offers for it: `enable_pc` turns desktop viewing on for that PC (a
 * restart of its bridge), `install_bridge` puts this server's bundle there.
 */
export interface PiDesktopAvailability { state: PiDesktopState; message: string; action?: "enable_pc" | "install_bridge" }
export interface PiGuiViewers {
  session: string;
  /** whether this PC can stream a desktop now (gateway switch, its own loopback guacd) */
  desktop: PiDesktopAvailability;
  /** "unsupported": this PC cannot find pi-gui viewers (no /proc: not Linux) */
  discovery: "available" | "unsupported";
  viewers: PiGuiViewer[];
  /** the PC's clock when it looked, for viewers started after a command */
  observedAt: number;
}
export const MAX_ANNOTATIONS = 100;
export function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
export function annotations(value: unknown): ImageAnnotation[] {
  if (!Array.isArray(value) || value.length > MAX_ANNOTATIONS) throw new Error("Invalid annotations");
  const ids = new Set<string>();
  return value.map((item: unknown) => {
    if (!object(item) || typeof item.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id) || ids.has(item.id)
      || typeof item.text !== "string" || item.text.length > 4000 || typeof item.resolved !== "boolean") throw new Error("Invalid annotation");
    const { x, y, width, height } = item;
    if (![x, y, width, height].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1)
      || (x as number) + (width as number) > 1.000001 || (y as number) + (height as number) > 1.000001) throw new Error("Invalid annotation coordinates");
    ids.add(item.id);
    return { id: item.id, text: item.text, resolved: item.resolved, x: x as number, y: y as number, width: width as number, height: height as number };
  });
}
export function reviewSource(value: unknown): ReviewSource {
  if (!object(value)) throw new Error("Invalid image source");
  if (value.kind === "conversation" && typeof value.ref === "string" && value.ref.length > 0 && value.ref.length <= 4096) return { kind: "conversation", ref: value.ref };
  if (value.kind === "file" && typeof value.path === "string" && value.path.length > 0 && value.path.length <= 4096 && !value.path.includes("\0")) return { kind: "file", path: value.path };
  throw new Error("Invalid image source");
}
/** Coordinates always address the immutable original, independent of zoom or viewport size. */
export function rectangle(a: { x: number; y: number }, b: { x: number; y: number }) {
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  const x = Math.min(clamp(a.x), clamp(b.x)), y = Math.min(clamp(a.y), clamp(b.y));
  return { x, y, width: Math.abs(clamp(a.x) - clamp(b.x)), height: Math.abs(clamp(a.y) - clamp(b.y)) };
}

/** pi-gui names its desktops `main`, `W1`, `W3-2`, `worker`: one shell word. */
export const GUI_VIEW_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/**
 * The desktop a message asks pi-gui to show, read the way pi-gui's `/gui` handler reads its
 * arguments: whitespace-split words, `view` then a name; `view list` and `view stop …` show
 * nothing. `worker: null` is `/gui view` without a name (pi-gui then picks the only GUI worker).
 */
export function guiViewCommand(text: string): { worker: string | null } | null {
  if (text.includes("\n")) return null;
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words[0] !== "/gui" || words[1] !== "view") return null;
  const name = words[2];
  if (name === "list" || name === "stop") return null;
  return { worker: name ?? null };
}
export type ViewerResolution = { viewer: PiGuiViewer } | { error: "invalid_worker" | "viewer_ambiguous" | "viewer_missing"; message: string };
/**
 * pi-gui's own name lookup (ViewRegistry.get): the exact name, else the case-insensitive one, over
 * the viewers this Pi process runs. Two case-insensitive matches are ambiguous rather than the first.
 * Without a name only a viewer started at or after `since` (this PC's clock) can be the one pi-gui
 * picked, and only when it is the only one: a running viewer alone does not say pi-gui chose it.
 */
export function resolveViewer(viewers: readonly PiGuiViewer[], name: string | null, since?: number): ViewerResolution {
  const list = (items: readonly PiGuiViewer[]) => items.map((item) => item.worker).join(", ") || "none";
  if (name === null) {
    const fresh = since === undefined ? [] : viewers.filter((item) => item.startedAt >= since);
    if (fresh.length === 1) return { viewer: fresh[0]! };
    if (fresh.length > 1) return { error: "viewer_ambiguous", message: `Several viewers started (${list(fresh)}); name one: /gui view <name>` };
    return { error: "viewer_missing", message: `Name the desktop to open it here: /gui view <name> (running viewers: ${list(viewers)})` };
  }
  if (!GUI_VIEW_NAME.test(name)) return { error: "invalid_worker", message: `"${name.slice(0, 64)}" is not a pi-gui desktop name (main, W1, …)` };
  const exact = viewers.filter((item) => item.worker === name);
  if (exact.length === 1) return { viewer: exact[0]! };
  const folded = exact.length ? exact : viewers.filter((item) => item.worker.toLowerCase() === name.toLowerCase());
  if (folded.length === 1) return { viewer: folded[0]! };
  if (folded.length > 1) return { error: "viewer_ambiguous", message: `Several viewers match ${name} (${list(folded)}); use the exact name` };
  return { error: "viewer_missing", message: `${name} has no running viewer in this Pi session (running viewers: ${list(viewers)})` };
}

/**
 * Another desktop name Pi's completion list would also offer for `name`: pi-gui lists `view <name>`
 * for every name that starts with what was typed (case-sensitive), and Enter takes the highlighted
 * entry. A `/gui view W1` typed while the list was open may have run W10 or W1-2 instead.
 */
export function completionConflict(name: string, names: Iterable<string>): string | null {
  for (const other of names) if (other !== name && other.startsWith(name)) return other;
  return null;
}

/** A `/gui view` an Enter submitted; `completing`: Pi's completion list may have been open then. */
export interface TypedGuiView { worker: string | null; completing: boolean }
const MOVES: Record<string, "left" | "right" | "home" | "end" | "delete"> = {
  "\x1b[D": "left", "\x1bOD": "left", "\x1b[C": "right", "\x1bOC": "right",
  "\x1b[H": "home", "\x1bOH": "home", "\x1b[1~": "home", "\x1b[7~": "home",
  "\x1b[F": "end", "\x1bOF": "end", "\x1b[4~": "end", "\x1b[8~": "end", "\x1b[3~": "delete",
};
const PASTE_START = "\x1b[200~", PASTE_END = "\x1b[201~";
const LINE_LIMIT = 4096;
/** The length of the escape sequence at `at` (1: a lone ESC, the Escape key). */
function escapeLength(data: string, at: number): number {
  const next = data[at + 1];
  if (next === undefined || next === "\x1b") return 1;
  if (next === "O") return data.length > at + 2 ? 3 : 2;
  if (next !== "[") return 2;
  let end = at + 2;
  while (end < data.length && /[0-9;:?<=>!"#$%&'()*+,\-./ ]/.test(data[end]!)) end++;
  return Math.min(data.length, end + 1) - at;
}
/**
 * The line typed straight into Pi's editor (pi-tui's Editor), followed as its keys arrive: text and
 * one-line pastes go in at the cursor; Backspace, Delete, ←, →, Home, End (and Ctrl+A, Ctrl+E) edit;
 * Ctrl+C and Ctrl+U at the end of the line empty it; Enter submits. A key it cannot follow (↑ or ↓:
 * history or the completion list's choice; Tab: a completion; a word motion, a modified Enter, a
 * multi-line paste, a key frame) leaves the line unknown, so that its Enter submits nothing anyone
 * can name. Mouse and focus reports change nothing. The next line starts known again. Escape closes Pi's completion list: `completing` says
 * whether the list may have been open, as it is from the first key of a slash command on.
 */
export class TypedLine {
  private text = ""; private cursor = 0; private known = true; private completing = false;
  private pasting: string | null = null;
  /** Terminal input as sent; returns the `/gui view` commands its Enters submitted. */
  feed(data: string): TypedGuiView[] {
    const submitted: TypedGuiView[] = [];
    let at = 0;
    while (at < data.length) {
      if (this.pasting !== null) {
        // the paste's end may come split over frames: it is looked for in all of the paste so far
        const pasted = this.pasting + data.slice(at);
        const end = pasted.indexOf(PASTE_END);
        if (end < 0) {
          // a paste too long for a command line is kept as its end's possible start only, marked unknown
          this.pasting = pasted.length > LINE_LIMIT ? "\n" + pasted.slice(-PASTE_END.length) : pasted;
          return submitted;
        }
        this.pasting = null;
        if (/[\r\n]/.test(pasted.slice(0, end))) this.lose(); else this.insert(pasted.slice(0, end));
        submitted.push(...this.feed(pasted.slice(end + PASTE_END.length)));
        return submitted;
      }
      const char = data[at]!;
      if (char === "\x1b") {
        const length = escapeLength(data, at); const sequence = data.slice(at, at + length); at += length;
        if (length === 1) this.completing = false;
        else if (sequence === PASTE_START) this.pasting = "";
        // a click or a focus change (the terminal reports them when asked to): Pi's editor takes no
        // text from them; an X10 report carries three raw bytes after its head
        else if (/^\x1b\[<[\d;]*[Mm]$|^\x1b\[[IO]$/.test(sequence)) continue;
        else if (sequence === "\x1b[M") at += 3;
        else if (MOVES[sequence]) this.move(MOVES[sequence]);
        else this.lose();
        continue;
      }
      at++;
      if (char === "\r") { const view = this.submit(); if (view) submitted.push(view); }
      else if (char === "\x7f" || char === "\b") { if (this.cursor > 0) { this.text = this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor); this.cursor--; } this.edited(); }
      else if (char === "\x01") this.move("home");
      else if (char === "\x05") this.move("end");
      else if ((char === "\x03" || char === "\x15") && this.cursor === this.text.length) this.clear();
      else if (char < " ") this.lose();
      else this.insert(char);
    }
    return submitted;
  }
  /** A key sent by name (a keys frame: arrows, chords): the line can no longer be followed. */
  lose(): void { this.known = false; }
  private clear(): void { this.text = ""; this.cursor = 0; this.known = true; this.completing = false; }
  private insert(text: string): void {
    if (this.text.length + text.length > LINE_LIMIT) { this.lose(); return; }
    this.text = this.text.slice(0, this.cursor) + text + this.text.slice(this.cursor); this.cursor += text.length;
    this.edited();
  }
  private move(move: "left" | "right" | "home" | "end" | "delete"): void {
    if (move === "left") this.cursor = Math.max(0, this.cursor - 1);
    else if (move === "right") this.cursor = Math.min(this.text.length, this.cursor + 1);
    else if (move === "home") this.cursor = 0;
    else if (move === "end") this.cursor = this.text.length;
    else this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1);
    if (move === "delete") this.edited();
  }
  /** pi-tui opens the slash command list on the first `/` and updates it on each edit after it */
  private edited(): void { if (this.text.trimStart().startsWith("/")) this.completing = true; }
  private submit(): TypedGuiView | null {
    const { text, known, completing } = this;
    this.clear();
    const command = known ? guiViewCommand(text) : null;
    return command ? { worker: command.worker, completing } : null;
  }
}
