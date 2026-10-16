/** Narrow public API of the pinned Apache Guacamole client. */
declare module "guacamole-common-js" {
  interface Status { code:number; message:string }
  interface MouseState { x:number;y:number;left:boolean;middle:boolean;right:boolean;up:boolean;down:boolean }
  class WebSocketTunnel { constructor(url:string); onerror:((status:Status)=>void)|null; oninstruction:((opcode:string,args:string[])=>void)|null; sendMessage(...elements:(string|number)[]):void; disconnect():void }
  class Display { getElement():HTMLElement; getWidth():number; getHeight():number; scale(value:number):void; onresize:((width:number,height:number)=>void)|null }
  class Client { constructor(tunnel:WebSocketTunnel); connect(data?:string):void; disconnect():void; getDisplay():Display; onerror:((status:Status)=>void)|null; onstatechange:((state:number)=>void)|null; sendKeyEvent(pressed:number,keysym:number):void; sendMouseState(state:MouseState,applyDisplayScale?:boolean):void }
  class Mouse { constructor(element:HTMLElement); onmousedown:((state:MouseState)=>void)|null; onmouseup:((state:MouseState)=>void)|null; onmousemove:((state:MouseState)=>void)|null }
  class Keyboard { constructor(element:HTMLElement); onkeydown:((keysym:number)=>boolean|void)|null; onkeyup:((keysym:number)=>void)|null; reset():void }
  const Guacamole: { WebSocketTunnel:typeof WebSocketTunnel; Client:typeof Client; Mouse:typeof Mouse; Keyboard:typeof Keyboard };
  export default Guacamole;
}
