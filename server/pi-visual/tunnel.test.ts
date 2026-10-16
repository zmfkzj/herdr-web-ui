import { expect, it } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { DesktopTunnel, InstructionParser, instruction, desktopRequest, type DesktopWebSocket } from "./guacamole.ts";
import type { PiPane } from "./identity.ts";

const pane:PiPane={paneId:"p1",sessionId:"pi-1",session:"a".repeat(64),path:"/pi.jsonl",cwd:null};
const until=async(test:()=>boolean,what:string)=>{for(let n=0;n<200;n++){if(test())return;await Bun.sleep(5);}throw new Error(`timed out waiting for ${what}`);};

/** A guacd stand-in on loopback that records what each connection received. */
async function guacd():Promise<{server:Server;port:number;connections:string[][][];sockets:Socket[]}> {
  const connections:string[][][]=[],sockets:Socket[]=[];
  const server=createServer(socket=>{
    const received:string[][]=[];connections.push(received);sockets.push(socket);socket.setEncoding("utf8");
    const parser=new InstructionParser(parts=>{
      received.push(parts);
      if(parts[0]==="select")socket.write(instruction("args","VERSION_1_6_0","hostname","port","username","password","security","cert-fingerprints","read-only"));
      if(parts[0]==="connect")socket.write(instruction("ready","fixture")+instruction("sync","123"));
    });socket.on("data",data=>parser.write(String(data)));
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  return {server,port:(server.address() as {port:number}).port,connections,sockets};
}
function open(port:number,readOnly:boolean,mayInteract?:()=>boolean){
  const request=desktopRequest({session:pane.session,port:3399,password:"secret",fingerprint:"ab".repeat(32),readOnly,width:1024,height:768});
  const tunnel=new DesktopTunnel({pane,request,binding:"test",expiresAt:Date.now()+30000},async()=>pane,port,mayInteract);
  const sent:string[]=[];let closed=false;
  const web:DesktopWebSocket={getBufferedAmount:()=>0,close:()=>{closed=true;},send:frame=>{sent.push(frame);return frame.length;}};
  tunnel.bind(web);
  return {tunnel,request,sent,closed:()=>closed,answers:()=>sent.flatMap(frame=>{const rows:string[][]=[];new InstructionParser(parts=>rows.push(parts)).write(frame);return rows;}).filter(row=>row[0]==="pi-input")};
}
/** what the browser's frames passed on, after the handshake */
const input=(rows:string[][])=>rows.slice(rows.findIndex(row=>row[0]==="connect")+1).filter(row=>["key","mouse","size","clipboard","pi-input"].includes(row[0]??""));

it("connects a desktop through a real TCP handshake and enforces view-only input",async()=>{
  const fixture=await guacd();const desktop=open(fixture.port,true);
  try {
    await until(()=>desktop.sent.includes(instruction("sync","123")),"the first sync");
    desktop.tunnel.message(instruction("key","65","1")+instruction("mouse","1","2","1")+instruction("size","800","600")+instruction("clipboard","0","text/plain")+instruction("sync","123"));
    await until(()=>fixture.connections[0]!.some(row=>row[0]==="sync"),"the browser's sync");
    // guacd takes input from the connection; the tunnel alone decides what reaches it
    expect(fixture.connections[0]!.find(row=>row[0]==="connect")).toEqual(["connect","VERSION_1_5_0","127.0.0.1","3399","pi","secret","tls","sha256:"+"ab".repeat(32),"false"]);
    expect(input(fixture.connections[0]!)).toEqual([]);
    expect(desktop.tunnel.inputMode).toBe("observe");
    expect(desktop.sent.join("")).not.toContain("secret");expect(desktop.request.password).toBe("");
  }finally{desktop.tunnel.close();for(const socket of fixture.sockets)socket.destroy();fixture.server.close();}
},10000);

it("switches one open desktop to input and back on its own socket, letting go of held keys and buttons",async()=>{
  const fixture=await guacd();const desktop=open(fixture.port,true);
  await until(()=>desktop.sent.includes(instruction("sync","123")),"the first desktop");
  // a second viewer of the same desktop, its own guacd connection
  const other=open(fixture.port,true);
  const sync=(n:number)=>instruction("sync",String(n));
  const synced=(conn:number,n:number)=>until(()=>fixture.connections[conn]!.some(row=>row[0]==="sync"&&row[1]===String(n)),`sync ${n}`);
  try {
    await until(()=>other.sent.includes(instruction("sync","123")),"the second desktop");
    // malformed switches are ignored, never passed on
    desktop.tunnel.message(instruction("pi-input","admin","1")+instruction("pi-input","interact","x")+instruction("pi-input","interact")+sync(1));
    await synced(0,1);expect(desktop.answers()).toEqual([]);expect(desktop.tunnel.inputMode).toBe("observe");
    // to input: answered on this socket, no new ticket or password
    desktop.tunnel.message(instruction("pi-input","interact","7"));
    await until(()=>desktop.answers().length===1,"the answer");
    expect(desktop.answers()).toEqual([["pi-input","interact","7"]]);
    // a drag and a held modifier, then text
    desktop.tunnel.message(instruction("mouse","10","20","1")+instruction("key","65505","1")+instruction("key","97","1")+instruction("key","97","0")+instruction("clipboard","0","text/plain")+sync(2));
    await synced(0,2);
    expect(input(fixture.connections[0]!)).toEqual([["mouse","10","20","1"],["key","65505","1"],["key","97","1"],["key","97","0"]]);
    // the other viewer of the same desktop stays view-only
    other.tunnel.message(instruction("key","98","1")+sync(3));await synced(1,3);
    expect(input(fixture.connections[1]!)).toEqual([]);expect(other.answers()).toEqual([]);
    // back to view-only: Shift and the left button are let go before the answer
    desktop.tunnel.message(instruction("pi-input","observe","8"));
    await until(()=>desktop.answers().length===2,"the second answer");
    expect(desktop.answers()[1]).toEqual(["pi-input","observe","8"]);
    desktop.tunnel.message(instruction("key","99","1")+instruction("mouse","30","40","4")+instruction("size","800","600")+sync(4));
    await synced(0,4);
    expect(input(fixture.connections[0]!).slice(4)).toEqual([["key","65505","0"],["mouse","10","20","0"]]);
    expect(desktop.tunnel.inputMode).toBe("observe");
    expect(fixture.connections.flat().some(row=>row[0]==="pi-input")).toBe(false);
  }finally{desktop.tunnel.close();other.tunnel.close();for(const socket of fixture.sockets)socket.destroy();fixture.server.close();}
},10000);

it("refuses input to a device that may only watch, and lets go of held keys when the desktop closes",async()=>{
  const fixture=await guacd();let drive=false;const desktop=open(fixture.port,true,()=>drive);
  try {
    await until(()=>desktop.sent.includes(instruction("sync","123")),"the first sync");
    desktop.tunnel.message(instruction("pi-input","interact","1")+instruction("key","97","1")+instruction("sync","1"));
    await until(()=>fixture.connections[0]!.some(row=>row[0]==="sync"&&row[1]==="1"),"sync 1");
    expect(desktop.answers()).toEqual([["pi-input","observe","1","This device may only watch"]]);
    expect(input(fixture.connections[0]!)).toEqual([]);
    drive=true;
    desktop.tunnel.message(instruction("pi-input","interact","2")+instruction("key","65507","1")+instruction("sync","2"));
    await until(()=>fixture.connections[0]!.some(row=>row[0]==="sync"&&row[1]==="2"),"sync 2");
    expect(desktop.answers()[1]).toEqual(["pi-input","interact","2"]);
    desktop.tunnel.close();
    await until(()=>input(fixture.connections[0]!).length===2,"the release on close");
    expect(input(fixture.connections[0]!)).toEqual([["key","65507","1"],["key","65507","0"]]);
  }finally{desktop.tunnel.close();for(const socket of fixture.sockets)socket.destroy();fixture.server.close();}
},10000);

it("ends the desktop of a device that may no longer give input at the next recheck",async()=>{
  const fixture=await guacd();let drive=true;const desktop=open(fixture.port,false,()=>drive);
  try {
    await until(()=>desktop.sent.includes(instruction("sync","123")),"the first sync");
    expect(desktop.tunnel.inputMode).toBe("interact");
    drive=false;
    for(let n=0;n<80&&!desktop.closed();n++)await Bun.sleep(50);
    expect(desktop.closed()).toBe(true);
    expect(desktop.sent.some(frame=>frame.includes("This device may no longer use private desktops"))).toBe(true);
  }finally{desktop.tunnel.close();for(const socket of fixture.sockets)socket.destroy();fixture.server.close();}
},10000);
