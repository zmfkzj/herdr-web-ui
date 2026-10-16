import { join } from "node:path";
import { GUI_VIEW_NAME } from "../../shared/pi-visual.ts";
import { agentDirOf, procViewerSystem, type ViewerSystem } from "./viewers.ts";

/**
 * `/gui view <name>` that Pi itself says it ran, for a browser whose own keys the server could not
 * read as that command.
 *
 * The typed line (shared TypedLine) names the command only when every key of it was followed: a
 * line recalled with ↑ from Pi's history, finished with Tab from Pi's completion list, edited with
 * a word motion, or a chat message that waited for a working Pi to finish and was then sent, opens
 * nothing that way, although Pi ran it. pi-gui writes one line per `/gui view` it answers with a
 * viewer, a new or a running one, to its `<agent dir>/gui.log` (`… [gui] main pid=<pi pid> view
 * <name>: client not opened (…)`, `… opened <client>` or `… could not open a client: …`; pi-gui
 * src/viewer.ts `connect`). So after a browser's Enter reached an original Pi pane, this watches
 * that pane's Pi processes' log for such a line written since; the newest Enter before it is the
 * one that ran it. Only what the browser could have typed itself follows: the same `/gui view
 * <name>` grant its typed line gives (grants.ts), for the name Pi actually opened, and service.ts
 * still checks the viewer, its Pi process and the name before any password is used.
 */
export const GUI_VIEW_RUN_MS = 10_000;
const POLL_MS = 400;
/** a log line can be written in the same millisecond as the Enter's record, never well before it */
const CLOCK_SLACK_MS = 50;
/** the lines written in one watch fit in far less; a cut first line is skipped */
const LOG_TAIL = 32 * 1024;
const MAX_ENTERS = 8;
const MAX_PANES = 64;
const MAX_SEEN = 256;
const RAN = /^(\S+) \[gui\] \S+ pid=(\d+) view (\S+): (?:client not opened \(|opened |could not open a client: )/;

export interface GuiViewRun { worker: string; at: number; piPid: number }

/** The `/gui view` runs a set of Pi processes logged in their agent dirs' gui.log, oldest first. */
export function readRuns(system: ViewerSystem, dirs: Map<string, number[]>): GuiViewRun[] {
  const runs: GuiViewRun[] = [];
  for (const [dir, pids] of dirs) {
    const text = [join(dir, "gui.log.1"), join(dir, "gui.log")].map((path) => system.tail(path, LOG_TAIL) ?? "").join("\n");
    for (const line of text.split("\n")) {
      const match = RAN.exec(line.trimEnd());
      if (!match) continue;
      const at = Date.parse(match[1]!), piPid = Number(match[2]), worker = match[3]!;
      if (!Number.isFinite(at) || !pids.includes(piPid) || !GUI_VIEW_NAME.test(worker)) continue;
      runs.push({ worker, at, piPid });
    }
  }
  return runs.sort((a, b) => a.at - b.at);
}

/** This pane's foreground processes of this user, by the agent dir each one's pi-gui logs in. */
export async function paneAgentDirs(paneId: string, system: ViewerSystem): Promise<Map<string, number[]>> {
  const dirs = new Map<string, number[]>();
  for (const pid of new Set(await system.foreground(paneId))) {
    if (system.uid(pid) !== system.myUid()) continue;
    const dir = agentDirOf(system.environ(pid));
    dirs.set(dir, [...(dirs.get(dir) ?? []), pid]);
  }
  return dirs;
}

interface Enter<C> { client: C; at: number }
interface Watch<C> { enters: Enter<C>[]; until: number; timer?: ReturnType<typeof setTimeout>; dirs?: Map<string, number[]>; busy: boolean }

/**
 * Enters that browser connections delivered to Pi panes, each watched for GUI_VIEW_RUN_MS for the
 * `/gui view` Pi logs after it. `isPi` decides whether a pane is worth watching (herdr's agent);
 * `ran` hears which connection ran which desktop name in which pane, and when its Enter arrived.
 */
export class GuiViewRuns<C extends object> {
  private watches = new Map<string, Watch<C>>();
  private seen: string[] = [];
  constructor(
    private readonly isPi: (paneId: string) => Promise<boolean>,
    private readonly ran: (client: C, paneId: string, worker: string, enteredAt: number) => void,
    private readonly system: ViewerSystem = procViewerSystem,
    private readonly now = Date.now,
    /** between two reads of a watched log; tests shorten it */
    private readonly pollMs = POLL_MS,
  ) {}

  /** `client` delivered an Enter to `paneId` at `at` (this server's clock, before the write). */
  entered(client: C, paneId: string, at = this.now()): void {
    if (!this.system.supported() || !paneId || paneId.length > 256) return;
    let watch = this.watches.get(paneId);
    if (!watch) {
      if (this.watches.size >= MAX_PANES) return;
      watch = { enters: [], until: 0, busy: false };
      this.watches.set(paneId, watch);
    }
    watch.enters = [...watch.enters.filter((enter) => enter.client !== client || enter.at !== at), { client, at }].slice(-MAX_ENTERS);
    watch.until = Math.max(watch.until, at + GUI_VIEW_RUN_MS);
    // the processes may change with the next command: looked up again for this Enter
    watch.dirs = undefined;
    if (!watch.timer && !watch.busy) this.schedule(paneId, watch, 0, true);
  }

  /** a closed connection: its Enters ran nothing anyone can open any more */
  forget(client: C): void {
    for (const [paneId, watch] of this.watches) {
      watch.enters = watch.enters.filter((enter) => enter.client !== client);
      if (!watch.enters.length) this.stop(paneId, watch);
    }
  }

  close(): void { for (const [paneId, watch] of this.watches) this.stop(paneId, watch); }

  /** panes being watched now (tests) */
  size(): number { return this.watches.size; }

  private stop(paneId: string, watch: Watch<C>): void {
    if (watch.timer) clearTimeout(watch.timer);
    watch.timer = undefined;
    if (this.watches.get(paneId) === watch) this.watches.delete(paneId);
  }

  private schedule(paneId: string, watch: Watch<C>, delay: number, first = false): void {
    watch.timer = setTimeout(() => { watch.timer = undefined; void this.poll(paneId, watch, first); }, delay);
    (watch.timer as { unref?: () => void }).unref?.();
  }

  private async poll(paneId: string, watch: Watch<C>, first: boolean): Promise<void> {
    if (this.watches.get(paneId) !== watch) return;
    watch.busy = true;
    try {
      if (first && !(await this.isPi(paneId).catch(() => false))) { this.stop(paneId, watch); return; }
      watch.dirs ??= await paneAgentDirs(paneId, this.system).catch(() => new Map<string, number[]>());
      const oldest = Math.min(...watch.enters.map((enter) => enter.at));
      for (const run of readRuns(this.system, watch.dirs)) {
        if (run.at < oldest - CLOCK_SLACK_MS) continue;
        const key = `${run.at} ${run.piPid} ${run.worker}`;
        if (this.seen.includes(key)) continue;
        // the newest Enter before the line ran it; one at most a watch's length before it
        const enter = watch.enters.filter((item) => item.at - CLOCK_SLACK_MS <= run.at && run.at - item.at <= GUI_VIEW_RUN_MS).at(-1);
        if (!enter) continue;
        this.seen.push(key);
        if (this.seen.length > MAX_SEEN) this.seen.splice(0, this.seen.length - MAX_SEEN);
        watch.enters = watch.enters.filter((item) => item !== enter);
        this.ran(enter.client, paneId, run.worker, enter.at);
      }
    } catch { /* an unreadable log or process ran nothing this server can name */ } finally { watch.busy = false; }
    if (this.watches.get(paneId) !== watch) return;
    const now = this.now();
    watch.enters = watch.enters.filter((enter) => now - enter.at <= GUI_VIEW_RUN_MS);
    if (!watch.enters.length || now >= watch.until) { this.stop(paneId, watch); return; }
    this.schedule(paneId, watch, this.pollMs);
  }
}
