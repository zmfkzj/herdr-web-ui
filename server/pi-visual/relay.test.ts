import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as netServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { handleMachineRequest } from "../machine-api.ts";
import type { MachineManager } from "../machines.ts";
import { GuiViewGrants } from "./grants.ts";
import { desktopBinding, instruction, InstructionParser, type DesktopTunnel } from "./guacamole.ts";
import { DesktopRelay, RemoteDesktops } from "./relay.ts";
import { PiVisualService } from "./service.ts";
import type { PiPane } from "./identity.ts";
import type { ViewerSecret } from "./viewers.ts";

/**
 * Two PCs whose panes, sessions and worker names are the same (p1, W1), each with its own bridge
 * (a real PiVisualService behind a bearer, as remote-entry.ts serves it), its own loopback guacd
 * fixture and its own pi-gui viewer; a connection server between them and a browser stand-in.
 * No real SSH, guacd, krdp or Pi: the SSH forward is a loopback port.
 */
const SESSION = "c".repeat(64);
const dirs: string[] = [];
const until = async (done: () => boolean, what: string, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!done()) { if (Date.now() > deadline) throw new Error(`timed out: ${what}`); await Bun.sleep(10); }
};

interface Pc { id: string; guacd: Server; sockets: Set<Socket>; connects: string[][]; bridge: ReturnType<typeof Bun.serve>; service: PiVisualService; token: string; tickets: string[]; endpoint: { url: string; token: string } }
async function pc(id: string, port: number): Promise<Pc> {
  const sockets = new Set<Socket>(); const connects: string[][] = [];
  const guacd = netServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.setEncoding("utf8");
    const parser = new InstructionParser((parts) => {
      if (parts[0] === "select") socket.write(instruction("args", "VERSION_1_6_0", "hostname", "port", "username", "password", "security", "cert-fingerprints", "read-only"));
      if (parts[0] === "connect") { connects.push(parts); socket.write(instruction("ready", `desktop-${id}`) + instruction("name", id)); }
    });
    socket.on("data", (data) => { try { parser.write(String(data)); } catch { socket.destroy(); } });
  });
  await new Promise<void>((resolve) => guacd.listen(0, "127.0.0.1", resolve));
  const dir = mkdtempSync(join(tmpdir(), `pi-visual-relay-${id}-`)); dirs.push(dir);
  const pane: PiPane = { paneId: "p1", sessionId: "pi-session", session: SESSION, path: "/fixture/pi.jsonl", cwd: null };
  const viewer: ViewerSecret = { worker: "W1", port, display: "wayland-virtual-1", pid: 4242, startedAt: Date.now() - 60_000, fingerprint: "ab".repeat(32), password: `password-of-${id}`, piStartedAt: Date.now() - 120_000 };
  const service = new PiVisualService(dir, {
    guacdPort: (guacd.address() as { port: number }).port, probe: async () => "ready", discovery: () => true,
    identity: async (_pane, expected) => { if (expected && expected !== SESSION) throw new Error("changed"); return pane; },
    viewers: async () => [{ ...viewer }],
    workers: () => ({ ...pane, observedAt: 0, source: "original-pi-orche-records", workers: [], truncated: false }),
    image: async () => null,
  });
  const token = `${id}-token`.padEnd(16, "x"); const tickets: string[] = [];
  const bridge = Bun.serve<{ desktop: DesktopTunnel }>({
    port: 0, hostname: "127.0.0.1",
    async fetch(request, server) {
      if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response("unauthorized", { status: 401 });
      const url = new URL(request.url);
      if (url.pathname === "/ws") {
        const desktop = await service.take(request).catch(() => null);
        if (!desktop) return new Response("expired", { status: 403 });
        if (server.upgrade(request, { headers: { "sec-websocket-protocol": "guacamole" }, data: { desktop } })) return;
        service.release(desktop); return new Response("upgrade", { status: 426 });
      }
      if (url.pathname === "/api/pane/pi-visual/review/image") return new Response("png", { headers: { "content-type": "image/png", "content-security-policy": "default-src 'none'; sandbox", "x-content-type-options": "nosniff" } });
      if (url.pathname === "/api/pane/read") return new Response(JSON.stringify({ text: `screen of ${id}` }), { headers: { "content-type": "application/json" } });
      const response = await service.handle(request, url, false, undefined, { relayed: true });
      if (url.pathname.endsWith("/desktop") && response.ok) tickets.push((await response.clone().json() as { ticket: string }).ticket);
      return response;
    },
    websocket: { open(ws) { ws.data.desktop.bind(ws); }, message(ws, raw) { ws.data.desktop.message(String(raw)); }, close(ws) { service.release(ws.data.desktop); } },
  });
  return { id, guacd, sockets, connects, bridge, service, token, tickets, endpoint: { url: `http://127.0.0.1:${bridge.port}`, token } };
}

let a: Pc, b: Pc, upstream: ReturnType<typeof Bun.serve>;
const closers = new Map<string, Set<() => void>>();
const endpoints = new Map<string, { url: string; token: string }>();
const capability = new Map<string, { protocol: number } | null>();
/** whether the user turned desktop viewing on for a PC here (MachineManager.piDesktop) */
const desktopOn = new Map<string, boolean>();
const manager = {
  endpoint: (id: string) => endpoints.get(id),
  piVisual: (id: string) => endpoints.has(id) ? capability.get(id) : undefined,
  piDesktop: (id: string) => endpoints.has(id) && desktopOn.get(id) !== false,
  trackTerminal: (id: string, close: () => void) => { const set = closers.get(id) ?? new Set(); set.add(close); closers.set(id, set); return () => set.delete(close); },
  updateBridge: () => ({}),
};
/** the PC's SSH connection drops and comes back: its terminals end, and its endpoint is a new one */
const reconnect = (id: string) => { for (const close of [...closers.get(id) ?? []]) close(); closers.delete(id); endpoints.set(id, { ...endpoints.get(id)! }); };
const grants = new GuiViewGrants();
const desktops = new RemoteDesktops(manager, grants);
const COOKIE = "herdr_web_device=browser-a";
/** `/gui view W1` run by this browser in p1 of a PC, through that PC's current bridge connection */
const ran = (machine: string, text = "/gui view W1", cookie = COOKIE) => grants.observe({ binding: desktopBinding(new Request("http://x", { headers: { cookie } })), machine, connection: endpoints.get(machine)! }, "p1", text);
let local: ReturnType<typeof Bun.serve>;
const previousSwitch = process.env["HERDR_PI_GUACD_ENABLED"];

beforeAll(async () => {
  process.env["HERDR_PI_GUACD_ENABLED"] = "1";
  a = await pc("pc-a", 3391); b = await pc("pc-b", 3392);
  upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(JSON.stringify({ error: { code: "not_found", message: "unknown endpoint" } }), { status: 404 }) });
  for (const pcx of [a, b]) { endpoints.set(pcx.id, pcx.endpoint); capability.set(pcx.id, { protocol: 1 }); }
  endpoints.set("pc-upstream", { url: `http://127.0.0.1:${upstream.port}`, token: "u" }); capability.set("pc-upstream", null);
  local = Bun.serve<{ relay: DesktopRelay }>({
    port: 0, hostname: "127.0.0.1",
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/ws") {
        try {
          const ticket = desktops.take(url.searchParams.get("pi_desktop_ticket") ?? "", desktopBinding(request));
          if (!ticket) return new Response("not a relayed ticket", { status: 404 });
          const relay = await desktops.open(ticket);
          if (server.upgrade(request, { headers: { "sec-websocket-protocol": "guacamole" }, data: { relay } })) return;
          relay.close(); return new Response("upgrade", { status: 426 });
        } catch (error) { return new Response(error instanceof Error ? error.message : "refused", { status: 403 }); }
      }
      return handleMachineRequest(request, manager as unknown as MachineManager, undefined, undefined, false, { desktops });
    },
    websocket: { open(ws) { ws.data.relay.bind(ws as ServerWebSocket<unknown>); }, message(ws, raw) { ws.data.relay.message(String(raw)); }, close(ws) { ws.data.relay.close(); } },
  });
});
afterAll(() => {
  desktops.close(); local?.stop(true); upstream?.stop(true);
  for (const pcx of [a, b]) { pcx?.bridge.stop(true); pcx?.service.close(); for (const socket of pcx?.sockets ?? []) socket.destroy(); pcx?.guacd.close(); }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  if (previousSwitch === undefined) delete process.env["HERDR_PI_GUACD_ENABLED"]; else process.env["HERDR_PI_GUACD_ENABLED"] = previousSwitch;
});

const post = (machine: string, body: Record<string, unknown>, cookie = COOKIE, origin = `http://127.0.0.1:${local.port}`) => fetch(`${origin}/api/machines/${machine}/pane/pi-visual/desktop?pane_id=p1`, {
  method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1", cookie }, body: JSON.stringify(body),
});
const AUTO = { session: SESSION, worker: "W1", viewerPid: 4242, readOnly: true, width: 1024, height: 768 };
/** a browser's desktop socket to this server, its frames, and whether it closed */
function browser(ticket: string, cookie = COOKIE) {
  const frames: string[] = []; const state = { open: false, closed: false };
  const Socket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string>; protocols: string[] }) => WebSocket;
  const ws = new Socket(`ws://127.0.0.1:${local.port}/ws?pi_desktop_ticket=${ticket}`, { headers: { cookie }, protocols: ["guacamole"] });
  ws.onopen = () => { state.open = true; }; ws.onmessage = (event) => frames.push(String(event.data)); ws.onclose = () => { state.closed = true; };
  return { ws, frames, state };
}

describe("private desktops of other PCs", () => {
  it("routes identical pane, session and worker names to each PC's own viewer and guacd", async () => {
    for (const pcx of [a, b]) ran(pcx.id);
    const opened: ReturnType<typeof browser>[] = [];
    for (const pcx of [a, b]) {
      const response = await post(pcx.id, AUTO);
      expect(response.status).toBe(200);
      const { ticket } = await response.json() as { ticket: string };
      // the browser holds this server's ticket only: never the bridge's, never its bearer
      expect(ticket).toMatch(/^[a-f0-9]{64}$/);
      expect(pcx.tickets).not.toContain(ticket);
      opened.push(browser(ticket));
    }
    await until(() => opened.every((item) => item.frames.length > 0), "both desktops ready");
    expect(a.connects.map((row) => row.slice(2, 6))).toEqual([["127.0.0.1", "3391", "pi", "password-of-pc-a"]]);
    expect(b.connects.map((row) => row.slice(2, 6))).toEqual([["127.0.0.1", "3392", "pi", "password-of-pc-b"]]);
    expect(opened[0]!.frames.join("")).toContain("pc-a"); expect(opened[1]!.frames.join("")).toContain("pc-b");
    expect(opened.map((item) => item.frames.join("")).join("")).not.toContain("password-of");
    // the SSH link of one PC drops: only its desktop ends, the other PC's stays
    reconnect("pc-a");
    await until(() => opened[0]!.state.closed && a.sockets.size === 0, "pc-a's desktop and guacd connection end");
    expect(opened[1]!.state.closed).toBe(false);
    expect(desktops.openCount("pc-a")).toBe(0); expect(desktops.openCount("pc-b")).toBe(1);
    // the browser closes the other one normally: the bridge's tunnel and its guacd connection go too
    opened[1]!.ws.close();
    await until(() => desktops.openCount() === 0 && b.sockets.size === 0, "pc-b's desktop released");
  });

  it("asks for the password unless this browser ran /gui view for that worker on that PC, once per command", async () => {
    ran("pc-b");
    const other = await post("pc-b", { ...AUTO }, "herdr_web_device=browser-b");
    expect(other.status).toBe(403);
    expect((await other.json() as { error: { code: string } }).error.code).toBe("gui_view_required");
    expect((await post("pc-b", { ...AUTO, worker: "W2" })).status).toBe(403);
    // a command run on PC a opens nothing on PC b, whose pane, session and worker have the same names
    ran("pc-a", "/gui view W1", "herdr_web_device=browser-c");
    expect((await post("pc-b", AUTO, "herdr_web_device=browser-c")).status).toBe(403);
    // the PC resolves what the command named: `/gui view w1` there is not W1's desktop when a w1 exists;
    // here only W1 runs, so it opens, and the grant is spent by that ticket
    ran("pc-b", "/gui view w1", "herdr_web_device=browser-d");
    expect((await post("pc-b", AUTO, "herdr_web_device=browser-d")).status).toBe(200);
    expect((await post("pc-b", AUTO, "herdr_web_device=browser-d")).status).toBe(403);
    // a browser's own `command` field is never taken for one
    expect((await post("pc-b", { ...AUTO, command: { worker: "W1", ageMs: 0 } }, "herdr_web_device=browser-e")).status).toBe(403);
    // a command made on the connection before a reconnect opens nothing on the new one
    ran("pc-b", "/gui view W1", "herdr_web_device=browser-f");
    reconnect("pc-b");
    expect((await post("pc-b", AUTO, "herdr_web_device=browser-f")).status).toBe(403);
    // with the password the user typed, it opens; the password goes to the PC's bridge only
    const manual = await post("pc-b", { session: SESSION, port: 3392, password: "typed-by-user", fingerprint: "ab".repeat(32), readOnly: true, width: 1024, height: 768 }, "herdr_web_device=browser-b");
    expect(manual.status).toBe(200);
    const body = await manual.text();
    expect(body).not.toContain("typed-by-user");
  });

  it("binds tickets to the browser, uses them once and refuses them after a reconnect", async () => {
    const issue = async () => { ran("pc-b"); return (await (await post("pc-b", AUTO)).json() as { ticket: string }).ticket; };
    const stolen = browser(await issue(), "herdr_web_device=browser-b");
    await until(() => stolen.state.closed, "a ticket used by another browser is refused");
    expect(stolen.state.open).toBe(false);
    const ticket = await issue();
    const first = browser(ticket);
    await until(() => first.frames.length > 0, "first use opens");
    const again = browser(ticket);
    await until(() => again.state.closed, "a second use is refused");
    expect(again.state.open).toBe(false);
    first.ws.close();
    const stale = await issue();
    reconnect("pc-b");
    const late = browser(stale);
    await until(() => late.state.closed, "a ticket of the previous connection is refused");
    expect(late.state.open).toBe(false);
    await until(() => desktops.openCount() === 0, "nothing left open");
  });

  it("decides HTTPS and its own switch on the browser's request, before the PC is asked", async () => {
    const insecure = await handleMachineRequest(new Request("http://pc.example.net/api/machines/pc-b/pane/pi-visual/desktop?pane_id=p1", { method: "POST", headers: { "x-herdr-machine": "1", "content-type": "application/json", cookie: COOKIE, origin: "http://pc.example.net" }, body: JSON.stringify(AUTO) }), manager as unknown as MachineManager, undefined, undefined, false, { desktops });
    expect(insecure.status).toBe(403);
    expect((await insecure.json() as { error: { code: string } }).error.code).toBe("https_required");
    // straight over Tailscale to this server's tailnet address (index.ts: directTailnetRequest): plain http passes,
    // and the browser still needs its own `/gui view` grant
    const overTailnet = (encrypted: boolean) => handleMachineRequest(new Request("http://100.127.163.32:7318/api/machines/pc-b/pane/pi-visual/desktop?pane_id=p1", { method: "POST", headers: { "x-herdr-machine": "1", "content-type": "application/json", cookie: COOKIE, origin: "http://100.127.163.32:7318" }, body: JSON.stringify(AUTO) }), manager as unknown as MachineManager, undefined, undefined, false, { desktops, encrypted });
    expect((await (await overTailnet(true)).json() as { error: { code: string } }).error.code).toBe("gui_view_required");
    ran("pc-b");
    const cleartext = await overTailnet(false);
    expect((await cleartext.json() as { error: { code: string } }).error.code).toBe("https_required");
    const tunnelled = await overTailnet(true);
    expect(tunnelled.status).toBe(200);
    expect((await tunnelled.json() as { ticket?: string }).ticket).toMatch(/^[a-f0-9]{64}$/);
    process.env["HERDR_PI_GUACD_ENABLED"] = "0";
    try {
      ran("pc-b");
      const off = await post("pc-b", AUTO);
      expect(off.status).toBe(503);
      const viewers = await (await fetch(`http://127.0.0.1:${local.port}/api/machines/pc-b/pane/pi-visual/viewers?pane_id=p1`)).json() as { desktop: { state: string }; viewers: unknown[] };
      expect(viewers.desktop.state).toBe("disabled");
      expect(viewers.viewers).toHaveLength(1);
    } finally { process.env["HERDR_PI_GUACD_ENABLED"] = "1"; }
  });

  it("relays no desktop to a PC whose user has not turned desktop viewing on here", async () => {
    desktopOn.set("pc-b", false);
    try {
      ran("pc-b");
      const refused = await post("pc-b", AUTO);
      expect(refused.status).toBe(409);
      expect((await refused.json() as { error: { code: string } }).error.code).toBe("pc_desktop_off");
      const viewers = await (await fetch(`http://127.0.0.1:${local.port}/api/machines/pc-b/pane/pi-visual/viewers?pane_id=p1`)).json() as { desktop: { state: string; action?: string } };
      expect(viewers.desktop).toMatchObject({ state: "disabled", action: "enable_pc" });
      // worker lists and the PC's terminals keep working
      expect((await fetch(`http://127.0.0.1:${local.port}/api/machines/pc-b/pane/pi-visual/workers?pane_id=p1`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${local.port}/api/machines/pc-b/pane/read?pane_id=p1`)).status).toBe(200);
    } finally { desktopOn.delete("pc-b"); }
  });

  it("ends one PC's relays when its desktop viewing is turned off, leaving the other PC's", async () => {
    const opened: ReturnType<typeof browser>[] = [];
    for (const pcx of [a, b]) { ran(pcx.id); opened.push(browser((await (await post(pcx.id, AUTO)).json() as { ticket: string }).ticket)); }
    await until(() => opened.every((item) => item.frames.length > 0), "both desktops ready");
    desktops.closeMachine("pc-a", "Desktop viewing was turned off for this PC");
    await until(() => opened[0]!.state.closed, "pc-a's desktop ends");
    expect(opened[0]!.frames.join("")).toContain("turned off");
    expect(opened[1]!.state.closed).toBe(false);
    opened[1]!.ws.close();
    await until(() => desktops.openCount() === 0, "nothing left open");
  });

  it("explains an upstream bridge instead of a broken control, and leaves its terminals alone", async () => {
    for (const route of ["workers", "viewers", "desktop"]) {
      const response = route === "desktop" ? await post("pc-upstream", AUTO) : await fetch(`http://127.0.0.1:${local.port}/api/machines/pc-upstream/pane/pi-visual/${route}?pane_id=p1`);
      expect(response.status).toBe(409);
      expect((await response.json() as { error: { code: string } }).error.code).toBe("pi_visual_bridge_required");
    }
    const screen = await fetch(`http://127.0.0.1:${local.port}/api/machines/pc-b/pane/read?pane_id=p1`);
    expect(await screen.json()).toEqual({ text: "screen of pc-b" });
    const offline = await fetch(`http://127.0.0.1:${local.port}/api/machines/pc-gone/pane/pi-visual/workers?pane_id=p1`);
    expect(offline.status).toBe(503);
  });

  it("keeps a review image's sandbox and nosniff through the PC proxy", async () => {
    const image = await fetch(`http://127.0.0.1:${local.port}/api/machines/pc-b/pane/pi-visual/review/image?pane_id=p1&session=${SESSION}&id=x`);
    expect(image.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
