import { connect, type Socket } from "node:net";
import { randomBytes, createHash } from "node:crypto";
import { object, PI_INPUT_OPCODE, type PiDesktopRequest, type PiDesktopTicket, type PiInputMode } from "../../shared/pi-visual.ts";
import { VisualError, type PiPane } from "./identity.ts";

const FRAME_LIMIT = 4 * 1024 * 1024;
/** Guacamole lengths count Unicode characters, not UTF-8 bytes or UTF-16 code units. */
export function instruction(...elements: string[]): string { return elements.map(s => `${Array.from(s).length}.${s}`).join(",") + ";"; }
export class InstructionParser {
  private buffer = "";
  constructor(private readonly receive: (parts: string[]) => void) {}
  write(data: string): void {
    this.buffer += data;
    if (this.buffer.length > FRAME_LIMIT) throw new Error("Guacamole frame too large");
    for (;;) {
      let pos = 0; const parts: string[] = []; let complete = false;
      while (pos < this.buffer.length) {
        const dot = this.buffer.indexOf(".", pos); if (dot < 0) { if (this.buffer.length - pos > 8) throw new Error("Invalid Guacamole length"); return; }
        const raw = this.buffer.slice(pos,dot);
        if (!/^\d{1,8}$/.test(raw)) throw new Error("Invalid Guacamole length");
        const size = Number(raw); if (size > FRAME_LIMIT) throw new Error("Guacamole element too large");
        const from = dot+1; let end = from;
        for (let n=0; n<size; n++) {
          if (end >= this.buffer.length) return;
          const code = this.buffer.charCodeAt(end);
          if (code >= 0xd800 && code <= 0xdbff) { if (end+1 >= this.buffer.length) return; end += 2; } else end++;
        }
        if (end >= this.buffer.length) return;
        const delimiter = this.buffer[end]; if (delimiter !== "," && delimiter !== ";") throw new Error("Invalid Guacamole delimiter");
        parts.push(this.buffer.slice(from,end)); if (parts.length > 512) throw new Error("Too many Guacamole elements");
        pos = end+1;
        if (delimiter === ";") { complete = true; break; }
      }
      if (!complete) return;
      this.buffer = this.buffer.slice(pos); this.receive(parts);
      if (!this.buffer.length) return;
    }
  }
}
export function desktopRequest(value: unknown): PiDesktopRequest {
  if (!object(value) || typeof value.session !== "string" || !/^[a-f0-9]{64}$/.test(value.session)
    || !Number.isInteger(value.port) || (value.port as number) < 1024 || (value.port as number) > 65535
    || typeof value.password !== "string" || value.password.length < 1 || value.password.length > 256 || /[\r\n\0]/.test(value.password)
    || typeof value.fingerprint !== "string" || typeof value.readOnly !== "boolean") throw new VisualError("invalid_desktop", "Invalid private desktop connection fields");
  const fingerprint = value.fingerprint.replace(/^sha256:/i,"").replaceAll(":","").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new VisualError("invalid_fingerprint", "Enter the SHA-256 certificate fingerprint printed by /gui view");
  const dimension = (n: unknown) => Number.isInteger(n) && (n as number) >= 200 && (n as number) <= 4096;
  if (!dimension(value.width) || !dimension(value.height)) throw new VisualError("invalid_size", "Invalid desktop dimensions");
  return { session:value.session, port:value.port as number, password:value.password, fingerprint, readOnly:value.readOnly, width:value.width as number, height:value.height as number };
}
/**
 * guacd always takes input from this connection (`read-only` false): the view-only mode a ticket
 * starts in, and every later switch (PI_INPUT_OPCODE), is enforced by DesktopTunnel's filter, the
 * only path to guacd, so that one connection can switch both ways without a new RDP login.
 */
export function rdpParameters(request: PiDesktopRequest): Record<string,string> {
  return {
    hostname:"127.0.0.1", port:String(request.port), username:"pi", password:request.password,
    security:"tls", "cert-fingerprints":`sha256:${request.fingerprint}`, "ignore-cert":"false",
    "read-only":"false", "disable-gfx":"false", "enable-audio":"false", "disable-audio":"true",
    "enable-drive":"false", "enable-printing":"false", "enable-sftp":"false", "enable-audio-input":"false",
    "disable-copy":"true", "disable-paste":"true", "resize-method":"display-update", "color-depth":"24",
  };
}
interface Ticket { pane: PiPane; request: PiDesktopRequest; binding: string; expiresAt: number }
/** Tickets are memory-only, one-use, cookie/device-bound and expire without logging their secrets. */
export class DesktopTickets {
  private tickets = new Map<string,Ticket>();
  private timer: ReturnType<typeof setInterval>;
  constructor(private readonly now = Date.now) { this.timer=setInterval(() => this.prune(),5000); this.timer.unref?.(); }
  private prune(): void { for (const [id,t] of this.tickets) if (t.expiresAt <= this.now()) { t.request.password=""; this.tickets.delete(id); } }
  issue(pane: PiPane, request: PiDesktopRequest, binding: string): PiDesktopTicket {
    this.prune(); if (this.tickets.size >= 32) throw new VisualError("desktop_busy", "Too many pending desktop connections",429);
    const ticket=randomBytes(32).toString("hex"), expiresAt=this.now()+30000;
    this.tickets.set(ticket,{pane,request,binding,expiresAt}); return {ticket,expiresAt};
  }
  take(id: string, binding: string): Ticket {
    this.prune(); const ticket=this.tickets.get(id);
    if (!ticket || ticket.binding!==binding) throw new VisualError("desktop_ticket_expired", "Desktop ticket expired; reconnect",403);
    this.tickets.delete(id); return ticket;
  }
  close(): void { clearInterval(this.timer); for(const t of this.tickets.values()) t.request.password=""; this.tickets.clear(); }
}
export function desktopBinding(request: Request, deviceId?: string): string {
  return createHash("sha256").update(JSON.stringify([deviceId??"",request.headers.get("cookie")??"",request.headers.get("authorization")??"",request.headers.get("tailscale-user-login")??""])).digest("hex");
}
export interface DesktopWebSocket { send(data: string): number; close(code?: number,reason?: string): void; getBufferedAmount(): number }
/** keys one connection may hold down at once, as the tunnel remembers them for their release */
const MAX_HELD_KEYS = 64;
/** a switch's request id, and a keysym (Unicode keysyms run to 0x0110ffff) */
const SEQUENCE = /^\d{1,10}$/;
const COORDINATE = /^-?\d{1,6}$/;
/** One authenticated browser -> one guacd session. A disconnect never kills the Pi worker/krdp. */
export class DesktopTunnel {
  private socket?: Socket; private web?: DesktopWebSocket; private stopped=false; private ready=false;
  private timer?: ReturnType<typeof setTimeout>; private checkTimer?: ReturnType<typeof setInterval>; private checking=false;
  private params: Record<string,string>; private request: PiDesktopRequest;
  /** whether key/mouse/size reach guacd now: the ticket's start, then the browser's switches */
  private mode: PiInputMode;
  /** keys and the pointer as forwarded, so that a switch to view-only or a close lets go of them */
  private held=new Set<string>(); private pointer?: { x: string; y: string; mask: number };
  readonly pane: PiPane;
  /**
   * `mayInteract`: whether the browser's device may still give input (its role now); asked before
   * each switch to input and on every session recheck. A device that may not loses the desktop.
   */
  constructor(ticket: Ticket, private readonly validate: () => Promise<unknown>, private readonly guacdPort=4822, private readonly mayInteract: () => boolean = () => true) {
    this.pane=ticket.pane; this.request=ticket.request; this.params=rdpParameters(ticket.request);
    this.mode=ticket.request.readOnly ? "observe" : "interact";
  }
  bind(web: DesktopWebSocket): void {
    this.web=web;
    const parser=new InstructionParser(parts => {
      const op=parts[0];
      if (!this.ready && op==="args") {
        if (!parts.includes("cert-fingerprints")) return this.fail("guacd 1.6+ with certificate pinning is required");
        // Version negotiation: guacd may prefix its argument list with VERSION_1_x_x.
        const names=parts.slice(1); const values=names.map(name => /^VERSION_/.test(name) ? "VERSION_1_5_0" : this.params[name]??"");
        this.socket?.write(instruction("size",String(this.request.width),String(this.request.height),"96"));
        this.socket?.write(instruction("audio")); this.socket?.write(instruction("video"));
        this.socket?.write(instruction("image","image/png","image/jpeg","image/webp"));
        this.socket?.write(instruction("connect",...values));
        values.fill(""); this.params.password=""; this.request.password="";
      } else if (!this.ready && op==="ready") {
        this.ready=true; clearTimeout(this.timer);
        // WebSocketTunnel uses the empty-opcode message for its tunnel UUID.
        this.send(instruction("",parts[1]??randomBytes(16).toString("hex")));
      } else if(op==="error") this.fail("Private desktop connection failed; check krdp, fingerprint and H.264 support");
      else if(this.ready) this.send(instruction(...parts));
    });
    this.socket=connect({host:"127.0.0.1",port:this.guacdPort}); this.socket.setEncoding("utf8");
    this.socket.once("connect",() => this.socket?.write(instruction("select","rdp")));
    this.socket.on("data",(data: string) => { try { parser.write(data); } catch { this.fail("Invalid desktop protocol"); } });
    this.socket.once("error",() => this.fail("Local guacd is unavailable"));
    this.socket.once("close",() => this.close());
    this.timer=setTimeout(() => this.fail("Desktop connection timed out"),20000); this.timer.unref?.();
    this.checkTimer=setInterval(() => {
      if(this.checking||this.stopped) return;
      if(!this.mayInteract()) return this.fail("This device may no longer use private desktops");
      this.checking=true;
      this.validate().catch(() => this.fail("Pi session ended or changed")).finally(() => {this.checking=false;});
    },3000); this.checkTimer.unref?.();
  }
  private input=new InstructionParser(parts => {
    if(!this.ready||this.stopped) return;
    const op=parts[0];
    if(op==="disconnect") return this.close();
    if(op===PI_INPUT_OPCODE) return this.switchMode(parts[1],parts[2]);
    // No file/clipboard/stream upload, sharing/joining, or arbitrary guacd control from the page.
    if(op==="" && parts[1]==="ping") { this.send(instruction(...parts)); return; }
    const observe=new Set(["sync","nop","ack"]); const interactive=new Set(["key","mouse","size"]);
    if(!observe.has(op??"") && (this.mode!=="interact" || !interactive.has(op??""))) return;
    if(op==="size" && (!parts.slice(1).every(v => /^\d{1,4}$/.test(v) && Number(v)>0 && Number(v)<=4096))) return;
    if(op==="key") {
      const [,keysym="",pressed=""]=parts;
      if(!SEQUENCE.test(keysym) || (pressed!=="0" && pressed!=="1")) return;
      if(pressed==="0") this.held.delete(keysym); else if(this.held.size<MAX_HELD_KEYS || this.held.has(keysym)) this.held.add(keysym); else return;
    }
    if(op==="mouse") {
      const [,x="",y="",mask=""]=parts;
      if(!COORDINATE.test(x) || !COORDINATE.test(y) || !/^\d{1,3}$/.test(mask)) return;
      this.pointer={x,y,mask:Number(mask)};
    }
    if(this.socket && this.socket.writableLength > 256*1024) return this.fail("Desktop input stalled");
    this.socket?.write(instruction(...parts));
  });
  /** The input mode in force, as the browser asked and its device allows. */
  get inputMode(): PiInputMode { return this.mode; }
  /** `pi-input,<mode>,<id>` from the browser: answered with the mode in force, never passed to guacd. */
  private switchMode(wanted: string|undefined, id: string|undefined): void {
    if((wanted!=="observe" && wanted!=="interact") || id===undefined || !SEQUENCE.test(id)) return;
    if(wanted==="observe") { this.release(); this.mode="observe"; this.send(instruction(PI_INPUT_OPCODE,"observe",id)); return; }
    if(!this.mayInteract()) { this.send(instruction(PI_INPUT_OPCODE,this.mode,id,"This device may only watch")); return; }
    this.mode="interact"; this.send(instruction(PI_INPUT_OPCODE,"interact",id));
  }
  /** Lets go of every key and pointer button this connection holds on the desktop. */
  private release(): void {
    const frames=[...this.held].map(keysym => instruction("key",keysym,"0"));
    if(this.pointer && this.pointer.mask!==0) { frames.push(instruction("mouse",this.pointer.x,this.pointer.y,"0")); this.pointer.mask=0; }
    this.held.clear();
    if(frames.length && this.ready && this.socket && !this.socket.destroyed) this.socket.write(frames.join(""));
  }
  message(raw: string): void { try { this.input.write(raw); } catch { this.fail("Invalid desktop input"); } }
  private send(frame: string): void {
    if(this.stopped||!this.web) return;
    if(this.web.getBufferedAmount()+Buffer.byteLength(frame)>FRAME_LIMIT) return this.fail("Desktop output stalled");
    if(this.web.send(frame)===0) this.close();
  }
  private fail(message: string): void { if(this.stopped) return; this.web?.send(instruction("error",message,"512")); this.close(); }
  close(): void {
    if(this.stopped) return; this.release(); this.stopped=true; this.params.password=""; this.request.password="";
    clearTimeout(this.timer); clearInterval(this.checkTimer); this.socket?.destroy(); this.web?.close(1000,"Desktop disconnected");
  }
}
