import type { RankedMusic } from '@qgroup/domain';

type PackedMusic<T extends RankedMusic> = { entry:T; id:string; count:number; baseR:number; r:number; x:number; y:number };
// Ported from music_site/public/app.js: seeded scatter packing, weighted toward
// the centre for popular terms. Each kind has its own scale and canvas bounds.
function hashId(id:string) {
  let h=2166136261;
  for(let i=0;i<id.length;i++){h^=id.charCodeAt(i);h=Math.imul(h,16777619);}
  return h>>>0;
}
function makeRng(seed:number) {
  let s=seed>>>0;
  return ()=>{s=(s+0x6D2B79F5)>>>0;let t=s;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;};
}
function tryPlace<T extends RankedMusic>(items:PackedMusic<T>[],W:number,H:number,pad:number,gap:number,scale:number) {
  const placed:PackedMusic<T>[]=[],cx=W/2,cy=H/2,maxDist=Math.max(1,Math.hypot(W/2-pad-8,H/2-pad-8));
  const maxCount=Math.max(1,...items.map(it=>it.count||0));
  for(let i=0;i<items.length;i++){
    const it=items[i]!,r=Math.max(9,it.baseR*scale),rnd=makeRng(hashId(it.id)+i*7919+101);
    const spanX=Math.max(1,W-2*(pad+r)),spanY=Math.max(1,H-2*(pad+r)),desired=1-Math.min(1,(it.count||0)/maxCount);
    let best:{x:number;y:number}|null=null,bestScore=-Infinity;
    for(let t=0;t<320+i*24;t++){
      const x=pad+r+rnd()*spanX,y=pad+r+rnd()*spanY;
      let minGap=Infinity,ok=true;
      for(const p of placed){const dx=p.x-x,dy=p.y-y,distanceSquared=dx*dx+dy*dy,limit=p.r+r+gap;if(distanceSquared<limit*limit){ok=false;break;}const d=Math.sqrt(distanceSquared)-limit;if(d<minGap)minGap=d;}
      if(!ok)continue;
      const cd=Math.min(1,Math.hypot(x-cx,y-cy)/maxDist),bias=Math.abs(cd-desired),score=-bias*100+Math.min(minGap,40)*0.4;
      if(score>bestScore){bestScore=score;best={x,y};}
      if(bias<0.02&&minGap>gap*3)break;
    }
    if(!best)return false;
    it.x=best.x;it.y=best.y;it.r=r;placed.push(it);
  }
  return true;
}
export function musicBubbleLayout<T extends RankedMusic>(entries:readonly T[],availableWidth:number,kind:'main'|'sub'=entries[0]?.kind??'sub') {
  const width=Math.max(280,availableWidth),n=entries.length;
  const base=kind==='main'?width*.42:width*.60,extra=kind==='main'?n*8:n*4,cap=kind==='main'?560:720;
  let height=Math.round(Math.min(cap,Math.max(kind==='main'?280:360,base+extra)));
  const max=Math.max(1,...entries.map(e=>e.count||0));
  const items=entries.map(entry=>{const ratio=Math.max(0,entry.count)/max,r=kind==='main'?26+26*Math.sqrt(ratio):12+30*Math.sqrt(ratio);return{entry,id:entry.id,count:entry.count,baseR:r,r,x:0,y:0};});
  const pad=10,gap=12,usable=Math.max(1,width-pad*2)*Math.max(1,height-pad*2),total=items.reduce((sum,it)=>sum+Math.PI*it.baseR*it.baseR,0);
  let scale=total>0?Math.min(1,Math.sqrt(usable*.46/total)):1,placed=false;
  for(let attempt=0;attempt<40;attempt++){if(tryPlace(items,width,height,pad,gap,scale)){placed=true;break;}scale*=.9;}
  // The old fixed cap can leave late terms unplaced in unusually large catalogs.
  // Retain every term by extending only those charts, using the same placement.
  while(!placed){height=Math.ceil(height*1.2);placed=tryPlace(items,width,height,pad,gap,scale);}
  return{width,height:n?height:0,circles:items.map(({entry,x,y,r})=>({entry,x,y,radius:r}))};
}
const graphemes = new Intl.Segmenter('zh', { granularity: 'grapheme' });
function charWidth(cluster:string){return /[\u3000-\u9fff\uff00-\uffef]|\p{Extended_Pictographic}/u.test(cluster)?1:.56;}
function wrapLabel(text:string,maxWidth:number,fontSize:number,maxLines:number){
  const pieces=Array.from(graphemes.segment(text),part=>part.segment),lines:string[]=[],measure=(value:string)=>Array.from(graphemes.segment(value),part=>charWidth(part.segment)*fontSize).reduce((sum,n)=>sum+n,0);
  let current='',used=0;
  for(const piece of pieces){const width=charWidth(piece)*fontSize;if(current&&used+width>maxWidth){lines.push(current);current='';used=0;}current+=piece;used+=width;}
  if(current)lines.push(current);
  if(lines.length>maxLines){const keep=lines.slice(0,maxLines-1),rest=Array.from(graphemes.segment(lines.slice(maxLines-1).join('')),part=>part.segment);while(rest.length&&measure(rest.join('')+'…')>maxWidth)rest.pop();keep.push(rest.join('')+'…');return keep;}
  return lines;
}
/** Source typography scales to the circle; full names/counts remain accessible. */
export function musicBubbleTypography(text:string,radius:number){
  const maxWidth=radius*1.72,start=Math.max(9,Math.min(20,radius*.33));
  let fontSize=Math.max(7.5,radius*.24),lines=wrapLabel(text,maxWidth,fontSize,2);
  for(let fs=start;fs>=10.5;fs-=.5){const one=wrapLabel(text,maxWidth,fs,1);if(one.length===1&&one[0]===text){fontSize=fs;lines=one;break;}}
  if(lines[0]!==text)for(let fs=start;fs>=8;fs-=.5){const wrapped=wrapLabel(text,maxWidth,fs,2);if(wrapped.every(line=>Array.from(graphemes.segment(line)).length>1||Array.from(graphemes.segment(text)).length<=1)){fontSize=fs;lines=wrapped;break;}}
  return{lines,fontSize,lineHeight:fontSize*1.18,countFontSize:radius>=26?Math.max(7.5,Math.min(11,radius*.18)):null};
}
export function musicBubbleLabel(name:string,radius:number){return musicBubbleTypography(name,radius).lines;}
