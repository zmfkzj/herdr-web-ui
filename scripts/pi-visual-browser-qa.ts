/** Real React + real review store and Guacamole websocket, with isolated Pi/guacd fixtures. */
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as netServer, type Socket } from "node:net";
import { chromium } from "playwright-core";
import { PiVisualService, type PiPane } from "../server/pi-visual/service.ts";
import { DesktopTunnel, instruction, InstructionParser } from "../server/pi-visual/guacamole.ts";
import { chromePath } from "./chrome-path.ts";

const root=mkdtempSync(join(tmpdir(),"pi-visual-browser-"));const outputs=join(process.cwd(),"evidence","pi-visual");mkdirSync(outputs,{recursive:true});
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;let server:ReturnType<typeof Bun.serve>|undefined;
let service:PiVisualService|undefined;const sockets=new Set<Socket>();const received:string[][]=[];
const guacd=netServer(socket=>{
  sockets.add(socket);socket.on("close",()=>sockets.delete(socket));socket.setEncoding("utf8");
  const parser=new InstructionParser(parts=>{
    received.push(parts);
    if(parts[0]==="select")socket.write(instruction("args","VERSION_1_6_0","hostname","port","username","password","security","cert-fingerprints","read-only"));
    if(parts[0]==="connect")socket.write(instruction("ready","test-desktop")+instruction("size","0","640","360")+instruction("rect","0","0","0","640","360")+instruction("cfill","14","0","50","80","120","255")+instruction("sync","1"));
  });socket.on("data",data=>parser.write(String(data)));
});
try {
  await new Promise<void>(resolve=>guacd.listen(0,"127.0.0.1",resolve));
  const port=(guacd.address() as {port:number}).port;
  const pane:PiPane={paneId:"p1",path:"/fixture/pi.jsonl",cwd:root,sessionId:"original-pi",session:"a".repeat(64)};
  // Construct a deterministic raster in memory; no external image or user data is read.
  const chunk=(kind:string,bytes:Buffer):Buffer=>{
    const body=Buffer.concat([Buffer.from(kind),bytes]);let crc=0xffffffff;
    for(const byte of body){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
    const size=Buffer.alloc(4);size.writeUInt32BE(bytes.length);const tail=Buffer.alloc(4);tail.writeUInt32BE((crc^0xffffffff)>>>0);
    return Buffer.concat([size,body,tail]);
  };
  const header=Buffer.alloc(13);header.writeUInt32BE(800,0);header.writeUInt32BE(450,4);header[8]=8;header[9]=2;
  const rows=Buffer.alloc(450*(1+800*3));for(let y=0;y<450;y++)for(let x=0;x<800;x++){
    const at=y*(1+800*3)+1+x*3;const marked=x>180&&x<620&&y>120&&y<330;
    rows[at]=marked?90:235;rows[at+1]=marked?130:240;rows[at+2]=marked?190:245;
  }
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",deflateSync(rows)),chunk("IEND",Buffer.alloc(0))]);
  service=new PiVisualService(root,{guacdPort:port,identity:async(_pane,expected)=>{assert.ok(!expected||expected===pane.session);return pane;},workers:()=>({...pane,observedAt:Date.now(),truncated:false,source:"original-pi-orche-records",workers:[{job:"J1",worker:"W1",role:"implement",state:"running",request:"Review the visual interface",summary:"",started:Date.now(),model:"fixture/model",children:[]}]}),image:async()=>({mediaType:"image/png",bytes:png})});
  const build=await Bun.build({entrypoints:["scripts/fixtures/pi-visual.tsx"],outdir:root,target:"browser",define:{"process.env.NODE_ENV":'"development"'}});assert.ok(build.success,String(build.logs));
  let uploads=0,desktopTickets=0,dropSwitch=false;
  server=Bun.serve<{desktop:DesktopTunnel}>({port:0,hostname:"127.0.0.1",async fetch(request,srv){
    const url=new URL(request.url);
    if(url.pathname==="/ws") {const desktop=await service!.take(request);if(srv.upgrade(request,{headers:{"sec-websocket-protocol":"guacamole"},data:{desktop}}))return;service!.release(desktop);return new Response("upgrade required",{status:426});}
    if(url.pathname==="/api/pane/pi-visual/desktop")desktopTickets++;
    if(url.pathname.startsWith("/api/pane/pi-visual/"))return service!.handle(request,url,false);
    if(url.pathname==="/fixture/keys")return new Response(JSON.stringify(received.filter(p=>p[0]==="key")),{headers:{"content-type":"application/json"}});
    if(url.pathname==="/api/pane/image") {uploads++;return new Response(JSON.stringify({path:"/fixture/review.png"}),{headers:{"content-type":"application/json"}});}
    if(url.pathname==="/")return new Response('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/pi-visual.css"></head><body><div id="root"></div><script type="module" src="/pi-visual.js"></script></body></html>',{headers:{"content-type":"text/html"}});
    const asset=Bun.file(join(root,url.pathname.slice(1)));return await asset.exists()?new Response(asset):new Response("Not found",{status:404});
  },websocket:{open(ws){ws.data.desktop.bind(ws);},message(ws,raw){if(dropSwitch&&String(raw).includes("pi-input"))return;ws.data.desktop.message(String(raw));},close(ws){service!.release(ws.data.desktop);}}});
  process.env["HERDR_PI_GUACD_ENABLED"]="1";
  browser=await chromium.launch({executablePath:chromePath(),headless:true,args:["--no-sandbox"]});
  for(const [name,width,height] of [["desktop",1440,1000],["mobile",390,844]] as const){
    const context=await browser.newContext({viewport:{width,height}});const page=await context.newPage();const failures:string[]=[];page.on("pageerror",error=>failures.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}`);await page.getByText("Pi workers and desktop",{exact:true}).click();await page.getByText("Review the visual interface").waitFor();
    await page.getByRole("button",{name:"Review fixture image"}).click();await page.getByRole("button",{name:"Add center comment"}).waitFor();
    await page.waitForFunction(()=>{const image=document.querySelector(".pi-review-image img") as HTMLImageElement|null;return image?.complete&&image.naturalWidth;});
    if(name==="desktop")await page.getByRole("button",{name:"Add center comment"}).click();
    else assert.equal(await page.getByLabel("Comment 1",{exact:true}).inputValue(),"Move the marked part to the left (desktop).");
    await page.getByLabel("Comment 1",{exact:true}).fill(`Move the marked part to the left (${name}).`);
    await page.getByRole("button",{name:"Save",exact:true}).click();await page.getByText("Saved",{exact:true}).waitFor();
    // no message box to show it in: refused where it is clicked, nothing uploaded or added, the review stays
    const kept=`Keep this line (${name})`;await page.evaluate((text:string)=>localStorage.setItem("herdr-web-ui:composer-draft:p1",text),kept);
    const box=page.getByLabel("Message box available",{exact:true});const before:number=uploads;
    await box.evaluate(el=>(el as HTMLInputElement).click());
    await page.getByRole("button",{name:"Create feedback draft"}).click();await page.getByRole("alert").getByText("The message box is not available right now.",{exact:true}).waitFor();
    assert.equal(uploads,before,"nothing is uploaded for a refused draft");assert.equal(await page.evaluate(()=>localStorage.getItem("herdr-web-ui:composer-draft:p1")),kept);
    assert.equal(await page.getByLabel("Comment 1",{exact:true}).inputValue(),`Move the marked part to the left (${name}).`);
    await page.screenshot({path:join(outputs,`${name}-review-refused.png`)});
    await box.evaluate(el=>(el as HTMLInputElement).click());
    // with one: the review closes on its own and hands over to the message box, after what it held
    await page.getByRole("button",{name:"Create feedback draft"}).click();await page.getByText("Message box shown 1",{exact:true}).waitFor();
    await page.locator(".pi-review").waitFor({state:"detached"});
    const draft=await page.evaluate(()=>localStorage.getItem("herdr-web-ui:composer-draft:p1"));assert.ok(draft?.startsWith(`${kept}\n\nPlease revise the marked image`));assert.ok(draft?.includes("Move the marked part"));assert.ok(draft?.includes('"/fixture/review.png"'));
    await page.screenshot({path:join(outputs,`${name}-review.png`)});
    if(name==="desktop"){
      await page.getByRole("button",{name:"Open private desktop"}).click();await page.getByLabel("RDP port",{exact:true}).fill("3399");await page.getByLabel("One-time viewer password",{exact:true}).fill("fixture-secret");await page.getByLabel("Certificate SHA-256",{exact:true}).fill("ab".repeat(32));
      await page.getByRole("button",{name:"Connect",exact:true}).click();
      await page.waitForFunction(()=>Array.from(document.querySelectorAll(".pi-desktop-display canvas")).some(c=>(c as HTMLCanvasElement).width===640));
      assert.equal(await page.getByLabel("One-time viewer password",{exact:true}).inputValue(),"");
      assert.ok(!(await page.evaluate(()=>JSON.stringify(localStorage))).includes("fixture-secret"));
      await page.screenshot({path:join(outputs,"desktop-screen.png")});
      assert.ok(received.some(p=>p[0]==="connect"&&p[1]==="VERSION_1_5_0"&&p.includes("sha256:"+"ab".repeat(32))));
      // Switch input: view-only -> input -> view-only on this one connection, no ticket or password asked
      const screen=page.getByRole("application",{name:"Private desktop screen"});const toggle=page.getByRole("button",{name:"Switch input",exact:true});
      const sent=()=>received.filter(p=>p[0]==="mouse"||p[0]==="key");
      await page.getByText("View only: input is blocked",{exact:true}).waitFor();assert.equal(await toggle.getAttribute("aria-pressed"),"false");
      assert.equal(await page.getByLabel("Observe only",{exact:true}).count(),0);
      await screen.focus();await page.keyboard.press("x");await screen.click({position:{x:50,y:50}});
      const tickets=desktopTickets;
      await toggle.click();await page.getByText("Input on: mouse and keyboard reach the desktop",{exact:true}).waitFor();
      assert.equal(await toggle.getAttribute("aria-pressed"),"true");
      assert.equal(sent().length,0,"view-only passed no input");
      await page.screenshot({path:join(outputs,"desktop-input-on.png")});
      await screen.focus();await page.keyboard.press("b");
      await page.waitForFunction(async()=>{const rows=await (await fetch("/fixture/keys")).json() as string[][];return rows.some(p=>p[0]==="key"&&p[1]==="98"&&p[2]==="0");});
      await screen.click({position:{x:60,y:40}});
      for(let n=0;n<200&&!sent().some(p=>p[0]==="mouse"&&p[3]==="1");n++){await Bun.sleep(10);}
      assert.ok(sent().some(p=>p[0]==="mouse"&&p[3]==="1"),"a click reached the desktop");
      // Shift and the left button held while switching back: both are let go
      await screen.focus();await page.keyboard.down("Shift");await screen.hover({position:{x:70,y:30}});await page.mouse.down();
      for(let n=0;n<200&&!sent().some(p=>p[0]==="key"&&p[1]==="65505"&&p[2]==="1");n++){await Bun.sleep(10);}
      await toggle.evaluate(el=>(el as HTMLButtonElement).click());
      await page.getByText("View only: input is blocked",{exact:true}).waitFor();
      await page.keyboard.up("Shift");await page.mouse.up();
      const shift=sent().filter(p=>p[0]==="key"&&p[1]==="65505").map(p=>p[2]);assert.deepEqual(shift.slice(-2),["1","0"]);
      assert.equal(sent().filter(p=>p[0]==="mouse").at(-1)?.[3],"0");
      const before=sent().length;
      await screen.focus();await page.keyboard.press("c");await screen.click({position:{x:80,y:20}});
      // fixed wait: proving that nothing arrives after view-only
      await Bun.sleep(300);
      assert.equal(sent().length,before,"view-only after the switch passed no input");
      assert.equal(desktopTickets,tickets,"no new ticket for a switch");
      assert.equal(await page.getByLabel("One-time viewer password",{exact:true}).inputValue(),"");
      assert.ok(!received.some(p=>p[0]==="pi-input"),"the switch never reaches guacd");
      // an unanswered switch (an older bridge): stays view-only and says why
      dropSwitch=true;
      await toggle.click();
      await page.getByText(/did not confirm the input switch/).waitFor({timeout:10000});
      await page.getByText("View only: input is blocked",{exact:true}).waitFor();
      await screen.focus();await page.keyboard.press("d");
      // fixed wait: proving that nothing arrives while the switch was unanswered
      await Bun.sleep(300);
      assert.equal(sent().length,before,"an unanswered switch passed no input");
      dropSwitch=false;
      await page.screenshot({path:join(outputs,"desktop-switch-unanswered.png")});
      await page.getByRole("button",{name:"Disconnect",exact:true}).click();
      await page.getByLabel("Observe only",{exact:true}).waitFor();
      // Reconnect on a fresh DOM input target; keyboard events must be sent once.
      await page.getByLabel("Observe only",{exact:true}).uncheck();
      await page.getByLabel("One-time viewer password",{exact:true}).fill("fixture-control");
      await page.getByRole("button",{name:"Connect",exact:true}).click();
      await page.getByRole("application",{name:"Private desktop screen"}).waitFor();
      await page.waitForFunction(()=>Array.from(document.querySelectorAll(".pi-desktop-display canvas")).some(c=>(c as HTMLCanvasElement).width===640));
      await page.getByRole("application",{name:"Private desktop screen"}).focus();
      await page.keyboard.press("a");
      await page.waitForFunction(async()=>{const rows=await (await fetch("/fixture/keys")).json() as string[][];return rows.some(p=>p[0]==="key"&&p[1]==="97"&&p[2]==="0");});
      assert.equal(received.filter(p=>p[0]==="key"&&p[1]==="97"&&p[2]==="1").length,1);
      // started with input on, then an unanswered switch back to view-only ends the viewer
      await page.getByText("Input on: mouse and keyboard reach the desktop",{exact:true}).waitFor();
      dropSwitch=true;
      await page.getByRole("button",{name:"Switch input",exact:true}).click();
      await page.getByText(/did not confirm view-only mode/).waitFor({timeout:10000});
      await page.getByRole("button",{name:"Connect",exact:true}).waitFor();
      dropSwitch=false;
      // reconnect for the rest of the checks
      await page.getByLabel("Observe only",{exact:true}).uncheck();
      await page.getByLabel("One-time viewer password",{exact:true}).fill("fixture-control");
      await page.getByRole("button",{name:"Connect",exact:true}).click();
      await page.getByRole("application",{name:"Private desktop screen"}).waitFor();
      await page.getByText("Input on: mouse and keyboard reach the desktop",{exact:true}).waitFor();
      await page.getByRole("application",{name:"Private desktop screen"}).focus();
      await page.keyboard.press("Shift+Escape");
      assert.equal(await page.getByRole("button",{name:"Close",exact:true}).evaluate(el=>el===document.activeElement),true);
      await page.getByRole("button",{name:"Disconnect",exact:true}).click();
      assert.ok(!received.some(p=>p[0]==="key"&&p[1]==="65307"));
      assert.ok(!(await page.evaluate(()=>JSON.stringify(localStorage))).includes("fixture-control"));
    }
    assert.deepEqual(failures,[]);await context.close();console.log(`PASS ${name}: image comments, persistence, feedback draft${name==="desktop"?", desktop handshake/render":""}`);
  }
  assert.equal(uploads,2);
} finally {await browser?.close();server?.stop(true);service?.close();for(const socket of sockets)socket.destroy();guacd.close();rmSync(root,{recursive:true,force:true});}
