import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { completionConflict, PI_INPUT_OPCODE, resolveViewer, type PiDesktopTicket, type PiGuiViewer, type PiInputMode, type PiVisualWorkers } from "../../../shared/pi-visual.ts";
import { useT } from "../../lib/i18n.ts";
import { useFocusTrap } from "../../lib/useFocusTrap.ts";
import { usePhoneSheetBack } from "../../lib/sheetHistory.ts";
import { visualUrl, visualRequest, checkSession, fetchViewers, installPiVisualBridge, setPcDesktop, VisualRequestError } from "../../lib/pi-visual/api.ts";
import "./PiVisual.css";

/**
 * The desktop to show. `command`: the user sent `/gui view <worker>` to this pane from this app,
 * which lets this browser open it without the password (server/pi-visual/grants.ts). Without that,
 * a found viewer still needs the password /gui view printed.
 */
export interface DesktopTarget { worker: string | null; command: boolean; completing?: boolean }
/** How long a viewer may take to appear: pi-gui waits up to 20 s for krdp, three ports at most. */
const FIND_MS = 45_000;
/** A name no orche record and no viewer knows is given up on sooner. */
const UNKNOWN_MS = 6_000;
/** How long the desktop has to confirm an input switch (PI_INPUT_OPCODE) before it counts as lost. */
const SWITCH_MS = 5_000;
type Pointer = { x: number; y: number; left: boolean; middle: boolean; right: boolean; up: boolean; down: boolean };

export function DesktopViewer({paneId,machineId,session,target,onClose}:{paneId:string;machineId:string;session:string|null;target?:DesktopTarget;onClose:()=>void}) {
  const t=useT(); const surface=useFocusTrap<HTMLDivElement>(true); const display=useRef<HTMLDivElement>(null);
  const password=useRef<HTMLInputElement>(null); const observe=useRef<HTMLInputElement>(null);
  const cleanup=useRef<()=>void>(()=>{}); const abort=useRef<AbortController|null>(null);
  const [state,setState]=useState<"idle"|"finding"|"connecting"|"connected">(target?"finding":"idle"); const [error,setError]=useState("");
  // the viewer /gui view started, once found; null while looking or for the plain manual form
  const [viewer,setViewer]=useState<PiGuiViewer|null>(null);
  // the password form: the plain viewer, a found viewer this browser has no grant for, or a PC that cannot look
  const [askPassword,setAskPassword]=useState(!target);
  const [note,setNote]=useState("");
  const [bridgeMissing,setBridgeMissing]=useState(false); const [installing,setInstalling]=useState(false);
  // this PC's desktop viewing is off: its user may turn it on here
  const [pcOff,setPcOff]=useState(false);
  const resolved=useRef<string|null>(session);
  const alive=useRef(true); const keyboardCleanup=useRef<()=>void>(()=>{});
  // the open connection's input mode as its desktop confirmed it, and its switch while one is asked
  const [inputMode,setInputMode]=useState<PiInputMode>("observe"); const [switching,setSwitching]=useState(false);
  const switchInput=useRef<((mode:PiInputMode)=>void)|null>(null);
  usePhoneSheetBack(onClose,true);
  const disconnect=()=>{
    const controller=abort.current; abort.current=null;
    controller?.abort(); cleanup.current(); cleanup.current=()=>{}; keyboardCleanup.current=()=>{};
    if(password.current) password.current.value="";
    if(alive.current) setState("idle");
  };
  useEffect(()=>{
    alive.current=true;
    const hidden=()=>{if(document.hidden)disconnect();};
    document.addEventListener("visibilitychange",hidden);window.addEventListener("pagehide",disconnect);
    return ()=>{alive.current=false;disconnect();document.removeEventListener("visibilitychange",hidden);window.removeEventListener("pagehide",disconnect);};
  },[]);
  const size=()=>({width:Math.max(200,Math.min(4096,Math.round(display.current?.clientWidth??1024))),height:768});
  /** One attempt: an abort that a newer attempt or a close owns ends it without touching that newer one. */
  const attempt=()=>{
    abort.current?.abort(); cleanup.current(); cleanup.current=()=>{};
    const controller=new AbortController(); abort.current=controller;
    const owns=()=>alive.current&&abort.current===controller&&!controller.signal.aborted;
    return {controller,owns};
  };
  const failWith=(owns:()=>boolean,controller:AbortController,message:string)=>{
    if(!owns())return;
    cleanup.current(); cleanup.current=()=>{}; abort.current=null; controller.abort();
    if(password.current)password.current.value="";
    setError(message);setState("idle");
  };
  /** Shows the desktop a ticket opens; the ticket is this server's, whichever PC the desktop is on. */
  const open=async(ticket:PiDesktopTicket,readOnly:boolean,controller:AbortController,owns:()=>boolean)=>{
    const {default:Guacamole}=await import("guacamole-common-js");
    if(!owns())return;
    const url=new URL("/ws",window.location.href);url.protocol=url.protocol==="https:"?"wss:":"ws:";
    const tunnel=new Guacamole.WebSocketTunnel(url.toString());const client=new Guacamole.Client(tunnel);const view=client.getDisplay();
    const host=display.current!;
    // Each connection owns a fresh keyboard target. Removing it also removes the
    // Guacamole DOM listeners, rather than accumulating listeners on the React host.
    const inputHost=document.createElement("div");inputHost.tabIndex=0;
    inputHost.setAttribute("role","application");inputHost.setAttribute("aria-label",t("Private desktop screen"));
    inputHost.appendChild(view.getElement());host.replaceChildren(inputHost);
    const resize=()=>{const w=view.getWidth();if(w>0)view.scale(Math.min(1,host.clientWidth/w));};
    const observer=new ResizeObserver(resize);observer.observe(host);view.onresize=resize;
    const keyboard=new Guacamole.Keyboard(inputHost);const mouse=new Guacamole.Mouse(view.getElement());
    // Input reaches the desktop only in the mode it confirmed: the ticket's start, then each switch
    // (PI_INPUT_OPCODE) the server answered. While a switch is asked nothing goes.
    let mode:PiInputMode=readOnly?"observe":"interact";
    let pending:{id:number;mode:PiInputMode;timer:ReturnType<typeof setTimeout>}|null=null; let nextId=0;
    let pointer:Pointer|null=null;
    const sending=()=>owns()&&mode==="interact"&&pending===null;
    const releasePointer=()=>{
      if(pointer&&(pointer.left||pointer.middle||pointer.right)&&sending())client.sendMouseState({...pointer,left:false,middle:false,right:false,up:false,down:false},true);
      pointer=null;
    };
    const onMouse=(state:Pointer)=>{if(sending()){pointer=state;client.sendMouseState(state,true);}};
    const attach=()=>{
      keyboard.reset();
      keyboard.onkeydown=key=>{if(sending())client.sendKeyEvent(1,key);return false;};
      keyboard.onkeyup=key=>{if(sending())client.sendKeyEvent(0,key);};
      mouse.onmousedown=mouse.onmouseup=mouse.onmousemove=onMouse;
    };
    /** lets go of what this browser holds on the desktop, then stops passing input */
    const detach=()=>{
      keyboard.reset();releasePointer();
      keyboard.onkeydown=null;keyboard.onkeyup=null;mouse.onmousedown=mouse.onmouseup=mouse.onmousemove=null;
      keyboard.reset();
    };
    if(mode==="interact")attach();
    const blur=()=>{keyboard.reset();releasePointer();}, focus=()=>inputHost.focus();
    inputHost.addEventListener("blur",blur);inputHost.addEventListener("pointerdown",focus);
    keyboardCleanup.current=blur;
    let disposed=false;
    const show=(next:PiInputMode,busy:boolean)=>{if(alive.current&&!disposed){setInputMode(next);setSwitching(busy);}};
    const answered=(args:string[])=>{
      const [granted,id,reason]=args;
      // a late, repeated or foreign answer changes nothing
      if(disposed||!pending||id!==String(pending.id)||(granted!=="observe"&&granted!=="interact"))return;
      const asked=pending.mode;clearTimeout(pending.timer);pending=null;
      if(asked==="observe"&&granted!=="observe"){mode="observe";failWith(owns,controller,t("The desktop did not confirm view-only mode, so this viewer disconnected to stop input."));return;}
      mode=granted;
      if(mode==="interact"){attach();inputHost.focus();} else detach();
      show(mode,false);
      if(granted!==asked&&alive.current)setError(reason||t("The desktop kept its input mode."));
    };
    const lost=(id:number)=>{
      if(disposed||!pending||pending.id!==id)return;
      const asked=pending.mode;pending=null;
      // input was never let through for this switch; view-only unconfirmed ends the connection
      if(asked==="observe"){mode="observe";failWith(owns,controller,t("The desktop did not confirm view-only mode, so this viewer disconnected to stop input."));return;}
      show(mode,false);
      if(alive.current)setError(t("The desktop did not confirm the input switch. Its PC may run an older Pi visual bridge: install this server's bridge there, or reconnect with Observe only unchecked."));
    };
    const request=(next:PiInputMode)=>{
      if(disposed||pending||next===mode||!owns())return;
      if(next==="observe")detach();
      const id=++nextId;pending={id,mode:next,timer:setTimeout(()=>lost(id),SWITCH_MS)};
      if(alive.current){setError("");setSwitching(true);}
      tunnel.sendMessage(PI_INPUT_OPCODE,next,id);
    };
    // Guacamole.Client handles every other instruction; the switch's answer only passes by
    const handle=tunnel.oninstruction;
    tunnel.oninstruction=(opcode,args)=>{if(opcode===PI_INPUT_OPCODE)answered(args);handle?.(opcode,args);};
    const dispose=()=>{
      if(disposed)return;
      detach();disposed=true;
      if(pending){clearTimeout(pending.timer);pending=null;}
      if(switchInput.current===request)switchInput.current=null;
      if(alive.current)setSwitching(false);
      observer.disconnect();view.onresize=null;
      inputHost.removeEventListener("blur",blur);inputHost.removeEventListener("pointerdown",focus);
      client.onerror=null;client.onstatechange=null;tunnel.onerror=null;tunnel.oninstruction=handle;
      client.disconnect();inputHost.remove();
      if(cleanup.current===dispose){cleanup.current=()=>{};keyboardCleanup.current=()=>{};}
    };
    cleanup.current=dispose;
    client.onerror=tunnel.onerror=status=>failWith(owns,controller,status.message||t("Desktop disconnected"));
    client.onstatechange=value=>{
      if(!owns())return;
      if(value===3){switchInput.current=request;show(mode,false);setState("connected");inputHost.focus();}
      else if(value===5){dispose();abort.current=null;controller.abort();setState("idle");}
    };
    client.connect(new URLSearchParams({pi_desktop_ticket:ticket.ticket}).toString());
  };
  /** Looks for the viewer the target names until it runs, then opens it, or asks for its password. */
  const find=async()=>{
    if(!target)return;
    const {controller,owns}=attempt();
    setError("");setNote("");setBridgeMissing(false);setPcOff(false);setState("finding");
    const readOnly=observe.current?.checked??true;
    const started=Date.now();let since:number|undefined;let known:Set<string>|null=null;let seen:number|null=null;let names:string[]|null=null;
    try {
      while(Date.now()-started<FIND_MS){
        const answer=await fetchViewers(machineId,paneId,resolved.current,controller.signal);
        if(!owns())return;
        if(resolved.current&&answer.session!==resolved.current)throw new Error(t("Pi session changed; reopen visual tools"));
        resolved.current=answer.session; since??=answer.observedAt-3000;
        // never a control that cannot work: say what this PC lacks instead
        if(answer.desktop.state!=="ready"){ if(answer.desktop.action==="enable_pc"&&machineId!=="local")setPcOff(true); throw new Error(answer.desktop.message); }
        // Enter took Pi's highlighted completion: a longer name may have run instead of the typed one
        if(target.completing&&target.worker!==null){
          if(names===null){
            const workers=await visualRequest<PiVisualWorkers>(visualUrl(machineId,paneId,"workers",{session:answer.session}),"GET",undefined,controller.signal);
            if(!owns())return;
            names=["main",...workers.workers.map(item=>item.worker)];
          }
          const other=completionConflict(target.worker,[...names,...answer.viewers.map(item=>item.worker)]);
          if(other)throw new Error(t("Pi's completion list was open when Enter was pressed, and it offers {other} for {worker} too: Pi may have opened that one. Press Esc before Enter, or send /gui view {worker} from the message box.",{worker:target.worker,other}));
        }
        if(answer.discovery==="unsupported"){setNote(t("This PC cannot find pi-gui viewers by itself (it needs Linux). Enter the fields /gui view printed in Pi's terminal."));setAskPassword(true);setState("idle");abort.current=null;return;}
        const found=resolveViewer(answer.viewers,target.worker,target.worker===null?since:undefined);
        if("viewer" in found){
          // the same krdp twice in a row: not the one a desktop replacement is about to stop
          if(seen===found.viewer.pid){setViewer(found.viewer);await connectTo(found.viewer,readOnly,controller,owns);return;}
          seen=found.viewer.pid;
        } else if(found.error!=="viewer_missing")throw new Error(found.message);
        else {
          seen=null;
          if(target.worker===null)throw new Error(found.message);
          if(known===null&&Date.now()-started>UNKNOWN_MS){
            const workers=await visualRequest<PiVisualWorkers>(visualUrl(machineId,paneId,"workers",{session:answer.session}),"GET",undefined,controller.signal);
            known=new Set(["main",...workers.workers.map(item=>item.worker.toLowerCase())]);
            if(!known.has(target.worker.toLowerCase().replace(/-\d+$/,""))&&!known.has(target.worker.toLowerCase()))throw new Error(t("No GUI desktop named {worker} in this Pi session. Check the name in /gui view list.",{worker:target.worker}));
          }
        }
        await new Promise<void>(resolve=>{const timer=setTimeout(resolve,1000);controller.signal.addEventListener("abort",()=>{clearTimeout(timer);resolve();},{once:true});});
        if(!owns())return;
      }
      throw new Error(t("{worker} has no running viewer. Pi's terminal shows why /gui view did not start it.",{worker:target.worker??"?"}));
    } catch(err) {
      if(err instanceof VisualRequestError&&err.code==="pi_visual_bridge_required")setBridgeMissing(true);
      if(err instanceof VisualRequestError&&err.code==="pc_desktop_off"&&machineId!=="local")setPcOff(true);
      failWith(owns,controller,err instanceof Error?err.message:t("Desktop disconnected"));
    }
  };
  /** A found viewer: this browser's /gui view opens it as it is; without that grant, its password is asked. */
  const connectTo=async(found:PiGuiViewer,readOnly:boolean,controller:AbortController,owns:()=>boolean)=>{
    setState("connecting");
    try {
      const ticket=await visualRequest<PiDesktopTicket>(visualUrl(machineId,paneId,"desktop"),"POST",{session:resolved.current,worker:found.worker,viewerPid:found.pid,readOnly,...size()},controller.signal);
      if(!owns())return;
      await open(ticket,readOnly,controller,owns);
    } catch(err) {
      if(err instanceof VisualRequestError&&err.code==="gui_view_required"){
        if(!owns())return;
        abort.current=null;setAskPassword(true);setState("idle");
        setNote(t("Enter {worker}'s one-time password from the /gui view output in Pi's terminal.",{worker:found.worker}));
        return;
      }
      throw err;
    }
  };
  useEffect(()=>{if(target)void find();},[]);
  const start=async(event:FormEvent<HTMLFormElement>)=>{
    event.preventDefault(); if(state!=="idle")return;
    if(target&&!askPassword){void find();return;}
    const {controller,owns}=attempt();
    setError("");setState("connecting");
    const fields=event.currentTarget.elements;
    const port=Number((fields.namedItem("port") as HTMLInputElement).value), fingerprint=(fields.namedItem("fingerprint") as HTMLInputElement).value;
    const readOnly=observe.current?.checked??true;
    try {
      const current=resolved.current;
      if(current)await checkSession(machineId,paneId,current,controller.signal);
      if(!owns())return;
      // Read the secret only for this explicit connect action; never retain it in React state.
      const connection={session:current,port,password:password.current?.value??"",fingerprint,readOnly,...size()};
      const pending=visualRequest<PiDesktopTicket>(visualUrl(machineId,paneId,"desktop"),"POST",connection,controller.signal);
      connection.password=""; if(password.current)password.current.value="";
      const ticket=await pending;
      if(!owns())return;
      await open(ticket,readOnly,controller,owns);
    } catch(err){failWith(owns,controller,err instanceof Error?err.message:t("Desktop disconnected"));}
  };
  const install=async()=>{
    setInstalling(true);
    try { await installPiVisualBridge(machineId); if(alive.current)setNote(t("The bridge update started. Follow it in the PC list, then open the desktop again.")); }
    catch(err) { if(alive.current)setError(err instanceof Error?err.message:t("Desktop disconnected")); }
    finally { if(alive.current)setInstalling(false); }
  };
  const turnOn=async()=>{
    setInstalling(true);
    try { const outcome=await setPcDesktop(machineId,true); if(!alive.current)return;
      if("job" in outcome)setNote(t("Desktop viewing is turning on: this PC's bridge restarts (herdr sessions keep running). Follow it in the PC list, then open the desktop again."));
      else {setPcOff(false);void find();} }
    catch(err) { if(alive.current)setError(err instanceof Error?err.message:t("Desktop disconnected")); }
    finally { if(alive.current)setInstalling(false); }
  };
  const title=target?.worker?t("{worker}'s private desktop",{worker:target.worker}):viewer?t("{worker}'s private desktop",{worker:viewer.worker}):t("Private desktop");
  const busy=state!=="idle";
  return createPortal(<div className="modal-scrim pi-visual-scrim"><div className="pi-visual-modal" ref={surface} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
    <header><h2>{title}</h2><button type="button" className="icon-button" onClick={onClose} aria-label={t("Close")}><X aria-hidden="true"/></button></header>
    {target
      ? <p role="status">{state==="finding"?t("Waiting for {worker}'s viewer from /gui view…",{worker:target.worker??"?"}):state==="connecting"?t("Connecting…"):state==="connected"?(inputMode==="interact"?t("Input is on. Do not use the desktop while the worker is acting on it."):t("Connected. Pause the worker before taking control.")):t("Pause the worker before taking control.")}</p>
      : <p>{t("Run /gui view W1 or /gui view main in Pi, then enter its connection fields. Pause the worker before taking control.")}</p>}
    <form key={viewer?.pid??"manual"} onSubmit={event=>void start(event)} className="pi-desktop-form" autoComplete="off">
      {askPassword&&<>
        <label>{t("RDP port")}<input className="input" name="port" type="number" min={1024} max={65535} required disabled={busy} defaultValue={viewer?.port}/></label>
        <label>{t("One-time viewer password")}<input className="input" ref={password} type="password" maxLength={256} autoComplete="off" required disabled={busy}/></label>
        <label className="pi-fingerprint">{t("Certificate SHA-256")}<input className="input" name="fingerprint" maxLength={200} required disabled={busy} defaultValue={viewer?.fingerprint}/></label>
      </>}
      {state==="connected"
        ? <>
          <span role="status" className={inputMode==="interact"?"pi-desktop-mode is-input":"pi-desktop-mode"}>{switching?t("Switching input…"):inputMode==="interact"?t("Input on: mouse and keyboard reach the desktop"):t("View only: input is blocked")}</span>
          <button type="button" className="btn" aria-pressed={inputMode==="interact"} disabled={switching} onClick={()=>switchInput.current?.(inputMode==="interact"?"observe":"interact")}>{t("Switch input")}</button>
        </>
        : <label><input ref={observe} name="observe" type="checkbox" defaultChecked disabled={busy}/>{t("Observe only")}</label>}
      <button type="submit" className="btn" disabled={busy}>{state==="connecting"?t("Connecting…"):t("Connect")}</button>
      <button type="button" className="btn" disabled={state==="idle"} onClick={disconnect}>{t("Disconnect")}</button>
    </form>
    {note&&<p className="pi-visual-muted">{note}</p>}
    {error&&<p role="alert">{error}</p>}
    {bridgeMissing&&machineId!=="local"&&<button type="button" className="btn" disabled={installing} onClick={()=>void install()}>{t("Install Pi visual bridge")}</button>}
    {pcOff&&<button type="button" className="btn" disabled={installing} onClick={()=>void turnOn()}>{t("Turn on desktop viewing for this PC")}</button>}
    <div className="pi-desktop-display" ref={display} onKeyDownCapture={event=>{if(event.key==="Escape"&&event.shiftKey){event.stopPropagation();event.preventDefault();keyboardCleanup.current();(surface.current?.querySelector("button") as HTMLButtonElement)?.focus();}}}/>
    <p className="pi-visual-muted">{t("Shift+Escape leaves screen focus. Closing this viewer keeps Pi and its desktop running. Switch input takes or hands back control without reconnecting; a reconnect asks for the password again.")}</p>
  </div></div>,document.body);
}
