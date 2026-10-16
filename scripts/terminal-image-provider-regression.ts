/**
 * Pi's inline images for the tool call ids real providers give, end to end (docs/terminal-images.md).
 * Run after a build:
 *
 *   PI_IMAGES_PACKAGE=/path/to/oh-my-pi-extensions \
 *     bun run check run --build bun scripts/terminal-image-provider-regression.ts
 *
 * What is real here: pi (1.3.x) itself, started fresh in an owned pane of the test herdr session
 * (scripts/test-herdr.ts) at its default image width; its OpenAI Responses client, which builds the
 * tool call ids it stores (`${call_id}|${item id}`, such as `call_…|fc_…`); its `read` tool opening
 * PNG and JPEG files and its `bash` tool; the session file pi writes; the pi images extension, loaded
 * the way an installed package is (a `packages` entry in pi's settings naming PI_IMAGES_PACKAGE,
 * filtered to `images/src/index.ts` when that is an oh-my-pi-extensions checkout) and loaded again
 * by pi's `/reload`; herdr's pi integration (HERDR_PI_INTEGRATION, by default the file herdr installed
 * in ~/.pi/agent/extensions); this build in Chromium, against this server and against a second
 * server as a remote PC's bridge. All read-only.
 *
 * What is simulated: the model (scripts/fixtures/responses-provider.ts: a loopback server speaking
 * the Responses streaming API with a dummy key, which asks for the reads with chosen `call_id`s and
 * item ids; no account, credential or network), and the SSH forward to the remote PC (loopback; not
 * real SSH). The pane drops every credential-looking variable before pi starts.
 *
 * Checked: the browser is on the terminal before pi reads anything; each picture is drawn at its
 * markers with its own pixels, here and through the remote PC, its image asked for by its composite
 * id; the chat and its whole-output link answer for those ids, here and through the PC; after
 * `/reload` (the extension loaded anew, its index rebuilt from the session file) the pictures are
 * drawn again and a new read is drawn too. An id with `!'()*` in its item id is drawn when
 * PI_IMAGES_PUNCTUATION=1 (an extension that escapes them, RFC 3986) and otherwise must draw
 * nothing. Evidence goes to TERMINAL_IMAGE_EVIDENCE_DIR or a temp dir. PI_TUI_MODE=regular too.
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { connect as tcpConnect, createServer as tcpServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import { BRIDGE_PROTOCOL, REMOTE_BUNDLE_VERSION, type Machine } from "../shared/machines.ts";
import type { ConversationResponse } from "../shared/protocol.ts";
import { createServer } from "../server/index.ts";
import { agentGet, paneSendKeys, paneSendText, sessionSnapshot, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { socketPath } from "../server/bridge.ts";
import { SshConnection } from "../server/ssh.ts";
import { chromePath } from "./chrome-path.ts";
import { responsesProvider, type ScriptedCall } from "./fixtures/responses-provider.ts";

if (process.env["HERDR_TEST_LIVE"] === "1") throw new Error("This regression refuses HERDR_TEST_LIVE=1");
const pkg = process.env["PI_IMAGES_PACKAGE"] ? resolve(process.env["PI_IMAGES_PACKAGE"]) : "";
if (!pkg || !existsSync(join(pkg, "package.json"))) throw new Error("Set PI_IMAGES_PACKAGE to the pi package holding the images extension (an oh-my-pi-extensions checkout, or the images package itself)");
const umbrella = existsSync(join(pkg, "images", "src", "index.ts"));
const integration = process.env["HERDR_PI_INTEGRATION"] || join(homedir(), ".pi", "agent", "extensions", "herdr-agent-state.ts");
if (!existsSync(integration)) throw new Error(`herdr's pi integration is not at ${integration}; set HERDR_PI_INTEGRATION`);
const mode = process.env["PI_TUI_MODE"] === "regular" ? "regular" : "fullscreen";
const punctuation = process.env["PI_IMAGES_PUNCTUATION"] === "1";

const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-provider-image-"));
const evidence = resolve(process.env["TERMINAL_IMAGE_EVIDENCE_DIR"] || join(root, "evidence"));
mkdirSync(evidence, { recursive: true });
const agentDir = join(root, "agent");
const project = join(root, "project");
mkdirSync(agentDir, { recursive: true });
mkdirSync(project, { recursive: true });

const until = async (test: () => boolean | Promise<boolean>, what: string, ms = 30_000) => {
  for (const end = Date.now() + ms; !(await test());) {
    if (Date.now() >= end) throw new Error(`Timed out: ${what}`);
    await Bun.sleep(50);
  }
};
const near = (a: readonly number[], b: readonly number[], tolerance = 60) => a.every((value, index) => Math.abs(value - b[index]!) <= tolerance);
const COLORS = { red: [224, 32, 32], blue: [32, 64, 224], green: [32, 176, 64], yellow: [224, 192, 32], magenta: [192, 32, 192], cyan: [32, 192, 192] } as const;

// the ids: what OpenAI Responses, Codex or Copilot hand pi (a `call_id` and an `fc_` item id), an
// Anthropic-style call id behind the same pipe, an item id RFC 3986 must escape, and after /reload one more
const KEY = "fixture-dummy-key";
const SESSION = "0190e2e0-0000-7000-8000-0000000e2e10";
const CALLS = {
  png: { callId: "call_E2E", itemId: "fc_0123abcd", name: "read", arguments: { path: "shot.png" } },
  jpeg: { callId: "toolu_01E2EsyntheticJpeg", itemId: "fc_4567cdef", name: "read", arguments: { path: "photo.jpg" } },
  punctuated: { callId: "call_test", itemId: "fc_(x)*!'", name: "read", arguments: { path: "punct.png" } },
  bash: { callId: "call_E2Ebash", itemId: "fc_0123bash", name: "bash", arguments: { command: "seq 1 3000" } },
  later: { callId: "call_E2Ereload", itemId: "fc_89ab0002", name: "read", arguments: { path: "later.png" } },
} satisfies Record<string, ScriptedCall>;
const idOf = (call: ScriptedCall) => `${call.callId}|${call.itemId}`;
const refOf = (call: ScriptedCall) => `pi:${idOf(call)}:0`;
const ROUND_ONE = { prompt: "fixture round one", done: "ROUND_ONE_FINISHED" };
const ROUND_TWO = { prompt: "fixture round two", done: "ROUND_TWO_FINISHED" };
/** Each picture's colour at a point of it (fractions of its size). */
const PICTURES: Record<string, (fx: number, fy: number) => readonly number[]> = {
  [refOf(CALLS.png)]: (fx) => fx < 0.5 ? COLORS.red : COLORS.blue,
  [refOf(CALLS.jpeg)]: (_fx, fy) => fy < 0.5 ? COLORS.green : COLORS.yellow,
  [refOf(CALLS.punctuated)]: () => COLORS.magenta,
  [refOf(CALLS.later)]: () => COLORS.cyan,
};

let workspaceId: string | undefined;
let failurePage: Page | undefined;
const stops: (() => void)[] = [];
const real = { start: SshConnection.prototype.start, run: SshConnection.prototype.run, close: SshConnection.prototype.close, forward: SshConnection.prototype.forward };
const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
const result: Record<string, unknown> = { mode, package: pkg, umbrella, integration, punctuation, actual: "pi, its Responses client and read/bash tools, the images extension as a package and after /reload, herdr's integration, herdr, this build, Chromium", simulated: "the model (loopback Responses server, dummy key) and the SSH forward (loopback)" };

try {
  const browser = await chromium.launch({ executablePath: chromePath(), headless: process.env["HEADED"] !== "1", args: ["--no-sandbox", "--no-proxy-server"] });
  stops.unshift(() => void browser.close());
  const context = await browser.newContext({ viewport: { width: 1600, height: 1400 }, locale: "en-US", deviceScaleFactor: 1 });
  const page = await context.newPage();
  failurePage = page;

  // the files pi reads: two-colour halves, so a sample tells which picture is drawn and which way up
  const files = await page.evaluate(() => {
    const draw = (width: number, height: number, type: string, paint: (ctx: CanvasRenderingContext2D) => void) => {
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      paint(canvas.getContext("2d")!);
      return canvas.toDataURL(type, 0.95).split(",")[1]!;
    };
    const fill = (colour: string) => (ctx: CanvasRenderingContext2D) => { ctx.fillStyle = colour; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height); };
    return {
      "shot.png": draw(320, 160, "image/png", (ctx) => { ctx.fillStyle = "rgb(224,32,32)"; ctx.fillRect(0, 0, 160, 160); ctx.fillStyle = "rgb(32,64,224)"; ctx.fillRect(160, 0, 160, 160); }),
      "photo.jpg": draw(240, 240, "image/jpeg", (ctx) => { ctx.fillStyle = "rgb(32,176,64)"; ctx.fillRect(0, 0, 240, 120); ctx.fillStyle = "rgb(224,192,32)"; ctx.fillRect(0, 120, 240, 120); }),
      "punct.png": draw(160, 96, "image/png", fill("rgb(192,32,192)")),
      "later.png": draw(160, 96, "image/png", fill("rgb(32,192,192)")),
    };
  });
  for (const [name, data] of Object.entries(files)) writeFileSync(join(project, name), Buffer.from(data, "base64"));

  // the model, and pi's own settings: only the images package, the fixture model, default image width
  const model = responsesProvider({
    [ROUND_ONE.prompt]: { calls: [CALLS.png, CALLS.jpeg, CALLS.punctuated, CALLS.bash], done: ROUND_ONE.done },
    [ROUND_TWO.prompt]: { calls: [CALLS.later], done: ROUND_TWO.done },
  }, KEY);
  stops.push(() => model.stop());
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { "fixture-responses": { baseUrl: model.url, api: "openai-responses", apiKey: KEY, models: [{ id: "fixture-vision", name: "Fixture vision", input: ["text", "image"], contextWindow: 200_000, maxTokens: 8192 }] } } }));
  const imagesPackage = umbrella ? { source: pkg, extensions: ["images/src/index.ts"], skills: [], prompts: [], themes: [] } : pkg;
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [imagesPackage], terminal: { showImages: true } }));
  const launcher = join(root, "pi.sh");
  writeFileSync(launcher, [
    "# no credential of the account reaches pi: the fixture model takes a dummy key",
    "for name in $(env | sed -n 's/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p' | grep -Ei 'api_?key|token|secret|password|credential|auth'); do unset \"$name\" 2>/dev/null; done",
    `export PI_CODING_AGENT_DIR='${agentDir}' PI_OFFLINE=1`,
    `exec pi --offline --no-skills --no-prompt-templates --no-context-files --no-mcp -e '${integration}' --provider fixture-responses --model fixture-vision --session-id ${SESSION} --tui-mode ${mode}`,
    "",
  ].join("\n"));

  // this PC and a remote PC's bridge, as in scripts/terminal-image-regression.ts; both serve the test herdr
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  const bridgeToken = "d".repeat(64);
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

  const created = await workspaceCreate({ cwd: project, label: "herdr-web-ui-test-provider-image" });
  workspaceId = created.workspace.workspace_id;
  const pane = created.root_pane.pane_id;

  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  /** every image the page asked for: path and query, and the answer's status and session echo */
  const imageAnswers: { url: string; status: number; session: string | null }[] = [];
  page.on("response", (response) => {
    if (!response.url().includes("/conversation/image")) return;
    const url = new URL(response.url());
    imageAnswers.push({ url: url.pathname + url.search, status: response.status(), session: response.headers()["x-herdr-pi-session"] ?? null });
  });
  await page.addInitScript((id) => {
    localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" }));
    localStorage.setItem(`herdr-web-ui:view:${id}`, "terminal");
  }, pane);

  /** what the image layer draws, read against the terminal's own text rows */
  const drawn = () => page.evaluate(() => {
    const rows = [...document.querySelectorAll(".pane-terminal .xterm-rows > div")].map((row) => [...(row.textContent ?? "")]);
    return [...document.querySelectorAll<HTMLElement>(".pane-terminal .terminal-image")].map((box) => {
      const [left, top, cols, height, firstRow, lastRow] = box.dataset["cells"]!.split(",").map(Number) as [number, number, number, number, number, number];
      const img = box.querySelector("img")!;
      const rect = img.getBoundingClientRect();
      const boxRect = box.getBoundingClientRect();
      const scale = Math.min(rect.width / img.naturalWidth, rect.height / img.naturalHeight);
      const span = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
      return {
        ref: box.dataset["ref"]!, left, top, cols, rows: height, firstRow, lastRow,
        loaded: img.complete && img.naturalWidth > 0,
        // the marker cell right of the image on each visible row after the first (the image line)
        markers: span(firstRow + 1, lastRow).every((row) => rows[row]?.[left + cols] === "\u2800"),
        // the cells under the image hold no text
        blank: span(firstRow, lastRow).every((row) => (rows[row] ?? []).slice(left, left + cols).join("").trim() === ""),
        box: { x: boxRect.x, y: boxRect.y, width: boxRect.width, height: boxRect.height },
        picture: { x: rect.x, y: rect.y, width: img.naturalWidth * scale, height: img.naturalHeight * scale },
      };
    });
  });
  type Drawn = Awaited<ReturnType<typeof drawn>>[number];
  const colourAt = async (x: number, y: number): Promise<number[]> => {
    const shot = await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 } });
    return page.evaluate(async (data) => {
      const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = 1; canvas.height = 1;
      const ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0);
      return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    }, shot.toString("base64"));
  };
  /**
   * Whether a drawn image sits left of its markers over blank cells and shows its own picture where
   * its visible rows meet it: sampled left and right of centre, away from a halfway line. Null when
   * too little of it is visible to tell.
   */
  const imageOk = async (image: Drawn): Promise<boolean | null> => {
    const colour = PICTURES[image.ref];
    if (!colour) return false;
    const from = Math.max(image.box.y, image.picture.y), to = Math.min(image.box.y + image.box.height, image.picture.y + image.picture.height);
    if (to - from < 6 || !image.loaded) return null;
    const half = image.picture.y + image.picture.height / 2;
    const [a, b] = from < half && to > half ? (half - from > to - half ? [from, half] : [half, to]) : [from, to];
    const y = (a! + b!) / 2, fy = (y - image.picture.y) / image.picture.height;
    for (const fx of [0.25, 0.75]) {
      if (!near(await colourAt(image.picture.x + image.picture.width * fx, y), colour(fx, fy))) return false;
    }
    return image.markers && image.blank;
  };
  /** The images drawn once they have held still for 300 ms (herdr may still be redrawing). */
  const settled = async (what: string, expect: (images: Drawn[]) => boolean = () => true) => {
    let images: Drawn[] = [], previous = "", since = Date.now();
    await until(async () => {
      images = await drawn();
      const key = JSON.stringify(images.map(({ ref, left, top, firstRow, lastRow, box }) => [ref, left, top, firstRow, lastRow, box]));
      if (key !== previous) { previous = key; since = Date.now(); }
      return images.every((image) => image.loaded) && expect(images) && Date.now() - since >= 300;
    }, what);
    return images;
  };
  /**
   * Checks every picture `refs` names, scrolling pi's transcript back as far as needed: each is drawn
   * at its markers with its own pixels somewhere on the way. Ends back at the bottom.
   */
  const verify = async (label: string, refs: string[]) => {
    const ok = new Set<string>();
    const seen: Record<string, number> = {};
    await page.locator(".pane-terminal .xterm-screen").first().hover();
    for (let step = 0; step < 60 && ok.size < refs.length; step++) {
      const images = await settled(`${label}: the images hold still`);
      for (const image of images) {
        assert.ok(image.ref in PICTURES, `${label}: only the session's pictures are drawn (${image.ref})`);
        seen[image.ref] = (seen[image.ref] ?? 0) + 1;
        const fine = await imageOk(image);
        if (fine === false) assert.fail(`${label}: ${image.ref} at rows ${image.firstRow}-${image.lastRow} is not its picture over its markers`);
        if (fine && refs.includes(image.ref)) ok.add(image.ref);
      }
      if (ok.size === refs.length) break;
      if (step === 0) await page.screenshot({ path: join(evidence, `${label}-bottom.png`) });
      for (let i = 0; i < 2; i++) await page.mouse.wheel(0, -360);
    }
    await page.screenshot({ path: join(evidence, `${label}.png`) });
    for (let i = 0; i < 60; i++) await page.mouse.wheel(0, 600);
    result[label] = { verified: [...ok], seen };
    assert.deepEqual([...ok].sort(), [...refs].sort(), `${label}: every picture is drawn with its own pixels`);
  };
  const askedFor = (call: ScriptedCall, prefix: string) => imageAnswers.filter((answer) => answer.url.startsWith(prefix) && new URL(answer.url, base).searchParams.get("ref") === refOf(call));

  // 1. pi starts fresh in the pane; the browser is on its terminal before anything is read
  await paneSendText(pane, `sh ${launcher}`);
  await paneSendKeys(pane, ["Enter"]);
  await until(async () => (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === pane)?.agent === "pi", "herdr sees pi in the pane");
  await until(async () => typeof (await agentGet(pane).catch(() => null))?.agent_session?.value === "string", "the pane's pi session is reported");
  await page.goto(`${base}/?pane=${encodeURIComponent(pane)}&view=terminal`);
  await page.locator(".conn-live").first().waitFor();
  await page.getByText("fixture-vision").first().waitFor({ timeout: 30_000 });
  assert.equal((await drawn()).length, 0, "nothing is drawn before pi reads");

  // 2. the model asks for the reads; pi stores its own composite ids; the pictures appear as pi draws them
  await paneSendText(pane, ROUND_ONE.prompt);
  await paneSendKeys(pane, ["Enter"]);
  await page.getByText(ROUND_ONE.done).first().waitFor({ timeout: 60_000 });
  const sessionPath = (await agentGet(pane)).agent_session!.value as string;
  result["sessionFile"] = sessionPath.replace(root, "<root>");
  const records = readFileSync(sessionPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string; id?: string; message?: { role?: string; toolCallId?: string; content?: { type: string; mimeType?: string }[] } });
  assert.equal(records[0]?.id, SESSION, "pi wrote the session it was started with");
  const stored = records.filter((record) => record.message?.role === "toolResult").map((record) => [record.message!.toolCallId, record.message!.content!.filter((part) => part.type === "image").map((part) => part.mimeType)]);
  result["storedResults"] = stored;
  assert.deepEqual(stored, [[idOf(CALLS.png), ["image/png"]], [idOf(CALLS.jpeg), ["image/jpeg"]], [idOf(CALLS.punctuated), ["image/png"]], [idOf(CALLS.bash), []]], "pi stored the provider's composite ids and the read tool's PNG and JPEG");
  const roundOne = [refOf(CALLS.png), refOf(CALLS.jpeg), ...(punctuation ? [refOf(CALLS.punctuated)] : [])];
  await verify("1-local", roundOne);
  for (const call of [CALLS.png, CALLS.jpeg]) {
    const answers = askedFor(call, "/api/pane/conversation/image?");
    assert.ok(answers.some((answer) => answer.status === 200 && answer.session === SESSION && answer.url.includes(`session=${SESSION}`)), `${refOf(call)} is asked of this PC by its own ref, with the marker's session`);
  }
  assert.ok(imageAnswers.some((answer) => answer.url.includes("ref=pi%3Acall_E2E%7Cfc_0123abcd%3A0")), "the pipe travels percent-encoded");
  if (!punctuation) assert.equal(askedFor(CALLS.punctuated, "/").length, 0, "no marker, no request, for an id this extension cannot escape");

  // 3. the chat: the page's refs and the whole-output link answer for the composite ids, here and through the PC
  const digests = new Map<string, string>();
  for (const answer of imageAnswers) {
    const query = new URL(answer.url, base).searchParams;
    if (answer.status === 200) digests.set(query.get("ref")!, query.get("digest")!);
  }
  for (const prefix of ["/api", `/api/machines/${encodeURIComponent(remoteId)}`]) {
    const conversation = await (await fetch(`${base}${prefix}/pane/conversation?pane_id=${encodeURIComponent(pane)}`)).json() as ConversationResponse;
    const tools = conversation.turns.flatMap((turn) => turn.parts).filter((part) => part.kind === "tool");
    for (const call of [CALLS.png, CALLS.jpeg, CALLS.punctuated]) {
      const tool = tools.find((part) => part.kind === "tool" && part.images?.[0]?.ref === refOf(call));
      assert.ok(tool && tool.kind === "tool", `${prefix}: the chat shows ${idOf(call)}'s picture by its own ref`);
      const image = await fetch(`${base}${prefix}/pane/conversation/image?${new URLSearchParams({ pane_id: pane, ref: tool.images![0]!.ref })}`);
      assert.equal(image.status, 200, `${prefix}: the chat's picture of ${idOf(call)} answers`);
      const bytes = Buffer.from(await image.arrayBuffer());
      assert.equal(image.headers.get("content-type"), call === CALLS.jpeg ? "image/jpeg" : "image/png");
      const digest = digests.get(refOf(call));
      if (digest) assert.equal(new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 32), digest, `${prefix}: the chat's bytes are the ones the marker named`);
    }
    const bash = tools.find((part) => part.kind === "tool" && part.output_ref === idOf(CALLS.bash));
    assert.ok(bash, `${prefix}: the cut bash output links its whole output by the composite id`);
    const output = await fetch(`${base}${prefix}/pane/conversation/tool-output?${new URLSearchParams({ pane_id: pane, ref: idOf(CALLS.bash) })}`);
    assert.equal(output.status, 200, `${prefix}: the whole output answers`);
    assert.ok((await output.text()).includes("\n3000"), `${prefix}: and it is whole`);
  }
  result["chat"] = "images and whole output answered locally and through the PC";

  // 4. the remote PC's terminal: same pane and session through its bridge; asked of that PC
  const remotePrefix = `/api/machines/${encodeURIComponent(remoteId)}/pane/conversation/image?`;
  await page.goto(`${base}/?machine=${encodeURIComponent(remoteId)}&pane=${encodeURIComponent(pane)}&view=terminal`);
  await page.locator(".conn-live").first().waitFor();
  await verify("2-remote", roundOne);
  for (const call of [CALLS.png, CALLS.jpeg]) assert.ok(askedFor(call, remotePrefix).some((answer) => answer.status === 200 && answer.session === SESSION), `${refOf(call)} is asked of the remote PC and answered with its session`);

  // 5. /reload: the extension is loaded anew and indexes the session file; pi redraws the transcript
  await page.goto(`${base}/?pane=${encodeURIComponent(pane)}&view=terminal`);
  await page.locator(".conn-live").first().waitFor();
  await paneSendText(pane, "/reload");
  await paneSendKeys(pane, ["Enter"]);
  await page.getByText("Reloaded keybindings").first().waitFor({ timeout: 30_000 });
  await verify("3-after-reload", roundOne);

  // 6. a read after /reload: drawn here and through the PC
  await paneSendText(pane, ROUND_TWO.prompt);
  await paneSendKeys(pane, ["Enter"]);
  await page.getByText(ROUND_TWO.done).first().waitFor({ timeout: 60_000 });
  await verify("4-local-after-reload", [refOf(CALLS.later)]);
  assert.ok(askedFor(CALLS.later, "/api/pane/conversation/image?").some((answer) => answer.status === 200), "the read after /reload is asked of this PC and answered");
  await page.goto(`${base}/?machine=${encodeURIComponent(remoteId)}&pane=${encodeURIComponent(pane)}&view=terminal`);
  await page.locator(".conn-live").first().waitFor();
  await verify("5-remote-after-reload", [refOf(CALLS.later), ...roundOne]);
  assert.ok(askedFor(CALLS.later, remotePrefix).some((answer) => answer.status === 200), "and of the remote PC");

  // 7. the model was only ever the fixture, asked with the dummy key, once per step
  result["modelRequests"] = model.requests;
  assert.ok(model.requests.every((request) => request.authorized && request.path === "/v1/responses"), "pi asked only the fixture model, with its dummy key");
  assert.deepEqual(model.requests.map((request) => [request.prompt, request.outputs]), [[ROUND_ONE.prompt, 0], [ROUND_ONE.prompt, 1], [ROUND_ONE.prompt, 2], [ROUND_ONE.prompt, 3], [ROUND_ONE.prompt, 4], [ROUND_TWO.prompt, 0], [ROUND_TWO.prompt, 1]]);
  if (!punctuation) assert.equal(askedFor(CALLS.punctuated, "/").length, 0, "the unescaped punctuation never drew");

  await paneSendText(pane, "/quit");
  await paneSendKeys(pane, ["Enter"]);
  await until(async () => (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === pane)?.agent !== "pi", "pi quits");
  assert.deepEqual(errors, [], "no page errors");
  result["imageAnswers"] = imageAnswers.length;
  result["refusedAnswers"] = imageAnswers.filter((answer) => answer.status !== 200).map((answer) => ({ ...answer, url: answer.url.replace(/digest=[0-9a-f]+/, "digest=…") }));
  result["herdr"] = Bun.spawnSync([process.env["HERDR_WEB_HERDR_BIN"] || "herdr", "--version"]).stdout.toString().trim();
  result["pi"] = Bun.spawnSync(["pi", "--version"]).stdout.toString().trim();
  result["status"] = "passed";
  writeFileSync(join(evidence, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.log(`terminal image provider-id regression passed (${mode}); evidence in ${evidence}`);
} catch (error) {
  await failurePage?.screenshot({ path: join(evidence, "failure.png") }).catch(() => {});
  result["status"] = `failed: ${error instanceof Error ? error.message : String(error)}`;
  writeFileSync(join(evidence, "result.json"), JSON.stringify(result, null, 2));
  throw error;
} finally {
  for (const stop of stops) { try { stop(); } catch { /* already gone */ } }
  Object.assign(SshConnection.prototype, real);
  if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"]; else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
  if (workspaceId) await workspaceClose(workspaceId).catch(() => {});
}
