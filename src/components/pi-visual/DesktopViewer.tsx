import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { PiDesktopTicket } from "../../../shared/pi-visual.ts";
import { useT } from "../../lib/i18n.ts";
import { useFocusTrap } from "../../lib/useFocusTrap.ts";
import { usePhoneSheetBack } from "../../lib/sheetHistory.ts";
import { visualUrl, visualRequest, checkSession } from "../../lib/pi-visual/api.ts";
import "./PiVisual.css";

export function DesktopViewer({paneId,machineId,session,onClose}:{paneId:string;machineId:string;session:string;onClose:()=>void}) {
  const t=useT(); const surface=useFocusTrap<HTMLDivElement>(true); const display=useRef<HTMLDivElement>(null);
  const password=useRef<HTMLInputElement>(null); const cleanup=useRef<()=>void>(()=>{}); const abort=useRef<AbortController|null>(null);
  const [state,setState]=useState<"idle"|"connecting"|"connected">("idle"); const [error,setError]=useState("");
  const alive=useRef(true); const keyboardCleanup=useRef<()=>void>(()=>{});
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
  const start=async(event:FormEvent<HTMLFormElement>)=>{
    event.preventDefault(); if(state!=="idle"||abort.current)return;
    setError("");setState("connecting");
    const fields=event.currentTarget.elements;
    const port=Number((fields.namedItem("port") as HTMLInputElement).value), fingerprint=(fields.namedItem("fingerprint") as HTMLInputElement).value;
    const readOnly=(fields.namedItem("observe") as HTMLInputElement).checked;
    const controller=new AbortController(); abort.current=controller;
    const ownsAttempt=()=>alive.current&&abort.current===controller&&!controller.signal.aborted;
    let disposeAttempt:()=>void=()=>{};
    const failed=(message:string)=>{
      // A late response from an aborted attempt must not close a newer connection
      // or erase the password the user has entered for that newer attempt.
      if(!ownsAttempt())return;
      disposeAttempt(); abort.current=null; controller.abort();
      if(password.current)password.current.value="";
      setError(message);setState("idle");
    };
    try {
      await checkSession(machineId,paneId,session,controller.signal);
      if(!ownsAttempt())return;
      // Read the secret only for this explicit connect action; never retain it in React state.
      const connection={session,port,password:password.current?.value??"",fingerprint,readOnly,width:Math.max(200,Math.min(4096,Math.round(display.current?.clientWidth??1024))),height:768};
      const pending=visualRequest<PiDesktopTicket>(visualUrl(machineId,paneId,"desktop"),"POST",connection,controller.signal);
      connection.password=""; if(password.current)password.current.value="";
      const ticket=await pending;
      if(!ownsAttempt())return;
      const {default:Guacamole}=await import("guacamole-common-js");
      if(!ownsAttempt())return;
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
      if(!readOnly){
        keyboard.onkeydown=key=>{if(ownsAttempt())client.sendKeyEvent(1,key);return false;};
        keyboard.onkeyup=key=>client.sendKeyEvent(0,key);
        mouse.onmousedown=mouse.onmouseup=mouse.onmousemove=mouseState=>{if(ownsAttempt())client.sendMouseState(mouseState,true);};
      }
      const blur=()=>keyboard.reset(), focus=()=>inputHost.focus();
      inputHost.addEventListener("blur",blur);inputHost.addEventListener("pointerdown",focus);
      keyboardCleanup.current=blur;
      let disposed=false;
      disposeAttempt=()=>{
        if(disposed)return;disposed=true;
        observer.disconnect();view.onresize=null;
        inputHost.removeEventListener("blur",blur);inputHost.removeEventListener("pointerdown",focus);
        keyboard.reset();keyboard.onkeydown=null;keyboard.onkeyup=null;
        mouse.onmousedown=mouse.onmouseup=mouse.onmousemove=null;
        client.onerror=null;client.onstatechange=null;tunnel.onerror=null;
        client.disconnect();inputHost.remove();
        if(cleanup.current===disposeAttempt){cleanup.current=()=>{};keyboardCleanup.current=()=>{};}
      };
      cleanup.current=disposeAttempt;
      client.onerror=tunnel.onerror=status=>failed(status.message||t("Desktop disconnected"));
      client.onstatechange=value=>{
        if(!ownsAttempt())return;
        if(value===3){setState("connected");inputHost.focus();}
        else if(value===5){disposeAttempt();abort.current=null;controller.abort();setState("idle");}
      };
      client.connect(new URLSearchParams({pi_desktop_ticket:ticket.ticket}).toString());
    } catch(err){failed(err instanceof Error?err.message:t("Desktop disconnected"));}
  };
  return createPortal(<div className="modal-scrim pi-visual-scrim"><div className="pi-visual-modal" ref={surface} role="dialog" aria-modal="true" aria-label={t("Private desktop")} tabIndex={-1}>
    <header><h2>{t("Private desktop")}</h2><button type="button" className="icon-button" onClick={onClose} aria-label={t("Close")}><X aria-hidden="true"/></button></header>
    <p>{t("Run /gui view W1 or /gui view main in Pi, then enter its connection fields. Pause the worker before taking control.")}</p>
    <form onSubmit={event=>void start(event)} className="pi-desktop-form" autoComplete="off">
      <label>{t("RDP port")}<input className="input" name="port" type="number" min={1024} max={65535} required disabled={state!=="idle"}/></label>
      <label>{t("One-time viewer password")}<input className="input" ref={password} type="password" maxLength={256} autoComplete="off" required disabled={state!=="idle"}/></label>
      <label className="pi-fingerprint">{t("Certificate SHA-256")}<input className="input" name="fingerprint" maxLength={200} required disabled={state!=="idle"}/></label>
      <label><input name="observe" type="checkbox" defaultChecked disabled={state!=="idle"}/>{t("Observe only")}</label>
      <button type="submit" className="btn" disabled={state!=="idle"}>{state==="connecting"?t("Connecting…"):t("Connect")}</button>
      <button type="button" className="btn" disabled={state==="idle"} onClick={disconnect}>{t("Disconnect")}</button>
    </form>
    {error&&<p role="alert">{error}</p>}
    <div className="pi-desktop-display" ref={display} onKeyDownCapture={event=>{if(event.key==="Escape"&&event.shiftKey){event.stopPropagation();event.preventDefault();keyboardCleanup.current();(surface.current?.querySelector("button") as HTMLButtonElement)?.focus();}}}/>
    <p className="pi-visual-muted">{t("Shift+Escape leaves screen focus. Closing this viewer keeps Pi and its desktop running. Reconnect requires the password again.")}</p>
  </div></div>,document.body);
}
