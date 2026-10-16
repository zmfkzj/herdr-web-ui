import { useEffect, useRef, useState } from "react";
import { Monitor, Users } from "lucide-react";
import type { PiVisualWorkers, WorkerState } from "../../../shared/pi-visual.ts";
import { useT } from "../../lib/i18n.ts";
import { usePageVisible } from "../../lib/visibility.ts";
import { visualRequest, visualUrl } from "../../lib/pi-visual/api.ts";
import { DesktopViewer } from "./DesktopViewer.tsx";
import "./PiVisual.css";

export function PiVisualTools({paneId,machineId,enabled}: {paneId:string;machineId:string;enabled:boolean}) {
  const t=useT(); const visible=usePageVisible(); const [open,setOpen]=useState(false);
  const [snapshot,setSnapshot]=useState<PiVisualWorkers|null>(null); const [error,setError]=useState("");
  const [desktop,setDesktop]=useState(false); const previousSession=useRef<string|null>(null);
  useEffect(()=>{
    if(!open||!visible||!enabled) {setDesktop(false);return;}
    let alive=true; let timer: ReturnType<typeof setTimeout>; const abort=new AbortController();
    const poll=async()=>{
      try { const value=await visualRequest<PiVisualWorkers>(visualUrl(machineId,paneId,"workers"),"GET",undefined,AbortSignal.any([abort.signal,AbortSignal.timeout(15000)]));
        if(alive) { if(previousSession.current && previousSession.current!==value.session) setDesktop(false); previousSession.current=value.session; setSnapshot(value); setError(""); }
      } catch(err) { if(alive) {setError(err instanceof Error?err.message:"Pi unavailable");setSnapshot(null);setDesktop(false);} }
      if(alive) timer=setTimeout(()=>void poll(),2000);
    };
    void poll();return ()=>{alive=false;abort.abort();clearTimeout(timer);};
  },[open,visible,enabled,paneId,machineId]);
  const state=(value:WorkerState):string=>({running:t("Running"),done:t("Completed"),failed:t("Failed"),cancelled:t("Cancelled"),interrupted:t("Interrupted"),queued:t("Queued"),unknown:t("Unknown")})[value];
  return <details className="pi-visual-tools" open={open} onToggle={e=>setOpen(e.currentTarget.open)}>
    <summary><Users size={16} aria-hidden="true"/>{t("Pi workers and desktop")}</summary>
    {open && <div className="pi-visual-body">
      <p className="pi-visual-muted">{t("Original Pi · recorded orche state; refreshes while open")}</p>
      {error && <p role="alert">{error}</p>}
      {!snapshot&&!error&&<p>{t("Loading…")}</p>}
      {snapshot && <>
        <button type="button" className="btn" disabled={!enabled||machineId!=="local"} onClick={()=>setDesktop(true)}><Monitor size={16} aria-hidden="true"/>{t("Open private desktop")}</button>
        {machineId!=="local"&&<p>{t("For desktop viewing, open this app directly on the Pi host.")}</p>}
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
    {desktop&&snapshot&&enabled&&<DesktopViewer key={snapshot.session} paneId={paneId} machineId={machineId} session={snapshot.session} onClose={()=>setDesktop(false)}/>}
  </details>;
}
