/**
 * Pi's inline images in the web terminal, end to end (docs/terminal-images.md). Run after a build:
 *
 *   PI_IMAGES_EXTENSION=/path/to/oh-my-pi-extensions/images/src/index.ts \
 *     bun run check run --build bun scripts/terminal-image-regression.ts
 *
 * A real `pi` (1.3.x) runs in an owned pane of the test herdr session (scripts/test-herdr.ts) with
 * its own PI_CODING_AGENT_DIR, `--no-extensions`, and only two extensions: the pi images extension
 * named by PI_IMAGES_EXTENSION (it writes the image markers) and herdr's pi integration
 * (HERDR_PI_INTEGRATION, by default the file herdr installed in ~/.pi/agent/extensions; it reports
 * the session file to the test herdr, as in real use). Both are loaded read-only. Pi resumes a
 * session file made here, whose tool results hold pictures generated in the browser, so no model,
 * network or user file is involved. The browser is this build against this server, and against a
 * second server as a remote PC's bridge behind a fake SSH forward (loopback; not real SSH).
 *
 * Checked: images drawn at their markers over blank rows only, with their own pixels, locally and
 * through the remote PC; after a resize, a scroll, a reload; gone when pi leaves the screen;
 * forged markers draw nothing; a later session that reuses the same tool call id shows its own
 * picture. A click on any drawn image (its first row, its last, a clipped one's first visible row,
 * a one-row image; after a resize and a scroll) opens it in the image viewer with its own bytes to
 * download; pasted pictures (transcript and draft) are drawn from their files, and image comments
 * are saved, reopened, and added to the message draft only, which the chat lens's message box
 * then shows (from the terminal lens and the chat lens) without sending it. Evidence (screenshots, result.json) goes to TERMINAL_IMAGE_EVIDENCE_DIR or a temp dir.
 * PI_TUI_MODE picks pi's TUI mode (fullscreen by default, or regular).
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { connect as tcpConnect, createServer as tcpServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page, type WebSocketRoute } from "playwright-core";
import { BRIDGE_PROTOCOL, REMOTE_BUNDLE_VERSION, type Machine } from "../shared/machines.ts";
import { createServer } from "../server/index.ts";
import { agentGet, herdrRpc, paneProcessInfo, paneSendKeys, paneSendText, sessionSnapshot, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { socketPath } from "../server/bridge.ts";
import { SshConnection } from "../server/ssh.ts";
import { chromePath } from "./chrome-path.ts";

if (process.env["HERDR_TEST_LIVE"] === "1") throw new Error("This regression refuses HERDR_TEST_LIVE=1");
const extension = process.env["PI_IMAGES_EXTENSION"];
if (!extension || !existsSync(extension)) throw new Error("Set PI_IMAGES_EXTENSION to the pi images extension's src/index.ts (it writes the terminal image markers)");
const integration = process.env["HERDR_PI_INTEGRATION"] || join(homedir(), ".pi", "agent", "extensions", "herdr-agent-state.ts");
if (!existsSync(integration)) throw new Error(`herdr's pi integration is not at ${integration}; set HERDR_PI_INTEGRATION`);
const mode = process.env["PI_TUI_MODE"] === "regular" ? "regular" : "fullscreen";

const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-terminal-image-"));
const evidence = resolve(process.env["TERMINAL_IMAGE_EVIDENCE_DIR"] || join(root, "evidence"));
mkdirSync(evidence, { recursive: true });
const agentDir = join(root, "agent");
const project = join(root, "project");
const store = join(agentDir, "sessions", `--${project.replaceAll("/", "-")}--`);
mkdirSync(store, { recursive: true });
mkdirSync(project, { recursive: true });
// small pictures keep every image on one screen; pi reads its settings from its own agent dir only
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ terminal: { imageWidthCells: 16, showImages: true } }));

const until = async (test: () => boolean | Promise<boolean>, what: string, ms = 20_000) => {
  for (const end = Date.now() + ms; !(await test());) {
    if (Date.now() >= end) throw new Error(`Timed out: ${what}`);
    await Bun.sleep(50);
  }
};
const near = (a: readonly number[], b: readonly number[], tolerance = 40) => a.every((value, index) => Math.abs(value - b[index]!) <= tolerance);
const COLORS = { red: [224, 32, 32], blue: [32, 64, 224], green: [32, 176, 64], yellow: [224, 192, 32], magenta: [192, 32, 192] } as const;

/** A pi session file: a header, then a user prompt and the tool calls whose results hold the pictures. */
function sessionFile(id: string, pictures: { call: string; type: string; data: string }[]): string {
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const assistant = (content: unknown[], stopReason: string) => ({ role: "assistant", content, api: "fixture", provider: "fixture", model: "fixture", usage, stopReason, timestamp: 2 });
  const entries: unknown[] = [{ type: "session", version: 3, id, timestamp: "2026-10-16T00:00:00.000Z", cwd: project }];
  let parent: string | null = null;
  const push = (message: unknown) => {
    const entryId = `e${entries.length}`;
    entries.push({ type: "message", id: entryId, parentId: parent, timestamp: "2026-10-16T00:00:01.000Z", message });
    parent = entryId;
  };
  push({ role: "user", content: [{ type: "text", text: "Show me the pictures." }], timestamp: 1 });
  for (const picture of pictures) {
    push(assistant([{ type: "toolCall", id: picture.call, name: "read", arguments: { path: `${picture.call}.img` } }], "toolUse"));
    push({ role: "toolResult", toolCallId: picture.call, toolName: "read", content: [{ type: "text", text: `Read image file [${picture.type}]` }, { type: "image", mimeType: picture.type, data: picture.data }], isError: false, timestamp: 3 });
  }
  push(assistant([{ type: "text", text: "TERMINAL_IMAGE_FIXTURE_END" }], "stop"));
  return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

let workspaceId: string | undefined;
let failurePage: Page | undefined;
const stops: (() => void)[] = [];
const real = { start: SshConnection.prototype.start, run: SshConnection.prototype.run, close: SshConnection.prototype.close, forward: SshConnection.prototype.forward };
const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
const result: Record<string, unknown> = { mode, extension, integration };

try {
  const browser = await chromium.launch({ executablePath: chromePath(), headless: process.env["HEADED"] !== "1", args: ["--no-sandbox", "--no-proxy-server"] });
  stops.unshift(() => void browser.close());
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, locale: "en-US", deviceScaleFactor: 1 });
  const page = await context.newPage();
  failurePage = page;

  // the pictures: two-colour halves, so a sample tells which picture is drawn and which way up
  const pictures = await page.evaluate(() => {
    const draw = (width: number, height: number, type: string, paint: (ctx: CanvasRenderingContext2D) => void) => {
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      paint(canvas.getContext("2d")!);
      return canvas.toDataURL(type, 0.95).split(",")[1]!;
    };
    const halves = (a: string, b: string, vertical: boolean) => (ctx: CanvasRenderingContext2D) => {
      const { width, height } = ctx.canvas;
      ctx.fillStyle = a; ctx.fillRect(0, 0, vertical ? width : width / 2, vertical ? height / 2 : height);
      ctx.fillStyle = b; ctx.fillRect(vertical ? 0 : width / 2, vertical ? height / 2 : 0, vertical ? width : width / 2, vertical ? height / 2 : height);
    };
    return {
      redBlue: draw(320, 160, "image/png", halves("rgb(224,32,32)", "rgb(32,64,224)", false)),
      greenYellow: draw(160, 160, "image/jpeg", halves("rgb(32,176,64)", "rgb(224,192,32)", true)),
      magenta: draw(96, 64, "image/png", (ctx) => { ctx.fillStyle = "rgb(192,32,192)"; ctx.fillRect(0, 0, 96, 64); }),
      // the viewer step's pictures: two pasted files and a strip pi draws in one row
      pasted: draw(200, 120, "image/png", halves("rgb(192,32,192)", "rgb(32,176,64)", false)),
      draft: draw(120, 200, "image/png", halves("rgb(32,64,224)", "rgb(224,192,32)", true)),
      strip: draw(640, 24, "image/png", (ctx) => { ctx.fillStyle = "rgb(224,192,32)"; ctx.fillRect(0, 0, 640, 24); }),
    };
  });
  const SESSION = "0190e2e0-0000-7000-8000-00000000e2e0";
  const LATER = "0190e2e0-0000-7000-8000-00000000e2e1";
  const first = join(store, "first.jsonl");
  const later = join(store, "later.jsonl");
  writeFileSync(first, sessionFile(SESSION, [
    { call: "call_e2e_a", type: "image/png", data: pictures.redBlue },
    { call: "call_e2e_b", type: "image/jpeg", data: pictures.greenYellow },
    // the same picture again under another tool call: a second image
    { call: "call_e2e_c", type: "image/png", data: pictures.redBlue },
  ]));
  // a later session in the same pane reuses the first tool call id for another picture
  writeFileSync(later, sessionFile(LATER, [{ call: "call_e2e_a", type: "image/png", data: pictures.magenta }]));

  // this PC and a remote PC's bridge, as in scripts/pi-visual-gui-view-qa.ts; both serve the test herdr
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

  const created = await workspaceCreate({ cwd: project, label: "herdr-web-ui-test-terminal-image" });
  workspaceId = created.workspace.workspace_id;
  const pane = created.root_pane.pane_id;
  const startPi = async (file: string) => {
    await paneSendText(pane, `PI_CODING_AGENT_DIR=${agentDir} PI_OFFLINE=1 pi --offline --no-extensions --no-skills --no-prompt-templates --no-context-files --no-mcp -e ${extension} -e ${integration} --tui-mode ${mode} --session ${file}`);
    await paneSendKeys(pane, ["Enter"]);
    await until(async () => (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === pane)?.agent === "pi", "herdr sees pi in the pane");
    // herdr's integration reports the session file: the server finds the pane's pictures through it
    await until(async () => (await agentGet(pane).catch(() => null))?.agent_session?.value === file, "the pane's pi session is reported");
  };
  const quitPi = async () => {
    await paneSendText(pane, "/quit");
    await paneSendKeys(pane, ["Enter"]);
    await until(async () => (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === pane)?.agent !== "pi", "pi quits");
  };

  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const imageRequests: string[] = [];
  // the terminal layer's own reads (bound by a digest); the image viewer's are the chat's, checked apart
  page.on("request", (request) => { if (request.url().includes("/conversation/image") && new URL(request.url()).searchParams.has("digest")) imageRequests.push(new URL(request.url()).pathname + new URL(request.url()).search); });
  await page.addInitScript((id) => {
    localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" }));
    localStorage.setItem(`herdr-web-ui:view:${id}`, "terminal");
  }, pane);
  // the page's socket, passed through to the server, so a test can drop it (a real reconnect)
  let liveSocket: WebSocketRoute | null = null;
  // and every terminal byte herdr sends is tallied: it should only place the cursor and write cells
  const moves: Record<string, number> = {};
  let ptyFrames = 0;
  // a message, input or request from the page that carries image feedback: there must never be one
  let sentFeedback = 0;
  page.on("request", (request) => { if ((request.postData() ?? "").includes("Please revise")) sentFeedback++; });
  await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => { if (String(message).includes("Please revise")) sentFeedback++; server.send(message); });
    server.onMessage((message) => {
      if (typeof message === "string" && message.includes('"pty-data"')) {
        const frame = JSON.parse(message) as { type?: string; data?: string };
        if (frame.type === "pty-data" && typeof frame.data === "string") {
          ptyFrames++;
          // a line feed, index, reverse index, scroll, inserted/deleted lines or characters, a scroll region
          for (const match of frame.data.matchAll(/\n|\x1b[DEM]|\x1b\[\d*[STLM@P]|\x1b\[\d*;?\d*r/g)) moves[JSON.stringify(match[0])] = (moves[JSON.stringify(match[0])] ?? 0) + 1;
        }
      }
      socket.send(message);
    });
    liveSocket = socket;
  });
  /** the terminal's text rows, as the browser shows them */
  const screenRows = () => page.evaluate(() => [...document.querySelectorAll(".pane-terminal .xterm-rows > div")].map((row) => [...(row.textContent ?? "")]));

  /** what the image layer draws, read against the terminal's own text rows */
  const drawn = () => page.evaluate(() => {
    const screen = document.querySelector(".pane-terminal .xterm-screen") as HTMLElement | null;
    const rows = [...document.querySelectorAll(".pane-terminal .xterm-rows > div")].map((row) => row.textContent ?? "");
    return [...document.querySelectorAll<HTMLElement>(".pane-terminal .terminal-image")].map((box) => {
      const [left, top, cols, height, firstRow, lastRow] = box.dataset["cells"]!.split(",").map(Number) as [number, number, number, number, number, number];
      const img = box.querySelector("img")!;
      const rect = img.getBoundingClientRect();
      const boxRect = box.getBoundingClientRect();
      const scale = Math.min(rect.width / img.naturalWidth, rect.height / img.naturalHeight);
      const chars = (row: number) => [...(rows[row] ?? "")];
      return {
        ref: box.dataset["ref"]!, left, top, cols, rows: height, firstRow, lastRow,
        loaded: img.complete && img.naturalWidth > 0,
        // the marker cell right of the image on each visible row after the first (the first may be
        // the image line, which carries none), and on some row at all
        markers: Array.from({ length: lastRow - firstRow }, (_, i) => firstRow + 1 + i).map((row) => chars(row)[left + cols] === "\u2800"),
        marked: Array.from({ length: lastRow - firstRow + 1 }, (_, i) => firstRow + i).some((row) => chars(row)[left + cols] === "\u2800"),
        // the cells under the image hold no text
        blank: Array.from({ length: lastRow - firstRow + 1 }, (_, i) => chars(firstRow + i).slice(left, left + cols).join("").trim() === ""),
        cell: screen ? { width: screen.clientWidth / Math.max(1, chars(0).length), height: screen.clientHeight / Math.max(1, rows.length) } : null,
        box: { x: boxRect.x, y: boxRect.y, width: boxRect.width, height: boxRect.height },
        picture: { x: rect.x, y: rect.y, width: img.naturalWidth * scale, height: img.naturalHeight * scale },
      };
    });
  });
  type Drawn = Awaited<ReturnType<typeof drawn>>;
  const colourAt = async (x: number, y: number): Promise<number[]> => {
    const shot = await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 } });
    return page.evaluate(async (data) => {
      const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = 1; canvas.height = 1;
      const ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0);
      return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    }, shot.toString("base64"));
  };
  /** colour at a point of the picture (fractions of its drawn size), when that point is visible */
  const sample = async (image: Drawn[number], fx: number, fy: number): Promise<number[] | null> => {
    const x = image.picture.x + image.picture.width * fx, y = image.picture.y + image.picture.height * fy;
    if (y < image.box.y || y >= image.box.y + image.box.height) return null;
    return colourAt(x, y);
  };
  /** what is drawn once it meets `expect` and has held still for 300 ms (herdr may still be redrawing) */
  const settled = async (expect: (images: Drawn) => boolean, what: string) => {
    let images: Drawn = [];
    let previous = "", since = Date.now();
    await until(async () => {
      images = await drawn();
      const key = JSON.stringify(images.map(({ ref, left, top, firstRow, lastRow, box }) => [ref, left, top, firstRow, lastRow, box]));
      if (key !== previous) { previous = key; since = Date.now(); }
      return images.every((image) => image.loaded) && expect(images) && Date.now() - since >= 300;
    }, what);
    return images;
  };
  const checkGeometry = (images: Drawn, label: string) => {
    for (const image of images) {
      assert.ok(image.marked && image.markers.every(Boolean), `${label}: ${image.ref} sits left of its marker cells`);
      assert.ok(image.blank.every(Boolean), `${label}: ${image.ref} covers no text`);
      assert.ok(image.cell && Math.abs(image.box.height - (image.lastRow - image.firstRow + 1) * image.cell.height) < 1, `${label}: ${image.ref} spans its visible rows`);
    }
  };
  const record = (name: string, images: Drawn) => { result[name] = images.map(({ ref, left, top, cols, rows, firstRow, lastRow }) => ({ ref, left, top, cols, rows, firstRow, lastRow })); };
  /**
   * Whether a drawn image shows its own picture (red|blue halves, or the JPEG's green over yellow)
   * where its visible rows meet the picture; null when they do not (a clipped image whose visible
   * rows are below the picture, drawn top-left in its cells).
   */
  const pictureOk = async (image: Drawn[number]): Promise<boolean | null> => {
    const jpeg = image.ref === "pi:call_e2e_b:0";
    const from = Math.max(image.box.y, image.picture.y), to = Math.min(image.box.y + image.box.height, image.picture.y + image.picture.height);
    if (to - from < 2) return null;
    // a point inside the visible part, away from the JPEG's halfway line
    const half = image.picture.y + image.picture.height / 2;
    const span = jpeg && from < half && to > half ? (half - from > to - half ? [from, half] : [half, to]) : [from, to];
    const y = (span[0]! + span[1]!) / 2;
    const colour = await colourAt(image.picture.x + image.picture.width * (jpeg ? 0.5 : 0.25), y);
    return near(colour, jpeg ? (y < half ? COLORS.green : COLORS.yellow) : COLORS.red, 60);
  };
  const allPicturesOk = async (images: Drawn, label: string) => {
    let seen = 0;
    for (const image of images) {
      const ok = await pictureOk(image);
      if (ok === null) continue;
      assert.ok(ok, `${label}: ${image.ref} at row ${image.firstRow} shows its picture`);
      seen++;
    }
    assert.ok(seen > 0, `${label}: some image's pixels are checked`);
  };
  /** The bytes each drawn ref shows (a tool image's fixture picture, a pasted picture's file). */
  const expectedBytes = new Map<string, Buffer>();
  const lightbox = page.locator(".image-lightbox");
  /**
   * A click on one visible row of a drawn image (its first by default: the image line, which carries no
   * marker, when it is on screen) opens that image in the image viewer, by the chat's URL for it: the
   * picture loads, and Download serves the same bytes. The cell right of the image's marker is not the
   * image. Returns the viewer's URL; the viewer is left open when `keepOpen`.
   */
  const opensOnClick = async (image: Drawn[number], label: string, row = 0, keepOpen = false): Promise<URL> => {
    assert.ok(image.cell, `${label}: the cell size is known`);
    const cell = image.cell!;
    // the drawn box is the image's own columns: the cell right of it (its marker) and the next are the terminal's
    const column = image.box.width / image.cols;
    const x = image.box.x + Math.min(image.box.width, Math.max(2, image.picture.width)) / 2;
    const y = image.box.y + (row + 0.5) * cell.height;
    const at = (px: number, py: number) => page.evaluate(([px, py]) => document.elementFromPoint(px!, py!)?.closest<HTMLElement>(".terminal-image")?.dataset["ref"] ?? null, [px, py]);
    assert.equal(await at(x, y), image.ref, `${label}: row ${image.firstRow + row} of ${image.ref} is the image under the pointer`);
    for (const next of [0.5, 1.5]) assert.equal(await at(image.box.x + image.box.width + next * column, y), null, `${label}: the cell ${next + 0.5} right of ${image.ref} is the terminal's`);
    await page.mouse.click(x, y);
    await lightbox.waitFor();
    await page.waitForFunction(() => { const img = document.querySelector<HTMLImageElement>(".image-lightbox img"); return img !== null && img.complete && img.naturalWidth > 0; }, undefined, { timeout: 10_000 });
    const src = new URL((await lightbox.locator("img").first().getAttribute("src"))!, base);
    const file = image.ref.startsWith("file:") ? image.ref.slice(5) : null;
    if (file === null) assert.equal(src.searchParams.get("ref"), image.ref, `${label}: the viewer shows ${image.ref} by the chat's URL`);
    else assert.equal(src.searchParams.get("path"), file, `${label}: the viewer shows the pasted file ${file}`);
    const download = lightbox.locator("a[download]");
    assert.equal(new URL((await download.getAttribute("href"))!, base).href, src.href, `${label}: Download is the shown picture`);
    const bytes = Buffer.from(await (await page.request.get(src.href)).body());
    const expected = expectedBytes.get(image.ref);
    assert.ok(expected && bytes.equals(expected), `${label}: Download serves ${image.ref}'s own bytes`);
    assert.equal(await lightbox.getByRole("button", { name: "Image comments" }).count(), 1, `${label}: the viewer offers image comments`);
    if (!keepOpen) {
      await lightbox.getByRole("button", { name: "Close", exact: true }).click();
      await lightbox.waitFor({ state: "detached" });
    }
    return src;
  };
  expectedBytes.set("pi:call_e2e_a:0", Buffer.from(pictures.redBlue, "base64"));
  expectedBytes.set("pi:call_e2e_b:0", Buffer.from(pictures.greenYellow, "base64"));
  expectedBytes.set("pi:call_e2e_c:0", Buffer.from(pictures.redBlue, "base64"));

  // 1. this PC: pi resumes the session; its three images are drawn where pi drew them natively
  await startPi(first);
  await page.goto(`${base}/?pane=${encodeURIComponent(pane)}&view=terminal`);
  await page.locator(".conn-live").first().waitFor();
  await page.getByText("TERMINAL_IMAGE_FIXTURE_END").first().waitFor();
  let images = await settled((list) => list.length === 3, "three images drawn on this PC");
  checkGeometry(images, "local");
  record("local", images);
  // top to bottom: red|blue, the green/yellow JPEG, red|blue again (pi names identical bytes by
  // the newest ref, so the repeat may carry the same ref: it is still drawn in both places)
  const [a, b, c] = [...images].sort((x, y) => x.top - y.top) as [Drawn[number], Drawn[number], Drawn[number]];
  assert.ok(near((await sample(a, 0.25, 0.5))!, COLORS.red), "the first picture's left half is red");
  assert.ok(near((await sample(a, 0.75, 0.5))!, COLORS.blue), "and its right half blue");
  assert.ok(near((await sample(b, 0.5, 0.25))!, COLORS.green, 60), "the JPEG's top half is green");
  assert.ok(near((await sample(b, 0.5, 0.75))!, COLORS.yellow, 60), "and its bottom half yellow");
  assert.ok(near((await sample(c, 0.25, 0.5))!, COLORS.red), "the repeated picture is drawn again in its own place");
  assert.equal(b.ref, "pi:call_e2e_b:0");
  // each opens in the image viewer from its first row (the image line, no marker) and its last
  for (const image of [a, b, c]) {
    assert.equal(image.firstRow, image.top, `${image.ref} shows its first row (the image line)`);
    await opensOnClick(image, "local");
    await opensOnClick(image, "local, last row", image.lastRow - image.firstRow);
  }
  assert.ok(images.every((image, i) => images.slice(i + 1).every((other) => other.top !== image.top)), "each image in its own place");
  await page.screenshot({ path: join(evidence, "1-local.png") });
  assert.ok(imageRequests.every((path) => path.startsWith("/api/pane/conversation/image?") && path.includes(`session=${SESSION}`)), "images are asked of this PC, for the marker's session");

  // 2. a narrower window: the grid is resized, herdr redraws it, the images follow pi's new layout
  await page.setViewportSize({ width: 1000, height: 900 });
  images = await settled((list) => list.length > 0 && list.every((image) => image.markers.every(Boolean)) && JSON.stringify(list.map((i) => [i.left, i.top])) !== JSON.stringify((result["local"] as Drawn).map((i) => [i.left, i.top])), "images follow a resize");
  checkGeometry(images, "resize");
  for (const image of images) {
    await opensOnClick(image, "resize");
    await opensOnClick(image, "resize, last row", image.lastRow - image.firstRow);
  }
  record("resized", images);
  await page.screenshot({ path: join(evidence, "2-resized.png") });

  // 3. scroll pi's transcript back: images move with their rows; an image cut at the top shows its lower part
  const beforeScroll = JSON.stringify((await drawn()).map((image) => [image.ref, image.top]));
  await page.locator(".pane-terminal .xterm-screen").first().hover();
  for (let i = 0; i < 6 && JSON.stringify((await drawn()).map((image) => [image.ref, image.top])) === beforeScroll; i++) {
    await page.mouse.wheel(0, -120);
    await Bun.sleep(400);
  }
  images = await settled((list) => list.length > 0 && JSON.stringify(list.map((image) => [image.ref, image.top])) !== beforeScroll, "images move when pi scrolls");
  checkGeometry(images, "scroll");
  await allPicturesOk(images, "scroll");
  // scrolled: each opens from its first visible row, a clipped one's included
  for (const image of images) await opensOnClick(image, `scroll (rows ${image.firstRow}-${image.lastRow} of ${image.top}+${image.rows})`);
  record("scrolled", images);
  result["scrolledClipped"] = images.some((image) => image.firstRow > image.top || image.lastRow < image.top + image.rows - 1);
  // scrolled until an image is cut at the screen's edge: it opens from its first and last visible rows
  const clippedOf = (list: Drawn) => list.find((image) => image.firstRow > image.top || image.lastRow < image.top + image.rows - 1);
  await page.locator(".pane-terminal .xterm-screen").first().hover();
  for (let i = 0; i < 12 && !clippedOf(images); i++) {
    const before = JSON.stringify(images.map((image) => [image.ref, image.top, image.firstRow, image.lastRow]));
    await page.mouse.wheel(0, i % 2 === 0 ? -40 : -120);
    images = await settled((list) => list.length > 0 && JSON.stringify(list.map((image) => [image.ref, image.top, image.firstRow, image.lastRow])) !== before, "images move when pi scrolls again").catch(() => images);
  }
  const clipped = clippedOf(images);
  assert.ok(clipped, "some image is cut at the screen's edge after scrolling");
  checkGeometry(images, "clipped");
  await opensOnClick(clipped, `clipped (rows ${clipped.firstRow}-${clipped.lastRow} of ${clipped.top}+${clipped.rows})`);
  await opensOnClick(clipped, "clipped, last visible row", clipped.lastRow - clipped.firstRow);
  record("clipped", [clipped]);
  await page.screenshot({ path: join(evidence, "3b-clipped.png") });
  // the wheel over a picture still scrolls the terminal (the picture takes clicks, not the wheel)
  const placed = (list: Drawn) => JSON.stringify(list.map((image) => [image.ref, image.top, image.firstRow, image.lastRow]));
  const beforeWheel = placed(images);
  await page.mouse.move(clipped.box.x + clipped.box.width / 2, clipped.box.y + Math.min(clipped.box.height, 4) / 2);
  assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest<HTMLElement>(".terminal-image")?.dataset["ref"] ?? null, { x: clipped.box.x + clipped.box.width / 2, y: clipped.box.y + Math.min(clipped.box.height, 4) / 2 }), clipped.ref, "the pointer is over the picture");
  await page.mouse.wheel(0, 240);
  images = await settled((list) => placed(list) !== beforeWheel, "a wheel over a picture scrolls the terminal");
  await page.screenshot({ path: join(evidence, "3-scrolled.png") });
  for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 240);
  // back at the bottom: what is drawn once it holds still is what every later attach must draw
  let steady = "";
  for (let i = 0; i < 40; i++) {
    await Bun.sleep(250);
    const now = JSON.stringify((await drawn()).map((image) => [image.ref, image.top, image.firstRow, image.lastRow]));
    if (now === steady) break;
    steady = now;
  }
  const visible = (JSON.parse(steady) as unknown[]).length;
  assert.ok(visible > 0, "images are drawn back at the bottom");

  // 4. a reload is a new attach: the full first frame brings the markers, the images come back
  await page.reload();
  await page.locator(".conn-live").first().waitFor();
  images = await settled((list) => list.length === visible, "every image again after a reload");
  checkGeometry(images, "reload");
  await allPicturesOk(images, "reload");
  record("reloaded", images);
  // the socket drops (no reload): the page reconnects, re-attaches, and the images come back
  assert.ok(liveSocket, "the page's socket is routed");
  await (liveSocket as WebSocketRoute).close();
  await page.waitForFunction(() => document.querySelector(".conn-live") === null);
  await page.locator(".conn-live").first().waitFor();
  images = await settled((list) => list.length === visible, "every image again after the socket reconnects");
  checkGeometry(images, "reconnect");
  await allPicturesOk(images, "reconnect");
  record("reconnected", images);

  // 5. the remote PC's terminal: same pane and session through its bridge; asked of that PC
  const remoteStart = imageRequests.length;
  await page.goto(`${base}/?machine=${encodeURIComponent(remoteId)}&pane=${encodeURIComponent(pane)}&view=terminal`);
  await page.locator(".conn-live").first().waitFor();
  images = await settled((list) => list.length === visible, "every image on the remote PC's terminal");
  checkGeometry(images, "remote");
  record("remote", images);
  await allPicturesOk(images, "remote");
  // the remote PC's image opens in the viewer by that PC's URL
  const remoteViewer = await opensOnClick(images[0]!, "remote");
  assert.ok(remoteViewer.pathname.startsWith(`/api/machines/${encodeURIComponent(remoteId)}/pane/conversation/image`), "the remote image's viewer asks that PC");
  const remoteRequests = imageRequests.slice(remoteStart);
  assert.ok(remoteRequests.length > 0 && remoteRequests.every((path) => path.startsWith(`/api/machines/${encodeURIComponent(remoteId)}/pane/conversation/image?`)), "the remote PC's images are asked of that PC");
  await page.screenshot({ path: join(evidence, "4-remote.png") });

  // 6. pi quits: what it leaves on the screen keeps its markers (as natively), and images already
  // drawn stay; the screen is cleared: the markers go, and the images with them
  await page.goto(`${base}/?pane=${encodeURIComponent(pane)}&view=terminal`);
  await page.locator(".conn-live").first().waitFor();
  await settled((list) => list.length > 0, "images before pi quits");
  await quitPi();
  images = await drawn();
  checkGeometry(images, "after quit");
  record("afterQuit", images);

  // 6b. a program writes over marker cells: the same U+2800, without the link. herdr re-sends such a
  // cell (its link changed); the glyph stays, the image it marked must go. Then the markers are
  // written again and the image is back. Each stage is a file one shell command prints in turn.
  const stages = ["bare", "middle", "restore"];
  writeFileSync(join(root, "overwrite.sh"), `for s in ${stages.join(" ")}; do until [ -e ${root}/go-$s ]; do sleep 0.05; done; cat ${root}/$s.bin; done\nuntil [ -e ${root}/go-end ]; do sleep 0.1; done\n`);
  const scriptRuns = async () => (await paneProcessInfo(pane).catch(() => undefined))?.foreground_processes?.some((process) => process.name === "sh") === true;
  await paneSendText(pane, `sh ${root}/overwrite.sh`);
  await paneSendKeys(pane, ["Enter"]);
  await until(scriptRuns, "the overwrite script runs");
  const beforeOverwrite = await settled((list) => list.length > 0 && list.every((image) => image.markers.every(Boolean)), "images on screen before the overwrite");
  await allPicturesOk(beforeOverwrite, "before overwrite");
  const markerRows = (image: Drawn[number], rows: string[][]) => Array.from({ length: image.lastRow - image.firstRow + 1 }, (_, i) => image.firstRow + i).filter((row) => rows[row]?.[image.left + image.cols] === "\u2800");
  const rowsBefore = await screenRows();
  // the image with the most marker rows loses all of them; another, if any, loses its middle one
  const ranked = [...beforeOverwrite].sort((x, y) => markerRows(y, rowsBefore).length - markerRows(x, rowsBefore).length);
  const target = ranked[0]!;
  const targetCells = markerRows(target, rowsBefore).map((row) => ({ x: target.left + target.cols, y: row }));
  const other = ranked.slice(1).find((image) => markerRows(image, rowsBefore).length >= 3);
  const otherRows = other ? markerRows(other, rowsBefore) : [];
  const middle = other ? { x: other.left + other.cols, y: otherRows[Math.floor(otherRows.length / 2)]! } : null;
  const cup = (cell: { x: number; y: number }) => `\x1b[${cell.y + 1};${cell.x + 1}H`;
  const digestOf = (data: string) => new Bun.CryptoHasher("sha256").update(Buffer.from(data, "base64")).digest("hex").slice(0, 32);
  const markerUri = (image: Drawn[number], row: number) => `x-pi-image:v1?s=${SESSION}&ref=${encodeURIComponent(image.ref)}&h=${digestOf(image.ref === "pi:call_e2e_b:0" ? pictures.greenYellow : pictures.redBlue)}&c=${image.cols}&r=${image.rows}&y=${row - image.top}`;
  writeFileSync(join(root, "bare.bin"), `\x1b7${targetCells.map((cell) => `${cup(cell)}\u2800`).join("")}\x1b8`);
  writeFileSync(join(root, "middle.bin"), middle ? `\x1b7${cup(middle)}\u2800\x1b8` : "");
  writeFileSync(join(root, "restore.bin"), `\x1b7${[...targetCells.map((cell) => ({ cell, image: target })), ...(middle && other ? [{ cell: middle, image: other }] : [])]
    .map(({ cell, image }) => `${cup(cell)}\x1b]8;;${markerUri(image, cell.y)}\x1b\\\u2800\x1b]8;;\x1b\\`).join("")}\x1b8`);
  const sameFootprint = (a: Drawn[number], b: Drawn[number]) => a.ref === b.ref && a.left === b.left && a.top === b.top;
  writeFileSync(join(root, "go-bare"), "");
  images = await settled((list) => !list.some((image) => sameFootprint(image, target)), "the image whose markers were overwritten goes");
  const rowsBare = await screenRows();
  assert.ok(targetCells.every((cell) => rowsBare[cell.y]?.[cell.x] === "\u2800"), "its marker cells still show U+2800 (only the link went)");
  assert.equal(images.length, beforeOverwrite.length - 1, "every other image stays");
  await allPicturesOk(images.length > 0 ? images : beforeOverwrite.filter((image) => !sameFootprint(image, target)), "the other images");
  // where the picture's red (or the JPEG's) pixels were: inside both the picture and its visible box
  const visibleTop = Math.max(target.box.y, target.picture.y), visibleBottom = Math.min(target.box.y + target.box.height, target.picture.y + target.picture.height);
  const centre = { x: target.picture.x + target.picture.width * (target.ref === "pi:call_e2e_b:0" ? 0.5 : 0.25), y: (visibleTop + visibleBottom) / 2 };
  const leftover = await colourAt(centre.x, centre.y);
  assert.ok(!near(leftover, COLORS.red, 60) && !near(leftover, COLORS.yellow, 60) && !near(leftover, COLORS.green, 60), `no picture pixels where it was (${leftover})`);
  record("overwritten", images);
  await page.screenshot({ path: join(evidence, "5a-marker-overwritten.png") });
  writeFileSync(join(root, "go-middle"), "");
  if (other && middle) {
    images = await settled((list) => list.filter((image) => sameFootprint(image, other)).length === 2, "an image whose middle marker was overwritten splits around that row");
    const parts = images.filter((image) => sameFootprint(image, other));
    assert.ok(parts.every((part) => part.firstRow > middle.y || part.lastRow < middle.y), "the overwritten row is not drawn");
    await allPicturesOk(parts, "split image");
    record("middleOverwritten", images);
    await page.screenshot({ path: join(evidence, "5b-middle-overwritten.png") });
  }
  result["overwrite"] = { target: target.ref, cells: targetCells.length, middle: middle !== null };
  writeFileSync(join(root, "go-restore"), "");
  images = await settled((list) => list.length === beforeOverwrite.length && list.some((image) => sameFootprint(image, target)), "the image is back once its markers are written again");
  checkGeometry(images, "restored");
  await allPicturesOk(images, "restored");
  record("restored", images);
  await page.screenshot({ path: join(evidence, "5c-markers-restored.png") });
  writeFileSync(join(root, "go-end"), "");
  await until(async () => !(await scriptRuns()), "the overwrite script ends");

  await paneSendText(pane, "clear");
  await paneSendKeys(pane, ["Enter"]);
  await settled((list) => list.length === 0, "no image once the screen is cleared");
  await page.screenshot({ path: join(evidence, "5-removed.png") });

  // 7. forged markers printed by another program: a wrong digest, an unknown ref, a ref of a session
  // the pane no longer runs, an oversized and a malformed one. None draws; each is asked at most once.
  const forgedStart = imageRequests.length;
  const digestA = new Bun.CryptoHasher("sha256").update(Buffer.from(pictures.redBlue, "base64")).digest("hex").slice(0, 32);
  // a printf format: `%` doubled, ESC and U+2800 (UTF-8 342 240 200) as octal escapes
  const marker = (fields: string) => `\\033]8;;x-pi-image:v1?${fields.replaceAll("%", "%%")}\\033\\\\\\342\\240\\200\\033]8;;\\033\\\\`;
  const forged = [
    `s=${SESSION}&ref=pi%3Acall_e2e_a%3A0&h=${"0".repeat(32)}&c=4&r=2&y=1`,
    `s=${SESSION}&ref=pi%3Acall_nope%3A0&h=${digestA}&c=4&r=2&y=1`,
    `s=${SESSION}&ref=pi%3Acall_e2e_a%3A0&h=${digestA}&c=4&r=2&y=1`,
    `s=${SESSION}&ref=pi%3Acall_e2e_a%3A0&h=${digestA}&c=4&r=2&y=1&pad=${"a".repeat(600)}`,
    `s=${SESSION}&ref=%2Fetc%2Fpasswd&h=${digestA}&c=4&r=2&y=1`,
  ];
  await paneSendText(pane, `printf 'FORGED ${forged.map((fields) => `    ${marker(fields)}`).join("\\n       ")}\\nFORGED_END\\n'`);
  await paneSendKeys(pane, ["Enter"]);
  await page.getByText("FORGED_END").first().waitFor();
  // fixed wait: proving that nothing is drawn (a forged marker's fetch and one retry come within it)
  await Bun.sleep(2_500);
  assert.equal((await drawn()).length, 0, "a forged marker draws nothing");
  const forgedRequests = imageRequests.slice(forgedStart);
  result["forgedRequests"] = forgedRequests.length;
  // three well-formed markers, each asked once and (a missing image may be late) once more after a second
  assert.ok(new Set(forgedRequests).size <= 3 && forgedRequests.length <= 6 && forgedRequests.every((path) => !path.includes("passwd") && !path.includes("pad=")), "only well-formed markers are asked about, a bounded number of times");
  await page.screenshot({ path: join(evidence, "6-forged.png") });

  // 8. the pane runs a later session that reuses call_e2e_a for another picture: that picture is drawn
  await startPi(later);
  images = await settled((list) => list.length === 1, "the later session's image");
  checkGeometry(images, "later session");
  record("laterSession", images);
  assert.equal(images[0]!.ref, "pi:call_e2e_a:0");
  assert.ok(near((await sample(images[0]!, 0.5, 0.5))!, COLORS.magenta), "the later session's own picture, not the first session's");
  await page.screenshot({ path: join(evidence, "7-later-session.png") });
  await quitPi();

  // 9. the image viewer for every kind of picture pi draws: a pasted picture in the transcript (the
  // images extension's `pasted-images` entry, named by its file), a one-row tool image, and a picture
  // pasted into the draft. Each opens on click (zoom, download); its comments are saved, there again
  // when it is reopened, and go to the message draft (never sent) with that picture's SHA-256.
  const pasteDir = join(project, ".herdr-web-ui");
  mkdirSync(pasteDir, { recursive: true });
  const pastedFile = join(pasteDir, "paste e2e #1.png"), draftFile = join(pasteDir, "paste-draft.png");
  writeFileSync(pastedFile, Buffer.from(pictures.pasted, "base64"));
  writeFileSync(draftFile, Buffer.from(pictures.draft, "base64"));
  expectedBytes.set(`file:${pastedFile}`, Buffer.from(pictures.pasted, "base64"));
  expectedBytes.set(`file:${draftFile}`, Buffer.from(pictures.draft, "base64"));
  expectedBytes.set("pi:call_e2e_row:0", Buffer.from(pictures.strip, "base64"));
  const VIEWER = "0190e2e0-0000-7000-8000-00000000e2e2";
  const viewer = join(store, "viewer.jsonl");
  {
    const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const assistant = (content: unknown[], stopReason: string) => ({ role: "assistant", content, api: "fixture", provider: "fixture", model: "fixture", usage, stopReason, timestamp: 2 });
    const entries: unknown[] = [{ type: "session", version: 3, id: VIEWER, timestamp: "2026-10-16T00:00:00.000Z", cwd: project }];
    const push = (entry: Record<string, unknown>) => entries.push({ id: `v${entries.length}`, parentId: entries.length > 1 ? `v${entries.length - 1}` : null, timestamp: "2026-10-16T00:00:01.000Z", ...entry });
    push({ type: "message", message: { role: "user", content: [{ type: "text", text: `'${pastedFile}' look at this` }, { type: "image", mimeType: "image/png", data: pictures.pasted }], timestamp: 1 } });
    push({ type: "custom", customType: "pasted-images", data: { paths: [pastedFile] } });
    push({ type: "message", message: assistant([{ type: "toolCall", id: "call_e2e_row", name: "read", arguments: { path: "strip.png" } }], "toolUse") });
    push({ type: "message", message: { role: "toolResult", toolCallId: "call_e2e_row", toolName: "read", content: [{ type: "text", text: "Read image file [image/png]" }, { type: "image", mimeType: "image/png", data: pictures.strip }], isError: false, timestamp: 3 } });
    push({ type: "message", message: assistant([{ type: "text", text: "TERMINAL_IMAGE_VIEWER_END" }], "stop") });
    writeFileSync(viewer, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  }
  await startPi(viewer);
  await page.getByText("TERMINAL_IMAGE_VIEWER_END").first().waitFor();
  // the draft: a bracketed paste of a picture's path, as a terminal paste brings it
  await paneSendText(pane, `\x1b[200~'${draftFile}' \x1b[201~`);
  const viewerRefs = [`file:${pastedFile}`, "pi:call_e2e_row:0", `file:${draftFile}`];
  images = await settled((list) => viewerRefs.every((ref) => list.some((image) => image.ref === ref)), "the pasted pictures and the one-row image are drawn");
  checkGeometry(images, "viewer");
  record("viewer", images);
  const byRef = (ref: string) => images.find((image) => image.ref === ref)!;
  assert.equal(byRef("pi:call_e2e_row:0").rows, 1, "the strip is a one-row image");
  assert.ok(near((await sample(byRef(`file:${pastedFile}`), 0.25, 0.5))!, COLORS.magenta, 60), "the pasted picture is drawn with its own pixels, not cells");
  assert.ok(near((await sample(byRef(`file:${draftFile}`), 0.5, 0.25))!, COLORS.blue, 60), "and so is the draft's");
  await page.screenshot({ path: join(evidence, "8-viewer.png") });
  for (const ref of viewerRefs) await opensOnClick(byRef(ref), `viewer ${ref}`);

  // comments: saved, back when reopened, and into the message draft with this picture's SHA-256
  const review = page.locator(".pi-review");
  const draftKey = `herdr-web-ui:composer-draft:${pane}`;
  const openReview = async (image: Drawn[number], label: string) => {
    await opensOnClick(image, label, 0, true);
    await lightbox.getByRole("button", { name: "Image comments" }).click();
    await lightbox.waitFor({ state: "detached" });
    await review.waitFor();
    await page.waitForFunction(() => { const img = document.querySelector<HTMLImageElement>(".pi-review-image img"); return img !== null && img.complete && img.naturalWidth > 0; }, undefined, { timeout: 10_000 });
  };
  const closeReview = async () => {
    await review.locator("header").getByRole("button", { name: "Close" }).click();
    await review.waitFor({ state: "detached" });
  };
  const composer = page.locator(".composer-text");
  const lens = (name: "Chat" | "Terminal") => page.locator(".view-switch button", { hasText: name });
  /**
   * Create feedback draft hands over to the chat lens's message box: the review closes on its own,
   * the box holds the whole stored draft, editable, with the focus and the caret at its end (the
   * appended feedback in view), and no later render takes them away. Nothing is sent meanwhile.
   */
  const draftShown = async (label: string) => {
    await review.waitFor({ state: "detached" });
    await composer.waitFor();
    assert.equal(await lens("Chat").getAttribute("aria-pressed"), "true", `${label}: the pane shows its chat lens`);
    const stored = (await page.evaluate((key) => localStorage.getItem(key), draftKey)) ?? "";
    await page.waitForFunction((text) => { const box = document.querySelector<HTMLTextAreaElement>(".composer-text"); return box !== null && box.value === text && document.activeElement === box && box.selectionStart === text.length; }, stored, { timeout: 10_000 });
    // fixed wait: proving that nothing after the hand-over moves the focus or the caret
    await Bun.sleep(500);
    assert.ok(await composer.evaluate((box) => { const area = box as HTMLTextAreaElement; return document.activeElement === area && area.selectionStart === area.value.length && area.scrollTop + area.clientHeight >= area.scrollHeight - 2 && !area.disabled && !area.readOnly; }), `${label}: the message box keeps the focus at the feedback's end, editable`);
    assert.ok(stored.startsWith(`${KEPT}\n\n`), `${label}: what the draft held before stays at its start`);
    assert.equal(sentFeedback, 0, `${label}: no feedback left the page`);
  };
  /** back to the terminal lens: its pictures are drawn again */
  const backToTerminal = async (label: string) => {
    await lens("Terminal").click();
    images = await settled((list) => viewerRefs.every((one) => list.some((image) => image.ref === one)), `the viewer's pictures in the terminal again (${label})`);
  };
  // the message draft already holds text of the user's: feedback goes after it, never over it
  const KEPT = "Keep this note of mine";
  await page.evaluate(([key, text]) => localStorage.setItem(key!, text!), [draftKey, KEPT]);
  const commented: Record<string, string> = {};
  for (const [ref, text] of [[`file:${pastedFile}`, "pasted: darken the green"], ["pi:call_e2e_row:0", "strip: make it taller"]] as const) {
    await openReview(byRef(ref), `comment ${ref}`);
    await review.getByRole("button", { name: "Add center comment" }).click();
    await review.locator("textarea").last().fill(text);
    await review.getByRole("button", { name: "Save", exact: true }).click();
    await review.getByText("Saved", { exact: true }).waitFor();
    await closeReview();
    // a reload drops everything the page held: what comes back was saved
    await page.reload();
    await page.locator(".conn-live").first().waitFor();
    images = await settled((list) => viewerRefs.every((one) => list.some((image) => image.ref === one)), `the viewer's pictures after a reload (${ref})`);
    await openReview(byRef(ref), `reopen ${ref}`);
    assert.deepEqual(await review.locator("textarea").evaluateAll((areas) => areas.map((area) => (area as HTMLTextAreaElement).value)), [text], `${ref}: the saved comment is there when reopened`);
    // the case the user hit: from the terminal lens, where no message box is drawn
    await review.getByRole("button", { name: "Create feedback draft" }).click();
    await draftShown(`terminal lens ${ref}`);
    await page.screenshot({ path: join(evidence, `9-draft-shown-${ref.startsWith("file:") ? "pasted" : "strip"}.png`) });
    const sha = new Bun.CryptoHasher("sha256").update(expectedBytes.get(ref)!).digest("hex");
    const draft = (await page.evaluate((key) => localStorage.getItem(key), draftKey)) ?? "";
    assert.ok(draft.includes(`Image SHA-256: ${sha}`) && draft.includes(`1. [x,y,w,h normalized: 0.5000, 0.5000, 0.0000, 0.0000] ${text}`), `${ref}: the feedback draft names this picture (SHA-256 ${sha}) and its comment at its place`);
    // the annotated copy it names is an upload in the pane's folder, the size of this picture
    const attached = new RegExp(`\\n(".*")\\nImage SHA-256: ${sha}\\n`).exec(draft)?.[1];
    const attachedPath = attached ? JSON.parse(attached) as string : "";
    assert.ok(attachedPath.startsWith(pasteDir) && existsSync(attachedPath), `${ref}: the draft names the annotated upload (${attachedPath})`);
    const size = (png: Buffer) => [png.readUInt32BE(16), png.readUInt32BE(20)];
    assert.deepEqual(size(readFileSync(attachedPath)), size(expectedBytes.get(ref)!), `${ref}: the annotated upload is this picture's size`);
    commented[ref] = sha;
    await backToTerminal(ref);
  }
  // from the chat lens, whose message box is already there under the review
  await lens("Chat").click();
  await composer.waitFor();
  // the strip pi read, under its turn's work block and its read row
  await page.getByText(/^Worked for/).first().click();
  await page.locator(".work-row-head").first().click();
  await page.locator(".chat-tool-images .chat-user-image").first().click();
  await lightbox.waitFor();
  await lightbox.getByRole("button", { name: "Image comments" }).click();
  await review.waitFor();
  await page.waitForFunction(() => { const img = document.querySelector<HTMLImageElement>(".pi-review-image img"); return img !== null && img.complete && img.naturalWidth > 0; }, undefined, { timeout: 10_000 });
  await review.getByRole("button", { name: "Add center comment" }).click();
  await review.locator("textarea").last().fill("chat: from the chat lens");
  await review.getByRole("button", { name: "Create feedback draft" }).click();
  await draftShown("chat lens");
  assert.ok(((await composer.inputValue()).trimEnd()).endsWith("chat: from the chat lens"), "the chat lens's feedback is at the draft's end");
  await page.screenshot({ path: join(evidence, "9-draft-shown-chat.png") });
  await backToTerminal("after the chat lens");
  const draftText = (await page.evaluate((key) => localStorage.getItem(key), draftKey)) ?? "";
  result["feedbackDraft"] = { commented, text: draftText };
  // each picture's comment is under its own SHA-256 only
  const [pasteSha, stripSha] = [commented[`file:${pastedFile}`]!, commented["pi:call_e2e_row:0"]!];
  assert.ok(draftText.indexOf(`Image SHA-256: ${pasteSha}`) < draftText.indexOf("pasted: darken the green") && draftText.indexOf("pasted: darken the green") < draftText.indexOf(`Image SHA-256: ${stripSha}`) && draftText.indexOf(`Image SHA-256: ${stripSha}`) < draftText.indexOf("strip: make it taller"), "the two pictures' comments are not mixed");
  assert.ok(!readFileSync(viewer, "utf8").includes("Please revise"), "nothing reached pi's session");
  assert.ok(!(await screenRows()).some((row) => row.join("").includes("Please revise")), "the feedback is never sent to pi");
  await page.screenshot({ path: join(evidence, "9-commented.png") });

  // a resize redraws the one-row image and the pasted pictures where pi puts them now; they still open
  await page.setViewportSize({ width: 1400, height: 1000 });
  const beforeResize = JSON.stringify(images.map((image) => [image.ref, image.left, image.top]));
  images = await settled((list) => viewerRefs.every((ref) => list.some((image) => image.ref === ref)) && JSON.stringify(list.map((image) => [image.ref, image.left, image.top])) !== beforeResize, "the viewer's pictures follow a resize");
  checkGeometry(images, "viewer resized");
  record("viewerResized", images);
  for (const ref of viewerRefs) await opensOnClick(byRef(ref), `viewer resized ${ref}`);
  await paneSendKeys(pane, ["C-c"]);
  await quitPi();

  assert.deepEqual(errors, [], "no page errors");
  // the attach stream moved no row in this whole run (resize, scroll, reload, reconnect, remote, quit,
  // overwrite, clear): what the marker tracking relies on, and fails closed without
  result["attachFrames"] = ptyFrames;
  result["attachRowMoves"] = moves;
  assert.ok(ptyFrames > 0, "terminal bytes were seen");
  assert.deepEqual(moves, {}, "herdr's attach stream never scrolls or shifts cells");
  result["imageRequests"] = imageRequests.length;
  result["herdr"] = Bun.spawnSync([process.env["HERDR_WEB_HERDR_BIN"] || "herdr", "--version"]).stdout.toString().trim();
  result["pi"] = Bun.spawnSync(["pi", "--version"]).stdout.toString().trim();
  result["status"] = "passed";
  writeFileSync(join(evidence, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.log(`terminal image regression passed (${mode}); evidence in ${evidence}`);
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
