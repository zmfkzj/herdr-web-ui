import { expect, it } from "bun:test";
import { feedbackText, sourceFromImage, visualUrl } from "./api.ts";
import type { ImageReviewDocument } from "../../../shared/pi-visual.ts";
it("does not interpret an arbitrary URL as a server image",()=>{
  expect(sourceFromImage("/api/pane/conversation/image?pane_id=p1&ref=img","local","p1","https://local")).toEqual({kind:"conversation",ref:"img"});
  expect(sourceFromImage("/api/fs/file?pane_id=p1&path=%2Fimage.png","local","p1","https://local")).toEqual({kind:"file",path:"/image.png"});
  expect(()=>sourceFromImage("https://evil/api/fs/file?pane_id=p1&path=a","local","p1","https://local")).toThrow();
  expect(()=>sourceFromImage("/api/fs/file?pane_id=p2&path=a","local","p1","https://local")).toThrow();
  expect(visualUrl("remote a","p1","workers")).toContain("/api/machines/remote%20a/");
});
it("feedback keeps image version, annotation numbers and normalized regions",()=>{
  const notes=[{id:"a",x:0,y:0,width:0.1,height:0.2,text:"done",resolved:true},{id:"b",x:0.5,y:0.5,width:0,height:0,text:"fix here",resolved:false}];
  const doc:ImageReviewDocument={id:"a".repeat(64),session:"s",revision:1,name:"image.png",mime:"image/png",updated:0,annotations:notes};
  const feedback=feedbackText(doc,"/folder with spaces/review.png",notes,"Review");expect(feedback).toContain('"/folder with spaces/review.png"');expect(feedback).toContain("2. [x,y,w,h normalized: 0.5000");expect(feedback).not.toContain("done");expect(feedback).toContain(doc.id);
});
