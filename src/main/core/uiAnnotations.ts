/** Repair the narrow legacy pattern: an out-of-flow label above a horizontal
 * bar's reference line collides with its preceding title. Reserve normal-flow
 * space for that label instead of translating text or guessing CSS class names.
 */
export const UI_ANNOTATIONS = `<script data-fenn-ui-annotations>
(()=>{
 const init=()=>{
  const root=document.querySelector('main[data-fenn-ui]')||document.body;
  if(!root)return;
  const originals=new Map();let queued=false,styles=new WeakMap();
  const style=el=>{if(!styles.has(el))styles.set(el,getComputedStyle(el));return styles.get(el)};
  const rect=el=>{const r=document.createRange();r.selectNodeContents(el);return r.getBoundingClientRect()};
  const referenceLine=bar=>{
   for(const el of [bar,...bar.querySelectorAll('*')].slice(0,64)){
    const r=el.getBoundingClientRect(),s=style(el);
    if(r.width<=8&&r.height>=10&&s.position==='absolute'&&(parseFloat(s.borderLeftWidth)>0||parseFloat(s.borderRightWidth)>0||s.backgroundImage!=='none'||s.backgroundColor!=='rgba(0, 0, 0, 0)'))return true;
    for(const pseudo of ['::before','::after']){
     const p=getComputedStyle(el,pseudo);
     if(p.content!=='none'&&p.content!=='normal'&&p.position==='absolute'&&parseFloat(p.height)>=10&&parseFloat(p.width)<=8&&(parseFloat(p.borderLeftWidth)>0||parseFloat(p.borderRightWidth)>0))return true;
    }
   }
   return false;
  };
  const trackFor=label=>{
   let absolute=false;
   for(let el=label,depth=0;el&&el!==root&&depth<7;el=el.parentElement,depth++){
    const s=style(el),r=el.getBoundingClientRect();
    if(s.position==='fixed')return null;
    if(s.position==='absolute'){absolute=true;continue}
    if(absolute&&r.width>=100&&r.height>=4&&r.height<=96&&r.width>=3*r.height&&referenceLine(el))return el;
   }
   return null;
  };
  const titleFor=bar=>{
   for(let el=bar,depth=0;el&&el!==root&&depth<3;el=el.parentElement,depth++){
    const prev=el.previousElementSibling;
    if(!prev)continue;
    const s=style(prev),text=prev.textContent.trim();
    if(s.position==='absolute'||s.position==='fixed'||!text||text.length>240||prev.querySelector('input,select,button,table,svg,canvas'))return null;
    return rect(prev);
   }
   return null;
  };
  const repair=()=>{
   queued=false;
   // Start from authored spacing each time, so wider windows and new labels
   // can release a lane. All writes happen before paint and do not accumulate.
   for(const [el,original] of originals){if(el.isConnected){if(original.value)el.style.setProperty('margin-block-start',original.value,original.priority);else el.style.removeProperty('margin-block-start')}}
   originals.clear();
   for(let pass=0;pass<3;pass++){
    styles=new WeakMap();
    const needed=new Map();
    for(const label of [...root.querySelectorAll('span,small,strong,b,label,div,p')].slice(0,2000)){
     if(label.childElementCount||!label.textContent.trim()||label.textContent.length>200||label.closest('button,a,input,select,textarea,[role=tooltip]'))continue;
     const bar=trackFor(label);if(!bar)continue;
     const text=rect(label),track=bar.getBoundingClientRect(),title=titleFor(bar);
     if(!title||!text.width||!text.height||text.height>80||text.top>=track.top||text.bottom>track.top+8)continue;
     if(text.right<=title.left||text.left>=title.right||text.bottom<=title.top||text.top>=title.bottom+8)continue;
     const gap=title.bottom+8-text.top;
     if(gap>0&&gap<=96)needed.set(bar,Math.max(needed.get(bar)||0,gap));
    }
    if(!needed.size)break;
    for(const [bar,gap] of needed){
     if(!originals.has(bar))originals.set(bar,{value:bar.style.getPropertyValue('margin-block-start'),priority:bar.style.getPropertyPriority('margin-block-start')});
     const margin=parseFloat(getComputedStyle(bar).marginBlockStart)||0;
     bar.style.setProperty('margin-block-start',(margin+Math.ceil(gap))+'px');
    }
   }
   mutations.takeRecords();
  };
  const schedule=()=>{if(!queued){queued=true;requestAnimationFrame(repair)}};
  const mutations=new MutationObserver(schedule);
  mutations.observe(root,{subtree:true,childList:true,characterData:true,attributes:true});
  new ResizeObserver(schedule).observe(root);
  addEventListener('resize',schedule);addEventListener('load',schedule);
  document.fonts.ready.then(schedule);
  repair();
 };
 if(document.readyState==='loading')addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
</script>`
