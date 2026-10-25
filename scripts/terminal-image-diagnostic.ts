/**
 * Locate missing inline terminal images without touching a user's session. Run under the isolated
 * test environment (docs/terminal-images.md). This is a diagnostic, NOT a passing image-render QA:
 * exit 2 means the image did not reach the browser. No package or service is installed or updated.
 *
 * PI_TUI_IMAGE_MODULE may name an installed pi-tui/dist/terminal-image.js: then its real encoder is
 * used. Otherwise the fixture uses Pi's documented Kitty PNG framing (a=T,f=100,C=1, 4096-char chunks).
 * The native herdr client and the web attach read the SAME owned pane. A loopback MachineRelay
 * captures the bridge route too (not real SSH). All dumps/screenshots contain fixture data only.
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { herdrRpc, paneRead, paneSendKeys, paneSendText } from "../server/herdr/client.ts";
import { PtySession } from "../server/pty/session.ts";
import { MachineRelay } from "../server/machine-relay.ts";
import type { MachineManager } from "../server/machines.ts";
import { chromePath } from "./chrome-path.ts";
import type { ServerMessage } from "../shared/protocol.ts";

if (process.env["HERDR_TEST_LIVE"] === "1") throw new Error("This diagnostic refuses HERDR_TEST_LIVE=1");
const root = mkdtempSync(join(tmpdir(), "terminal-image-"));
const evidence = resolve(process.env["IMAGE_EVIDENCE_DIR"] || root);
mkdirSync(evidence, { recursive: true });
// Self-generated 64×64 PNG: red left, blue right. No remote URL or user file is involved.
const png = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAVUlEQVR4nO3PMQ0AMAgAMCQhAYmTiAQkIGEXX5MaaEzlqXx9KgQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEfhaZngFp1DP0fAAAAABJRU5ErkJggg==";
const until = async (test: () => boolean, what: string, ms = 15_000) => {
  for (const end = Date.now() + ms; !test();) {
    if (Date.now() >= end) throw new Error(`Timed out: ${what}`);
    await Bun.sleep(25);
  }
};
const commands = (text: string) => [...text.matchAll(/\x1b_G([^;\x1b]*)(?:;[^\x1b]*)?\x1b\\/g)].map((match) => match[1]!);
const imagePayload = (text: string) => /\x1b_G[^\x1b]*;[A-Za-z0-9+/]{8}/.test(text) || /\x1b\]1337;File=/.test(text) || /\x1bP[\d;]*q/.test(text);

let workspace: string | undefined;
let server: ReturnType<typeof createServer> | undefined;
let native: PtySession | undefined;
let proxy: ReturnType<typeof Bun.serve<{ relay: MachineRelay }>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const sockets: WebSocket[] = [];
const relays = new Set<MachineRelay>();
let nativeOutput = "";
const captured = { local: "", bridge: "" };
try {
  const encoderPath = process.env["PI_TUI_IMAGE_MODULE"];
  let image: string;
  if (encoderPath) {
    const encoder = await import(pathToFileURL(resolve(encoderPath)).href) as { encodeKitty(data: string, options: object): string };
    image = encoder.encodeKitty(png, { imageId: 41, columns: 12, rows: 6, moveCursor: false });
  } else image = `\x1b_Ga=T,f=100,q=2,C=1,c=12,r=6,i=41;${png}\x1b\\`;
  assert(image.startsWith("\x1b_G") && imagePayload(image), "fixture actually emits image bytes");
  const fixture = join(root, "image.bin");
  writeFileSync(fixture, `\x1b[2J\x1b[HIMAGE_START\r\n${image}\x1b[10;1HIMAGE_END\r\n`);
  writeFileSync(join(evidence, "fixture.png"), Buffer.from(png, "base64"));
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>("workspace.create", { label: "herdr-web-ui-test-terminal-image", cwd: root, focus: true });
  workspace = created.workspace.workspace_id;
  const pane = created.root_pane.pane_id;
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", herdrProfiles: async () => [], tailscaleOwner: null, stateDir: join(root, "state") });

  // Remove inherited *live* herdr selectors for the native client. Its --session and XDG config
  // identify only the isolated test session. TMUX blocks herdr's file-transport fast path: pixels
  // must travel inline in this experiment, never by a filename sent by the terminal.
  native = new PtySession({ command: "/usr/bin/env", args: [
    ...Object.keys(process.env).filter((key) => key.startsWith("HERDR_")).flatMap((key) => ["-u", key]),
    process.env["OVIS_HERDR_BIN"] || "herdr", "--session", process.env["HERDR_TEST_SESSION"] || "herdr-web-ui-test",
  ], cols: 100, rows: 30, env: { TERM_PROGRAM: "xterm", TMUX: "fixture" }, onExit() {}, onData(data) {
    nativeOutput += data;
    if (nativeOutput.length > 8 * 1024 * 1024) throw new Error("Fixture native output exceeded its bound");
    // Only reply to well-known terminal geometry/capability queries of our owned native client.
    if (data.includes("\x1b[16t")) native?.write("\x1b[6;18;9t");
    if (data.includes("\x1b[14t")) native?.write("\x1b[4;540;900t");
    if (data.includes("\x1b[c")) native?.write("\x1b[?1;2c");
    if (data.includes("\x1b[?1016$p")) native?.write("\x1b[?1016;4$y");
  } });

  // Reuse the production frame relay. Its manager stands in for one SSH forward to this fixture.
  // No actual SSH command or remote PC is accessed. This tests byte forwarding, not SSH/auth setup.
  const endpoint = { url: `http://127.0.0.1:${server.port}`, token: "fixture-only" };
  const manager = { endpoint: () => endpoint, trackTerminal: () => () => {} } as unknown as MachineManager;
  proxy = Bun.serve<{ relay: MachineRelay }>({ port: 0, hostname: "127.0.0.1", async fetch(request, app) {
    if (new URL(request.url).pathname !== "/ws") return new Response("not found", { status: 404 });
    const relay = new MachineRelay(manager, "fixture-pc"); relays.add(relay);
    try { await relay.ready; } catch { relay.close(); return new Response("upstream failed", { status: 502 }); }
    if (app.upgrade(request, { data: { relay } })) return;
    relay.close(); return new Response("upgrade failed", { status: 400 });
  }, websocket: {
    open(client) { client.data.relay.bind(client); },
    message(client, data) { client.data.relay.message(data); },
    close(client) { client.data.relay.close(); relays.delete(client.data.relay); },
  } });
  for (const [route, port] of [["local", server.port], ["bridge", proxy.port]] as const) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); sockets.push(ws);
    ws.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as ServerMessage;
      if (frame.type !== "pty-data" || frame.pane_id !== pane) return;
      captured[route] += frame.data;
      if (captured[route].length > 8 * 1024 * 1024) throw new Error("Fixture attach output exceeded its bound");
      if (frame.flow) ws.send(JSON.stringify({ type: "pty-ack", pane_id: pane, ...frame.flow }));
    };
    await until(() => ws.readyState === WebSocket.OPEN, `${route} socket`);
    ws.send(JSON.stringify({ type: "attach", pane_id: pane, cols: 100, rows: 30, flow_control: "ack" }));
    await until(() => captured[route].length > 0, `${route} initial frame`);
  }

  browser = await chromium.launch({ executablePath: chromePath(), headless: process.env["HEADED"] !== "1", args: ["--no-sandbox", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 }, locale: "en-US" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((id) => localStorage.setItem(`ovis:view:${id}`, "terminal"), pane);
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}&view=terminal`);
  await page.locator(".conn-live").first().waitFor();
  await page.screenshot({ path: join(evidence, "before.png") });
  await page.locator(".terminal-surface .xterm:visible").first().waitFor();
  await paneSendText(pane, `python3 -c 'import sys;sys.stdout.buffer.write(open("${fixture}","rb").read())'`);
  await paneSendKeys(pane, ["Enter"]);
  await page.getByText("IMAGE_END", { exact: false }).first().waitFor();
  // Native output may follow the text frame; allow its actual image event, not a guessed sleep.
  await until(() => commands(nativeOutput).some((control) => control.startsWith("a=p,")), "native Kitty placement");
  const read = await paneRead({ paneId: pane, format: "ansi", source: "visible" });
  await page.screenshot({ path: join(evidence, "web-terminal.png") });
  assert.deepEqual(errors, [], "browser stays usable while the image is missing");
  for (const [route, bytes] of Object.entries(captured)) writeFileSync(join(evidence, `${route}-attach.txt`), bytes);
  writeFileSync(join(evidence, "native.txt"), nativeOutput);
  writeFileSync(join(evidence, "mirror-ansi.txt"), read.text);
  const result = {
    herdr: Bun.spawnSync([process.env["OVIS_HERDR_BIN"] || "herdr", "--version"]).stdout.toString().trim(),
    encoder: encoderPath ? "installed pi-tui encodeKitty" : "Pi-compatible Kitty fixture",
    native: { image: imagePayload(nativeOutput), commands: commands(nativeOutput) },
    local: { image: imagePayload(captured.local), commands: commands(captured.local) },
    bridgeFixture: { image: imagePayload(captured.bridge), commands: commands(captured.bridge) },
    mirror: { image: imagePayload(read.text) }, browserErrors: errors,
    status: !imagePayload(captured.local) ? "blocked: herdr terminal attach contains no image payload" : "image payload arrived; browser pixel verification still required",
  };
  writeFileSync(join(evidence, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.log(`Fixture evidence: ${evidence}`);
  if (process.env["IMAGE_HOLD_FILE"]) {
    const file = process.env["IMAGE_HOLD_FILE"]!; writeFileSync(file, "holding");
    console.log(`Fixture URL: http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}&view=terminal`);
    for (const end = Date.now() + 600_000; Date.now() < end && await Bun.file(file).exists();) await Bun.sleep(500);
  }
  process.exitCode = result.local.image && result.bridgeFixture.image ? 0 : 2;
} finally {
  writeFileSync(join(evidence, "native.txt"), nativeOutput);
  for (const [route, bytes] of Object.entries(captured)) writeFileSync(join(evidence, `${route}-attach.txt`), bytes);
  await browser?.close();
  for (const ws of sockets) ws.close();
  for (const relay of relays) relay.close();
  proxy?.stop(true);
  native?.kill(); await native?.exited;
  server?.stop();
  if (workspace) await herdrRpc("workspace.close", { workspace_id: workspace });
}
