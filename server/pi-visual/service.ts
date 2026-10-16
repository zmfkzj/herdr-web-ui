import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { basename } from "node:path";
import { object, reviewSource, type PiDesktopRequest } from "../../shared/pi-visual.ts";
import { jsonResponse } from "../http.ts";
import { conversationImage } from "../conversation.ts";
import { locateFile } from "../file-view.ts";
import { canSendSecret } from "../machine-security.ts";
import { originalPi, VisualError, type PiPane } from "./identity.ts";
import { readWorkers } from "./workers.ts";
import { MAX_REVIEW_IMAGE_BYTES, ReviewStore } from "./reviews.ts";
import { DesktopTickets, DesktopTunnel, desktopBinding, desktopRequest } from "./guacamole.ts";

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
}
/** Extra routes run only after the host's auth, same-origin and device-role checks. */
export class PiVisualService {
  readonly store: ReviewStore;
  private tickets=new DesktopTickets();
  private tunnels=new Set<DesktopTunnel>();
  private deps: VisualDependencies;
  constructor(stateDir: string,deps: Partial<VisualDependencies>={}) {
    this.store=new ReviewStore(stateDir);
    this.deps={guacdPort:4822,identity:originalPi,workers:readWorkers,image:conversationImage,...deps};
  }
  async handle(request: Request,url: URL,readOnly: boolean,deviceId?: string): Promise<Response> {
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
      if(route==="desktop" && request.method==="POST") {
        if(process.env["HERDR_PI_GUACD_ENABLED"]!=="1") throw new VisualError("desktop_disabled","Set HERDR_PI_GUACD_ENABLED=1 after installing local guacd 1.6+",503);
        if(!canSendSecret(request)) throw new VisualError("https_required","Use HTTPS or localhost for desktop credentials",403);
        let requestFields: PiDesktopRequest|undefined; const value=await body(request);
        try {
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
