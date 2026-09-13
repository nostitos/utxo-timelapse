import { blockX, EPOCH_BLOCKS, TIP } from './axis-mapping.mjs';
document.documentElement.classList.add('js');
const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
const $=s=>document.querySelector(s);
// Colour legends are extracted from the same metadata as the published explorer.
const canvases=[...document.querySelectorAll('[data-palette]')];
if(canvases.length) fetch('./assets/palettes.json').then(r=>{if(!r.ok)throw Error('Palette metadata unavailable');return r.json();}).then(p=>{
  canvases.forEach(c=>{const ctx=c.getContext('2d'),hex=p[c.dataset.palette];for(let x=0;x<c.width;x++){const i=Math.min(255,Math.floor(x/c.width*256));ctx.fillStyle='#'+hex.slice(i*6,i*6+6);ctx.fillRect(x,0,1,c.height);}});
}).catch(()=>{canvases.forEach(c=>{c.hidden=true;const t=document.createElement('span');t.textContent='See the colour legend in the explorer.';c.after(t);});});
// Real images remain normal links without JavaScript; dialog adds a larger inspection view.
const lightbox=$('#lightbox');
if(lightbox){
 document.querySelectorAll('[data-lightbox]').forEach(link=>link.addEventListener('click',e=>{e.preventDefault();$('#lightbox-caption').textContent=link.dataset.caption||'';$('#lightbox-image').src=link.href;$('#lightbox-image').alt=link.querySelector('img')?.alt||link.dataset.caption;$('#lightbox-original').href=link.href;lightbox.showModal();}));
 $('#lightbox-close').addEventListener('click',()=>lightbox.close());
 lightbox.addEventListener('click',e=>{if(e.target===lightbox){const r=lightbox.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)lightbox.close();}});
}
const compare=$('#compare-range');
if(compare){
 const comparison=$('#comparison');
 const updateComparison=()=>{
  comparison.style.setProperty('--split',compare.value+'%');
  compare.setAttribute('aria-valuetext',`${compare.value}% original, ${100-Number(compare.value)}% UTXO Timelapse`);
 };
 // The native range provides keyboard and assistive-technology controls. Pointer
 // coordinates follow the image itself, without an invisible native thumb offset.
 const moveComparison=e=>{
  const bounds=compare.getBoundingClientRect();
  if(!bounds.width)return;
  compare.value=String(Math.round(Math.max(0,Math.min(1,(e.clientX-bounds.left)/bounds.width))*100));
  updateComparison();
 };
 let pointer=null;
 compare.addEventListener('input',updateComparison);
 compare.addEventListener('pointerdown',e=>{
  if(!e.isPrimary||e.button!==0)return;
  e.preventDefault();
  pointer=e.pointerId;
  compare.focus({preventScroll:true});
  compare.setPointerCapture(pointer);
  moveComparison(e);
 });
 compare.addEventListener('pointermove',e=>{if(e.pointerId===pointer)moveComparison(e);});
 compare.addEventListener('pointerup',e=>{
  if(e.pointerId!==pointer)return;
  moveComparison(e);
  compare.releasePointerCapture(pointer);
  pointer=null;
 });
 const cancel=()=>{pointer=null;};
 compare.addEventListener('pointercancel',cancel);
 compare.addEventListener('lostpointercapture',cancel);
 updateComparison();
}
// Previews load on explicit request, or when visible with motion enabled. Playback always has a pause control.
const userPaused=new WeakSet();
function loadVideo(v){if(v.dataset.loaded)return;v.querySelectorAll('source[data-src]').forEach(s=>s.src=s.dataset.src);v.dataset.loaded='true';v.load();}
document.querySelectorAll('[data-video]').forEach(button=>{
 const v=document.getElementById(button.dataset.video);
 v.addEventListener('play',()=>{button.textContent='Pause preview Ⅱ';button.setAttribute('aria-pressed','true');});
 v.addEventListener('pause',()=>{button.textContent='Play preview ▷';button.setAttribute('aria-pressed','false');});
 button.addEventListener('click',()=>{loadVideo(v);if(v.paused){userPaused.delete(v);v.play().catch(()=>{});}else{userPaused.add(v);v.pause();}});
});
const videoObserver=new IntersectionObserver(entries=>entries.forEach(({target:v,isIntersecting})=>{if(isIntersecting&&!reduced.matches&&!userPaused.has(v)){loadVideo(v);v.play().catch(()=>{});}else v.pause();}),{threshold:.25});
document.querySelectorAll('video').forEach(v=>videoObserver.observe(v));
reduced.addEventListener('change',()=>{if(reduced.matches)document.querySelectorAll('video').forEach(v=>v.pause());});
document.addEventListener('visibilitychange',()=>{if(document.hidden)document.querySelectorAll('video').forEach(v=>v.pause());});
if(!reduced.matches){const ob=new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting){e.target.classList.remove('pending');ob.unobserve(e.target);}}),{threshold:.05});document.querySelectorAll('.reveal').forEach(el=>{el.classList.add('pending');ob.observe(el);});}
function progress(){const p=$('.progress');if(p)p.style.width=100*window.scrollY/Math.max(1,document.documentElement.scrollHeight-innerHeight)+'%';}
addEventListener('scroll',progress,{passive:true});progress();
// Time-axis comparison, all geometry in a 3720-pixel source canvas before SVG scaling.
const range=$('#epoch-range'),svg=$('#axis-demo');
const ns='http://www.w3.org/2000/svg';
function node(tag,attrs,text){const el=document.createElementNS(ns,tag);for(const [k,v]of Object.entries(attrs))el.setAttribute(k,v);if(text!==undefined)el.textContent=text;return el;}
function drawAxis(){
 if(!range)return;const b=Number(range.value),current=Math.floor(b/EPOCH_BLOCKS),X=120,W=1020,sourceWidth=3720;
 svg.replaceChildren();$('#epoch-output').textContent='BLOCK '+b.toLocaleString('en-US');
 const colors=['#28362f','#364638','#455741','#56684a','#687a53','#7d8e61','#93a470','#acba85','#c5d09c','#e1e4bb'];
 for(const [row,compressed]of [[42,false],[132,true]]){
  svg.append(node('text',{x:0,y:row+19},compressed?'COMPRESSED':'LINEAR'));
  svg.append(node('rect',{x:X,y:row,width:W,height:38,fill:'#111c21'}));
  const map=h=>X+(compressed?blockX(h,b,sourceWidth)/sourceWidth:h/TIP)*W;
  for(let e=0;e<=current;e++){
    const start=e*EPOCH_BLOCKS,end=Math.min(b,(e+1)*EPOCH_BLOCKS-1),sx=map(start),ex=map(end);
    if(end<start)continue;
    svg.append(node('rect',{x:sx,y:row,width:Math.max(.7,ex-sx),height:38,fill:colors[e%colors.length]}));
    svg.append(node('line',{x1:sx,y1:row,x2:sx,y2:row+38,stroke:'#080b0e','stroke-width':1}));
  }
  const cursor=map(b);svg.append(node('line',{x1:cursor,y1:row-9,x2:cursor,y2:row+43,stroke:'#f6f4dc','stroke-width':2}));
  for(const h of [210000,420000,630000,840000])if(h<=b){let x=map(h);svg.append(node('path',{d:`M${x-3} ${row-6}l3 -5l3 5z`,fill:'#edbf76'}));if(!compressed)svg.append(node('text',{x,y:row+58,'text-anchor':'middle'},(h/1000)+'k'));}
  svg.append(node('text',{x:X,y:row+58},'0'));
 }
 $('#epoch-note').textContent=current<2?'Two epochs fit before the first compression.':b%EPOCH_BLOCKS<120?'Inside the 120-block smooth transition.':'Newest epoch: 50% of the width. Gold = subsidy halving.';
}
range?.addEventListener('input',drawAxis);document.querySelectorAll('[data-epoch-block]').forEach(b=>b.addEventListener('click',()=>{range.value=b.dataset.epochBlock;drawAxis();}));drawAxis();
const filter=$('#config-filter');filter?.addEventListener('input',()=>{const term=filter.value.trim().toLowerCase();let visible=0;document.querySelectorAll('#config-body tr').forEach(row=>{row.hidden=!row.textContent.toLowerCase().includes(term);if(!row.hidden)visible++;});$('#config-count').textContent=visible+' settings shown';});
if($('.toc')){const ob=new IntersectionObserver(entries=>{entries.forEach(e=>{if(e.isIntersecting){document.querySelectorAll('.toc a').forEach(a=>a.classList.toggle('active',a.hash==='#'+e.target.id));}});},{rootMargin:'-5% 0px -75% 0px'});document.querySelectorAll('.reference-body section[id]').forEach(s=>ob.observe(s));}
