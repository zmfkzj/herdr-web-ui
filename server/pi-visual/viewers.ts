import { X509Certificate } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { connect } from "node:net";
import { paneProcessInfo } from "../herdr/client.ts";
import type { PiDesktopState, PiGuiViewer } from "../../shared/pi-visual.ts";
import { instruction, InstructionParser } from "./guacamole.ts";

/**
 * The pi-gui viewers (`/gui view <name>`) one Pi process runs, read on the PC that runs it.
 *
 * pi-gui keeps its viewer registry in Pi's memory and prints the connection fields only to Pi's
 * screen. What it leaves outside: one `<agent dir>/gui.log` line per started viewer, written by
 * that Pi process (`… [gui] main pid=<pi pid> view W1: krdp pid <pid> listening on
 * 127.0.0.1:<port> for wayland-virtual-<n>`), and the krdp process itself, a child of Pi, with the
 * one-time password, loopback address and port in its arguments and its TLS certificate in a
 * private runtime directory (pi-gui README, "Security": readable by the same user while it runs).
 *
 * A viewer counts only when all of that agrees: the logging Pi is a foreground process of this
 * pane, the krdp named is alive, owned by this user, still that Pi's child, listening where the
 * line says on the display the line says, and its certificate lies inside its private
 * `computer-use-mcp-isolated-*` runtime directory. Pi processes in other panes, other users, a
 * reused pid or an orphaned viewer never match. The password stays on this PC's server.
 */
export interface ViewerSystem {
  /** whether this OS exposes the process facts below (Linux /proc) */
  supported(): boolean;
  /** pids of the pane's foreground processes, as herdr reports them */
  foreground(paneId: string): Promise<number[]>;
  ppid(pid: number): number | undefined;
  /** when the process started, in epoch ms (a reused pid starts later than the record that named it) */
  startedAt(pid: number): number | undefined;
  uid(pid: number): number | undefined;
  cmdline(pid: number): string[] | undefined;
  environ(pid: number): Record<string, string> | undefined;
  /** the last `bytes` of a file, or undefined when it is absent or unreadable */
  tail(path: string, bytes: number): string | undefined;
  /** a regular file owned by `uid`, at most 64 KiB, or undefined */
  privateFile(path: string, uid: number): Buffer | undefined;
  /** a directory owned by `uid` with no group or other access */
  privateDir(path: string, uid: number): boolean;
  realpath(path: string): string | undefined;
  myUid(): number;
}

const LOG_TAIL = 256 * 1024;
const LOG_LINE = /^(\S+) \[gui\] \S+ pid=(\d+) view (\S+): krdp pid (\d+) listening on 127\.0\.0\.1:(\d+) for (wayland-virtual-\d+)$/;
const RUNTIME_DIR = /^computer-use-mcp-isolated-[A-Za-z0-9]{6,}$/;

function parseNul(raw: Buffer): string[] { return raw.toString("utf8").split("\0").filter((part, index, all) => part.length > 0 || index < all.length - 1); }
let ticks: number | undefined;
/** USER_HZ, the unit of /proc/<pid>/stat's start time (100 on every mainstream kernel). */
function clockTicks(): number {
  if (ticks === undefined) {
    try { const value = Number(Bun.spawnSync(["getconf", "CLK_TCK"]).stdout.toString().trim()); ticks = Number.isInteger(value) && value > 0 ? value : 100; } catch { ticks = 100; }
  }
  return ticks;
}
function bootTime(): number | undefined {
  try { const match = /^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8")); return match ? Number(match[1]) * 1000 : undefined; } catch { return undefined; }
}

export const procViewerSystem: ViewerSystem = {
  supported: () => process.platform === "linux",
  async foreground(paneId) {
    const info = await paneProcessInfo(paneId);
    return (info?.foreground_processes ?? []).map((process) => (process as { pid?: unknown }).pid).filter((pid): pid is number => Number.isSafeInteger(pid) && (pid as number) > 1);
  },
  ppid(pid) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const value = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      return Number.isSafeInteger(value) ? value : undefined;
    } catch { return undefined; }
  },
  startedAt(pid) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const start = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
      const boot = bootTime();
      return boot !== undefined && Number.isFinite(start) ? boot + Math.round(start * 1000 / clockTicks()) : undefined;
    } catch { return undefined; }
  },
  uid(pid) { try { return lstatSync(`/proc/${pid}`).uid; } catch { return undefined; } },
  cmdline(pid) { try { return parseNul(readFileSync(`/proc/${pid}/cmdline`)); } catch { return undefined; } },
  environ(pid) {
    try {
      const env: Record<string, string> = {};
      for (const entry of readFileSync(`/proc/${pid}/environ`).toString("utf8").split("\0")) {
        const at = entry.indexOf("=");
        if (at > 0) env[entry.slice(0, at)] = entry.slice(at + 1);
      }
      return env;
    } catch { return undefined; }
  },
  tail(path, bytes) {
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      const size = fstatSync(fd).size, from = Math.max(0, size - bytes);
      const buffer = Buffer.alloc(size - from);
      const text = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, from)).toString("utf8");
      // a cut first line is not a record
      return from > 0 ? text.slice(text.indexOf("\n") + 1) : text;
    } catch { return undefined; } finally { if (fd !== undefined) closeSync(fd); }
  },
  privateFile(path, uid) {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.uid !== uid || stat.size > 64 * 1024) return undefined;
      return readFileSync(path);
    } catch { return undefined; }
  },
  privateDir(path, uid) {
    try { const stat = lstatSync(path); return stat.isDirectory() && stat.uid === uid && (stat.mode & 0o077) === 0; } catch { return false; }
  },
  realpath(path) { try { return realpathSync(path); } catch { return undefined; } },
  myUid: () => process.getuid?.() ?? -1,
};

/** A discovered viewer with the password its krdp was started with; never leaves this server. */
/** `piStartedAt`: when the Pi process that runs the viewer started (this PC's clock) */
export interface ViewerSecret extends PiGuiViewer { password: string; piStartedAt: number }

/** pi-gui's agent dir for that Pi process: its own PI_CODING_AGENT_DIR, else its HOME's ~/.pi/agent. */
export function agentDirOf(env: Record<string, string> | undefined): string {
  const home = env?.["HOME"] || homedir();
  const dir = env?.["PI_CODING_AGENT_DIR"];
  if (dir) return dir === "~" ? home : dir.startsWith("~/") ? join(home, dir.slice(2)) : dir;
  return join(home, ".pi", "agent");
}

function argument(args: readonly string[], name: string): string | undefined {
  const found = args.filter((arg) => arg.startsWith(`--${name}=`));
  return found.length === 1 ? found[0]!.slice(name.length + 3) : undefined;
}

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function verify(system: ViewerSystem, line: { piPid: number; worker: string; krdpPid: number; port: number; display: string; startedAt: number }): ViewerSecret | undefined {
  const uid = system.myUid();
  if (system.uid(line.krdpPid) !== uid || system.ppid(line.krdpPid) !== line.piPid) return undefined;
  // pi-gui logs the line once krdp listens (its start, a certificate and up to three ports before
  // it): a process that started after the line, or long before it, is another one with that pid
  const krdpStart = system.startedAt(line.krdpPid), piStart = system.startedAt(line.piPid);
  if (krdpStart === undefined || piStart === undefined || krdpStart > line.startedAt + 5_000 || krdpStart < line.startedAt - 120_000 || piStart > krdpStart + 1_000) return undefined;
  const args = system.cmdline(line.krdpPid);
  if (!args) return undefined;
  if (argument(args, "address") !== "127.0.0.1" || argument(args, "port") !== String(line.port) || argument(args, "username") !== "pi") return undefined;
  const password = argument(args, "password"), certificate = argument(args, "certificate");
  if (!password || password.length > 256 || /[\r\n\0]/.test(password) || !certificate || !isAbsolute(certificate)) return undefined;
  const env = system.environ(line.krdpPid);
  const runtimeDir = env?.["XDG_RUNTIME_DIR"];
  if (!env || env["WAYLAND_DISPLAY"] !== line.display || !runtimeDir || !isAbsolute(runtimeDir) || !RUNTIME_DIR.test(basename(runtimeDir))) return undefined;
  if (!system.privateDir(runtimeDir, uid)) return undefined;
  const root = system.realpath(runtimeDir), real = system.realpath(certificate);
  if (!root || !real || !inside(real, root)) return undefined;
  const pem = system.privateFile(real, uid);
  if (!pem) return undefined;
  let fingerprint: string;
  try { fingerprint = new X509Certificate(pem).fingerprint256.replaceAll(":", "").toLowerCase(); } catch { return undefined; }
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) return undefined;
  return { worker: line.worker, port: line.port, display: line.display, pid: line.krdpPid, startedAt: line.startedAt, fingerprint, password, piStartedAt: piStart };
}

/** Every verified viewer of the Pi processes in this pane, the latest per desktop name. */
export async function discoverViewers(paneId: string, system: ViewerSystem = procViewerSystem): Promise<ViewerSecret[]> {
  if (!system.supported()) return [];
  const foreground = new Set(await system.foreground(paneId));
  if (!foreground.size) return [];
  const dirs = new Map<string, number[]>();
  for (const pid of foreground) {
    if (system.uid(pid) !== system.myUid()) continue;
    const dir = agentDirOf(system.environ(pid));
    dirs.set(dir, [...(dirs.get(dir) ?? []), pid]);
  }
  const latest = new Map<string, { piPid: number; worker: string; krdpPid: number; port: number; display: string; startedAt: number }>();
  for (const [dir, pids] of dirs) {
    const log = [join(dir, "gui.log.1"), join(dir, "gui.log")].map((path) => system.tail(path, LOG_TAIL) ?? "").join("\n");
    for (const text of log.split("\n")) {
      const match = LOG_LINE.exec(text.trimEnd());
      if (!match) continue;
      const piPid = Number(match[2]);
      if (!pids.includes(piPid)) continue;
      const startedAt = Date.parse(match[1]!);
      const port = Number(match[5]);
      if (!Number.isFinite(startedAt) || !Number.isInteger(port) || port < 1024 || port > 65535) continue;
      // later lines replace earlier ones: a restarted viewer of the same desktop is the current one
      latest.set(`${piPid}\0${match[3]}`, { piPid, worker: match[3]!, krdpPid: Number(match[4]), port, display: match[6]!, startedAt });
    }
  }
  const found: ViewerSecret[] = [];
  for (const line of latest.values()) {
    const viewer = verify(system, line);
    if (viewer) found.push(viewer);
  }
  return found.sort((a, b) => a.worker.localeCompare(b.worker, undefined, { numeric: true }));
}

/** The public view of a viewer: everything but its password. */
export function publicViewer({ password: _password, piStartedAt: _pi, ...viewer }: ViewerSecret): PiGuiViewer { return viewer; }

/**
 * Whether the guacd on this PC's loopback answers an RDP select with the arguments the gateway
 * needs (certificate pinning came with guacd 1.6). H.264 decoding cannot be seen from here.
 */
export function probeGuacd(port: number, timeoutMs = 2000): Promise<Extract<PiDesktopState, "ready" | "guacd_missing" | "guacd_incompatible">> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect({ host: "127.0.0.1", port });
    const done = (state: "ready" | "guacd_missing" | "guacd_incompatible") => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(state); };
    const timer = setTimeout(() => done("guacd_missing"), timeoutMs);
    timer.unref?.();
    const parser = new InstructionParser((parts) => { if (parts[0] === "args") done(parts.includes("cert-fingerprints") ? "ready" : "guacd_incompatible"); else done("guacd_incompatible"); });
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(instruction("select", "rdp")));
    socket.on("data", (data: string) => { try { parser.write(data); } catch { done("guacd_incompatible"); } });
    socket.once("error", () => done("guacd_missing"));
    socket.once("close", () => done("guacd_missing"));
  });
}
