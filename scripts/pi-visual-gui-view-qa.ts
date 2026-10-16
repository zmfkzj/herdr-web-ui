/**
 * `/gui view <WORKER>` typed straight into a Pi pane's terminal -> this web server -> the private
 * desktop on screen, for this PC and for a remote PC behind its bridge. Run after bun run build.
 *
 * Everything is a fixture of its own: an owned pane of the test herdr session (scripts/test-herdr.ts)
 * running a stand-in `pi` that echoes lines; this server; a second server as the remote PC's bridge
 * (remote-entry.ts runs the same createServer) reached through a fake SSH connection whose forward
 * is a loopback TCP proxy; and one fake guacd per PC that paints the desktop in that PC's colour.
 * No real SSH, Pi, pi-gui, krdp or guacd, and no user's herdr, desktop or host is touched. Both
 * servers serve the same herdr, so the remote PC's pane, session and worker names are exactly the
 * local ones: only the colour on screen says which PC answered.
 *
 * HOLD=1 keeps everything running afterwards for a look by hand (prints the URLs; stops after
 * HOLD_MS, default 15 minutes, or when the file named by HOLD_FILE disappears).
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect as tcpConnect, createServer as tcpServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { BRIDGE_PROTOCOL, REMOTE_BUNDLE_VERSION, type Machine } from "../shared/machines.ts";
import { createServer } from "../server/index.ts";
import { herdrRpc, sessionSnapshot, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { socketPath } from "../server/bridge.ts";
import { instruction, InstructionParser } from "../server/pi-visual/guacamole.ts";
import type { PiPane } from "../server/pi-visual/identity.ts";
import type { ViewerSecret } from "../server/pi-visual/viewers.ts";
import type { VisualDependencies } from "../server/pi-visual/service.ts";
import { SshConnection } from "../server/ssh.ts";
import { chromePath } from "./chrome-path.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-gui-view-"));
const shots = process.env["QA_SHOTS"] || join(root, "shots");
mkdirSync(shots, { recursive: true });
const SESSION = "e".repeat(64);
const started = Date.now();
const COLORS = { local: [200, 40, 40], localW2: [40, 170, 60], remote: [40, 80, 220] } as const;

interface Guacd { server: Server; port: number; connects: string[][]; sockets: Set<Socket> }
/** A guacd stand-in: answers the RDP handshake and paints the whole desktop one colour per RDP port. */
async function guacd(colourOf: (rdpPort: string) => readonly number[]): Promise<Guacd> {
  const connects: string[][] = []; const sockets = new Set<Socket>();
  const server = tcpServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.setEncoding("utf8");
    let args: string[] = [];
    const parser = new InstructionParser((parts) => {
      if (parts[0] === "select") { args = ["VERSION_1_6_0", "hostname", "port", "username", "password", "security", "cert-fingerprints", "read-only"]; socket.write(instruction("args", ...args)); }
      if (parts[0] === "connect") {
        connects.push(parts);
        const [r, g, b] = colourOf(parts[2 + args.indexOf("port") - 1] ?? "");
        socket.write(instruction("ready", "fixture") + instruction("size", "0", "640", "360") + instruction("rect", "0", "0", "0", "640", "360") + instruction("cfill", "14", "0", String(r), String(g), String(b), "255") + instruction("sync", "1"));
      }
    });
    socket.on("data", (data) => { try { parser.write(String(data)); } catch { socket.destroy(); } });
    socket.on("error", () => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as { port: number }).port, connects, sockets };
}
const viewer = (worker: string, port: number, pid: number, password: string): ViewerSecret =>
  ({ worker, port, display: `wayland-virtual-${pid}`, pid, startedAt: started - 30_000, fingerprint: "ab".repeat(32), password, piStartedAt: started - 60_000 });
function visual(guacdPort: number, paneId: string, viewers: ViewerSecret[]): Partial<VisualDependencies> {
  const pane: PiPane = { paneId, sessionId: "pi-session", session: SESSION, path: "/fixture/pi.jsonl", cwd: null };
  return {
    guacdPort, probe: async () => "ready", discovery: () => true,
    identity: async (id, expected) => { if (id !== paneId || expected && expected !== SESSION) throw new Error("not this fixture's Pi"); return pane; },
    viewers: async () => viewers.map((item) => ({ ...item })),
    workers: () => ({ ...pane, observedAt: Date.now(), source: "original-pi-orche-records", workers: [], truncated: false }),
    image: async () => null,
  };
}
const until = async (done: () => boolean | Promise<boolean>, what: string, ms = 15_000) => {
  for (const deadline = Date.now() + ms; !(await done());) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await Bun.sleep(50);
  }
};
/** The colour the open desktop shows, read from its canvas. */
const desktopColour = (page: Page) => page.evaluate(() => {
  const canvas = document.querySelector(".pi-desktop-display canvas") as HTMLCanvasElement | null;
  const pixel = canvas?.getContext("2d")?.getImageData(20, 20, 1, 1).data;
  return pixel ? [pixel[0], pixel[1], pixel[2]] : null;
});
const near = (a: readonly number[] | null, b: readonly number[]) => !!a && a.every((value, index) => Math.abs(value - b[index]!) <= 6);

let workspaceId: string | undefined;
let failurePage: Page | undefined;
const stops: (() => void)[] = [];
const real = { start: SshConnection.prototype.start, run: SshConnection.prototype.run, close: SshConnection.prototype.close, forward: SshConnection.prototype.forward };
const previousSwitch = process.env["HERDR_PI_GUACD_ENABLED"];

try {
  // both servers start with desktop viewing on: the remote one as an activated PC's bridge is started
  process.env["HERDR_PI_GUACD_ENABLED"] = "1";
  const bin = join(root, "bin"); mkdirSync(bin);
  const fakePi = join(bin, "pi");
  // a stand-in Pi: herdr takes it for one by its name; it echoes each line it is given, and writes
  // pi-gui's line for a `/gui view <name>` it answers to its own agent dir's gui.log (pi-gui
  // src/viewer.ts `connect`), arrow keys left in the line by its tty taken out
  const agentDir = join(root, "agent"); mkdirSync(agentDir);
  writeFileSync(fakePi, [
    "#!/bin/sh", "printf 'fixture pi ready\\n'",
    "while IFS= read -r line; do",
    "  printf 'pi got: %s\\n' \"$line\"",
    "  clean=$(printf '%s' \"$line\" | sed 's/\\x1b\\[[0-9;]*[A-Za-z]//g')",
    "  case \"$clean\" in \"/gui view \"*) printf '%s [gui] main pid=%s view %s: client not opened (fixture)\\n' \"$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)\" \"$$\" \"${clean#/gui view }\" >> \"$PI_CODING_AGENT_DIR/gui.log\";; esac",
    "done", "",
  ].join("\n"));
  chmodSync(fakePi, 0o755);
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-gui-view" });
  workspaceId = created.workspace.workspace_id;
  const paneId = created.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: paneId, text: `PI_CODING_AGENT_DIR=${agentDir} ${fakePi}\n` });
  await until(async () => (await sessionSnapshot()).panes.find((pane) => pane.pane_id === paneId)?.agent === "pi", "the stand-in pi is detected");
  await herdrRpc("pane.report_agent", { pane_id: paneId, source: "herdr:pi", agent: "pi", state: "idle", seq: Date.now() * 1000 });

  const localGuacd = await guacd((port) => port === "3392" ? COLORS.localW2 : COLORS.local);
  const remoteGuacd = await guacd(() => COLORS.remote);
  stops.push(() => { for (const g of [localGuacd, remoteGuacd]) { for (const socket of g.sockets) socket.destroy(); g.server.close(); } });

  // the remote PC: its bridge, as remote-entry.ts starts it (a bearer, no PC list of its own)
  const bridgeToken = "c".repeat(64);
  const bridge = createServer({ port: 0, hostname: "127.0.0.1", token: bridgeToken, machines: false, stateDir: join(root, "bridge"), tailscaleOwner: null,
    piVisual: visual(remoteGuacd.port, paneId, [viewer("W1", 3391, 5101, "remote-secret")]) });
  stops.push(() => bridge.stop());
  // this PC: the same pane, session and worker names, its own viewers and guacd
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "local"), tailscaleOwner: null,
    piVisual: visual(localGuacd.port, paneId, [viewer("W1", 3391, 4101, "local-secret-w1"), viewer("W2", 3392, 4102, "local-secret-w2")]) });
  stops.push(() => server.stop());

  // SSH to the remote PC: a fake host whose forward is a TCP proxy to the bridge above
  const descriptor = { pid: process.pid, port: bridge.port, token: bridgeToken, socket_path: socketPath(), managed_remote: true, bridge_protocol: BRIDGE_PROTOCOL, bundle_version: REMOTE_BUNDLE_VERSION };
  const proxies: Server[] = [];
  stops.push(() => { for (const proxy of proxies) proxy.close(); });
  SshConnection.prototype.start = async () => {};
  SshConnection.prototype.close = () => {};
  SshConnection.prototype.run = async (script: string) => {
    if (script.includes("uname")) return `Linux\nx86_64\n${root}\n${root}/.config\n/usr/bin/herdr\nbundle-ready\n${JSON.stringify(descriptor)}\n`;
    if (script.includes("socket=")) return descriptor.socket_path;
    if (script.includes("--version")) return "herdr 0.9.3";
    if (script.includes("kill -0")) return "live";
    if (script.includes('for f in "$HOME/.config/herdr-web-ui/bridges/"')) return JSON.stringify(descriptor);
    throw new Error(`the fixture host runs nothing else: ${script.slice(0, 80)}`);
  };
  SshConnection.prototype.forward = async (local: number) => {
    const proxy = tcpServer((client) => { const upstream = tcpConnect(bridge.port, "127.0.0.1"); client.pipe(upstream); upstream.pipe(client); client.on("error", () => upstream.destroy()); upstream.on("error", () => client.destroy()); });
    await new Promise<void>((resolve) => proxy.listen(local, "127.0.0.1", resolve));
    proxies.push(proxy);
  };
  const base = `http://127.0.0.1:${server.port}`;
  const api = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", "x-herdr-machine": "1", origin: base, ...init.headers } });
  const job = await (await api("/api/machines/setup", { method: "POST", body: JSON.stringify({ destination: "fixture-remote-pc", name: "Fixture remote PC" }) })).json() as { machine_id: string };
  const remoteId = job.machine_id;
  let remote: Machine | undefined;
  await until(async () => { remote = ((await (await api("/api/machines")).json()) as { machines: Machine[] }).machines.find((machine) => machine.id === remoteId); return remote?.state === "connected"; }, "the remote PC connects through the fake SSH");
  assert.equal(remote!.pi_visual?.protocol, 1, "the bridge reports the Pi visual routes");
  assert.equal(remote!.pi_visual?.desktop, true, "the bridge was started with desktop viewing on");
  assert.notEqual(remote!.pi_desktop, true, "but nobody turned it on for this PC here yet");

  const browser = await chromium.launch({ executablePath: chromePath(), headless: process.env["HEADED"] !== "1", args: ["--no-sandbox", "--no-proxy-server"] });
  stops.unshift(() => void browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  const page = await context.newPage();
  failurePage = page;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(20_000);
  await page.addInitScript((id) => {
    localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" }));
    localStorage.setItem(`herdr-web-ui:view:${id}`, "terminal");
  }, paneId);
  const dialog = page.getByRole("dialog");
  /** types into the pane's terminal grid key by key, as a user does */
  const typeInTerminal = async (text: string) => {
    await page.locator(".terminal-surface .xterm").first().click();
    await page.keyboard.type(text, { delay: 15 });
  };
  const openPane = async (machine: string | null) => {
    await page.goto(`${base}/?${machine ? `machine=${encodeURIComponent(machine)}&` : ""}pane=${encodeURIComponent(paneId)}&view=terminal`);
    await page.locator(".conn-live").first().waitFor();
    await page.locator(".terminal-surface .xterm").first().waitFor();
    await page.getByText("fixture pi ready").first().waitFor();
  };

  // 1. this PC: `/gui view W2` typed into the terminal opens W2's desktop, not W1's
  await openPane(null);
  await typeInTerminal("/gui view W2");
  await page.keyboard.press("Enter");
  await dialog.getByRole("heading", { name: "W2's private desktop" }).waitFor();
  await dialog.getByText("Connected. Pause the worker before taking control.").waitFor();
  await until(async () => near(await desktopColour(page), COLORS.localW2), "W2's desktop is painted");
  await page.screenshot({ path: join(shots, "1-local-w2.png") });
  assert.deepEqual(localGuacd.connects.map((row) => row.slice(2, 6)), [["127.0.0.1", "3392", "pi", "local-secret-w2"]], "this PC's guacd connected W2's viewer with its own password");
  assert.equal(remoteGuacd.connects.length, 0, "the remote PC was not asked");
  assert.equal(await dialog.getByLabel("One-time viewer password").count(), 0, "no password was asked for");
  await dialog.getByRole("button", { name: "Close" }).click();
  await until(() => localGuacd.sockets.size === 0, "closing ends that guacd connection");

  // 1b. a line whose keys the browser cannot follow (an arrow here; ↑ from Pi's history or Tab from its
  // completion list alike) names nothing, but Pi's own log says it ran `/gui view W2`: it opens all the same
  await typeInTerminal("/gui view W2");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await dialog.getByRole("heading", { name: "W2's private desktop" }).waitFor();
  await dialog.getByText("Connected. Pause the worker before taking control.").waitFor();
  await until(async () => near(await desktopColour(page), COLORS.localW2), "W2's desktop is painted again");
  await page.screenshot({ path: join(shots, "1b-local-w2-from-pi-log.png") });
  assert.equal(localGuacd.connects.length, 2, "Pi's word opened W2 once more");
  assert.equal(await dialog.getByLabel("One-time viewer password").count(), 0, "no password was asked for");
  await dialog.getByRole("button", { name: "Close" }).click();
  await until(() => localGuacd.sockets.size === 0, "closing ends that guacd connection");
  // the command was one: nothing opens again after it closed
  // fixed wait: proving that no second desktop opens (the server watches Pi's log for 10 s after an Enter)
  await Bun.sleep(1500);
  assert.equal(await dialog.count(), 0, "a desktop opened once per command");

  // 2. a name no desktop has fails clearly, and opens nothing else
  await typeInTerminal("/gui view W9");
  await page.keyboard.press("Enter");
  await dialog.getByRole("alert").filter({ hasText: "No GUI desktop named W9" }).waitFor({ timeout: 20_000 });
  assert.equal(localGuacd.connects.length, 2, "no other desktop was opened for W9");
  await page.screenshot({ path: join(shots, "2-local-unknown.png") });
  await dialog.getByRole("button", { name: "Close" }).click();

  // 3. text that only shows the command (an echo, terminal output) opens nothing
  await typeInTerminal("echo /gui view W1");
  await page.keyboard.press("Enter");
  await page.getByText("pi got: echo /gui view W1").first().waitFor();
  assert.equal(await dialog.count(), 0, "a line that is not the command opens no desktop");

  // 4. the remote PC, same pane and worker names: off until turned on here, then its own desktop
  await openPane(remoteId);
  await typeInTerminal("/gui view W1");
  await page.keyboard.press("Enter");
  await dialog.getByRole("heading", { name: "W1's private desktop" }).waitFor();
  await dialog.getByRole("alert").filter({ hasText: "Desktop viewing is off for this PC" }).waitFor();
  await page.screenshot({ path: join(shots, "3-remote-off.png") });
  assert.equal(remoteGuacd.connects.length, 0, "nothing streams before the user turns it on");
  await dialog.getByRole("button", { name: "Turn on desktop viewing for this PC" }).click();
  await dialog.getByText("Connected. Pause the worker before taking control.").waitFor();
  await until(async () => near(await desktopColour(page), COLORS.remote), "the remote PC's desktop is painted");
  await page.screenshot({ path: join(shots, "4-remote-w1.png") });
  assert.deepEqual(remoteGuacd.connects.map((row) => row.slice(2, 6)), [["127.0.0.1", "3391", "pi", "remote-secret"]], "the remote PC's guacd connected its W1 with its password");
  assert.equal(localGuacd.connects.length, 2, "this PC's W1 was not opened for the remote W1");
  const machines = ((await (await api("/api/machines")).json()) as { machines: Machine[] }).machines;
  assert.equal(machines.find((machine) => machine.id === remoteId)?.pi_desktop, true, "the choice is recorded for that PC");
  // the PC's SSH link drops: its desktop ends with it
  for (const proxy of proxies) proxy.close();
  await api(`/api/machines/${remoteId}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
  await until(() => remoteGuacd.sockets.size === 0, "the remote desktop's guacd connection ends with the PC");
  await dialog.getByText("Connected. Pause the worker before taking control.").waitFor({ state: "detached" });
  await page.screenshot({ path: join(shots, "5-remote-disconnected.png") });
  assert.deepEqual(errors, [], "no page errors");
  console.log(`pi-visual /gui view QA passed; screenshots in ${shots}`);

  if (process.env["HOLD"] === "1") {
    await api(`/api/machines/${remoteId}`, { method: "PATCH", body: JSON.stringify({ enabled: true }) });
    console.log(`HOLD: local pane ${base}/?pane=${encodeURIComponent(paneId)}&view=terminal`);
    console.log(`HOLD: remote pane ${base}/?machine=${encodeURIComponent(remoteId)}&pane=${encodeURIComponent(paneId)}&view=terminal`);
    const holdFile = process.env["HOLD_FILE"];
    if (holdFile) writeFileSync(holdFile, String(process.pid));
    for (const deadline = Date.now() + Number(process.env["HOLD_MS"] || 900_000); Date.now() < deadline && (!holdFile || existsSync(holdFile));) await Bun.sleep(500);
  }
} catch (error) {
  // what the page showed when it failed
  await failurePage?.screenshot({ path: join(shots, "failure.png") }).catch(() => {});
  throw error;
} finally {
  for (const stop of stops) { try { stop(); } catch { /* already gone */ } }
  Object.assign(SshConnection.prototype, real);
  if (previousSwitch === undefined) delete process.env["HERDR_PI_GUACD_ENABLED"]; else process.env["HERDR_PI_GUACD_ENABLED"] = previousSwitch;
  if (workspaceId) await workspaceClose(workspaceId).catch(() => {});
  if (!process.env["QA_SHOTS"]) rmSync(root, { recursive: true, force: true });
}
