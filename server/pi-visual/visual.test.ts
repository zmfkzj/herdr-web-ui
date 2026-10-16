import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { annotations, rectangle } from "../../shared/pi-visual.ts";
import { readHeader, sessionKey, type PiPane } from "./identity.ts";
import { foldJobs, jobEntries, readWorkers, contained } from "./workers.ts";
import { ReviewStore } from "./reviews.ts";
import { PiVisualService } from "./service.ts";
import { desktopBinding, desktopRequest, DesktopTickets, instruction, InstructionParser, rdpParameters } from "./guacamole.ts";

const dirs:string[]=[];const close:(()=>void)[]=[];
const temp=()=>{const dir=mkdtempSync(join(tmpdir(),"pi-visual-test-"));dirs.push(dir);return dir;};
afterEach(()=>{for(const fn of close.splice(0))fn();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const session="a".repeat(64);const identity:PiPane={paneId:"p1",sessionId:"pi-session-1",session,path:"/test/pi.jsonl",cwd:"/test"};
const note={id:"a1",x:0.1,y:0.2,width:0.3,height:0.4,text:"move this",resolved:false};
const png=new Uint8Array([137,80,78,71,13,10,26,10]);
function row(id:string,parentId:string|null,data:Record<string,unknown>){return {type:"custom",id,parentId,customType:"orche-job",data};}

describe("original Pi orche records",()=>{
  it("keeps newest job facts when older custom entries exhaust the byte budget",()=>{
    const path=join(temp(),"pi.jsonl");
    const records:unknown[]=[{type:"session",id:"s-budget"}];
    let parent:string|null=null;
    for(let n=0;n<24;n++){
      const id=`large-${n}`;
      records.push({...row(id,parent,{}),customType:"unrelated-state",data:{text:"x".repeat(450000)}});parent=id;
    }
    records.push(row("latest-start",parent,{event:"start",job:"J9",worker:"W9",at:1}));
    records.push(row("latest-end","latest-start",{event:"end",job:"J9",status:"done",at:2}));
    writeFileSync(path,records.map(r=>JSON.stringify(r)).join("\n")+"\n");
    const found=jobEntries(path);expect(found.truncated).toBe(true);
    expect(foldJobs(found.entries).map(job=>[job.job,job.state])).toEqual([["J9","done"]]);
  });
  it("does not borrow a reused worker's later tools for an ended assignment",()=>{
    const dir=temp(),root=join(dir,"records"),group=join(root,identity.sessionId),record=join(group,"run1"),path=join(dir,"pi.jsonl");
    mkdirSync(record,{recursive:true});const workerFile=join(group,"worker.jsonl");
    writeFileSync(path,JSON.stringify({type:"session",id:identity.sessionId})+"\n"+JSON.stringify(row("a",null,{event:"start",job:"J1",worker:"W1",at:1,record}))+"\n");
    writeFileSync(workerFile,JSON.stringify({type:"message",message:{role:"toolResult",toolName:"later_assignment_tool"}})+"\n");
    writeFileSync(join(record,"run.json"),JSON.stringify({version:1,parentSession:{id:identity.sessionId,file:path},worker:{id:"W1",sessionFile:workerFile},status:"done",agents:[]}));
    const job=readWorkers({...identity,path},root).workers[0];expect(job?.state).toBe("done");expect(job?.lastTool).toBeUndefined();
  });
  it("folds original orche jobs, not OMP task records",()=>{
    expect(foldJobs([{type:"task",id:"task-1",state:"running"}])).toEqual([]);
    const jobs=foldJobs([{event:"start",job:"J1",worker:"W1",role:"implement",at:1,request:"fix"},{event:"queue",job:"Q1",worker:"W2",at:2},{event:"end",job:"J1",at:3,status:"done",summary:"fixed"}]);
    expect(jobs.map(j=>[j.job,j.state])).toEqual([["J1","done"],["Q1","queued"]]);expect(jobs[0]?.summary).toBe("fixed");
  });
  it("follows the recorded Pi branch, excludes abandoned jobs and torn final lines",()=>{
    const dir=temp(),path=join(dir,"pi.jsonl");
    const records=[{type:"session",id:"s1"},row("root",null,{event:"start",job:"J1",worker:"W1",at:1}),row("old","root",{event:"start",job:"J2",worker:"W2",at:2}),row("new","root",{event:"end",job:"J1",status:"done",at:3})];
    writeFileSync(path,records.map(r=>JSON.stringify(r)).join("\n")+"\n"+'{"type":"custom"');
    expect(foldJobs(jobEntries(path).entries).map(j=>j.job)).toEqual(["J1"]);expect(readHeader(path).id).toBe("s1");
    expect(sessionKey(path,"s1")).not.toBe(sessionKey(path,"s2"));
  });
  it("uses only manifests bound to the exact Pi parent, with containment",()=>{
    const dir=temp(),root=join(dir,"records"),group=join(root,"pi-session-1"),record=join(group,"run1"),path=join(dir,"pi.jsonl");mkdirSync(record,{recursive:true});
    writeFileSync(path,JSON.stringify({type:"session",id:"pi-session-1"})+"\n"+JSON.stringify(row("a",null,{event:"start",job:"J1",worker:"W1",at:1,record}))+"\n");
    const pane={...identity,path};const manifest={version:1,parentSession:{id:pane.sessionId,file:path},worker:{id:"W1"},status:"done",summary:"own result",assignment:{model:"provider/model"},agents:[]};
    writeFileSync(join(record,"run.json"),JSON.stringify(manifest));expect(readWorkers(pane,root).workers[0]?.summary).toBe("own result");
    manifest.parentSession.file="/another/pi.jsonl";writeFileSync(join(record,"run.json"),JSON.stringify(manifest));expect(readWorkers(pane,root).workers[0]?.summary).toBe("");
    const outside=join(dir,"outside.json");writeFileSync(outside,"{}");symlinkSync(outside,join(group,"escape"));expect(contained(join(group,"escape"),root)).toBeNull();
  });
});
describe("image review persistence",()=>{
  it("validates normalized rectangles, duplicate ids and unbounded text",()=>{
    expect(rectangle({x:0.9,y:0.8},{x:0.1,y:0.2})).toEqual({x:0.1,y:0.2,width:0.8,height:0.6000000000000001});
    expect(annotations([note])).toEqual([note]);for(const bad of [[{...note,x:NaN}],[{...note,x:0.9}],[note,note],[{...note,text:"x".repeat(4001)}]])expect(()=>annotations(bad)).toThrow();
  });
  it("separates content versions and sessions; persists and detects stale saves",()=>{
    const dir=temp();let store=new ReviewStore(dir);close.push(()=>store.close());
    const a=store.open(session,png,"same.png","image/png"),b=store.open(session,new Uint8Array([...png,1]),"same.png","image/png");expect(a.id).not.toBe(b.id);
    const saved=store.save(session,a.id,0,[note]);expect(saved.revision).toBe(1);
    expect(()=>store.save(session,a.id,0,[])).toThrow("Another tab");expect(()=>store.get("other",a.id)).toThrow("not found");
    store.close();store=new ReviewStore(dir);expect(store.get(session,a.id).annotations).toEqual([note]);expect(store.image(session,a.id).bytes).toEqual(png);
    expect(()=>store.open(session,png,"active.svg","image/svg+xml")).toThrow();
  });
  it("enforces observer and session checks on every image operation",async()=>{
    const dir=temp();let current=session;
    const svc=new PiVisualService(dir,{identity:async(_pane,expected)=>{if(expected&&expected!==current)throw new Error("changed");return {...identity,session:current};},workers:p=>({...p,observedAt:0,source:"original-pi-orche-records",workers:[],truncated:false}),image:async()=>({bytes:png,mediaType:"image/png"})});close.push(()=>svc.close());
    const url=new URL("http://localhost/api/pane/pi-visual/review/open?pane_id=p1");const req=()=>new Request(url,{method:"POST",body:JSON.stringify({source:{kind:"conversation",ref:"img1"},session})});
    expect((await svc.handle(req(),url,true)).status).toBe(403);
    const opened=await (await svc.handle(req(),url,false)).json();expect(opened.id).toHaveLength(64);
    current="b".repeat(64);expect((await svc.handle(req(),url,false)).ok).toBe(false);
    const invalid=new Request(url,{method:"POST",body:JSON.stringify({source:{kind:"url",url:"http://elsewhere"}})});expect((await svc.handle(invalid,url,false)).ok).toBe(false);
  });
});
describe("private desktop boundary",()=>{
  const request=()=>desktopRequest({session,port:3399,password:"temporary-only",fingerprint:"ab:".repeat(31)+"ab",readOnly:true,width:1024,height:768});
  it("pins TLS certificates and forces loopback with no clipboard or filesystem",()=>{
    const args=rdpParameters(request());expect(args.hostname).toBe("127.0.0.1");expect(args.security).toBe("tls");expect(args["ignore-cert"]).toBe("false");expect(args["cert-fingerprints"]).toBe("sha256:"+"ab".repeat(32));expect(args["enable-drive"]).toBe("false");expect(args["disable-copy"]).toBe("true");
    expect(()=>desktopRequest({...request(),fingerprint:"bad"})).toThrow();expect(()=>desktopRequest({...request(),port:22})).toThrow();
  });
  it("makes ticket use single-shot, authenticated and expiring",()=>{
    let now=0;const tickets=new DesktopTickets(()=>now);close.push(()=>tickets.close());
    const issued=tickets.issue(identity,request(),"binding");expect(()=>tickets.take(issued.ticket,"another")).toThrow();expect(tickets.take(issued.ticket,"binding").pane.session).toBe(session);expect(()=>tickets.take(issued.ticket,"binding")).toThrow();
    const expired=tickets.issue(identity,request(),"binding");now=31000;expect(()=>tickets.take(expired.ticket,"binding")).toThrow();
    expect(desktopBinding(new Request("https://local",{headers:{cookie:"token=a"}}))).not.toBe(desktopBinding(new Request("https://local",{headers:{cookie:"token=b"}})));
  });
  it("parses fragmented Unicode Guacamole instructions and rejects malformed frames",()=>{
    const got:string[][]=[];const parser=new InstructionParser(p=>got.push(p));const wire=instruction("name","한글🙂;comma,")+instruction("sync","123");
    for(const char of wire)parser.write(char);expect(got).toEqual([["name","한글🙂;comma,"],["sync","123"]]);
    for(const bad of ["-1.x;","a.x;","99999999.x;"])expect(()=>new InstructionParser(()=>{}).write(bad)).toThrow();
  });
});
