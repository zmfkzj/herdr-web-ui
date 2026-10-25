import { machinePath, paneStorageId } from "../../../shared/machines.ts";
import type { ImageAnnotation, ImageReviewDocument, PiGuiViewers, PiVisualWorkers, ReviewSource } from "../../../shared/pi-visual.ts";
import { composerDrafts } from "../composerDraft.ts";
import { appendQuote } from "../terminalQuote.ts";
import { MAX_COMPOSER_CHARS } from "../compose.ts";

export function visualUrl(machine: string,pane: string,route: string,query: Record<string,string>={}): string {
  return machinePath(machine,`pane/pi-visual/${route}?${new URLSearchParams({pane_id:pane,...query})}`);
}
/** A refused Pi visual request: `code` decides what the panel offers next (a password, a bridge install). */
export class VisualRequestError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) { super(message); }
}
export async function visualRequest<T>(url: string,method="GET",body?: unknown,signal?: AbortSignal): Promise<T> {
  const response=await fetch(url,{method,credentials:"same-origin",cache:"no-store",headers:{"content-type":"application/json","x-herdr-machine":"1"},...(body===undefined?{}:{body:JSON.stringify(body)}),signal});
  const result=await response.json().catch(()=>null);
  if(!response.ok) throw new VisualRequestError(typeof result?.error?.message==="string" ? result.error.message : "Pi visual request failed",typeof result?.error?.code==="string" ? result.error.code : "pi_visual_unavailable",response.status);
  return result as T;
}
/** The pi-gui viewers this pane's Pi runs on its PC, and whether that PC can stream a desktop now. */
export function fetchViewers(machine: string,pane: string,session: string|null,signal?: AbortSignal): Promise<PiGuiViewers> {
  return visualRequest<PiGuiViewers>(visualUrl(machine,pane,"viewers",session?{session}:{}),"GET",undefined,signal);
}
/**
 * Replaces a PC's bridge with this server's bundle, which carries the Pi visual routes (a bridge of
 * the same version from upstream's bundle does not). It runs like Update bridge: the PC list shows it.
 */
/**
 * Turns Pi desktop viewing on or off for one remote PC: on restarts its bridge with it when it runs
 * without (a job the PC list shows), off stops this server relaying its desktops at once.
 */
export function setPcDesktop(machine: string,enabled: boolean): Promise<{job: unknown}|{enabled: boolean}> {
  return visualRequest(`/api/machines/${encodeURIComponent(machine)}/pi-desktop`,"POST",{enabled});
}
export async function installPiVisualBridge(machine: string): Promise<void> {
  await visualRequest<unknown>(`/api/machines/${encodeURIComponent(machine)}/update-bridge?feature=pi-visual`,"POST");
}
export function sourceFromImage(src: string,machine: string,pane: string,origin: string): ReviewSource {
  const url=new URL(src,origin);
  if(url.origin!==origin || url.searchParams.get("pane_id")!==pane) throw new Error("Image does not belong to this pane");
  if(url.pathname===machinePath(machine,"pane/conversation/image") && url.searchParams.get("ref")) return {kind:"conversation",ref:url.searchParams.get("ref")!};
  if(url.pathname===machinePath(machine,"fs/file") && url.searchParams.get("path")) return {kind:"file",path:url.searchParams.get("path")!};
  throw new Error("Unsupported image source");
}
export async function checkSession(machine: string,pane: string,session: string,signal?: AbortSignal): Promise<void> {
  const result=await visualRequest<PiVisualWorkers>(visualUrl(machine,pane,"workers",{session}),"GET",undefined,signal);
  if(result.session!==session) throw new Error("Pi session changed; reopen visual tools");
}
export function addDraft(machine: string,pane: string,text: string): void {
  const key=`ovis:composer-draft:${paneStorageId(machine,pane)}`;
  composerDrafts.refresh(key); const draft=composerDrafts.read(key);
  if(draft.sending) throw new Error("A message is being sent. Try again afterwards.");
  const next=appendQuote(draft.text,text,MAX_COMPOSER_CHARS);
  if(next===null) throw new Error("Too long for the message draft");
  composerDrafts.set(key,next);
  // the pane's composer shows it as soon as it is there (the chat lens), never sending it
  composerDrafts.reveal(key);
}
/** Explicitly requested feedback, never automatically submitted to the agent. */
export function feedbackText(doc: ImageReviewDocument,imagePath: string,notes: ImageAnnotation[],heading: string): string {
  return `${heading}\n${JSON.stringify(imagePath)}\nImage SHA-256: ${doc.id}\n${notes.filter(n=>!n.resolved).map(n=> {
    const ordinal=notes.findIndex(other=>other.id===n.id)+1;
    const region=[n.x,n.y,n.width,n.height].map(v=>v.toFixed(4)).join(", ");
    return `${ordinal}. [x,y,w,h normalized: ${region}] ${n.text}`;
  }).join("\n")}`;
}
