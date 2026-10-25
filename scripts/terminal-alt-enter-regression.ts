import assert from "node:assert/strict";
import type { Browser, Page, WebSocketRoute } from "playwright-core";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneSendKeys, paneSendText } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";

/** how long a send that should not happen gets to show up */
const NO_SEND_WAIT_MS = 300;
const hex = (text: string) => Buffer.from(text, "utf8").toString("hex");

async function until(check: () => boolean | Promise<boolean>, label: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

type Sent = { type: "input"; text: string } | { type: "keys"; keys: string[] };
const typed = (text: string): Sent => ({ type: "input", text });
const ALT_ENTER: Sent = { type: "keys", keys: ["alt+enter"] };

/**
 * Alt+Enter (macOS Option+Enter) against a pane owned by the UI suite, in the browser's frames and
 * in the bytes a raw-mode program reads in the pane. xterm.js types it as ESC CR, which herdr passes
 * on as it is and a Kitty-protocol program (pi) reads as Shift+Enter: the terminal sends herdr's
 * `alt+enter` key instead, once, which herdr encodes in the program's own mode (CSI 13;3u under
 * Kitty, ESC CR in the legacy mode). A program that asked for modifyOtherKeys keeps xterm's ESC CR
 * (a mirror, which never shows the browser that request, sends herdr's key). Every other Enter and
 * Option chord keeps its sequence; an IME's Enter stays the IME's and pending IME text goes first;
 * a held draft, a terminal not ready, view-only mode and a dropped connection send nothing, and
 * nothing is sent later. A Mac is Chromium with `navigator.platform` set to MacIntel, not macOS.
 */
export async function checkAltEnter(browser: Browser, origin: string, paneId: string): Promise<void> {
  const fixture = mkdtempSync(join(tmpdir(), "herdr-alt-enter-"));
  const received = join(fixture, "received.txt");
  const script = join(fixture, "keys.cjs");
  // a raw-mode program in one keyboard mode: writes down every read, and leaves on "q"
  writeFileSync(script, `const fs = require("node:fs");
const [mode, done] = process.argv.slice(2);
const on = mode === "kitty" ? "\\x1b[>7u" : mode === "modify" ? "\\x1b[>4;2m" : "";
const off = mode === "kitty" ? "\\x1b[<u" : mode === "modify" ? "\\x1b[>4;0m" : "";
process.stdin.setRawMode(true);
process.stdout.write("\\x1b[2J\\x1b[H" + on + "Owned Alt+Enter test: " + mode + " keys\\r\\n");
process.stdin.on("data", (data) => {
  fs.appendFileSync(${JSON.stringify(received)}, data.toString("hex") + "\\n");
  if (data.toString() === "q" || data.includes(3)) {
    process.stdout.write(off);
    fs.writeFileSync(done, "");
    process.exit(0);
  }
});
`);
  appendFileSync(received, "");
  const reads = (): string[] => readFileSync(received, "utf8").split("\n").filter(Boolean);
  let runs = 0;
  let running: string | null = null;
  /** starts the program in `mode` and waits for it on the page */
  const start = async (page: Page, mode: "legacy" | "kitty" | "modify") => {
    running = join(fixture, `${++runs}.done`);
    await paneSendText(paneId, `node '${script.replaceAll("'", "'\\''")}' ${mode} '${running}'`);
    await paneSendKeys(paneId, ["Enter"]);
    await page.locator(".pane-terminal .xterm-rows", { hasText: `Owned Alt+Enter test: ${mode} keys` }).waitFor();
  };
  const stop = async () => {
    if (running === null) return;
    const done = running;
    await paneSendText(paneId, "q");
    await until(() => existsSync(done), "the fixture leaves");
    running = null;
  };
  try {
    for (const platform of ["MacIntel", "Linux x86_64"]) {
      const mac = platform === "MacIntel";
      const context = await browser.newContext({ viewport: { width: 1100, height: 650 } });
      await context.addInitScript(({ platform, paneId }) => {
        Object.defineProperty(navigator, "platform", { get: () => platform });
        localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", terminalInputMode: "direct" }));
        localStorage.setItem(`ovis:view:${paneId}`, "terminal");
      }, { platform, paneId });
      try {
        const page = await context.newPage();
        const sent: Sent[] = [];
        let mirrored = false;
        let inputReady = false;
        let offline = false;
        let route: WebSocketRoute | undefined;
        await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
          inputReady = false;
          // a dropped connection that stays down until the check lets it come back
          if (offline) { void socket.close(); return; }
          route = socket;
          const server = socket.connectToServer();
          server.onMessage((raw) => {
            const message = JSON.parse(String(raw));
            if (message.pane_id === paneId) {
              if (message.type === "pane-geometry" && message.fixed) mirrored = true;
              if (message.type === "input-ready") inputReady = message.ready !== false;
            }
            socket.send(raw);
          });
          socket.onMessage((raw) => {
            const message = JSON.parse(String(raw));
            if (message.pane_id === paneId && message.type === "input") sent.push(typed(message.text));
            if (message.pane_id === paneId && message.type === "keys") sent.push({ type: "keys", keys: message.keys });
            server.send(raw);
          });
        });
        await page.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
        await page.locator(".conn-live").waitFor();
        const input = page.locator(".xterm-helper-textarea");
        await input.waitFor();
        await until(() => inputReady, "input-ready");
        await input.focus();
        /** what the program read after its first `since` reads */
        const readsAfter = (since: number) => reads().slice(since).join("");
        /**
         * What `action` sent, bounded by a Ctrl+G typed after it, once the program (always running
         * here) has read that marker too: the next check's reads start after it.
         */
        const framesOf = async (action: () => Promise<unknown>): Promise<Sent[]> => {
          const before = sent.length;
          const read = reads().length;
          await action();
          await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          await input.press("Control+g");
          await until(() => sent.slice(before).some((frame) => frame.type === "input" && frame.text === "\x07"), "the Ctrl+G marker is sent");
          await until(() => readsAfter(read).endsWith(hex("\x07")), "the pane reads the Ctrl+G marker");
          const frames = sent.slice(before);
          assert.deepEqual(frames.at(-1), typed("\x07"), "nothing is sent after the marker");
          return frames.slice(0, -1);
        };
        /** the program read `expected` and then the marker, nothing else, after its first `since` reads */
        const readExactly = (expected: string, since: number, label: string) => {
          assert.equal(readsAfter(since), hex(expected) + hex("\x07"), `${label}: the pane reads ${JSON.stringify(expected)} once`);
        };

        for (const mode of ["legacy", "kitty", "modify"] as const) {
          await start(page, mode);
          // Option+Enter: one frame, and what the pane's program reads as Alt+Enter in its mode
          const keptByXterm: boolean = mode === "modify" && !mirrored;
          const altEnter: string = mode === "kitty" ? "\x1b[13;3u" : mode === "modify" && mirrored ? "\x1b[27;3;13~" : "\x1b\r";
          let since = reads().length;
          assert.deepEqual(await framesOf(() => input.press("Alt+Enter")), [keptByXterm ? typed("\x1b\r") : ALT_ENTER], `${platform} ${mode}: Alt+Enter sends one key, no ESC CR beside it`);
          readExactly(altEnter, since, `${platform} ${mode} Alt+Enter`);
          // every other Enter keeps its sequence, and an Option letter is never a herdr key
          for (const [shortcut, expected] of [["Enter", "\r"], ["Shift+Enter", "\x1b\r"], ["Alt+Shift+Enter", "\x1b\r"], ["Control+Alt+Enter", "\x1b\r"], ["Meta+Enter", "\r"]] as const) {
            since = reads().length;
            assert.deepEqual(await framesOf(() => input.press(shortcut)), [typed(expected)], `${platform} ${mode}: ${shortcut} keeps its sequence`);
            readExactly(expected, since, `${platform} ${mode} ${shortcut}`);
          }
          const option = await framesOf(() => input.press("Alt+b"));
          assert.equal(option.some((frame) => frame.type === "keys"), false, `${platform} ${mode}: an Option letter is never a herdr key`);
          if (!mac) assert.deepEqual(option, [typed("\x1bb")], `${platform} ${mode}: Alt+b stays xterm's ESC b`);
          await stop();
          console.log(`PASS ${platform} ${mode}${mirrored ? " (mirrored)" : ""}: Alt+Enter reaches the pane as ${JSON.stringify(altEnter)} once; Enter, Shift/Ctrl/Meta+Enter and Option letters unchanged`);
        }
        if (!mac) continue;

        // the IME's own Enter is left to xterm; pending IME text goes before Option+Enter, once each
        await start(page, "kitty");
        for (const composition of [{ isComposing: true, keyCode: 13 }, { isComposing: false, keyCode: 229 }]) {
          const frames = await framesOf(() => input.dispatchEvent("keydown", { key: "Enter", code: "Enter", altKey: true, ...composition, bubbles: true, cancelable: true }));
          assert.equal(frames.some((frame) => frame.type === "keys"), false, "an IME's Enter never becomes herdr's alt+enter");
        }
        const since = reads().length;
        const commit = await framesOf(() => input.evaluate(async (element) => {
          const textarea = element as HTMLTextAreaElement;
          textarea.value = "";
          textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
          textarea.value = "한";
          textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "한", bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 0));
          textarea.dispatchEvent(new CompositionEvent("compositionend", { data: "한", bubbles: true }));
          const enter = { key: "Enter", code: "Enter", keyCode: 13, which: 13, altKey: true, bubbles: true, cancelable: true };
          textarea.dispatchEvent(new KeyboardEvent("keydown", enter));
          textarea.dispatchEvent(new KeyboardEvent("keyup", enter));
        }));
        assert.deepEqual(commit, [typed("한"), ALT_ENTER], "pending IME text precedes Option+Enter, without duplicates");
        readExactly("한\x1b[13;3u", since, "IME text, then Option+Enter");
        console.log("PASS Mac IME: an IME's Enter stays xterm's; pending IME text precedes Option+Enter once");

        await checkRefusals(page, paneId, { route: () => route!, sent: () => sent, inputReady: () => inputReady, setOffline: (value) => { offline = value; }, framesOf });
        await stop();
      } finally { await context.close(); }
    }
  } finally {
    await stop().catch(() => {});
    if (existsSync(fixture)) rmSync(fixture, { recursive: true, force: true });
  }
}

/** A terminal not ready, a held draft, view-only mode and a dropped connection: nothing sent, now or later. */
async function checkRefusals(page: Page, paneId: string, io: {
  route: () => WebSocketRoute; sent: () => Sent[]; inputReady: () => boolean; setOffline: (value: boolean) => void;
  framesOf: (action: () => Promise<unknown>) => Promise<Sent[]>;
}): Promise<void> {
  const input = page.locator(".xterm-helper-textarea");
  const banner = (text: string) => page.locator(".terminal-banner", { hasText: text });
  const dismiss = async (text: string) => {
    await banner(text).getByRole("button", { name: "Dismiss", exact: true }).click();
    await banner(text).waitFor({ state: "hidden" });
  };
  const waiting = banner("Waiting for terminal input…");
  const ready = async (value: boolean) => {
    io.route().send(JSON.stringify({ type: "input-ready", pane_id: paneId, ready: value }));
    await waiting.waitFor({ state: value ? "hidden" : "visible" });
    await input.focus();
  };
  const NOT_READY = "Not sent: the terminal is not ready for keys.";
  const BESIDE_DRAFT = "Not sent: send or discard the held input first.";

  // not ready: told, not sent, and not sent once the terminal is ready again
  let before = io.sent().length;
  await ready(false);
  await input.press("Alt+Enter");
  await banner(NOT_READY).waitFor();
  assert.equal(io.sent().length, before, "nothing is sent while the terminal is not ready");
  await dismiss(NOT_READY);
  await ready(true);
  assert.deepEqual(await io.framesOf(async () => {}), [], "a refused Option+Enter is never sent later");
  assert.equal(io.sent().slice(before).some((frame) => frame.type === "keys"), false);

  // a held draft: Option+Enter is refused beside it, and the draft stays for Send or Discard
  await ready(false);
  await input.pressSequentially("held");
  await page.locator(".terminal-banner-draft .draft-text", { hasText: "held" }).waitFor();
  await ready(true);
  before = io.sent().length;
  await input.press("Alt+Enter");
  await banner(BESIDE_DRAFT).waitFor();
  // fixed wait: nothing may arrive in this time
  await page.waitForTimeout(NO_SEND_WAIT_MS);
  assert.equal(io.sent().length, before, "nothing is sent beside a held draft");
  assert.equal(await page.locator(".terminal-banner-draft .draft-text").textContent(), "held", "the draft is kept");
  await dismiss(BESIDE_DRAFT);
  await page.locator(".terminal-banner-draft .draft-discard").click();
  await page.locator(".terminal-banner-draft").waitFor({ state: "hidden" });

  // view only: xterm takes no input at all
  io.route().send(JSON.stringify({ type: "role-ack", mode: "observe" }));
  await page.locator(".terminal-banner-observe").waitFor();
  before = io.sent().length;
  await input.focus();
  await input.press("Alt+Enter");
  // fixed wait: nothing may arrive in this time
  await page.waitForTimeout(NO_SEND_WAIT_MS);
  assert.equal(io.sent().length, before, "a view-only terminal sends nothing");
  io.route().send(JSON.stringify({ type: "role-ack", mode: "interact" }));
  await page.locator(".terminal-banner-observe").waitFor({ state: "hidden" });

  // a dropped connection: told, not sent, and nothing sent after the connection comes back
  io.setOffline(true);
  await io.route().close();
  await page.locator(".conn-live").waitFor({ state: "detached" });
  before = io.sent().length;
  await input.focus();
  await input.press("Alt+Enter");
  await banner(NOT_READY).waitFor();
  assert.equal(io.sent().length, before, "nothing is sent while offline");
  io.setOffline(false);
  await page.locator(".conn-live").waitFor({ timeout: 30_000 });
  await until(io.inputReady, "input-ready after the reconnect", 30_000);
  if (await banner(NOT_READY).isVisible()) await dismiss(NOT_READY);
  await input.focus();
  assert.deepEqual(await io.framesOf(async () => {}), [], "an Option+Enter pressed offline is never sent on reconnect");
  assert.equal(io.sent().slice(before).some((frame) => frame.type === "keys"), false);
  console.log("PASS Mac Option+Enter: not ready, beside a held draft, view only and offline it is told or ignored, never sent later");
}

if (import.meta.main) {
  await import("./test-herdr.ts");
  const { createServer } = await import("../server/index.ts");
  const { workspaceCreate, workspaceClose } = await import("../server/herdr/client.ts");
  const { UsageService } = await import("../server/usage.ts");
  const { chromium } = await import("playwright-core");
  const root = mkdtempSync(join(tmpdir(), "herdr-alt-enter-qa-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: root, token: "", usage: new UsageService(undefined, []) });
  let browser: Browser | undefined;
  let workspace: string | undefined;
  try {
    const made = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-alt-enter" });
    workspace = made.workspace.workspace_id;
    browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    await checkAltEnter(browser, `http://127.0.0.1:${server.port}`, made.root_pane.pane_id);
  } finally {
    await browser?.close(); server.stop();
    if (workspace) await workspaceClose(workspace);
    rmSync(root, { recursive: true, force: true });
  }
}
