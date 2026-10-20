// Matches --space-3 in the host: space for rounded focus rings and edge shadows.
const DISPLAY_STYLE = `<style data-fenn-ui-display>[data-fenn-ui]{padding:6px}:where(button,select,input:not([type=range],[type=checkbox],[type=radio]),textarea){border-radius:6px}:focus-visible{outline-offset:-2px}</style>`

/** Apply current display fixes to saved UI documents too; user source stays intact. */
export function uiDisplayDocument(html: string): string {
  return html.includes('<main data-fenn-ui>') && !html.includes('data-fenn-ui-display')
    ? html.replace(/<\/head>/i, `${DISPLAY_STYLE}</head>`)
    : html
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
