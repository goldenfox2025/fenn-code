// Matches --space-3 in the host: space for rounded focus rings and edge shadows.
const DISPLAY_STYLE = `<style data-fenn-ui-display>[data-fenn-ui]{padding:6px}:where(button,select,input:not([type=range],[type=checkbox],[type=radio]),textarea){border-radius:6px}:focus-visible{outline-offset:-2px}</style>`
// Native pickers in a sandbox cannot be opened explicitly, and their default
// mouse action scrolls tall frames into view. Use the app's existing menu.
const PICKER_BEHAVIOR = `<script data-fenn-ui-picker-events>
(()=>{
 let host=false,seq=0,pending=null;
 addEventListener('message',e=>{
  if(e.source!==parent)return;
  if(e.data?.type==='fenn:ui-theme')host=e.data.selectMenu===true;
  if(e.data?.type!=='fenn:ui-select-result'||!pending||e.data.id!==pending.id)return;
  const el=pending.el,index=e.data.index;pending=null;
  if(!el.isConnected)return;
  if(Number.isInteger(index)&&index>=0&&index<el.options.length&&!el.options[index].disabled&&!el.options[index].parentElement.disabled&&index!==el.selectedIndex){el.selectedIndex=index;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))}
  el.focus({preventScroll:true});
 });
 for(const type of ['pointerdown','click','keydown'])document.addEventListener(type,e=>{
  const el=e.target;
  if(!host||e.defaultPrevented||!(el instanceof HTMLSelectElement)||el.disabled||el.multiple||el.size>1||!el.options.length||el.options.length>2000)return;
  if(type==='keydown'&&![' ','Enter','ArrowDown','ArrowUp'].includes(e.key))return;
  e.preventDefault();el.focus({preventScroll:true});
  if(type==='pointerdown')return;
  const r=el.getBoundingClientRect(),id=++seq;
  pending={id,el};
  parent.postMessage({type:'fenn:ui-select',id,rect:{left:r.left,top:r.top,width:r.width,height:r.height},options:Array.from(el.options,(o,index)=>({label:o.label,index,disabled:o.disabled||o.parentElement.disabled===true,selected:o.selected,group:o.parentElement.tagName==='OPTGROUP'?o.parentElement.label:undefined}))},'*');
 },true);
})();
</script>`
const LAYOUT_STYLE = `<style data-fenn-ui-layout>
[data-fenn-ui]{max-width:100%;overflow-x:auto}
[data-fenn-ui] :where(div,section,article,form,fieldset){min-width:0;max-width:100%}
[data-fenn-ui] :where(input,select,textarea,button){max-width:100%}
[data-fenn-ui] :where(pre,table){display:block;max-width:100%;overflow:auto}
</style>`

/** Apply current display fixes to saved UI documents too; user source stays intact. */
export function uiDisplayDocument(html: string): string {
  if (!html.includes('<main data-fenn-ui>')) return html
  // Replace the previous generated picker, including saved documents. The
  // source fragment and authored CSS are preserved.
  html = html.replace(/<style data-fenn-ui-picker>[\s\S]*?<\/style>/g, '').replace(/<script data-fenn-ui-picker-events>[\s\S]*?<\/script>/g, '')
  const additions = (!html.includes('data-fenn-ui-display') ? DISPLAY_STYLE : '') + (!html.includes('data-fenn-ui-layout') ? LAYOUT_STYLE : '') + PICKER_BEHAVIOR
  return html.replace(/<\/head>/i, `${additions}</head>`)
}

/** A self-contained UI fragment gets typography and colors, not a webpage shell. */
export function uiDocument(fragment: string): string {
  if (!fragment.trim()) throw new Error('UI 内容不能为空')
  if (/<(?:!doctype|html|head|body)(?:\s|>)/i.test(fragment)) {
    throw new Error('render_ui 接受嵌入正文的 UI 片段，不需要 html/head/body 或整页布局；完整网页请用 publish_page。')
  }
  return uiDisplayDocument(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{color-scheme:light dark;--text:light-dark(#141413,#faf9f5);--text-2:light-dark(#3d3d3a,#e5e3da);--text-3:light-dark(#73726c,#a6a39a);--bg:light-dark(#faf9f5,#262624);--bg-elevated:light-dark(#fff,#30302e);--border:light-dark(#deddd7,#484844);--accent:light-dark(#07789e,#3fd6f5);--accent-fg:light-dark(#fff,#062630)}
*{box-sizing:border-box}html,body{margin:0;background:transparent;color:var(--text);font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}html{overflow-x:hidden}body{overflow-wrap:anywhere}
[data-fenn-ui]{display:flow-root;width:100%;min-width:0}button,input,select,textarea{font:inherit}button,input,select{accent-color:var(--accent)}button{cursor:pointer}svg,img,canvas{max-width:100%}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--border)}:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style></head><body><main data-fenn-ui>${fragment}</main><script>
(()=>{
 const root=document.querySelector('[data-fenn-ui]');let queued=false,last=-1;
 const measure=()=>{if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;const h=Math.ceil(Math.max(root.getBoundingClientRect().height,root.scrollHeight));if(h!==last){last=h;parent.postMessage({type:'fenn:ui-size',height:h},'*')}})};
 new ResizeObserver(measure).observe(root);
 new MutationObserver(measure).observe(root,{subtree:true,childList:true,attributes:true,characterData:true});
 addEventListener('load',measure);document.fonts.ready.then(measure);
 addEventListener('message',e=>{if(e.source!==parent||e.data?.type!=='fenn:ui-theme')return;const p=e.data.palette;for(const k of ['text','text-2','text-3','bg','bg-elevated','border','accent','accent-fg']){if(typeof p?.[k]==='string')document.documentElement.style.setProperty('--'+k,p[k])}if(e.data.scheme==='dark'||e.data.scheme==='light')document.documentElement.style.colorScheme=e.data.scheme;last=-1;measure()});
 measure();
})();
</script></body></html>`)
}
