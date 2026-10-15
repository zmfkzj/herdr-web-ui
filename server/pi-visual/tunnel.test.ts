import { expect, it } from "bun:test";
import { createServer, type Socket } from "node:net";
import { DesktopTunnel, InstructionParser, instruction, desktopRequest, type DesktopWebSocket } from "./guacamole.ts";
import type { PiPane } from "./identity.ts";

it("connects a desktop through a real TCP handshake and enforces read-only input",async()=>{
  const received:string[][]=[],sent:string[]=[];let native:Socket|undefined;
  let finish!:()=>void;const synced=new Promise<void>(resolve=>{finish=resolve;});
  const server=createServer(socket=>{
    native=socket;socket.setEncoding("utf8");const parser=new InstructionParser(parts=>{
      received.push(parts);
      if(parts[0]==="select")socket.write(instruction("args","VERSION_1_6_0","hostname","port","username","password","security","cert-fingerprints","read-only"));
      if(parts[0]==="connect")socket.write(instruction("ready","fixture")+instruction("sync","123"));
      if(parts[0]==="sync")finish();
    });socket.on("data",data=>parser.write(String(data)));
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const pane:PiPane={paneId:"p1",sessionId:"pi-1",session:"a".repeat(64),path:"/pi.jsonl",cwd:null};
  const req=desktopRequest({session:pane.session,port:3399,password:"secret",fingerprint:"ab".repeat(32),readOnly:true,width:1024,height:768});
  const tunnel=new DesktopTunnel({pane,request:req,binding:"test",expiresAt:Date.now()+30000},async()=>pane,(server.address() as {port:number}).port);
  const web:DesktopWebSocket={getBufferedAmount:()=>0,close:()=>{},send:frame=>{
    sent.push(frame);
    if(frame===instruction("sync","123"))tunnel.message(instruction("key","65","1")+instruction("mouse","1","2","1")+instruction("clipboard","0","text/plain")+instruction("sync","123"));
    return frame.length;
  }};
  try {
    tunnel.bind(web);await synced;
    expect(received.find(row=>row[0]==="connect")).toEqual(["connect","VERSION_1_5_0","127.0.0.1","3399","pi","secret","tls","sha256:"+"ab".repeat(32),"true"]);
    expect(received.some(row=>["key","mouse","clipboard"].includes(row[0]??""))).toBe(false);
    expect(sent.join("")).not.toContain("secret");expect(req.password).toBe("");
  }finally{tunnel.close();native?.destroy();server.close();}
},10000);
