import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { basename } from "node:path";
import { GUI_VIEW_NAME, object, resolveViewer, reviewSource, type PiDesktopAutoRequest, type PiDesktopAvailability, type PiDesktopCommand, type PiDesktopRequest, type PiGuiViewers } from "../../shared/pi-visual.ts";
import { jsonResponse } from "../http.ts";
import { conversationImage } from "../conversation.ts";
import { locateFile } from "../file-view.ts";
import { canSendSecret } from "../machine-security.ts";
import { originalPi, PRIVATE_DESKTOP_TRANSPORT, VisualError, type PiPane } from "./identity.ts";
import { readWorkers } from "./workers.ts";
import { MAX_REVIEW_IMAGE_BYTES, ReviewStore } from "./reviews.ts";
import { DesktopTickets, DesktopTunnel, desktopBinding, desktopRequest } from "./guacamole.ts";
import { discoverViewers, probeGuacd, procViewerSystem, publicViewer, type ViewerSecret } from "./viewers.ts";

async function body(request: Request): Promise<Record<string,unknown>> {
  const reader=request.body?.getReader(); if(!reader) throw new VisualError("invalid_body","A JSON body is required");
  const chunks: Uint8Array[]=[]; let length=0;
  try {
    for(;;) { const next=await reader.read(); if(next.done) break; length+=next.value.length;
      if(length>512*1024) { await reader.cancel(); throw new VisualError("body_too_large","Request exceeds 512 KiB",413); } chunks.push(next.value); }
    const parsed: unknown=JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if(!object(parsed)) throw new VisualError("invalid_body","A JSON object is required"); return parsed;
  } catch(error) { if(error instanceof VisualError) throw error; throw new VisualError("invalid_body","Invalid JSON body"); }
  finally { reader.releaseLock(); }
}
export function visualResponse(error: unknown): Response {
  const e=error instanceof VisualError ? error : new VisualError("pi_visual_unavailable","Pi visual tools are temporarily unavailable",503);
  return jsonResponse({error:{code:e.code,message:e.message}},e.status,{"cache-control":"no-store"});
}
export interface VisualDependencies {
  guacdPort: number;
  identity: typeof originalPi;
  workers: typeof readWorkers;
  image: (paneId: string,ref: string) => ReturnType<typeof conversationImage>;
  /** the pi-gui viewers this pane's Pi process runs (server/pi-visual/viewers.ts) */
  viewers: (paneId: string) => Promise<ViewerSecret[]>;
  /** whether this OS lets the viewers be found (Linux /proc) */
  discovery: () => boolean;
  probe: typeof probeGuacd;
}
/**
 * Who asks. A connection server relaying for its own browser (a bridge's bearer) has already
 * checked that browser: its device role, HTTPS, its own desktop switch and its `/gui view` grant.
 * A browser asking this server directly brings its grant check along.
 */
export interface VisualCaller {
  relayed: boolean;
  /**
   * The `/gui view` this browser ran in this pane lately that may name `worker` (grants.ts), with
   * its time on this server's clock; `consume` once a desktop ticket was issued for it.
   */
  command?: (paneId: string, worker: string) => { worker: string | null; at: number; consume(): void } | undefined;
  /**
   * The browser reached this server over an encrypted link the URL does not show: straight over
   * Tailscale to its tailnet address (access.ts directTailnetRequest). HTTPS and localhost need no flag.
   */
  encrypted?: boolean;
}
/** Clock slack between a command, Pi's log line and the processes it names. */
const COMMAND_SLACK_MS = 3000;
function commandField(value: unknown): PiDesktopCommand | undefined {
  if (!object(value)) return undefined;
  const { worker, ageMs } = value;
  if (!(worker === null || typeof worker === "string" && GUI_VIEW_NAME.test(worker)) || !Number.isSafeInteger(ageMs) || (ageMs as number) < 0 || (ageMs as number) > 10 * 60_000) return undefined;
  return { worker: worker as string | null, ageMs: ageMs as number };
}
const DIMENSION = (n: unknown) => Number.isInteger(n) && (n as number) >= 200 && (n as number) <= 4096;
function autoRequest(value: Record<string,unknown>): PiDesktopAutoRequest {
  if (typeof value.session !== "string" || !/^[a-f0-9]{64}$/.test(value.session) || typeof value.worker !== "string" || value.worker.length > 64
    || !Number.isSafeInteger(value.viewerPid) || (value.viewerPid as number) < 2 || typeof value.readOnly !== "boolean" || !DIMENSION(value.width) || !DIMENSION(value.height)) throw new VisualError("invalid_desktop","Invalid private desktop connection fields");
  return { session:value.session, worker:value.worker, viewerPid:value.viewerPid as number, readOnly:value.readOnly, width:value.width as number, height:value.height as number };
}
const VIEWER_STATUS = { invalid_worker: 400, viewer_ambiguous: 409, viewer_missing: 404 } as const;
/** Extra routes run only after the host's auth, same-origin and device-role checks. */
export class PiVisualService {
  readonly store: ReviewStore;
  private tickets=new DesktopTickets();
  private tunnels=new Set<DesktopTunnel>();
  private deps: VisualDependencies;
  private probed?: { at: number; state: Awaited<ReturnType<typeof probeGuacd>> };
  constructor(stateDir: string,deps: Partial<VisualDependencies>={}) {
    this.store=new ReviewStore(stateDir);
    this.deps={guacdPort:4822,identity:originalPi,workers:readWorkers,image:conversationImage,viewers:paneId => discoverViewers(paneId),discovery:() => procViewerSystem.supported(),probe:probeGuacd,...deps};
  }
  /**
   * The desktop switch, HERDR_PI_GUACD_ENABLED=1, for this server's own browsers and for a
   * connection server alike: a bridge has it only when the connecting server started it so, for a
   * PC whose desktop viewing its user turned on (MachineManager.setDesktop).
   */
  private desktopEnabled(): boolean { return process.env["HERDR_PI_GUACD_ENABLED"]==="1"; }
  /** Whether a desktop can stream from this PC now. guacd answering says nothing yet about H.264. */
  async availability(caller: VisualCaller): Promise<PiDesktopAvailability> {
    if(!this.desktopEnabled()) return caller.relayed
      ? {state:"disabled",action:"enable_pc",message:"Desktop viewing is off for this PC. Turn it on here: its bridge restarts with it (herdr sessions keep running)."}
      : {state:"disabled",message:"Desktop viewing is off on this web server. Start it with HERDR_PI_GUACD_ENABLED=1 after installing guacd 1.6+ built with H.264."};
    const now=Date.now();
    if(!this.probed || now-this.probed.at>15_000) this.probed={at:now,state:await this.deps.probe(this.deps.guacdPort)};
    const state=this.probed.state;
    if(state==="guacd_missing") return {state,message:`No guacd answers on this PC's 127.0.0.1:${this.deps.guacdPort}. Start guacd 1.6+ built with FreeRDP H.264 there (docs/pi-visual-tools.md).`};
    if(state==="guacd_incompatible") return {state,message:`The guacd on this PC's 127.0.0.1:${this.deps.guacdPort} lacks certificate pinning. Install guacd 1.6+ built with FreeRDP H.264.`};
    return {state,message:"guacd answers on this PC's loopback. Whether it decodes H.264 shows only when a desktop connects."};
  }
  async handle(request: Request,url: URL,readOnly: boolean,deviceId?: string,caller: VisualCaller={relayed:false}): Promise<Response> {
    // Watch devices may otherwise read selected chat images, but must not gain arbitrary file access.
    if(readOnly) return jsonResponse({error:{code:"read_only",message:"Pi visual tools require an interactive device"}},403);
    try {
      const route=url.pathname.slice("/api/pane/pi-visual/".length);
      const paneId=url.searchParams.get("pane_id")??"";
      if(route==="workers" && request.method==="GET") {
        const pane=await this.deps.identity(paneId,url.searchParams.get("session")??undefined);
        const snapshot=this.deps.workers(pane);
        await this.deps.identity(paneId,pane.session);
        return jsonResponse(snapshot,200,{"cache-control":"no-store"});
      }
      if(route==="review/open" && request.method==="POST") {
        const value=await body(request); const source=reviewSource(value.source);
        const pane=await this.deps.identity(paneId,typeof value.session==="string" ? value.session : undefined);
        let image: {bytes:Uint8Array;mime:string;name:string};
        if(source.kind==="conversation") {
          const found=await this.deps.image(paneId,source.ref); if(!found) throw new VisualError("image_not_found","Image not found",404);
          image={bytes:found.bytes,mime:found.mediaType,name:typeof value.name==="string" ? value.name.slice(0,1024):"Image"};
        } else {
          const found=locateFile(source.path,pane.cwd);
          if(!found || !("info" in found)) throw new VisualError("image_not_found","Image path is unavailable or ambiguous",404);
          const fd=openSync(found.info.path,"r");
          try { const stat=fstatSync(fd); if(!stat.isFile() || stat.size>MAX_REVIEW_IMAGE_BYTES) throw new VisualError("image_too_large","Review images must be at most 16 MiB",413);
            const bytes=Buffer.alloc(stat.size); const size=readSync(fd,bytes,0,bytes.length,0);
            if(size!==stat.size || fstatSync(fd).mtimeMs!==stat.mtimeMs) throw new VisualError("image_changed","Image changed during read; reopen it",409);
            image={bytes,mime:found.info.mime,name:basename(found.info.path)};
          } finally {closeSync(fd);}
        }
        await this.deps.identity(paneId,pane.session);
        return jsonResponse(this.store.open(pane.session,image.bytes,image.name,image.mime),200,{"cache-control":"no-store"});
      }
      if(route==="review" || route==="review/image") {
        const session=url.searchParams.get("session")??"";
        if(!session) throw new VisualError("missing_session","Session identity is required");
        const pane=await this.deps.identity(paneId,session), id=url.searchParams.get("id")??"";
        if(route==="review/image" && request.method==="GET") {
          const image=this.store.image(pane.session,id);
          return new Response(image.bytes,{headers:{"content-type":image.mime,"cache-control":"private, no-store","x-content-type-options":"nosniff","content-security-policy":"default-src 'none'; sandbox"}});
        }
        if(route==="review" && request.method==="GET") return jsonResponse(this.store.get(pane.session,id),200,{"cache-control":"no-store"});
        if(route==="review" && request.method==="PUT") {
          const value=await body(request); await this.deps.identity(paneId,session);
          return jsonResponse(this.store.save(pane.session,id,value.revision,value.annotations),200,{"cache-control":"no-store"});
        }
      }
      if(route==="viewers" && request.method==="GET") {
        const pane=await this.deps.identity(paneId,url.searchParams.get("session")??undefined);
        // a lookup that failed (herdr busy, /proc unreadable) finds nothing; the panel keeps its manual form
        const viewers=this.deps.discovery() ? await this.deps.viewers(paneId).catch(() => []) : [];
        await this.deps.identity(paneId,pane.session);
        const answer: PiGuiViewers={session:pane.session,desktop:await this.availability(caller),discovery:this.deps.discovery()?"available":"unsupported",viewers:viewers.map(publicViewer),observedAt:Date.now()};
        return jsonResponse(answer,200,{"cache-control":"no-store"});
      }
      if(route==="desktop" && request.method==="POST") {
        if(!this.desktopEnabled()) throw new VisualError("desktop_disabled",(await this.availability(caller)).message,503);
        if(!caller.encrypted && !canSendSecret(request)) throw new VisualError("https_required",PRIVATE_DESKTOP_TRANSPORT,403);
        let requestFields: PiDesktopRequest|undefined; const value=await body(request);
        try {
          if(typeof value.worker==="string") {
            // `/gui view <worker>` run from this app: this PC finds that viewer and its connection fields itself
            const auto=autoRequest(value);
            if(!GUI_VIEW_NAME.test(auto.worker)) throw new VisualError("invalid_worker",`"${auto.worker}" is not a pi-gui desktop name (main, W1, …)`);
            const now=Date.now();
            // a connection server brings the command its browser ran; this server's browser has its own grant
            const relayedCommand=caller.relayed ? commandField(value.command) : undefined;
            const command=caller.relayed ? relayedCommand && {worker:relayedCommand.worker,at:now-relayedCommand.ageMs,consume:() => {}} : caller.command?.(paneId,auto.worker);
            if(!command) throw new VisualError("gui_view_required",`Enter ${auto.worker}'s one-time password, or run /gui view ${auto.worker} in this pane first`,403);
            const pane=await this.deps.identity(paneId,auto.session);
            const viewers=await this.deps.viewers(paneId);
            // the viewer the command named, the way pi-gui resolves names; without a name the only one it started
            const found=resolveViewer(viewers,command.worker,command.worker===null ? command.at-COMMAND_SLACK_MS : undefined);
            if("error" in found) throw new VisualError(found.error,found.message,VIEWER_STATUS[found.error]);
            const viewer=found.viewer as ViewerSecret, typed=command.worker===null ? "/gui view" : `/gui view ${command.worker}`;
            if(viewer.worker!==auto.worker) throw new VisualError("viewer_mismatch",`${typed} opens ${viewer.worker}, not ${auto.worker}`,409);
            if(viewer.pid!==auto.viewerPid) throw new VisualError("viewer_changed",`${viewer.worker}'s viewer was restarted; open it again`,409);
            // the Pi process that runs it was there when the command was typed: not a Pi started since in a reused pane
            if(viewer.piStartedAt>command.at+COMMAND_SLACK_MS) throw new VisualError("gui_view_required",`This pane's Pi started after ${typed}; run it again`,403);
            await this.deps.identity(paneId,auto.session);
            requestFields={session:auto.session,port:viewer.port,password:viewer.password,fingerprint:viewer.fingerprint,readOnly:auto.readOnly,width:auto.width,height:auto.height};
            const ticket=this.tickets.issue(pane,requestFields,desktopBinding(request,deviceId)); requestFields=undefined;
            command.consume();
            return jsonResponse(ticket,200,{"cache-control":"no-store"});
          }
          requestFields=desktopRequest(value); value.password="";
          const pane=await this.deps.identity(paneId,requestFields.session);
          const ticket=this.tickets.issue(pane,requestFields,desktopBinding(request,deviceId)); requestFields=undefined;
          return jsonResponse(ticket,200,{"cache-control":"no-store"});
        } finally {value.password=""; if(requestFields) requestFields.password="";}
      }
      return jsonResponse({error:{code:"not_found",message:"Unknown Pi visual endpoint or method"}},404);
    } catch(error) { return visualResponse(error); }
  }
  async take(request: Request,deviceId?: string): Promise<DesktopTunnel> {
    if(this.tunnels.size>=8) throw new VisualError("desktop_busy","Too many desktop connections",429);
    const ticket=this.tickets.take(new URL(request.url).searchParams.get("pi_desktop_ticket")??"",desktopBinding(request,deviceId));
    try {
      await this.deps.identity(ticket.pane.paneId,ticket.pane.session);
      const tunnel=new DesktopTunnel(ticket,() => this.deps.identity(ticket.pane.paneId,ticket.pane.session),this.deps.guacdPort); this.tunnels.add(tunnel); return tunnel;
    } catch(error) {ticket.request.password=""; throw error;}
  }
  release(tunnel: DesktopTunnel): void {this.tunnels.delete(tunnel); tunnel.close();}
  ended(paneId: string): void { for(const tunnel of this.tunnels) if(tunnel.pane.paneId===paneId) this.release(tunnel); }
  close(): void {this.tickets.close(); for(const tunnel of this.tunnels) tunnel.close(); this.tunnels.clear(); this.store.close();}
}
export type { PiPane };
