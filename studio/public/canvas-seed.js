const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function shouldEditCanvas(question, active = false) {
  if (active) return true;
  if (typeof question !== 'string') return false;
  // Require an instruction, not a mathematical noun such as "rate of change"
  // or a question about HTML. An active canvas already owns its follow-ups.
  const instruction = /(?:^|[.!?;]\s*)(?:now[,\s]+)?(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?|i(?:'d| would) like you to\s+|i want you to\s+)?(change|set|replace|turn|make|build|create|add|design|remove|edit|redesign|restyle|rewrite|update|generate|convert)\b([^.!?;]*)/ig;
  const target = /\b(?:html|css|website|webpage|theme|palette|background|layout|coefficient|page|section|block|card|diagram|graph|function|f\s*\(|f of x|fx\b|font|colou?r|cerebras|google|animation|button)\b/i;
  for (const match of question.matchAll(instruction)) {
    if (/^(?:redesign|restyle)$/i.test(match[1]) || target.test(match[2])) return true;
  }
  return false;
}
export function canvasSeed(sheet, title = 'Lesson Lab') {
  const parts = [];
  for (const selector of ['.page-heading', '.graph-section', '#lesson-blocks', '#live-notes-section']) {
    const original = sheet.querySelector(selector);
    if (!original || original.hidden) continue;
    const clone = original.cloneNode(true);
    clone.querySelectorAll('button,input,select,textarea,script,iframe,details,.explanation-label,.focus-cue,.block-focus,.note-actions,[hidden]').forEach(n => n.remove());
    clone.querySelectorAll('*').forEach(n => {
      for (const attr of [...n.attributes]) if (/^on/i.test(attr.name) || ['tabindex','role','aria-pressed'].includes(attr.name)) n.removeAttribute(attr.name);
      if (n.dataset.passageId) { n.setAttribute('data-block-id',n.dataset.passageId); n.id = n.dataset.passageId; }
      n.classList.remove('is-teaching','is-focused','is-explaining');
    });
    for (const path of clone.querySelectorAll('path[d],polyline[points]')) { const attr=path.hasAttribute('d')?'d':'points';path.setAttribute(attr,path.getAttribute(attr).replace(/-?\d+\.\d+/g,v=>String(Number(Number(v).toFixed(2))))); }
    clone.setAttribute('data-block-id', selector.includes('graph') ? 'working-example' : selector.includes('heading') ? 'introduction' : selector.slice(1));
    parts.push(clone.outerHTML);
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>
:root{color-scheme:light;--paper:#faf8f1;--ink:#25392e;--accent:#2c6549;--line:#d7dfd2}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.75 Georgia,serif}main{max-width:980px;margin:auto;padding:clamp(24px,5vw,66px)}h1,h2{font-size:clamp(30px,5vw,54px);line-height:1.12;letter-spacing:-.035em}h3{font-size:23px;line-height:1.3}h4{font-size:19px}p{max-width:72ch}.eyebrow,.source-tag,.note-source{font:11px/1.6 sans-serif;letter-spacing:.08em}.eyebrow{text-transform:uppercase;color:var(--accent)}.graph-section{margin:38px 0;padding:28px 0;border-block:1px solid var(--line)}svg{display:block;width:100%;height:auto;overflow:visible}svg text{font:12px sans-serif;fill:var(--ink)}.graph-legend{display:flex;gap:24px;font:12px sans-serif}.computed-comparison{display:flex;flex-wrap:wrap;gap:24px}.computed-comparison dl{min-width:40%}dt{font:12px sans-serif}dd{font-size:32px;margin:4px 0}.computed-comparison p{width:100%}.graph-footnote{font:11px/1.6 sans-serif}.lesson-block,.live-note{padding:24px 0;border-bottom:1px solid var(--line)}.source-tag{color:#586b5c}.formula{font-size:24px;color:var(--accent)}a{color:var(--accent)}[data-block-id]{scroll-margin:20px}
</style></head><body><main>${parts.join('\n')}</main></body></html>`;
}
