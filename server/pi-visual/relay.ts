import { randomBytes } from "node:crypto";
import { PI_VISUAL_PROTOCOL, type PiDesktopAvailability, type PiDesktopCommand, type PiDesktopTicket, type PiGuiViewers, type PiVisualBridge } from "../../shared/pi-visual.ts";
import { jsonResponse } from "../http.ts";
import { canSendSecret } from "../machine-security.ts";
import { desktopBinding, instruction, type DesktopWebSocket } from "./guacamole.ts";
import type { Grant, GuiViewGrants } from "./grants.ts";
import { VisualError } from "./identity.ts";

const FRAME_LIMIT = 4 * 1024 * 1024;
const INPUT_LIMIT = 256 * 1024;
const BODY_LIMIT = 512 * 1024;
const TICKET_MS = 30_000;
const MAX_TICKETS = 32;
const MAX_RELAYS = 8;

type Endpoint = { url: string; token: string };
/** The part of MachineManager a relayed desktop needs. */
export interface DesktopMachines {
  endpoint(id: string): Endpoint | undefined;
  /** the pi-visual routes the PC's connected bridge serves, null without them */
  piVisual(id: string): PiVisualBridge | null | undefined;
  /** Pi desktop viewing turned on for that PC here, and its bridge started so (MachineManager.setDesktop) */
  piDesktop(id: string): boolean;
  /** called when the PC disconnects (SSH lost, disabled, removed, reconnected) */
  trackTerminal(id: string, close: () => void): () => void;
}
interface RemoteTicket { machine: string; paneId: string; remote: string; binding: string; endpoint: Endpoint; expiresAt: number }

const failure = (code: string, message: string, status: number) => jsonResponse({ error: { code, message } }, status, { "cache-control": "no-store" });
export const BRIDGE_WITHOUT_PI_VISUAL = "This PC's bridge has no Pi visual tools (an upstream or older bundle). Build this branch's bundle for that PC on this web server (bun run build:remote linux-x64, for example: this server then installs it instead of the upstream release), then use Install Pi visual bridge. Terminals and chats keep working meanwhile.";
/** Why a PC's bridge cannot serve this server's pi-visual requests, or null when it can. */
export function bridgeProblem(bridge: PiVisualBridge | null | undefined): string | null {
  if (!bridge) return BRIDGE_WITHOUT_PI_VISUAL;
  if (bridge.protocol !== PI_VISUAL_PROTOCOL) return `This PC's bridge serves Pi visual tools of another version (${bridge.protocol}; this server uses ${PI_VISUAL_PROTOCOL}). Install this server's Pi visual bridge there. Terminals and chats keep working meanwhile.`;
  return null;
}
/** This server's own desktop switch: it also decides for every PC it relays to. */
export function localDesktopEnabled(): boolean { return process.env["HERDR_PI_GUACD_ENABLED"] === "1"; }
export const LOCAL_DESKTOP_OFF: PiDesktopAvailability = { state: "disabled", message: "Desktop viewing is off on this web server, for this PC and the PCs it connects to. Start it with HERDR_PI_GUACD_ENABLED=1." };

export const PC_DESKTOP_OFF: PiDesktopAvailability = { state: "disabled", action: "enable_pc", message: "Desktop viewing is off for this PC. Turn it on here: its bridge restarts with it (herdr sessions keep running)." };
/**
 * A remote viewer list as this server lets the browser use it: its own switch comes first, then
 * the user's choice for that PC; the PC's own availability (its guacd) last.
 */
export function relayedViewers(answer: PiGuiViewers, desktopOn: boolean): PiGuiViewers {
  if (!localDesktopEnabled()) return { ...answer, desktop: LOCAL_DESKTOP_OFF };
  return desktopOn || answer.desktop.state !== "ready" && answer.desktop.action !== "enable_pc" ? answer : { ...answer, desktop: PC_DESKTOP_OFF };
}

async function boundedBody(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  const reader = request.body?.getReader();
  if (!reader) throw new VisualError("invalid_body", "A JSON body is required");
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.length;
      if (length > BODY_LIMIT) { await reader.cancel(); throw new VisualError("body_too_large", "Request exceeds 512 KiB", 413); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; chunk.fill(0); }
  return bytes;
}

/**
 * Private desktops of other PCs, through the SSH bridge this server already holds: the browser
 * gets a ticket of this server's own (one use, 30 s, bound to its cookie/device like a local one,
 * to that PC and to the bridge connection it was issued on), and only this server ever holds the
 * bridge's bearer token and the bridge's ticket. guacd and krdp stay on the PC's loopback, behind
 * that PC's own DesktopTunnel (its input filter, session recheck and connection limit).
 */
export class RemoteDesktops {
  private tickets = new Map<string, RemoteTicket>();
  private relays = new Set<DesktopRelay>();
  private timer: ReturnType<typeof setInterval>;
  constructor(private readonly machines: DesktopMachines, private readonly grants: GuiViewGrants, private readonly now = Date.now) {
    this.timer = setInterval(() => this.prune(), 5000); this.timer.unref?.();
  }
  private prune(): void { for (const [id, ticket] of this.tickets) if (ticket.expiresAt <= this.now()) this.tickets.delete(id); }
  /** POST /api/machines/<id>/pane/pi-visual/desktop: checked here, then asked of the PC's bridge. */
  async issue(request: Request, machine: string, url: URL, deviceId?: string): Promise<Response> {
    try {
      if (!localDesktopEnabled()) throw new VisualError("desktop_disabled", LOCAL_DESKTOP_OFF.message, 503);
      // the PC's bridge sees only this server's loopback: HTTPS is decided on the browser's request
      if (!canSendSecret(request)) throw new VisualError("https_required", "Use HTTPS or localhost for private desktops", 403);
      const endpoint = this.machines.endpoint(machine);
      if (!endpoint) throw new VisualError("machine_offline", "This PC is disconnected", 503);
      const problem = bridgeProblem(this.machines.piVisual(machine));
      if (problem) throw new VisualError("pi_visual_bridge_required", problem, 409);
      if (!this.machines.piDesktop(machine)) throw new VisualError("pc_desktop_off", PC_DESKTOP_OFF.message, 409);
      const paneId = url.searchParams.get("pane_id") ?? "";
      if (!paneId || paneId.length > 256) throw new VisualError("invalid_pane", "Invalid pane");
      this.prune();
      if (this.tickets.size >= MAX_TICKETS) throw new VisualError("desktop_busy", "Too many pending desktop connections", 429);
      const binding = desktopBinding(request, deviceId);
      let body = await boundedBody(request);
      let grant: Grant | undefined;
      try {
        let parsed: unknown;
        try { parsed = JSON.parse(new TextDecoder().decode(body)); } catch { throw new VisualError("invalid_body", "Invalid JSON body"); }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new VisualError("invalid_body", "A JSON object is required");
        const fields = parsed as Record<string, unknown>;
        delete fields.command;
        if (typeof fields.worker === "string") {
          // the `/gui view` this browser ran in that pane through this bridge connection: the PC checks
          // which viewer it names and that its Pi ran it, on its own clock
          grant = this.grants.find({ binding, machine, connection: endpoint }, paneId, fields.worker);
          if (!grant) throw new VisualError("gui_view_required", `Enter ${fields.worker.slice(0, 64)}'s one-time password, or run /gui view ${fields.worker.slice(0, 64)} in this pane first`, 403);
          fields.command = { worker: grant.worker, ageMs: Math.max(0, this.now() - grant.at) } satisfies PiDesktopCommand;
          const encoded = new TextEncoder().encode(JSON.stringify(fields));
          body.fill(0); body = new Uint8Array(encoded);
        }
        if (typeof fields.password === "string") fields.password = "";
        let response: Response;
        try {
          response = await fetch(`${endpoint.url}/api/pane/pi-visual/desktop?${new URLSearchParams({ pane_id: paneId })}`, {
            method: "POST", headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" }, body, redirect: "error",
            signal: AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]),
          });
        } catch { throw new VisualError("machine_unavailable", "The PC connection was interrupted; retry after reconnecting", 502); }
        const answer: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const error = (answer as { error?: { code?: unknown; message?: unknown } } | null)?.error;
          return failure(typeof error?.code === "string" ? error.code : "pi_visual_unavailable", typeof error?.message === "string" ? error.message.slice(0, 500) : "The PC refused the private desktop", response.status);
        }
        const remote = (answer as { ticket?: unknown } | null)?.ticket;
        if (typeof remote !== "string" || !/^[a-f0-9]{64}$/.test(remote)) throw new VisualError("pi_visual_unavailable", "The PC answered without a desktop ticket", 502);
        // a reconnect or another PC while the bridge answered: that ticket belongs to a connection that is gone
        if (this.machines.endpoint(machine) !== endpoint) throw new VisualError("machine_offline", "The PC reconnected; open the desktop again", 503);
        const ticket = randomBytes(32).toString("hex"), expiresAt = this.now() + TICKET_MS;
        this.tickets.set(ticket, { machine, paneId, remote, binding, endpoint, expiresAt });
        if (grant) this.grants.take(grant);
        return jsonResponse({ ticket, expiresAt } satisfies PiDesktopTicket, 200, { "cache-control": "no-store" });
      } finally { body.fill(0); }
    } catch (error) {
      const e = error instanceof VisualError ? error : new VisualError("pi_visual_unavailable", "Pi visual tools are temporarily unavailable", 503);
      return failure(e.code, e.message, e.status);
    }
  }
  /** This server's ticket, consumed; undefined when it is not one of the relayed desktops' tickets. */
  take(id: string, binding: string): RemoteTicket | undefined {
    this.prune();
    const ticket = this.tickets.get(id);
    if (!ticket) return undefined;
    this.tickets.delete(id);
    if (ticket.binding !== binding) throw new VisualError("desktop_ticket_expired", "Desktop ticket expired; reconnect", 403);
    return ticket;
  }
  /** Opens the PC's desktop socket with the bridge's ticket, on the connection the ticket came from. */
  async open(ticket: RemoteTicket): Promise<DesktopRelay> {
    if (this.relays.size >= MAX_RELAYS) throw new VisualError("desktop_busy", "Too many desktop connections", 429);
    if (this.machines.endpoint(ticket.machine) !== ticket.endpoint) throw new VisualError("machine_offline", "The PC reconnected; open the desktop again", 503);
    const relay = new DesktopRelay(ticket.machine, ticket.paneId, ticket.endpoint, ticket.remote, (closed) => { this.relays.delete(closed); });
    ticket.remote = "";
    this.relays.add(relay);
    relay.untrack = this.machines.trackTerminal(ticket.machine, () => relay.close("The PC disconnected"));
    try { await relay.ready; } catch (error) { relay.close(); throw error; }
    return relay;
  }
  release(relay: DesktopRelay): void { relay.close(); }
  /** ends one PC's relays and pending tickets, leaving every other PC's */
  closeMachine(machine: string, reason: string): void {
    for (const [id, ticket] of this.tickets) if (ticket.machine === machine) this.tickets.delete(id);
    for (const relay of [...this.relays]) if (relay.machine === machine) relay.close(reason);
  }
  /** relays still open, of one PC or all */
  openCount(machine?: string): number { return [...this.relays].filter((relay) => machine === undefined || relay.machine === machine).length; }
  close(): void { clearInterval(this.timer); this.tickets.clear(); for (const relay of [...this.relays]) relay.close("The web server is stopping"); }
}

/** One browser desktop socket <-> one bridge desktop socket. Guacamole text frames pass unchanged. */
export class DesktopRelay {
  readonly ready: Promise<void>;
  untrack: () => void = () => {};
  private upstream: WebSocket;
  private web?: DesktopWebSocket;
  private waiting: string[] = [];
  private waitingBytes = 0;
  private closed = false;
  constructor(readonly machine: string, readonly paneId: string, endpoint: Endpoint, remoteTicket: string, private readonly onClosed: (relay: DesktopRelay) => void) {
    // Bun's client takes headers and the subprotocol the bridge answers with (guacamole)
    const RuntimeSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string>; protocols: string[] }) => WebSocket;
    this.upstream = new RuntimeSocket(`${endpoint.url.replace("http:", "ws:")}/ws?${new URLSearchParams({ pi_desktop_ticket: remoteTicket })}`, { headers: { authorization: `Bearer ${endpoint.token}` }, protocols: ["guacamole"] });
    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { reject(new VisualError("machine_timeout", "The PC's desktop did not answer in time", 504)); this.close(); }, 15_000);
      timeout.unref?.();
      this.upstream.addEventListener("open", () => { clearTimeout(timeout); if (this.closed) reject(new VisualError("machine_offline", "The PC disconnected", 503)); else resolve(); }, { once: true });
      this.upstream.addEventListener("close", () => { clearTimeout(timeout); reject(new VisualError("pi_visual_unavailable", "The PC refused the private desktop; open it again", 502)); }, { once: true });
    });
    this.ready.catch(() => {});
    this.upstream.onmessage = (event) => {
      if (this.closed) return;
      const frame = String(event.data);
      if (!this.web) {
        this.waitingBytes += Buffer.byteLength(frame);
        if (this.waitingBytes > FRAME_LIMIT) { this.close("Desktop output stalled"); return; }
        this.waiting.push(frame); return;
      }
      this.send(frame);
    };
    this.upstream.onclose = () => this.close();
    this.upstream.onerror = () => this.close("The PC's desktop connection failed");
  }
  bind(web: DesktopWebSocket): void {
    this.web = web;
    if (this.closed) { web.close(1000, "Desktop disconnected"); return; }
    for (const frame of this.waiting) this.send(frame);
    this.waiting = []; this.waitingBytes = 0;
  }
  message(raw: string): void {
    if (this.closed) return;
    if (this.upstream.readyState !== WebSocket.OPEN) { this.close("Desktop disconnected"); return; }
    if (this.upstream.bufferedAmount + Buffer.byteLength(raw) > INPUT_LIMIT) { this.close("Desktop input stalled"); return; }
    this.upstream.send(raw);
  }
  private send(frame: string): void {
    if (this.closed || !this.web) return;
    if (this.web.getBufferedAmount() + Buffer.byteLength(frame) > FRAME_LIMIT) { this.close("Desktop output stalled"); return; }
    if (this.web.send(frame) === 0) this.close();
  }
  /** Ends both sockets once. `error` is said to the browser first, the way DesktopTunnel does. */
  close(error?: string): void {
    if (this.closed) return;
    this.closed = true; this.waiting = []; this.waitingBytes = 0;
    this.untrack();
    try { this.upstream.close(1000, "Desktop disconnected"); } catch { /* not open yet */ }
    try { if (error) this.web?.send(instruction("error", error, "512")); } catch { /* the socket is going anyway */ }
    try { this.web?.close(1000, "Desktop disconnected"); } catch { /* already closed */ }
    this.onClosed(this);
  }
}
