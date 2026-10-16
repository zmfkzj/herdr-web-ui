import { useEffect, useRef, useState } from "react";
import { Monitor, Users } from "lucide-react";
import type { PiGuiViewers, PiVisualWorkers, WorkerState } from "../../../shared/pi-visual.ts";
import { useT } from "../../lib/i18n.ts";
import { usePageVisible } from "../../lib/visibility.ts";
import { fetchViewers, installPiVisualBridge, setPcDesktop, visualRequest, visualUrl, VisualRequestError } from "../../lib/pi-visual/api.ts";
import { DesktopViewer, type DesktopTarget } from "./DesktopViewer.tsx";
import "./PiVisual.css";

export function PiVisualTools({paneId,machineId,enabled}: {paneId:string;machineId:string;enabled:boolean}) {
  const t=useT(); const visible=usePageVisible(); const [open,setOpen]=useState(false);
  const [snapshot,setSnapshot]=useState<PiVisualWorkers|null>(null); const [error,setError]=useState("");
  const [viewers,setViewers]=useState<PiGuiViewers|null>(null);
  const [bridgeMissing,setBridgeMissing]=useState(false); const [bridgeNote,setBridgeNote]=useState("");
  // the plain viewer (`null` target) or one running viewer of this Pi
  const [desktop,setDesktop]=useState<{target?:DesktopTarget}|null>(null); const previousSession=useRef<string|null>(null);
  useEffect(()=>{
    if(!open||!visible||!enabled) {setDesktop(null);return;}
    let alive=true; let timer: ReturnType<typeof setTimeout>; const abort=new AbortController();
    const poll=async()=>{
      try { const value=await visualRequest<PiVisualWorkers>(visualUrl(machineId,paneId,"workers"),"GET",undefined,AbortSignal.any([abort.signal,AbortSignal.timeout(15000)]));
        if(alive) { if(previousSession.current && previousSession.current!==value.session) setDesktop(null); previousSession.current=value.session; setSnapshot(value); setError(""); setBridgeMissing(false); }
        // the desktops this Pi runs, and whether this PC can stream one now (its guacd, the switch)
        const found=await fetchViewers(machineId,paneId,value.session,AbortSignal.any([abort.signal,AbortSignal.timeout(15000)])).catch(()=>null);
        if(alive) setViewers(found);
      } catch(err) {
        if(alive) {setError(err instanceof Error?err.message:"Pi unavailable");setBridgeMissing(err instanceof VisualRequestError&&err.code==="pi_visual_bridge_required");setSnapshot(null);setViewers(null);setDesktop(null);}
      }
      if(alive) timer=setTimeout(()=>void poll(),2000);
    };
    void poll();return ()=>{alive=false;abort.abort();clearTimeout(timer);};
  },[open,visible,enabled,paneId,machineId]);
  const install=async()=>{
    setBridgeNote("");
    try { await installPiVisualBridge(machineId); setBridgeNote(t("The bridge update started. Follow it in the PC list, then open the desktop again.")); }
    catch(err) { setBridgeNote(err instanceof Error?err.message:"Pi unavailable"); }
  };
  const pcDesktop=async(enabled:boolean)=>{
    setBridgeNote("");
    try { const outcome=await setPcDesktop(machineId,enabled);
      setBridgeNote("job" in outcome?t("Desktop viewing is turning on: this PC's bridge restarts (herdr sessions keep running). Follow it in the PC list, then open the desktop again."):enabled?t("Desktop viewing is on for this PC."):t("Desktop viewing is off for this PC."));
      setViewers(null); }
    catch(err) { setBridgeNote(err instanceof Error?err.message:"Pi unavailable"); }
  };
  const state=(value:WorkerState):string=>({running:t("Running"),done:t("Completed"),failed:t("Failed"),cancelled:t("Cancelled"),interrupted:t("Interrupted"),queued:t("Queued"),unknown:t("Unknown")})[value];
  const ready=viewers?.desktop.state==="ready";
  return <details className="pi-visual-tools" open={open} onToggle={e=>setOpen(e.currentTarget.open)}>
    <summary><Users size={16} aria-hidden="true"/>{t("Pi workers and desktop")}</summary>
    {open && <div className="pi-visual-body">
      <p className="pi-visual-muted">{t("Original Pi · recorded orche state; refreshes while open")}</p>
      {error && <p role="alert">{error}</p>}
      {bridgeMissing && machineId!=="local" && <p><button type="button" className="btn" onClick={()=>void install()}>{t("Install Pi visual bridge")}</button></p>}
      {bridgeNote && <p className="pi-visual-muted">{bridgeNote}</p>}
      {!snapshot&&!error&&<p>{t("Loading…")}</p>}
      {snapshot && <>
        <div className="pi-desktop-form">
          <button type="button" className="btn" disabled={!enabled||(viewers!==null&&!ready)} onClick={()=>setDesktop({})}><Monitor size={16} aria-hidden="true"/>{t("Open private desktop")}</button>
          {/* a running viewer opens here at once after /gui view <name> from this app, otherwise with its password */}
          {ready&&viewers?.viewers.map(item=><button key={`${item.worker}:${item.pid}`} type="button" className="btn" disabled={!enabled} onClick={()=>setDesktop({target:{worker:item.worker,command:false}})}><Monitor size={16} aria-hidden="true"/>{t("{worker}'s desktop",{worker:item.worker})}</button>)}
        </div>
        {viewers&&!ready&&<p>{viewers.desktop.message}</p>}
        {viewers&&!ready&&viewers.desktop.action==="enable_pc"&&machineId!=="local"&&<p><button type="button" className="btn" onClick={()=>void pcDesktop(true)}>{t("Turn on desktop viewing for this PC")}</button></p>}
        {ready&&<p className="pi-visual-muted">{t("Run /gui view W1 in this pane (typed into the terminal or sent from the message box) to open that worker's desktop here at once.")}</p>}
        {ready&&machineId!=="local"&&<p><button type="button" className="btn" onClick={()=>void pcDesktop(false)}>{t("Turn off desktop viewing for this PC")}</button></p>}
        {!snapshot.workers.length&&<p>{t("No recorded orche jobs in this Pi branch.")}</p>}
        <div className="pi-worker-list">{snapshot.workers.map(worker=><article className="pi-worker" key={worker.job}>
          <header><strong>{worker.worker||worker.job}</strong><span>{worker.job} · {worker.role}</span><span className="pi-worker-state">{state(worker.state)}</span></header>
          <p>{worker.request}</p>
          <small>{[worker.model,worker.thinking,worker.lastTool].filter(Boolean).join(" · ")}</small>
          <small>{worker.started ? new Date(worker.started).toLocaleTimeString():""}{worker.ended ? ` → ${new Date(worker.ended).toLocaleTimeString()}`:""}</small>
          {worker.summary&&<details><summary>{t("Result")}</summary><p>{worker.summary}</p></details>}
          {!!worker.children.length&&<details><summary>{t("Recorded sub-workers")}</summary>{worker.children.map(child=><p key={child.id}>{child.id} · {child.role} · {child.model}</p>)}</details>}
        </article>)}</div>
        {snapshot.truncated&&<p>{t("Recent jobs only; complete history remains in Pi records.")}</p>}
        <p className="pi-visual-muted">{t("Use /orche commands for control; existing Pi approval rules are unchanged.")}</p>
      </>}
    </div>}
    {desktop&&snapshot&&enabled&&<DesktopViewer key={`${snapshot.session}:${desktop.target?.worker??""}`} paneId={paneId} machineId={machineId} session={snapshot.session} {...(desktop.target?{target:desktop.target}:{})} onClose={()=>setDesktop(null)}/>}
  </details>;
}
