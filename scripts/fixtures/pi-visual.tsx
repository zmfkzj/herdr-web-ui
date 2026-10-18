import { createRoot } from "react-dom/client";
import { useState } from "react";
import { SettingsProvider } from "../../src/lib/settings.ts";
import { PiVisualTools } from "../../src/components/pi-visual/PiVisualTools.tsx";
import { ImageReview } from "../../src/components/pi-visual/ImageReview.tsx";
import "../../src/styles.css";
function Fixture() {
  // `box`: whether a message box could show the feedback (PaneTerminal's composerShown)
  const [review,setReview]=useState(false),[box,setBox]=useState(true),[shown,setShown]=useState(0);
  return <SettingsProvider><main style={{padding:24}}><h1>Pi visual integration fixture</h1><PiVisualTools paneId="p1" machineId="local" enabled/><button className="btn" onClick={()=>setReview(true)}>Review fixture image</button>
    <label><input type="checkbox" checked={box} onChange={e=>setBox(e.target.checked)}/>Message box available</label>{shown>0&&<p role="status">Message box shown {shown}</p>}
    {review&&<ImageReview paneId="p1" machineId="local" image={{src:"/api/pane/conversation/image?pane_id=p1&ref=image1",name:"fixture.png",file:"fixture.png"}} onClose={()=>setReview(false)} onDraft={box?()=>{setReview(false);setShown(n=>n+1);}:null}/>}</main></SettingsProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
