/**
 * Option+Enter (Alt+Enter) typed in the browser terminal reaches pi as its own Alt+Enter, end to
 * end (docs/terminal-input.md). Run after a build:
 *
 *   bun run check run --build bun scripts/pi-alt-enter-regression.ts
 *
 * What is real here: pi (1.3.x) itself with its default keybindings (`app.message.followUp` is
 * `alt+enter` on Linux and macOS: queue a follow-up while pi answers, submit while it is idle),
 * started fresh in an owned pane of the test herdr session (scripts/test-herdr.ts) with an agent
 * directory of its own; pi's keyboard protocol negotiation with herdr (Kitty, as on the user's PC);
 * herdr encoding the key; this build in Chromium, against this server and against a second server as
 * a remote PC's bridge.
 *
 * What is simulated: the model (a loopback server speaking the Responses streaming API with a dummy
 * key, which holds one answer open until the check lets it finish; no account, credential or
 * network); the SSH forward to the remote PC (loopback, not real SSH); and macOS, by Chromium with
 * `navigator.platform` set to MacIntel: Option+Enter there is the same `keydown` (key "Enter",
 * altKey) as Alt+Enter here, but no native macOS or Safari takes part. The pane drops every
 * credential-looking variable before pi starts.
 *
 * Checked, on this PC and through the remote PC: one Alt+Enter sends one `alt+enter` key and no
 * ESC CR; while pi answers, it queues the line as a follow-up (pi shows "Follow-up:") and the model
 * is asked nothing more until that answer ends, then exactly once for the follow-up; while pi is
 * idle it submits the line once. Shift+Enter still breaks pi's line, and Enter submits it.
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect as tcpConnect, createServer as tcpServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import { BRIDGE_PROTOCOL, REMOTE_BUNDLE_VERSION, type Machine } from "../shared/machines.ts";
import { createServer } from "../server/index.ts";
import { paneSendKeys, paneSendText, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { socketPath } from "../server/bridge.ts";
import { SshConnection } from "../server/ssh.ts";
import { chromePath } from "./chrome-path.ts";

if (process.env["HERDR_TEST_LIVE"] === "1") throw new Error("This regression refuses HERDR_TEST_LIVE=1");

const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-pi-alt-enter-"));
const evidence = resolve(process.env["PI_ALT_ENTER_EVIDENCE_DIR"] || join(root, "evidence"));
mkdirSync(evidence, { recursive: true });
const agentDir = join(root, "agent");
const project = join(root, "project");
mkdirSync(agentDir, { recursive: true });
mkdirSync(project, { recursive: true });
const KEY = "fixture-dummy-key";
/** how long a request that must not come gets to show up */
const NO_REQUEST_WAIT_MS = 1_500;

const until = async (test: () => boolean | Promise<boolean>, what: string, ms = 20_000) => {
  for (const end = Date.now() + ms; !(await test());) {
    if (Date.now() >= end) throw new Error(`Timed out: ${what}`);
    await Bun.sleep(50);
  }
};

type Item = { type?: unknown; role?: unknown; content?: unknown };
const itemText = (item: Item): string => typeof item.content === "string" ? item.content
  : Array.isArray(item.content) ? item.content.map((part) => typeof (part as { text?: unknown })?.text === "string" ? (part as { text: string }).text : "").join("") : "";
const event = (value: Record<string, unknown>, index: number) => `event: ${String(value["type"])}\ndata: ${JSON.stringify({ ...value, sequence_number: index })}\n\n`;

/**
 * The model: answers the newest user message with "answered <message>", streamed. A message named
 * by `hold` gets its first words at once and the rest only when `release` is called, so pi is
 * answering meanwhile. `requests` lists the newest user message of every request, in order.
 */
function heldModel() {
  const requests: string[] = [];
  const gates = new Map<string, { opened: Promise<void>; open: () => void }>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/responses")) return Response.json({ error: { message: "not served" } }, { status: 404 });
      if (request.headers.get("authorization") !== `Bearer ${KEY}`) return Response.json({ error: { message: "unknown key" } }, { status: 401 });
      const body = await request.json() as { input?: Item[] };
      const users = (Array.isArray(body.input) ? body.input : []).filter((item) => item.role === "user");
      const text = users.length > 0 ? itemText(users.at(-1)!).trim() : "";
      requests.push(text);
      const id = `resp_fixture_${requests.length}`;
      const response = { id, object: "response", status: "in_progress", output: [] as unknown[] };
      const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
      const gate = gates.get(text);
      // a held answer starts with "holding" at once, so the screen tells that pi is answering
      const answer = `${gate ? "holding " : ""}answered ${text.replace(/\s+/g, " ")}`;
      const message = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: answer, annotations: [] }] };
      const stream = new ReadableStream<string>({
        async start(controller) {
          let index = 0;
          const send = (value: Record<string, unknown>) => controller.enqueue(event(value, index++));
          const delta = (text: string) => send({ type: "response.output_text.delta", output_index: 0, item_id: message.id, content_index: 0, delta: text });
          send({ type: "response.created", response });
          send({ type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } });
          if (gate) {
            delta("holding ");
            await gate.opened;
            delta(answer.slice("holding ".length));
          } else delta(answer);
          send({ type: "response.output_item.done", output_index: 0, item: message });
          send({ type: "response.completed", response: { ...response, status: "completed", output: [message], usage } });
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requests,
    hold(text: string) { let open!: () => void; const opened = new Promise<void>((done) => { open = done; }); gates.set(text, { opened, open }); },
    release(text: string) { gates.get(text)?.open(); },
    stop: () => server.stop(true),
  };
}

let workspaceId: string | undefined;
let failurePage: Page | undefined;
const stops: (() => void)[] = [];
const real = { start: SshConnection.prototype.start, run: SshConnection.prototype.run, close: SshConnection.prototype.close, forward: SshConnection.prototype.forward };
const result: Record<string, unknown> = {
  actual: "pi with its default keybindings, its Kitty keyboard negotiation with herdr, herdr, this build, Chromium, this server and a bridge server",
  simulated: "the model (loopback Responses server, dummy key), the SSH forward (loopback), macOS (Chromium with navigator.platform MacIntel)",
};

try {
  const model = heldModel();
  stops.push(() => model.stop());
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { "fixture-responses": { baseUrl: model.url, api: "openai-responses", apiKey: KEY, models: [{ id: "fixture-alt-enter", name: "Fixture Alt+Enter", input: ["text"], contextWindow: 200_000, maxTokens: 8192 }] } } }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({}));
  const launcher = join(root, "pi.sh");
  writeFileSync(launcher, [
    "# no credential of the account reaches pi: the fixture model takes a dummy key",
    "for name in $(env | sed -n 's/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p' | grep -Ei 'api_?key|token|secret|password|credential|auth'); do unset \"$name\" 2>/dev/null; done",
    `export PI_CODING_AGENT_DIR='${agentDir}' PI_OFFLINE=1`,
    "exec pi --offline --no-skills --no-prompt-templates --no-context-files --no-mcp --provider fixture-responses --model fixture-alt-enter",
    "",
  ].join("\n"));

  // this PC and a remote PC's bridge, as in scripts/terminal-image-provider-regression.ts; both serve the test herdr
  const bridgeToken = "e".repeat(64);
  const bridge = createServer({ port: 0, hostname: "127.0.0.1", token: bridgeToken, machines: false, stateDir: join(root, "bridge"), tailscaleOwner: null });
  stops.push(() => bridge.stop());
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "local"), tailscaleOwner: null });
  stops.push(() => server.stop());
  const descriptor = { pid: process.pid, port: bridge.port, token: bridgeToken, socket_path: socketPath(), managed_remote: true, bridge_protocol: BRIDGE_PROTOCOL, bundle_version: REMOTE_BUNDLE_VERSION };
  const proxies: Server[] = [];
  stops.push(() => { for (const proxy of proxies) proxy.close(); });
  SshConnection.prototype.start = async () => {};
  SshConnection.prototype.close = () => {};
  SshConnection.prototype.run = async (script: string) => {
    if (script.includes("uname")) return `Linux\nx86_64\n${root}\n${root}/.config\n/usr/bin/herdr\nbundle-ready\n${JSON.stringify(descriptor)}\n`;
    if (script.includes("socket=")) return descriptor.socket_path;
    if (script.includes("--version")) return "herdr 0.9.5";
    if (script.includes("kill -0")) return "live";
    if (script.includes('for f in "$HOME/.config/herdr-web-ui/bridges/"')) return JSON.stringify(descriptor);
    throw new Error(`the fixture host runs nothing else: ${script.slice(0, 80)}`);
  };
  SshConnection.prototype.forward = async (local: number) => {
    const proxy = tcpServer((client) => { const upstream = tcpConnect(bridge.port, "127.0.0.1"); client.pipe(upstream); upstream.pipe(client); client.on("error", () => upstream.destroy()); upstream.on("error", () => client.destroy()); });
    await new Promise<void>((done) => proxy.listen(local, "127.0.0.1", done));
    proxies.push(proxy);
  };
  const base = `http://127.0.0.1:${server.port}`;
  const api = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", "x-herdr-machine": "1", origin: base, ...init.headers } });
  const job = await (await api("/api/machines/setup", { method: "POST", body: JSON.stringify({ destination: "fixture-remote-pc", name: "Fixture remote PC" }) })).json() as { machine_id: string };
  const remoteId = job.machine_id;
  await until(async () => ((await (await api("/api/machines")).json()) as { machines: Machine[] }).machines.find((machine) => machine.id === remoteId)?.state === "connected", "the remote PC connects through the fake SSH");

  const created = await workspaceCreate({ cwd: project, label: "herdr-web-ui-test-pi-alt-enter" });
  workspaceId = created.workspace.workspace_id;
  const pane = created.root_pane.pane_id;

  const browser = await chromium.launch({ executablePath: chromePath(), headless: process.env["HEADED"] !== "1", args: ["--no-sandbox", "--no-proxy-server"] });
  stops.unshift(() => void browser.close());
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, locale: "en-US" });
  await context.addInitScript((id) => {
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", terminalInputMode: "direct" }));
    localStorage.setItem(`ovis:view:${id}`, "terminal");
  }, pane);
  const page = await context.newPage();
  failurePage = page;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  type Sent = { type: "input"; text: string } | { type: "keys"; keys: string[] };
  const sent: Sent[] = [];
  let inputReady = false;
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.pane_id !== pane) return;
      if (message.type === "input") sent.push({ type: "input", text: message.text });
      if (message.type === "keys") sent.push({ type: "keys", keys: message.keys });
      if (message.type === "attach" || message.type === "detach") inputReady = false;
    });
    socket.on("framereceived", ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === "input-ready" && message.pane_id === pane) inputReady = message.ready !== false;
    });
  });
  const input = page.locator(".xterm-helper-textarea");
  const screenText = () => page.locator(".pane-terminal .xterm-rows").first().innerText();
  const shows = (text: string, what: string, ms?: number) => until(async () => (await screenText()).includes(text), what, ms);

  // pi starts fresh in the pane, then the browser opens its terminal
  await paneSendText(pane, `sh ${launcher}`);
  await paneSendKeys(pane, ["Enter"]);
  const open = async (label: string, machine: string | null) => {
    inputReady = false;
    await page.goto(`${base}/?${machine ? `machine=${encodeURIComponent(machine)}&` : ""}pane=${encodeURIComponent(pane)}&view=terminal`);
    await page.locator(".conn-live").first().waitFor();
    await until(() => inputReady, `${label}: terminal input ready`);
    await shows("fixture-alt-enter", `${label}: pi is up with the fixture model`, 30_000);
    await input.focus();
  };
  /** Types `text` into pi's editor and waits until pi shows it. */
  const type = async (text: string) => {
    await input.pressSequentially(text);
    await shows(text, `pi shows ${JSON.stringify(text)}`);
  };
  /** Presses `shortcut` and returns the frames it sent, waiting `settle` ms after the first. */
  const press = async (shortcut: string, settle = 300): Promise<Sent[]> => {
    const before = sent.length;
    await input.press(shortcut);
    await until(() => sent.length > before, `${shortcut} sends a frame`);
    // fixed wait: proves that no further frame follows the first (an ESC CR beside the key would come here)
    await page.waitForTimeout(settle);
    return sent.slice(before);
  };
  const ALT_ENTER: Sent[] = [{ type: "keys", keys: ["alt+enter"] }];
  const requestsOf = (text: string) => model.requests.filter((request) => request === text).length;

  for (const [label, machine] of [["local", null], ["remote", "remote"]] as const) {
    await open(label, machine === null ? null : remoteId);
    const steps: Record<string, unknown> = {};
    result[label] = steps;

    // idle: Alt+Enter submits the line once, as Enter would
    const idle = `${label}-idle-alt-enter`;
    await type(idle);
    const idleFrames = await press("Alt+Enter");
    steps["idleFrames"] = idleFrames;
    await until(() => requestsOf(idle) > 0, `${label}: idle Alt+Enter submits ${idle} (frames ${JSON.stringify(idleFrames)})`, 10_000).catch(async (error) => {
      await page.screenshot({ path: join(evidence, `${label}-idle-not-submitted.png`) });
      steps["idleScreen"] = await screenText();
      throw error;
    });
    await shows(`answered ${idle}`, `${label}: pi shows the idle answer`);
    assert.deepEqual(idleFrames, ALT_ENTER, `${label}: one Alt+Enter is one alt+enter key, with no ESC CR beside it`);
    assert.equal(requestsOf(idle), 1, `${label}: the idle line is submitted once`);

    // answering: Alt+Enter queues a follow-up, which pi sends only after the answer ends
    const first = `${label}-first-turn`;
    const followUp = `${label}-follow-up`;
    model.hold(first);
    await type(first);
    assert.deepEqual(await press("Enter"), [{ type: "input", text: "\r" }], `${label}: Enter is still a plain CR`);
    await until(() => requestsOf(first) === 1, `${label}: pi asks the model for ${first}`);
    await shows("holding", `${label}: pi is answering`);
    await type(followUp);
    const followFrames = await press("Alt+Enter");
    steps["followUpFrames"] = followFrames;
    await shows(`Follow-up: ${followUp}`, `${label}: pi queues ${followUp} as a follow-up (frames ${JSON.stringify(followFrames)})`, 10_000).catch(async (error) => {
      await page.screenshot({ path: join(evidence, `${label}-follow-up-not-queued.png`) });
      steps["followUpScreen"] = await screenText();
      throw error;
    });
    await page.screenshot({ path: join(evidence, `${label}-follow-up-queued.png`) });
    assert.deepEqual(followFrames, ALT_ENTER, `${label}: one Alt+Enter while answering is one alt+enter key`);
    // fixed wait: proves that pi sends no request for the follow-up in this time
    await page.waitForTimeout(NO_REQUEST_WAIT_MS);
    assert.equal(requestsOf(followUp), 0, `${label}: the follow-up waits for the answer`);
    model.release(first);
    await until(() => requestsOf(followUp) === 1, `${label}: pi sends the follow-up after the answer`);
    await shows(`answered ${followUp}`, `${label}: pi shows the follow-up's answer`);
    await page.screenshot({ path: join(evidence, `${label}-follow-up-answered.png`) });
    // fixed wait: proves that pi sends no request for the follow-up in this time
    await page.waitForTimeout(NO_REQUEST_WAIT_MS);
    assert.equal(requestsOf(followUp), 1, `${label}: the follow-up is sent once`);

    // Shift+Enter still breaks pi's line, and Enter submits both lines as one message
    const lines = [`${label}-line-one`, `${label}-line-two`];
    await type(lines[0]!);
    assert.deepEqual(await press("Shift+Enter"), [{ type: "input", text: "\x1b\r" }], `${label}: Shift+Enter keeps its newline chord`);
    await type(lines[1]!);
    await press("Enter");
    await until(() => model.requests.includes(lines.join("\n")), `${label}: Shift+Enter broke the line and Enter sent both lines once`);
    await shows(`answered ${lines.join(" ")}`, `${label}: pi shows the two-line answer`);
    console.log(`PASS ${label}: Alt+Enter submits an idle line and queues a follow-up while pi answers; Shift+Enter breaks the line`);
  }

  result["modelRequests"] = model.requests;
  assert.deepEqual(model.requests, ["local", "remote"].flatMap((label) => [
    `${label}-idle-alt-enter`, `${label}-first-turn`, `${label}-follow-up`, `${label}-line-one\n${label}-line-two`,
  ]), "the model is asked once per message, in order");
  assert.deepEqual(errors, [], "no page errors");
  await paneSendKeys(pane, ["ctrl+c"]).catch(() => {});
  await paneSendKeys(pane, ["ctrl+c"]).catch(() => {});
  result["herdr"] = Bun.spawnSync([process.env["OVIS_HERDR_BIN"] || "herdr", "--version"]).stdout.toString().trim();
  result["pi"] = Bun.spawnSync(["pi", "--version"]).stdout.toString().trim();
  result["status"] = "passed";
  writeFileSync(join(evidence, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.log(`pi Alt+Enter regression passed; evidence in ${evidence}`);
} catch (error) {
  await failurePage?.screenshot({ path: join(evidence, "failure.png") }).catch(() => {});
  result["status"] = `failed: ${error instanceof Error ? error.message : String(error)}`;
  writeFileSync(join(evidence, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  throw error;
} finally {
  for (const stop of stops) { try { stop(); } catch { /* already gone */ } }
  Object.assign(SshConnection.prototype, real);
  if (workspaceId) await workspaceClose(workspaceId).catch(() => {});
  // the agent directory and project go; screenshots and result.json stay only in PI_ALT_ENTER_EVIDENCE_DIR
  rmSync(root, { recursive: true, force: true });
}
