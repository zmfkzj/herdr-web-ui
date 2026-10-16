/**
 * scripts/pi-visual-stack.sh against stand-ins: a fake guacd and a fake `bun run server`, each a
 * small listener on a free loopback port, in a copy of the launcher under a temporary root. No
 * real guacd, herdr or web UI server runs, and nothing reads the user's state or ports.
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

interface Run { code: number; out: string; err: string }

/** A port nothing listens on at the moment. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Whether pid runs (a zombie does not count). */
function running(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
}

function sessionOf(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[3]);
}

async function gone(pid: number, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (running(pid)) {
    if (Date.now() > deadline) return false;
    await Bun.sleep(25);
  }
  return true;
}

describe.skipIf(process.platform !== "linux")("pi-visual-stack.sh", () => {
  let base: string, root: string, stack: string, script: string;
  let env: Record<string, string>;
  const held: Server[] = [];

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), "pi-visual-stack-"));
    root = join(base, "repo");
    stack = join(base, "stack");
    const bin = join(base, "bin");
    for (const dir of [join(root, "scripts"), join(root, "node_modules"), join(root, "dist"), join(base, "home"), bin]) mkdirSync(dir, { recursive: true });
    for (const name of ["pi-visual-stack.sh", "bun-path.sh"]) copyFileSync(join(source, name), join(root, "scripts", name));
    script = join(root, "scripts", "pi-visual-stack.sh");
    writeFileSync(join(root, "dist", "index.html"), "<html></html>");
    writeFileSync(join(base, "listener.ts"), listener);
    writeFileSync(join(bin, "guacd"), guacdMock, { mode: 0o755 });
    writeFileSync(join(bin, "bun"), bunMock, { mode: 0o755 });
    env = {
      HOME: join(base, "home"), XDG_CONFIG_HOME: join(base, "config"), HERDR_WEB_STATE_DIR: join(base, "state"),
      PATH: `${bin}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      HERDR_STACK_DIR: stack, HERDR_STACK_GUACD_BIN: join(bin, "guacd"),
      HERDR_STACK_GUACD_PORT: String(await freePort()), PORT: String(await freePort()), HOST: "127.0.0.1",
      HERDR_STACK_START_TIMEOUT: "15", HERDR_STACK_STOP_TIMEOUT: "10",
      REAL_BUN: process.execPath, MOCK_LISTENER: join(base, "listener.ts"), MOCK_DIR: base,
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
    const child = Bun.spawn(["bash", script, command], { env: { ...env, ...extra }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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
    expect(sessionOf(guacd!)).toBe(guacd!);
    expect(sessionOf(web!)).toBe(web!);
    expect(sessionOf(webChild)).toBe(web!);
    expect(sessionOf(guacd!)).not.toBe(sessionOf(process.pid));
    expect(await reachable(Number(env["HERDR_STACK_GUACD_PORT"]))).toBe(true);
    expect(await reachable(Number(env["PORT"]))).toBe(true);

    const guacdLog = readFileSync(join(stack, "guacd.log"), "utf8");
    expect(guacdLog).toContain(`guacd mock: -f -b 127.0.0.1 -l ${env["HERDR_STACK_GUACD_PORT"]} -L info`);
    expect(readFileSync(join(stack, "web-ui.log"), "utf8")).toContain("web-ui mock:  gateway=1");

    const status = await launch("status");
    expect(status.code).toBe(0);
    expect(status.out).toContain(`guacd: running (pid ${guacd}, listening on 127.0.0.1:${env["HERDR_STACK_GUACD_PORT"]})`);
    expect(status.out).toContain(`web UI: running (pid ${web}`);

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

  it("names a missing guacd, a broken guacd, a missing build or dependencies before starting anything", async () => {
    const missing = await launch("start", { HERDR_STACK_GUACD_BIN: join(base, "nowhere", "guacd") });
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("guacd not found at");
    expect(missing.err).toContain("install-guacd-h264-ubuntu26.04-v3.sh --resume");

    const broken = await launch("start", { MOCK_GUACD_VERSION_FAIL: "1" });
    expect(broken.code).toBe(1);
    expect(broken.err).toContain("-v failed");
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
    if (!Bun.which("bun", { PATH: "/usr/bin:/bin" })) {
      const noBun = await launch("start", { PATH: "/usr/bin:/bin", WITH_BUN_EXTRA_DIRS: join(base, "empty") });
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
    expect(result.err).toContain("guacd exited during startup");
    expect(result.err).toContain("guacd mock failing on purpose");
    expect(existsSync(join(stack, "web-ui.log"))).toBe(false);
  }, 30_000);

  it("kills a process that ignores TERM after the stop timeout", async () => {
    expect((await launch("start", { MOCK_GUACD: "ignore-term" })).code).toBe(0);
    const [guacd] = record("guacd");
    const stopped = await launch("stop", { HERDR_STACK_STOP_TIMEOUT: "1" });
    expect(stopped.code).toBe(0);
    expect(stopped.err).toContain("sending KILL");
    expect(await gone(guacd!)).toBe(true);
  }, 30_000);

  it("never signals an unrelated process that a stale or foreign record names", async () => {
    const bystander = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1 << 30)"], { stdio: ["ignore", "ignore", "ignore"] });
    try {
      mkdirSync(stack, { recursive: true });
      const stat = readFileSync(`/proc/${bystander.pid}/stat`, "utf8");
      const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      // a reused pid: alive, but started at another time than recorded
      writeFileSync(join(stack, "guacd.pid"), `${bystander.pid} 1 ${boot} 127.0.0.1 ${env["HERDR_STACK_GUACD_PORT"]}\n`);
      // the right start time, but not a session the launcher made
      writeFileSync(join(stack, "web-ui.pid"), `${bystander.pid} ${start} ${boot} 127.0.0.1 ${env["PORT"]}\n`);
      expect((await launch("status")).code).toBe(3);
      const stopped = await launch("stop");
      expect(stopped.code).toBe(1);
      expect(stopped.out).toContain("guacd was not running (stale record removed)");
      expect(stopped.err).toContain("does not lead its own session; not signalling it");
      expect(running(bystander.pid)).toBe(true);
      writeFileSync(join(stack, "web-ui.pid"), "garbage\n");
      expect((await launch("stop")).code).toBe(0);
      expect(running(bystander.pid)).toBe(true);
    } finally {
      bystander.kill("SIGKILL");
    }
  }, 30_000);
});
