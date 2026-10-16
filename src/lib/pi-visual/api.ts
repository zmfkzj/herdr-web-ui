import { machinePath, paneStorageId } from "../../../shared/machines.ts";
import type { ImageAnnotation, ImageReviewDocument, PiVisualWorkers, ReviewSource } from "../../../shared/pi-visual.ts";
import { composerDrafts } from "../composerDraft.ts";
import { appendQuote } from "../terminalQuote.ts";
import { MAX_COMPOSER_CHARS } from "../compose.ts";

export function visualUrl(machine: string,pane: string,route: string,query: Record<string,string>={}): string {
  return machinePath(machine,`pane/pi-visual/${route}?${new URLSearchParams({pane_id:pane,...query})}`);
}
export async function visualRequest<T>(url: string,method="GET",body?: unknown,signal?: AbortSignal): Promise<T> {
  const response=await fetch(url,{method,credentials:"same-origin",cache:"no-store",headers:{"content-type":"application/json","x-herdr-machine":"1"},...(body===undefined?{}:{body:JSON.stringify(body)}),signal});
  const result=await response.json();
  if(!response.ok) throw new Error(typeof result?.error?.message==="string" ? result.error.message : "Pi visual request failed");
  return result as T;
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
  const key=`herdr-web-ui:composer-draft:${paneStorageId(machine,pane)}`;
  composerDrafts.refresh(key); const draft=composerDrafts.read(key);
  if(draft.sending) throw new Error("A message is being sent. Try again afterwards.");
  const next=appendQuote(draft.text,text,MAX_COMPOSER_CHARS);
  if(next===null) throw new Error("Too long for the message draft");
  composerDrafts.set(key,next);
}
/** Explicitly requested feedback, never automatically submitted to the agent. */
export function feedbackText(doc: ImageReviewDocument,imagePath: string,notes: ImageAnnotation[],heading: string): string {
  return `${heading}\n${JSON.stringify(imagePath)}\nImage SHA-256: ${doc.id}\n${notes.filter(n=>!n.resolved).map(n=> {
    const ordinal=notes.findIndex(other=>other.id===n.id)+1;
    const region=[n.x,n.y,n.width,n.height].map(v=>v.toFixed(4)).join(", ");
    return `${ordinal}. [x,y,w,h normalized: ${region}] ${n.text}`;
  }).join("\n")}`;
}
