import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { MessageSquare, Minus, Plus, X } from "lucide-react";
import { rectangle, MAX_ANNOTATIONS, type ImageAnnotation, type ImageReviewDocument } from "../../../shared/pi-visual.ts";
import type { GalleryImage } from "../../lib/imageViewer.ts";
import { useT } from "../../lib/i18n.ts";
import { useFocusTrap } from "../../lib/useFocusTrap.ts";
import { usePhoneSheetBack } from "../../lib/sheetHistory.ts";
import { uploadPaneImage } from "../../lib/api.ts";
import { addDraft, checkSession, feedbackText, sourceFromImage, visualRequest, visualUrl } from "../../lib/pi-visual/api.ts";
import "./PiVisual.css";

/** `onDraft` closes the review and shows the pane's message box, where the feedback went; null while no message box can show it. */
export function ImageReview({paneId,machineId,image,onClose,onDraft}:{paneId:string;machineId:string;image:GalleryImage;onClose:()=>void;onDraft:(()=>void)|null}) {
  const handedOff=useRef(false),draftTo=useRef(onDraft);draftTo.current=onDraft;
  const commentId=useId();const t=useT();const surface=useFocusTrap<HTMLDivElement>(true,{shouldRestore:()=>!handedOff.current});const picture=useRef<HTMLImageElement>(null);
  const [doc,setDoc]=useState<ImageReviewDocument|null>(null),[notes,setNotes]=useState<ImageAnnotation[]>([]);
  const [selected,setSelected]=useState<string|null>(null),[zoom,setZoom]=useState(1),[dirty,setDirty]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const [dimensions,setDimensions]=useState({width:1000,height:1000});
  const [preview,setPreview]=useState<ReturnType<typeof rectangle>|null>(null);
  const pointer=useRef<{id:number;from:{x:number;y:number}}|null>(null),alive=useRef(true),lock=useRef(false);
  const close=()=>{if(!busy&&(!dirty||window.confirm(t("Discard unsaved image comments?"))))onClose();};
  usePhoneSheetBack(close,true);
  useEffect(()=>{
    alive.current=true;const controller=new AbortController();
    void (async()=>{
      try {
        const source=sourceFromImage(image.src,machineId,paneId,window.location.origin);
        const identity=await visualRequest<{session:string}>(visualUrl(machineId,paneId,"workers"),"GET",undefined,controller.signal);
        const value=await visualRequest<ImageReviewDocument>(visualUrl(machineId,paneId,"review/open"),"POST",{source,name:image.name,session:identity.session},controller.signal);
        if(alive.current){setDoc(value);setNotes(value.annotations);}
      }catch(err){if(alive.current&&!controller.signal.aborted)setError(err instanceof Error?err.message:t("Image unavailable"));}
    })();
    return()=>{alive.current=false;controller.abort();};
  },[paneId,machineId,image.src,image.name,t]);
  const change=(next:ImageAnnotation[])=>{setNotes(next);setDirty(true);setNotice("");};
  const add=(area:ReturnType<typeof rectangle>)=>{
    if(notes.length>=MAX_ANNOTATIONS||busy)return;
    const item:ImageAnnotation={id:crypto.randomUUID(),...area,text:"",resolved:false};change([...notes,item]);setSelected(item.id);
  };
  const point=(event:ReactPointerEvent<SVGSVGElement>)=>{const bounds=event.currentTarget.getBoundingClientRect();return {x:Math.min(1,Math.max(0,(event.clientX-bounds.left)/bounds.width)),y:Math.min(1,Math.max(0,(event.clientY-bounds.top)/bounds.height))};};
  const down=(event:ReactPointerEvent<SVGSVGElement>)=>{
    if(busy||!doc||event.button!==0||pointer.current)return;event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);
    pointer.current={id:event.pointerId,from:point(event)};setPreview(rectangle(pointer.current.from,pointer.current.from));
  };
  const move=(event:ReactPointerEvent<SVGSVGElement>)=>{if(pointer.current?.id===event.pointerId)setPreview(rectangle(pointer.current.from,point(event)));};
  const up=(event:ReactPointerEvent<SVGSVGElement>)=>{
    if(pointer.current?.id!==event.pointerId)return;
    if(event.type!=="pointercancel") {const area=rectangle(pointer.current.from,point(event));add(area.width<0.005&&area.height<0.005?{...area,width:0,height:0}:area);}
    pointer.current=null;setPreview(null);
  };
  const persist=async():Promise<ImageReviewDocument>=>{
    if(!doc)throw new Error(t("Image unavailable"));
    const value=await visualRequest<ImageReviewDocument>(visualUrl(machineId,paneId,"review",{session:doc.session,id:doc.id}),"PUT",{revision:doc.revision,annotations:notes});
    if(alive.current){setDoc(value);setDirty(false);}return value;
  };
  const save=async()=>{
    if(lock.current)return;lock.current=true;setBusy(true);setError("");
    try{await persist();if(alive.current)setNotice(t("Saved"));}catch(err){if(alive.current)setError(err instanceof Error?err.message:t("Save failed"));}
    finally{lock.current=false;if(alive.current)setBusy(false);}
  };
  const feedback=async()=>{
    if(lock.current||!doc)return;lock.current=true;setBusy(true);setError("");
    try {
      if(!notes.some(n=>!n.resolved&&n.text.trim()))throw new Error(t("Add a comment before creating feedback."));
      if(!draftTo.current)throw new Error(t("The message box is not available right now."));
      const value=dirty?await persist():doc;const source=picture.current;
      if(!source?.complete||!source.naturalWidth||!source.naturalHeight)throw new Error(t("Image unavailable"));
      if(source.naturalWidth*source.naturalHeight>100_000_000)throw new Error(t("Image is too large to annotate."));
      const scale=Math.min(1,4096/Math.max(source.naturalWidth,source.naturalHeight));
      const canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.round(source.naturalWidth*scale));canvas.height=Math.max(1,Math.round(source.naturalHeight*scale));
      const ctx=canvas.getContext("2d");if(!ctx)throw new Error(t("Image unavailable"));ctx.drawImage(source,0,0,canvas.width,canvas.height);
      const color=getComputedStyle(surface.current!).getPropertyValue("--accent").trim();ctx.strokeStyle=color;ctx.fillStyle=color;
      const radius=Math.max(10,Math.min(28,canvas.width/70));ctx.lineWidth=Math.max(2,radius/5);ctx.font=`bold ${radius}px sans-serif`;
      for(const [index,note] of notes.entries()){
        if(note.resolved)continue;const x=note.x*canvas.width,y=note.y*canvas.height;
        if(note.width||note.height)ctx.strokeRect(x,y,note.width*canvas.width,note.height*canvas.height);
        const cx=Math.min(canvas.width-radius,Math.max(radius,x)),cy=Math.min(canvas.height-radius,Math.max(radius,y));
        ctx.beginPath();ctx.arc(cx,cy,radius,0,Math.PI*2);ctx.fill();ctx.fillStyle=getComputedStyle(surface.current!).getPropertyValue("--bg").trim();ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillText(String(index+1),cx,cy);ctx.fillStyle=color;
      }
      const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error(t("Image unavailable"))),"image/png"));
      await checkSession(machineId,paneId,value.session);if(!alive.current)return;
      const path=await uploadPaneImage(paneId,new File([blob],`review-${value.id.slice(0,12)}.png`,{type:"image/png"}),machineId);
      await checkSession(machineId,paneId,value.session);if(!alive.current)return;
      // the pane may have stopped taking input during the upload: nothing is added where it cannot be seen
      const show=draftTo.current;if(!show)throw new Error(t("The message box is not available right now."));
      addDraft(machineId,paneId,feedbackText(value,path,notes,t("Please revise the marked image using these comments:")));
      handedOff.current=true;show();
    }catch(err){if(alive.current)setError(err instanceof Error?err.message:t("Save failed"));}
    finally{lock.current=false;if(alive.current)setBusy(false);}
  };
  const patch=(id:string,fields:Partial<ImageAnnotation>)=>change(notes.map(n=>n.id===id?{...n,...fields}:n));
  const overlay=(area:ReturnType<typeof rectangle>,label:string,key:string,resolved=false)=>{
    const {width:w,height:h}=dimensions, radius=Math.max(10,Math.min(w,h)/40);
    const x=Math.min(w-radius,Math.max(radius,area.x*w)), y=Math.min(h-radius,Math.max(radius,area.y*h));
    return <g key={key} className={resolved?"is-resolved":undefined}>
      {!!(area.width||area.height)&&<rect x={area.x*w} y={area.y*h} width={area.width*w} height={area.height*h} vectorEffect="non-scaling-stroke"/>}
      <circle cx={x} cy={y} r={radius}/><text x={x} y={y} style={{fontSize:radius*1.2}} textAnchor="middle" dominantBaseline="central">{label}</text>
    </g>;
  };
  return createPortal(<div className="modal-scrim pi-visual-scrim"><div className="pi-visual-modal pi-review" ref={surface} role="dialog" aria-modal="true" aria-label={t("Image comments")} tabIndex={-1} onKeyDown={event=>{if(event.key==="Escape"){event.stopPropagation();close();}}}>
    <header><h2>{t("Image comments")}</h2><span className="pi-visual-muted">{doc?.name??image.name}</span><button type="button" className="icon-button" disabled={busy} onClick={close} aria-label={t("Close")}><X aria-hidden="true"/></button></header>
    <div className="pi-review-toolbar">
      <button type="button" className="icon-button" onClick={()=>setZoom(z=>Math.max(1,z-0.5))} aria-label={t("Zoom out")}><Minus aria-hidden="true"/></button><span>{Math.round(zoom*100)}%</span>
      <button type="button" className="icon-button" onClick={()=>setZoom(z=>Math.min(4,z+0.5))} aria-label={t("Zoom in")}><Plus aria-hidden="true"/></button>
      <button type="button" className="btn" disabled={!doc||busy||notes.length>=MAX_ANNOTATIONS} onClick={()=>add({x:0.5,y:0.5,width:0,height:0})}>{t("Add center comment")}</button>
      <button type="button" className="btn" disabled={!doc||busy||!dirty} onClick={()=>void save()}>{t("Save")}</button>
      <button type="button" className="btn" disabled={!doc||busy} onClick={()=>void feedback()}><MessageSquare size={16} aria-hidden="true"/>{t("Create feedback draft")}</button>
    </div>
    <p className="pi-visual-muted">{t("Click to pin, drag to select an area. Feedback is added to the draft, never sent automatically.")}</p>
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {!doc&&!error&&<p>{t("Loading…")}</p>}
    {doc&&<div className="pi-review-grid"><div className="pi-review-stage"><div className="pi-review-image" style={{width:`${zoom*100}%`}}>
      <img ref={picture} src={visualUrl(machineId,paneId,"review/image",{session:doc.session,id:doc.id})} alt={doc.name} draggable={false} onLoad={event=>setDimensions({width:event.currentTarget.naturalWidth,height:event.currentTarget.naturalHeight})} onError={()=>setError(t("Image unavailable"))}/>
      <svg viewBox={`0 0 ${dimensions.width} ${dimensions.height}`} preserveAspectRatio="none" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} aria-label={t("Image annotation area")}>
        {notes.map((note,index)=>overlay(note,String(index+1),note.id,note.resolved))}{preview&&overlay(preview,"+","preview")}
      </svg>
    </div></div><div className="pi-review-comments">{notes.map((note,index)=><article key={note.id} className={selected===note.id?"is-selected":undefined}>
      <label htmlFor={`${commentId}-${note.id}`}>{t("Comment {n}",{n:index+1})}</label><textarea id={`${commentId}-${note.id}`} className="input" value={note.text} maxLength={4000} disabled={busy} onFocus={()=>setSelected(note.id)} onChange={e=>patch(note.id,{text:e.target.value})}/>
      <label><input type="checkbox" checked={note.resolved} disabled={busy} onChange={e=>patch(note.id,{resolved:e.target.checked})}/>{t("Resolved")}</label>
      <button type="button" className="btn" disabled={busy} onClick={()=>change(notes.filter(n=>n.id!==note.id))}>{t("Delete")}</button>
    </article>)}</div></div>}
  </div></div>,document.body);
}
