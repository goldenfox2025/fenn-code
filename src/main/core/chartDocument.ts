import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { uiDocument } from './uiDocument'

export interface ChartSpec {
  title: string
  type: 'line' | 'bar'
  labels: string[]
  series: { name: string; values: (number | null)[] }[]
  unit?: string
  source?: string
}

let library: string | undefined
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** A portable, offline chart: the agent supplies data, not layout boilerplate. */
export function chartDocument(raw: unknown): string {
  const c = raw as ChartSpec
  if (!c || typeof c.title !== 'string' || !c.title.trim() || c.title.length > 120 || !['line', 'bar'].includes(c.type)) throw new Error('Chart needs a title and type line or bar')
  if (!Array.isArray(c.labels) || c.labels.length < 1 || c.labels.length > 500 || c.labels.some((v) => typeof v !== 'string' || v.length > 200)) throw new Error('labels must contain 1–500 text labels')
  if (!Array.isArray(c.series) || !c.series.length || c.series.length > 10 || c.series.some((s) => !s || typeof s.name !== 'string' || !s.name.trim() || s.name.length > 120 || !Array.isArray(s.values) || s.values.length !== c.labels.length || s.values.some((v) => v !== null && (typeof v !== 'number' || !Number.isFinite(v))))) throw new Error('Each series needs a name and one finite number or null per label')
  if ([c.unit, c.source].some((s) => s !== undefined && (typeof s !== 'string' || s.length > 1000))) throw new Error('unit and source must be short text')
  // Chart.js is a declared runtime dependency and ships in desktop packages.
  library ??= readFileSync(join(dirname(createRequire(import.meta.url).resolve('chart.js')), 'chart.umd.js'), 'utf8')
  const json = JSON.stringify(c).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  const heading = `<tr><th></th>${c.series.map((s) => `<th>${escape(s.name)}</th>`).join('')}</tr>`
  const rows = c.labels.map((l, i) => `<tr><th>${escape(l)}</th>${c.series.map((s) => `<td>${s.values[i] ?? '—'}</td>`).join('')}</tr>`).join('')
  return uiDocument(`<style>
[data-fenn-chart]{margin:0;min-width:0}[data-fenn-chart] figcaption{font-weight:600;margin-bottom:12px}[data-fenn-chart] .chart-plot{position:relative;width:100%;height:clamp(240px,45vw,360px)}[data-fenn-chart] .chart-source{color:var(--text-3);font-size:12px;margin:10px 0}[data-fenn-chart] details{font-size:12px;margin-top:12px}[data-fenn-chart] summary{cursor:pointer;color:var(--text-3)}[data-fenn-chart] table{font-variant-numeric:tabular-nums;font-size:12px;margin-top:8px;max-height:320px;overflow:auto}
</style><figure data-fenn-chart><figcaption>${escape(c.title)}</figcaption><div class="chart-plot"><canvas tabindex="0" role="img" aria-label="${escape(c.title)}. ← →: inspect data; Esc: close tooltip."></canvas></div>${c.source ? `<p class="chart-source">${escape(c.source)}</p>` : ''}<details><summary>Data</summary><table>${heading}${rows}</table></details></figure>
<script>${library.replace(/<\/script/gi, '<\\/script')}</script><script>
(()=>{
 const spec=${json},figure=document.querySelector('[data-fenn-chart]'),canvas=figure.querySelector('canvas');
 const color=k=>getComputedStyle(document.documentElement).getPropertyValue('--'+k).trim();
 const colors=[color('accent'),'#8b78c4','#b87844','#4e9380','#ba728c','#8b897b'];
 const chart=new Chart(canvas,{type:spec.type,data:{labels:spec.labels,datasets:spec.series.map((s,i)=>({label:s.name,data:s.values,borderColor:colors[i%colors.length],backgroundColor:spec.type==='bar'?colors[i%colors.length]:colors[i%colors.length]+'22',borderWidth:2,pointRadius:spec.labels.length>50?0:2,pointHitRadius:12,borderDash:i>=colors.length?[5,3]:[],spanGaps:false}))},options:{responsive:true,maintainAspectRatio:false,animation:false,interaction:{mode:'index',intersect:false},plugins:{legend:{display:spec.series.length>1,position:'bottom',align:'start',labels:{usePointStyle:true,pointStyle:spec.type==='line'?'line':'rectRounded',pointStyleWidth:20,boxWidth:20,boxHeight:6,padding:16,font:{size:12}}},tooltip:{callbacks:{label:ctx=>ctx.dataset.label+': '+(ctx.parsed.y??'—')+(spec.unit?' '+spec.unit:'')}}},scales:{x:{grid:{display:false},ticks:{maxRotation:0,autoSkip:true,maxTicksLimit:8}},y:{beginAtZero:spec.type==='bar',title:{display:!!spec.unit,text:spec.unit},ticks:{maxTicksLimit:6}}}}});
 const theme=()=>{const text=color('text-2'),border=color('border');chart.options.color=text;for(const axis of Object.values(chart.options.scales)){axis.ticks.color=text;axis.title.color=text;axis.grid.color=border;axis.border.color=border}chart.data.datasets[0].borderColor=color('accent');if(spec.type==='bar')chart.data.datasets[0].backgroundColor=color('accent');chart.update('none')};
 new MutationObserver(theme).observe(document.documentElement,{attributes:true,attributeFilter:['style']});theme();
 let index=0;canvas.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home','End','Escape'].includes(e.key))return;e.preventDefault();if(e.key==='Escape'){chart.setActiveElements([]);chart.tooltip.setActiveElements([],{x:0,y:0});chart.update('none');return}index=e.key==='Home'?0:e.key==='End'?spec.labels.length-1:Math.max(0,Math.min(spec.labels.length-1,index+(e.key==='ArrowRight'?1:-1)));const active=spec.series.map((_,datasetIndex)=>({datasetIndex,index})).filter(a=>chart.isDatasetVisible(a.datasetIndex)&&spec.series[a.datasetIndex].values[index]!==null);chart.setActiveElements(active);chart.tooltip.setActiveElements(active,active.length?chart.getDatasetMeta(active[0].datasetIndex).data[index].getCenterPoint():{x:0,y:0});chart.update('none')});
})();
</script>`)
}
