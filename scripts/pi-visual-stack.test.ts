/**
 * scripts/pi-visual-stack.sh against stand-ins: a fake guacd and a fake `bun run server`, each a
 * small listener on a free loopback port, in a copy of the launcher under a temporary root. No
 * real guacd, herdr or web UI server runs, and nothing reads the user's state or ports.
 *
 * The same checks run for each variant of the launcher this machine can run: on Linux the Linux
 * one, and the macOS one with Linux's real perl, ps and lsof, where the commands macOS lacks
 * (setsid, flock, ss, GNU ps options) fail and netstat/sysctl answer in macOS's format; on macOS
 * the macOS one natively, under /bin/bash (3.2). PI_VISUAL_STACK_TEST_BASH runs them under another
 * bash, such as a local build of 3.2.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = import.meta.dir;

// The stand-in for guacd and for the server: listens like the real one, or fails as asked.
const listener = `
const [role, ...args] = process.argv.slice(2);
const mode = process.env["MOCK_" + role.toUpperCase().replace("-", "_")] ?? "ok";
let host = process.env.HOST ?? "127.0.0.1", port = Number(process.env.PORT);
if (role === "guacd") { host = args[args.indexOf("-b") + 1]; port = Number(args[args.indexOf("-l") + 1]); }
console.log(role + " mock: " + args.join(" ") + " gateway=" + (process.env.HERDR_PI_GUACD_ENABLED ?? "unset"));
if (mode === "exit") { console.error(role + " mock failing on purpose"); process.exit(3); }
process.on("SIGTERM", () => { if (mode === "ignore-term") console.log("ignoring TERM"); else process.exit(0); });
if (mode !== "nolisten") Bun.listen({ hostname: host, port, socket: { data() {} } });
setInterval(() => {}, 1 << 30);
`;

const guacdMock = `#!/bin/sh
if [ "$1" = "-v" ]; then
  if [ -n "\${MOCK_GUACD_VERSION_FAIL:-}" ]; then echo "error while loading shared libraries: libfreerdp3.so.3" >&2; exit 127; fi
  echo "Guacamole proxy daemon (guacd) version 1.6.0"; exit 0
fi
exec "$REAL_BUN" "$MOCK_LISTENER" guacd "$@"
`;

// Like \`bun run server\`: a wrapper process whose child is the actual listener.
const bunMock = `#!/bin/sh
[ "$1 $2" = "run server" ] || { echo "unexpected bun $*" >&2; exit 90; }
"$REAL_BUN" "$MOCK_LISTENER" web-ui &
echo $! > "$MOCK_DIR/web-child.pid"
wait
`;

const FAKE_BOOT = "6F1C2B9E-0D4A-4C55-9B8E-2A7D0C3E5F11";

/** Stand-ins that make Linux look like macOS to the launcher, written to its PATH's first directory. */
function emulatedMacTools(): Record<string, string> {
  const real = (name: string) => Bun.which(name, { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" })!;
  const absent = (name: string) => `#!/bin/sh\necho "${name}: not on macOS (the test's macOS emulation)" >&2\nexit 127\n`;
  return {
    setsid: absent("setsid"), flock: absent("flock"), ss: absent("ss"),
    // BSD ps takes one header-less keyword per -o and has no long options
    ps: `#!/bin/sh\nfor a in "$@"; do case $a in --*|*=,*) echo "ps: $a is not a macOS ps option" >&2; exit 1 ;; esac; done\nexec ${real("ps")} "$@"\n`,
    sysctl: `#!/bin/sh\n[ "$*" = "-n kern.bootsessionuuid" ] || { echo "sysctl: unexpected $*" >&2; exit 1; }\necho ${FAKE_BOOT}\n`,
    // macOS's netstat -an -p tcp: the port after the address's last dot, every user's sockets
    netstat: `#!/bin/sh
[ "$*" = "-an -p tcp" ] || { echo "netstat: unexpected $*" >&2; exit 64; }
echo "Active Internet connections (including servers)"
echo "Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)"
${real("ss")} -Hltn | awk '{ a = $4; p = a; sub(/.*:/, "", p); sub(/:[^:]*$/, "", a); gsub(/[][]/, "", a); if (a == "0.0.0.0" || a == "*") a = "*"; print "tcp4       0      0  " a "." p "          *.*                    LISTEN" }'
`,
  };
}

interface Backend { name: string; available: boolean; mac: boolean; emulated: boolean; bash: string }
const customBash = process.env["PI_VISUAL_STACK_TEST_BASH"];
const backends: Backend[] = [
  { name: "Linux", available: process.platform === "linux", mac: false, emulated: false, bash: customBash ?? "bash" },
  {
    name: "macOS variant on Linux", mac: true, emulated: true, bash: customBash ?? "bash",
    available: process.platform === "linux" && ["perl", "lsof", "ss", "ps"].every((name) => Bun.which(name, { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" })),
  },
  { name: "macOS", available: process.platform === "darwin", mac: true, emulated: false, bash: customBash ?? "/bin/bash" },
];

interface Run { code: number; out: string; err: string }

/** A port nothing listens on at the moment. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function ps(pid: number, ...keywords: string[]): string | null {
  const args = keywords.flatMap((keyword) => ["-o", `${keyword}=`]);
  const result = Bun.spawnSync(["ps", ...args, "-p", String(pid)], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, stdout: "pipe", stderr: "ignore" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

/** Whether pid runs (a zombie does not count). */
function running(pid: number): boolean {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
    } catch {
      return false;
    }
  }
  const state = ps(pid, "stat");
  return state !== null && state !== "" && !state.startsWith("Z");
}

async function gone(pid: number, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (running(pid)) {
    if (Date.now() > deadline) return false;
    await Bun.sleep(25);
  }
  return true;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

for (const backend of backends) describe.skipIf(!backend.available)(`pi-visual-stack.sh (${backend.name})`, () => {
  let base: string, root: string, stack: string, script: string;
  let env: Record<string, string>;
  const held: Server[] = [];
  const groupKind = backend.mac ? "process group" : "session";

  /** The session (Linux) or process group (macOS) the launcher tracks pid by. */
  function groupOf(pid: number): number {
    if (backend.mac) return Number(ps(pid, "pgid"));
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[3]);
  }

  /** The start time as the launcher records it. */
  function startOf(pid: number): string {
    if (!backend.mac) {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!;
    }
    const [, month, day, time, year] = ps(pid, "lstart")!.split(/\s+/);
    return `${year}${String(MONTHS.indexOf(month!) + 1).padStart(2, "0")}${day!.padStart(2, "0")}${time!.replaceAll(":", "")}`;
  }

  function bootId(): string {
    if (!backend.mac) return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (backend.emulated) return FAKE_BOOT;
    return Bun.spawnSync(["sysctl", "-n", "kern.bootsessionuuid"], { stdout: "pipe" }).stdout.toString().trim();
  }

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), "pi-visual-stack-"));
    root = join(base, "repo");
    stack = join(base, "stack");
    const bin = join(base, "bin"), tools = join(base, "tools");
    for (const dir of [join(root, "scripts"), join(root, "node_modules"), join(root, "dist"), join(base, "home"), bin, tools]) mkdirSync(dir, { recursive: true });
    for (const name of ["pi-visual-stack.sh", "bun-path.sh"]) copyFileSync(join(source, name), join(root, "scripts", name));
    script = join(root, "scripts", "pi-visual-stack.sh");
    writeFileSync(join(root, "dist", "index.html"), "<html></html>");
    writeFileSync(join(base, "listener.ts"), listener);
    writeFileSync(join(bin, "guacd"), guacdMock, { mode: 0o755 });
    writeFileSync(join(bin, "bun"), bunMock, { mode: 0o755 });
    if (backend.emulated) for (const [name, body] of Object.entries(emulatedMacTools())) writeFileSync(join(tools, name), body, { mode: 0o755 });
    if (backend.mac) {
      // lsof as is, or blind (MOCK_LSOF_BLIND=1) like lsof facing another user's socket
      const lsof = Bun.which("lsof", { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" })!;
      writeFileSync(join(tools, "lsof"), `#!/bin/sh\n[ -n "\${MOCK_LSOF_BLIND:-}" ] && exit 1\nexec ${lsof} "$@"\n`, { mode: 0o755 });
    }
    env = {
      HOME: join(base, "home"), XDG_CONFIG_HOME: join(base, "config"), OVIS_STATE_DIR: join(base, "state"),
      PATH: `${bin}:${tools}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      HERDR_STACK_DIR: stack, HERDR_STACK_GUACD_BIN: join(bin, "guacd"),
      HERDR_STACK_GUACD_PORT: String(await freePort()), PORT: String(await freePort()), HOST: "127.0.0.1",
      HERDR_STACK_START_TIMEOUT: "15", HERDR_STACK_STOP_TIMEOUT: "10",
      REAL_BUN: process.execPath, MOCK_LISTENER: join(base, "listener.ts"), MOCK_DIR: base,
      ...(backend.emulated ? { HERDR_STACK_PLATFORM: "Darwin" } : {}),
    };
  });

  afterEach(async () => {
    await launch("stop");
    // whatever a failed assertion left behind: only the sessions this test's launcher recorded
    for (const name of ["guacd", "web-ui"]) {
      const file = join(stack, `${name}.pid`);
      if (!existsSync(file)) continue;
      const pid = Number(readFileSync(file, "utf8").split(" ")[0]);
      try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
    }
    const child = join(base, "web-child.pid");
    if (existsSync(child)) try { process.kill(Number(readFileSync(child, "utf8")), "SIGKILL"); } catch { /* already gone */ }
    for (const server of held.splice(0)) server.close();
    rmSync(base, { recursive: true, force: true });
  });

  async function launch(command: string, extra: Record<string, string> = {}): Promise<Run> {
    const shell = Bun.which(backend.bash) ?? backend.bash;
    const child = Bun.spawn([shell, script, command], { env: { ...env, ...extra }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, out, err };
  }

  function record(name: string): number[] {
    const [pid, start] = readFileSync(join(stack, `${name}.pid`), "utf8").trim().split(" ");
    return [Number(pid), Number(start)];
  }

  async function hold(port: number): Promise<Server> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    held.push(server);
    return server;
  }

  async function reachable(port: number): Promise<boolean> {
    try {
      const socket = await Bun.connect({ hostname: "127.0.0.1", port: port, socket: { data() {} } });
      socket.end();
      return true;
    } catch {
      return false;
    }
  }

  it("starts both in their own sessions, past the launcher's exit, then stops exactly them", async () => {
    const started = await launch("start");
    expect(started.err).toBe("");
    expect(started.code).toBe(0);
    expect(started.out).toContain(`http://127.0.0.1:${env["PORT"]}`);
    const [guacd] = record("guacd"), [web] = record("web-ui");
    const webChild = Number(readFileSync(join(base, "web-child.pid"), "utf8"));
    // the launcher has exited; both still run, detached from the caller's session
    for (const pid of [guacd!, web!, webChild]) expect(running(pid)).toBe(true);
    expect(groupOf(guacd!)).toBe(guacd!);
    expect(groupOf(web!)).toBe(web!);
    expect(groupOf(webChild)).toBe(web!);
    expect(groupOf(guacd!)).not.toBe(groupOf(process.pid));
    expect(await reachable(Number(env["HERDR_STACK_GUACD_PORT"]))).toBe(true);
    expect(await reachable(Number(env["PORT"]))).toBe(true);

    const guacdLog = readFileSync(join(stack, "guacd.log"), "utf8");
    expect(guacdLog).toContain(`guacd mock: -f -b 127.0.0.1 -l ${env["HERDR_STACK_GUACD_PORT"]} -L info`);
    expect(readFileSync(join(stack, "web-ui.log"), "utf8")).toContain("web-ui mock:  gateway=1");

    const status = await launch("status");
    expect(status.code).toBe(0);
    expect(status.out).toContain(`guacd: running (pid ${guacd}, listening on 127.0.0.1:${env["HERDR_STACK_GUACD_PORT"]})`);
    expect(status.out).toContain(`web UI: running (pid ${web}`);

    // stop takes the lock: neither daemon kept the launcher's lock descriptor
    const stopped = await launch("stop");
    expect(stopped.code).toBe(0);
    for (const pid of [guacd!, web!, webChild]) expect(await gone(pid)).toBe(true);
    expect(existsSync(join(stack, "guacd.pid"))).toBe(false);
    const after = await launch("status");
    expect(after.code).toBe(3);
    expect(after.out).toContain("guacd: stopped");
    // logs stay for a look after the stop
    expect(readFileSync(join(stack, "guacd.log"), "utf8")).toContain("started by scripts/pi-visual-stack.sh");
    expect((await launch("stop")).code).toBe(0);
  }, 30_000);

  it("reuses the running pair on a second start and lets only one of two simultaneous starts launch", async () => {
    const [first, second] = await Promise.all([launch("start"), launch("start")]);
    // the loser either meets the lock or, if it came late, the pair the winner started
    expect(first.code === 0 || second.code === 0).toBe(true);
    const loser = first.code === 0 ? second : first;
    if (loser.code !== 0) expect(loser.err).toContain("another scripts/pi-visual-stack.sh command is running");
    else expect(loser.out).toContain("already running");
    const [guacd] = record("guacd"), [web] = record("web-ui");
    const again = await launch("start");
    expect(again.code).toBe(0);
    expect(again.out).toContain(`guacd already running (pid ${guacd}`);
    expect(again.out).toContain(`web UI already running (pid ${web}`);
    expect(record("guacd")[0]).toBe(guacd!);
    expect(record("web-ui")[0]).toBe(web!);
    expect(readFileSync(join(stack, "guacd.log"), "utf8").match(/guacd mock:/g)).toHaveLength(1);
  }, 30_000);

  it("refuses at once while another command holds the lock, which outlives the helper that took it", async () => {
    mkdirSync(stack, { recursive: true });
    // the lock as the launcher takes it: flock(2) on descriptor 9 by a helper that then exits
    const holder = Bun.spawn(["bash", "-c", `exec 9>"$1/lock"; perl -MFcntl=:flock -e 'open(my $fh, ">&=", 9) or die; flock($fh, LOCK_EX | LOCK_NB) or exit 1' || exit 1; echo held; exec sleep 30`, "holder", stack], { stdout: "pipe", stderr: "inherit" });
    try {
      const reader = holder.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("held");
      for (const command of ["start", "stop"]) {
        const blocked = await launch(command);
        expect(blocked.code).toBe(1);
        expect(blocked.err).toContain("another scripts/pi-visual-stack.sh command is running");
      }
      expect(existsSync(join(stack, "guacd.pid"))).toBe(false);
    } finally {
      holder.kill("SIGKILL");
      await holder.exited;
    }
    const started = await launch("start");
    expect(started.code).toBe(0);
  }, 30_000);

  it("names missing commands and an unsupported system for what they are", async () => {
    const empty = join(base, "empty");
    mkdirSync(empty);
    const missing = await launch("status", { PATH: empty, HERDR_STACK_PLATFORM: backend.mac ? "Darwin" : "Linux" });
    expect(missing.code).toBe(1);
    if (backend.mac) {
      expect(missing.err).toContain("missing commands: perl ps awk lsof netstat sysctl.");
      expect(missing.err).toContain("They ship with macOS");
      expect(missing.err).not.toContain("util-linux");
    } else {
      expect(missing.err).toContain("missing commands: setsid flock ss ps awk (util-linux, iproute2, procps).");
    }
    const other = await launch("status", { HERDR_STACK_PLATFORM: "FreeBSD" });
    expect(other.code).toBe(1);
    expect(other.err).toContain("runs on Linux and macOS only, not on 'FreeBSD'");
  }, 30_000);

  it("names a missing guacd, a broken guacd, a missing build or dependencies before starting anything", async () => {
    const missing = await launch("start", { HERDR_STACK_GUACD_BIN: join(base, "nowhere", "guacd") });
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("guacd not found at");
    if (backend.mac) {
      expect(missing.err).toContain("no guacd installer for macOS");
      expect(missing.err).toContain("set HERDR_STACK_GUACD_BIN");
      expect(missing.err).not.toContain("--resume");
    } else {
      expect(missing.err).toContain("install-guacd-h264-ubuntu26.04-v3.sh --resume");
    }

    const broken = await launch("start", { MOCK_GUACD_VERSION_FAIL: "1" });
    expect(broken.code).toBe(1);
    expect(broken.err).toContain("-v failed");
    expect(broken.err).toContain(backend.mac ? "check: otool -L" : "check: ldd");
    expect(broken.err).toContain("libfreerdp3");

    rmSync(join(root, "dist"), { recursive: true });
    const unbuilt = await launch("start");
    expect(unbuilt.code).toBe(1);
    expect(unbuilt.err).toContain("bun run build");

    rmSync(join(root, "node_modules"), { recursive: true });
    const uninstalled = await launch("start");
    expect(uninstalled.code).toBe(1);
    expect(uninstalled.err).toContain("bun install");

    // no bun on a system PATH (skipped where the system has one) and none in the install places
    if (!Bun.which("bun", { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" })) {
      const noBun = await launch("start", { PATH: `${join(base, "tools")}:/usr/bin:/bin:/usr/sbin:/sbin`, WITH_BUN_EXTRA_DIRS: join(base, "empty") });
      expect(noBun.code).toBe(1);
      expect(noBun.err).toContain("bun not found");
    }
    expect(existsSync(join(stack, "guacd.pid"))).toBe(false);
    expect(existsSync(join(stack, "guacd.log"))).toBe(false);
  }, 30_000);

  it("refuses a port someone else listens on and leaves that listener alone", async () => {
    await hold(Number(env["HERDR_STACK_GUACD_PORT"]));
    const result = await launch("start");
    expect(result.code).toBe(1);
    expect(result.err).toContain(`port ${env["HERDR_STACK_GUACD_PORT"]} is already in use by pid ${process.pid}`);
    expect(existsSync(join(stack, "guacd.pid"))).toBe(false);
    expect(existsSync(join(stack, "web-ui.pid"))).toBe(false);
    expect((await launch("status")).out).toContain("not started by this launcher");
    expect((await launch("stop")).code).toBe(0);
    expect(await reachable(Number(env["HERDR_STACK_GUACD_PORT"]))).toBe(true);
  }, 30_000);

  it.skipIf(!backend.mac)("refuses a port held by a listener lsof cannot show (another user's), from netstat", async () => {
    await hold(Number(env["HERDR_STACK_GUACD_PORT"]));
    const result = await launch("start", { MOCK_LSOF_BLIND: "1" });
    expect(result.code).toBe(1);
    expect(result.err).toContain(`port ${env["HERDR_STACK_GUACD_PORT"]} is already in use by a process this user cannot see`);
    expect(existsSync(join(stack, "guacd.pid"))).toBe(false);
    expect(await reachable(Number(env["HERDR_STACK_GUACD_PORT"]))).toBe(true);
  }, 30_000);

  it("stops the guacd it just started when the web UI's port is taken", async () => {
    await hold(Number(env["PORT"]));
    const result = await launch("start");
    expect(result.code).toBe(1);
    expect(result.out).toContain("guacd started (pid ");
    const guacd = Number(/guacd started \(pid (\d+)/.exec(result.out)![1]);
    expect(result.err).toContain(`port ${env["PORT"]} is already in use`);
    expect(result.err).toContain("stopping guacd started by this run");
    expect(await gone(guacd)).toBe(true);
    expect(existsSync(join(stack, "guacd.pid"))).toBe(false);
    expect(await reachable(Number(env["PORT"]))).toBe(true);
  }, 30_000);

  it("rolls back guacd when the server exits during startup, and shows why", async () => {
    const result = await launch("start", { MOCK_WEB_UI: "exit" });
    expect(result.code).toBe(1);
    expect(result.err).toContain("web UI exited during startup");
    expect(result.err).toContain("web-ui mock failing on purpose");
    const guacd = Number(/guacd started \(pid (\d+)/.exec(result.out)![1]);
    expect(await gone(guacd)).toBe(true);
    expect(existsSync(join(stack, "guacd.pid"))).toBe(false);
    expect(existsSync(join(stack, "web-ui.pid"))).toBe(false);
  }, 30_000);

  it("rolls back both when the server never listens before the start timeout", async () => {
    const result = await launch("start", { MOCK_WEB_UI: "nolisten", HERDR_STACK_START_TIMEOUT: "2" });
    expect(result.code).toBe(1);
    expect(result.err).toContain(`did not listen on port ${env["PORT"]} within 2s`);
    const guacd = Number(/guacd started \(pid (\d+)/.exec(result.out)![1]);
    const webChild = Number(readFileSync(join(base, "web-child.pid"), "utf8"));
    expect(await gone(guacd)).toBe(true);
    expect(await gone(webChild)).toBe(true);
  }, 30_000);

  it("rolls back a guacd that fails without starting the server", async () => {
    const result = await launch("start", { MOCK_GUACD: "exit" });
    expect(result.code).toBe(1);
    // a guacd gone before the launcher reads its start time (fast on the macOS variant's ps) fails as "immediately"
    expect(result.err).toMatch(/guacd exited (?:during startup|immediately)/);
    expect(result.err).toContain("guacd mock failing on purpose");
    expect(existsSync(join(stack, "web-ui.log"))).toBe(false);
  }, 30_000);

  it("kills a process that ignores TERM after the stop timeout", async () => {
    expect((await launch("start", { MOCK_GUACD: "ignore-term" })).code).toBe(0);
    const [guacd] = record("guacd");
    const stopped = await launch("stop", { HERDR_STACK_STOP_TIMEOUT: "1" });
    expect(stopped.code).toBe(0);
    expect(stopped.err).toContain(`${groupKind} ${guacd} did not stop within 1s; sending KILL`);
    expect(await gone(guacd!)).toBe(true);
  }, 30_000);

  it("stops what remains of a server whose leader died, and refuses to start beside it", async () => {
    expect((await launch("start")).code).toBe(0);
    const [web] = record("web-ui");
    const webChild = Number(readFileSync(join(base, "web-child.pid"), "utf8"));
    process.kill(web!, "SIGKILL");
    expect(await gone(web!)).toBe(true);
    expect(running(webChild)).toBe(true);
    expect(groupOf(webChild)).toBe(web!);

    const status = await launch("status");
    expect(status.code).toBe(3);
    expect(status.out).toContain(`web UI: stopped (stale record: pid ${web} is gone)`);
    const again = await launch("start");
    expect(again.code).toBe(1);
    expect(again.err).toContain(`web UI's earlier processes (${groupKind} ${web}) are still running without their leader`);
    expect(running(webChild)).toBe(true);

    const stopped = await launch("stop");
    expect(stopped.code).toBe(0);
    expect(stopped.out).toContain(`stopping what remains of web-ui (${groupKind} ${web})`);
    expect(await gone(webChild)).toBe(true);
    expect(existsSync(join(stack, "web-ui.pid"))).toBe(false);
  }, 30_000);

  it("never signals an unrelated process that a stale or foreign record names", async () => {
    const bystander = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1 << 30)"], { stdio: ["ignore", "ignore", "ignore"] });
    try {
      mkdirSync(stack, { recursive: true });
      const start = startOf(bystander.pid);
      const boot = bootId();
      // a reused pid: alive, but started at another time than recorded
      writeFileSync(join(stack, "guacd.pid"), `${bystander.pid} 1 ${boot} 127.0.0.1 ${env["HERDR_STACK_GUACD_PORT"]}\n`);
      // the right start time, but not a session the launcher made
      writeFileSync(join(stack, "web-ui.pid"), `${bystander.pid} ${start} ${boot} 127.0.0.1 ${env["PORT"]}\n`);
      expect((await launch("status")).code).toBe(3);
      const stopped = await launch("stop");
      expect(stopped.code).toBe(1);
      expect(stopped.out).toContain("guacd was not running (stale record removed)");
      expect(stopped.err).toContain(`does not lead its own ${groupKind}; not signalling it`);
      expect(running(bystander.pid)).toBe(true);
      // the right pid and start, but recorded in another boot
      writeFileSync(join(stack, "web-ui.pid"), `${bystander.pid} ${start} another-boot 127.0.0.1 ${env["PORT"]}\n`);
      const otherBoot = await launch("stop");
      expect(otherBoot.code).toBe(0);
      expect(otherBoot.out).toContain("web-ui was not running (stale record removed)");
      writeFileSync(join(stack, "web-ui.pid"), "garbage\n");
      expect((await launch("stop")).code).toBe(0);
      expect(running(bystander.pid)).toBe(true);
    } finally {
      bystander.kill("SIGKILL");
    }
  }, 30_000);
});
