// Масштабируется только фотография; visualViewport и переписка остаются прежними.
import {$} from './core.js';
import {adjustViewport,followViewport} from './viewport.js';

let initialized=false,scale=1,x=0,y=0,gesture=null,moved=false,suppressClick=0,previousFocus=null,wasInert=false,close=hidePhotoViewer;
const pointers=new Map(),limit=(value,range)=>Math.max(-range,Math.min(range,value));
function visible(){return !$('viewer-layer').hidden;}
function paint(){
 const image=$('viewer-image'),layer=$('viewer-layer');
 x=limit(x,Math.max(0,(image.offsetWidth*scale-layer.clientWidth)/2));
 y=limit(y,Math.max(0,(image.offsetHeight*scale-layer.clientHeight)/2));
 image.style.transform=`translate3d(${x}px,${y}px,0) scale(${scale})`;
 layer.dataset.zoomed=String(scale>1);
}
function reset(){scale=1;x=y=0;pointers.clear();gesture=null;paint();}
function local(point){const box=$('viewer-layer').getBoundingClientRect();return {x:point.x-box.left-box.width/2,y:point.y-box.top-box.height/2};}
function current(){
 const points=[...pointers.values()].slice(0,2),a=local(points[0]);
 if(points.length===1)return {center:a,distance:0};
 const b=local(points[1]);return {center:{x:(a.x+b.x)/2,y:(a.y+b.y)/2},distance:Math.hypot(a.x-b.x,a.y-b.y)};
}
function rebase(){gesture=pointers.size?{...current(),scale,x,y}:null;}
function zoomAt(next,point){
 next=Math.max(1,Math.min(8,next));const p=local(point),ratio=next/scale;
 x=p.x-(p.x-x)*ratio;y=p.y-(p.y-y)*ratio;scale=next;paint();
}
function init(){
 if(initialized)return;initialized=true;
 const layer=$('viewer-layer'),image=$('viewer-image');image.draggable=false;
 image.addEventListener('load',()=>{if(visible())reset();});
 layer.addEventListener('pointerdown',event=>{
  if(event.target.closest('button')||event.button!==0)return;
  if(!pointers.size)moved=false;
  pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
  if(pointers.size>1){moved=true;suppressClick=Date.now()+600;}
  try{layer.setPointerCapture(event.pointerId);}catch(_error){}
  rebase();
 });
 layer.addEventListener('pointermove',event=>{
  if(!pointers.has(event.pointerId)||!gesture)return;
  pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
  const point=current(),dx=point.center.x-gesture.center.x,dy=point.center.y-gesture.center.y;
  if(Math.hypot(dx,dy)>4||pointers.size>1)moved=true;
  if(pointers.size>1&&gesture.distance>0){
   scale=Math.max(1,Math.min(8,gesture.scale*point.distance/gesture.distance));
   x=point.center.x-(gesture.center.x-gesture.x)*scale/gesture.scale;
   y=point.center.y-(gesture.center.y-gesture.y)*scale/gesture.scale;
  }else if(scale>1){x=gesture.x+dx;y=gesture.y+dy;}
  paint();if(event.cancelable)event.preventDefault();
 });
 const end=event=>{
  if(!pointers.delete(event.pointerId))return;
  if(moved)suppressClick=Date.now()+600;
  rebase();
 };
 for(const name of ['pointerup','pointercancel','lostpointercapture'])layer.addEventListener(name,end);
 // Резерв для WebKit: не отдавать pinch системному увеличению страницы.
 layer.addEventListener('touchmove',event=>{if(event.cancelable)event.preventDefault();},{passive:false});
 for(const name of ['gesturestart','gesturechange'])layer.addEventListener(name,event=>{if(event.cancelable)event.preventDefault();},{passive:false});
 layer.addEventListener('click',event=>{
  if(event.target.closest('#viewer-close')){close();return;}
  if(Date.now()<suppressClick){event.preventDefault();return;}
  const box=image.getBoundingClientRect();
  if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)close();
 });
 layer.addEventListener('wheel',event=>{
  if(event.target.closest('button'))return;
  event.preventDefault();zoomAt(scale*Math.exp(-event.deltaY*.002),{x:event.clientX,y:event.clientY});suppressClick=Date.now()+600;
 },{passive:false});
 layer.addEventListener('keydown',event=>{if(event.key==='Tab'){event.preventDefault();$('viewer-close').focus({preventScroll:true});}});
 layer.addEventListener('contextmenu',event=>event.preventDefault());
 const resize=()=>{if(visible())reset();};window.addEventListener('resize',resize);window.visualViewport?.addEventListener('resize',resize);
}
export function showPhotoViewer(url,onClose,opener){
 init();const layer=$('viewer-layer');
 if(layer.hidden){previousFocus=opener||document.activeElement;wasInert=$('chat').inert;}
 close=onClose||hidePhotoViewer;suppressClick=0;
 document.dispatchEvent(new Event('mayak-expression-close'));
 if(document.activeElement?.matches('input,textarea,[contenteditable=true]'))document.activeElement.blur();
 $('viewer-image').src=url;layer.hidden=false;$('chat').inert=true;adjustViewport();reset();$('viewer-close').focus({preventScroll:true});
}
export function hidePhotoViewer(){
 const layer=$('viewer-layer');if(!layer||layer.hidden)return;
 layer.hidden=true;$('viewer-image').removeAttribute('src');reset();$('chat').inert=wasInert;
 if(previousFocus?.isConnected&&!previousFocus.matches('input,textarea,[contenteditable=true]'))previousFocus.focus({preventScroll:true});
 previousFocus=null;followViewport(800);
}
