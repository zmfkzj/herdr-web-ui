import { GUI_VIEW_NAME, guiViewCommand, TypedLine } from "../../shared/pi-visual.ts";

/** How long a `/gui view` run from this app opens that desktop without its password. */
export const GUI_VIEW_GRANT_MS = 2 * 60_000;
const MAX_GRANTS = 128;
const MAX_TAKEN = 32;
/** panes one connection follows the typing of */
const MAX_LINES = 64;

/**
 * Who ran a command: the browser (its cookie/device binding, the one desktop tickets use, and its
 * device for revocation), the PC, and for another PC the bridge connection it went through. A grant
 * made on a connection that has since been replaced (a reconnect, another bridge) is no grant.
 */
export interface GrantOrigin { binding: string; deviceId?: string; machine: string; connection?: object }
/** `worker`: as typed; null for `/gui view` without a name. `at`: this server's clock. */
export interface Grant extends GrantOrigin { pane: string; worker: string | null; at: number }

/**
 * `/gui view <worker>` run in a Pi pane from this app, typed into the terminal or sent from a message
 * box, is the user asking to see that desktop. pi-gui answers it on that pane's screen with the
 * viewer's one-time password, which the same browser is shown. Recorded here as this server passes
 * the keys on, a grant lets that browser and only it open, once, the desktop the command named on
 * that PC's pane without retyping the password from the screen (service.ts checks the name the way
 * pi-gui resolves it, and that the Pi process ran it). Every other open of a desktop (another
 * browser, the panel's buttons, a second open) still asks for the password.
 */
export class GuiViewGrants {
  private grants: Grant[] = [];
  /** the latest grants used to open a desktop, so that Pi's word on the same command grants nothing more */
  private taken: Grant[] = [];
  constructor(private readonly now = Date.now) {}
  /** A message on its way to a pane; returns whether it ran `/gui view`. */
  observe(origin: GrantOrigin, pane: string, text: string): boolean {
    const command = guiViewCommand(text);
    return command ? this.record(origin, pane, command.worker) : false;
  }
  record(origin: GrantOrigin, pane: string, worker: string | null): boolean {
    if (!origin.binding || !pane || pane.length > 256 || worker !== null && worker.length > 64) return false;
    const at = this.now();
    this.grants = this.grants.filter((grant) => at - grant.at < GUI_VIEW_GRANT_MS && !(sameOrigin(grant, origin) && grant.pane === pane && grant.worker === worker));
    this.grants.push({ ...origin, pane, worker, at });
    if (this.grants.length > MAX_GRANTS) this.grants.splice(0, this.grants.length - MAX_GRANTS);
    return true;
  }
  /**
   * The newest grant this browser has for opening `worker` on this PC's pane: one that named it
   * (pi-gui finds names case-insensitively too; the PC decides which viewer a name meant), or one
   * without a name. Not consumed: `take` does that once a desktop ticket was issued for it.
   */
  find(origin: GrantOrigin, pane: string, worker: string): Grant | undefined {
    const at = this.now();
    for (let index = this.grants.length - 1; index >= 0; index--) {
      const grant = this.grants[index]!;
      if (at - grant.at >= GUI_VIEW_GRANT_MS || !sameOrigin(grant, origin) || grant.pane !== pane) continue;
      if (grant.worker === null || grant.worker.toLowerCase() === worker.toLowerCase()) return grant;
    }
    return undefined;
  }
  take(grant: Grant): void {
    this.grants = this.grants.filter((item) => item !== grant);
    this.taken = [...this.taken, grant].slice(-MAX_TAKEN);
  }
  /**
   * Pi logged that it ran `/gui view <worker>` after this browser's Enter at `since` (runs.ts): the
   * grant the typed command gives, unless that command already gave it (still open, or used to open
   * the desktop since), so one command opens one desktop once. Returns whether it granted.
   */
  confirm(origin: GrantOrigin, pane: string, worker: string, since: number): boolean {
    const same = (grant: Grant) => sameOrigin(grant, origin) && grant.pane === pane && grant.at >= since
      && (grant.worker === null || grant.worker.toLowerCase() === worker.toLowerCase());
    if (this.grants.some(same) || this.taken.some(same)) return false;
    return this.record(origin, pane, worker);
  }
  /** Input the pane refused after all (observe mode, not ready): what it carried ran nothing. */
  withdraw(origin: GrantOrigin, pane: string, since: number): void {
    this.grants = this.grants.filter((grant) => !(sameOrigin(grant, origin) && grant.pane === pane && grant.at >= since));
  }
  /** a revoked device, a PC removed or reconnected: its grants go with it */
  forget(predicate: (grant: Grant) => boolean): void {
    this.grants = this.grants.filter((grant) => !predicate(grant));
    this.taken = this.taken.filter((grant) => !predicate(grant));
  }
  count(): number { return this.grants.length; }
}

function sameOrigin(a: GrantOrigin, b: GrantOrigin): boolean {
  return a.binding === b.binding && a.machine === b.machine && a.connection === b.connection;
}

/**
 * The keys one browser connection types into its panes, followed per pane (shared TypedLine): an
 * Enter that submits `/gui view` records a grant. Only typing a pane accepted is fed: the caller
 * feeds after the write went through, and `reset` drops what a role change, a detach or a refusal
 * leaves unknown.
 */
export class GuiViewTyping {
  private lines = new Map<string, TypedLine>();
  constructor(private readonly grants: GuiViewGrants, private readonly origin: () => GrantOrigin | null) {}
  input(pane: string, text: string): void {
    let line = this.lines.get(pane);
    if (!line) {
      if (this.lines.size >= MAX_LINES) this.lines.delete(this.lines.keys().next().value!);
      line = new TypedLine(); this.lines.set(pane, line);
    }
    const views = line.feed(text);
    if (!views.length) return;
    const origin = this.origin();
    if (origin) for (const view of views) this.grants.record(origin, pane, view.worker);
  }
  keys(pane: string): void { this.lines.get(pane)?.lose(); }
  reset(pane?: string): void { if (pane === undefined) this.lines.clear(); else this.lines.delete(pane); }
}

/** Errors a bridge answers typing with when the pane did not take it. */
const REFUSED = new Set(["read_only", "input_failed", "input_not_ready", "attach_held"]);
const MAX_SUBMITS = 16;
/** how long after a relayed command its PC's `gui-view` frame can come: pi-gui logs once krdp listens (runs.ts) */
const CONFIRM_LATE_MS = 5000;
/**
 * A browser's terminal socket relayed to another PC (MachineRelay): its frames are read once they
 * went to the PC (typing, keys, role changes, detaches, submits) and the PC's answers on their way
 * back. A submit grants only when the PC answers that it typed it; typing the PC then refuses takes
 * back what it granted.
 */
export class RelayedGuiViews {
  private mode: "interact" | "observe";
  private typing: GuiViewTyping;
  private submits = new Map<number, { pane: string; text: string }>();
  constructor(private readonly grants: GuiViewGrants, private readonly origin: GrantOrigin, readOnly: boolean, private readonly now = Date.now) {
    this.mode = readOnly ? "observe" : "interact";
    this.typing = new GuiViewTyping(grants, () => this.mode === "interact" ? origin : null);
  }
  /** A frame the browser sent, once it went to the PC. */
  client(text: string): void {
    if (!/"type":\s*"(?:submit|input|keys|role|detach)"/.test(text)) return;
    let frame: { type?: unknown; id?: unknown; pane_id?: unknown; text?: unknown; delivery?: unknown; mode?: unknown; resend_id?: unknown };
    try { frame = JSON.parse(text); } catch { return; }
    if (frame.type === "role") { this.mode = frame.mode === "observe" ? "observe" : "interact"; this.typing.reset(); return; }
    if (typeof frame.pane_id !== "string") return;
    if (frame.type === "detach") { this.typing.reset(frame.pane_id); return; }
    if (this.mode !== "interact") return;
    if (frame.type === "keys") this.typing.keys(frame.pane_id);
    else if (frame.type === "input" && typeof frame.text === "string") this.typing.input(frame.pane_id, frame.text);
    else if (frame.type === "submit" && typeof frame.text === "string" && Number.isSafeInteger(frame.id) && frame.resend_id === undefined
      && (frame.delivery === undefined || frame.delivery === "immediate") && guiViewCommand(frame.text)) {
      if (this.submits.size >= MAX_SUBMITS) this.submits.delete(this.submits.keys().next().value!);
      this.submits.set(frame.id as number, { pane: frame.pane_id, text: frame.text });
    }
  }
  /** A frame the PC sent to the browser; false when the browser is not to get it. */
  server(text: string): boolean {
    if (!text.includes("\"error\"") && !text.includes("\"submit-result\"") && !text.includes("\"gui-view\"")) return true;
    let frame: { type?: unknown; id?: unknown; ok?: unknown; pending?: unknown; code?: unknown; pane_id?: unknown; worker?: unknown };
    try { frame = JSON.parse(text); } catch { return true; }
    if (frame.type === "submit-result" && typeof frame.id === "number") {
      const submit = this.submits.get(frame.id); this.submits.delete(frame.id);
      // typed into the pane now; a message kept pending ran nothing yet
      if (submit && frame.ok === true && frame.pending === undefined && submit.pane === frame.pane_id && this.mode === "interact") this.grants.observe(this.origin, submit.pane, submit.text);
      return true;
    }
    // the PC's Pi logged `/gui view <worker>` right after an Enter of this connection (runs.ts): the
    // same grant the typed command would have given, for the name Pi opened. A command whose keys
    // this server read granted it already, and the browser opened that desktop itself: not again.
    if (frame.type === "gui-view") {
      return this.mode === "interact" && typeof frame.pane_id === "string" && typeof frame.worker === "string" && GUI_VIEW_NAME.test(frame.worker)
        && this.grants.confirm(this.origin, frame.pane_id, frame.worker, this.now() - CONFIRM_LATE_MS);
    }
    if (frame.type !== "error" || typeof frame.code !== "string" || !REFUSED.has(frame.code)) return true;
    // a refusal says which pane when it can; one without a pane takes back every recent grant
    const since = this.now() - 5000;
    if (typeof frame.pane_id === "string") { this.grants.withdraw(this.origin, frame.pane_id, since); this.typing.reset(frame.pane_id); }
    else { this.grants.forget((grant) => grant.binding === this.origin.binding && grant.machine === this.origin.machine && grant.connection === this.origin.connection && grant.at >= since); this.typing.reset(); }
    return true;
  }
}
