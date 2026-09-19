import { canvasSeed, shouldEditCanvas } from './canvas-seed.js';
import { spokenText } from './narration.js';
const $ = id => document.getElementById(id);
const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const PREVIEW_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; media-src 'none'; form-action 'none'; base-uri 'none'";
export function previewHTML(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,iframe,object,embed,form,base,link,meta[http-equiv]').forEach(n => n.remove());
  for (const n of doc.querySelectorAll('*')) for (const a of [...n.attributes]) if (/^on/i.test(a.name) || ['srcdoc','formaction','action','autofocus'].includes(a.name)) n.removeAttribute(a.name);
  const csp = doc.createElement('meta'); csp.httpEquiv = 'Content-Security-Policy'; csp.content = PREVIEW_CSP; doc.head.prepend(csp);
  return '<!doctype html>\n' + doc.documentElement.outerHTML;
}
export class LiveCanvas {
  constructor(options) {
    this.o = options; this.active = false; this.busy = false; this.document = null; this.selected = null; this.key = null; this.generation = 0; this.controller = null; this.player = null; this.audioURL = null; this.frame = $('canvas-document'); this.lastQuestion = '';
    $('open-canvas').addEventListener('click', () => { this.o.beforeEdit(); void this.open().catch(error=>this.o.error(error.message)); });
    $('canvas-back').addEventListener('click', () => this.close());
    $('canvas-cancel').addEventListener('click', () => this.cancel());
    $('canvas-stop-voice').addEventListener('click',()=>{this.stopSpeech();$('canvas-status').textContent='Speaking stopped. The current page is kept.';});
    $('canvas-undo').addEventListener('click', () => void this.undo());
    $('canvas-download').addEventListener('click', () => this.download());
    for (const button of document.querySelectorAll('[data-canvas-prompt]')) button.addEventListener('click', () => this.o.ask(button.dataset.canvasPrompt));
    window.addEventListener('resize', () => { this.resize(); this.focus(this.selected, false); });
    this.observer = null;
    const scrolled=()=>{if(this.busy)this.userScrolled=true;};
    document.addEventListener('wheel',scrolled,{passive:true,capture:true});document.addEventListener('touchstart',scrolled,{passive:true,capture:true});
    document.addEventListener('keydown',event=>{if(['PageDown','PageUp','ArrowDown','ArrowUp','Home','End',' '].includes(event.key)&&!event.target.closest('input,textarea,select,[contenteditable]'))scrolled();});
  }
  handles(question) { return shouldEditCanvas(question, this.active); }
  anchor() { return this.o.anchor(); }
  contextKey() { const a=this.anchor(); return `${a?.connectionId}:${this.o.lessonKey()}:${a?.pageId}`; }
  current(serial, anchor) { return this.generation === serial && this.o.matches(anchor) && this.active && !document.hidden; }
  sync() {
    const key=this.contextKey();
    if (this.key===key) return;
    this.cancel(false); this.key=key; this.document=null; this.selected=null; this.active=false;
    $('canvas-workspace').hidden=true; document.body.classList.remove('canvas-active');
    const captured=this.anchor(), serial=this.generation; if (!captured?.connectionId) return;
    void this.o.get(`/api/canvas?connectionId=${encodeURIComponent(captured.connectionId)}`).then(async data=>{
      if (this.generation!==serial || this.key!==key || !this.o.matches(captured) || this.busy) return;
      if (data.document) { this.document=data.document; await this.open(); }
    }).catch(()=>{});
  }
  async open({scroll=true}={}) {
    const serial=this.generation;
    this.active=true; document.body.classList.add('canvas-active'); $('canvas-workspace').hidden=false;
    const html=this.document?.html || canvasSeed(document.querySelector('.lesson-sheet'),this.o.title());
    if (!this.document) this.document={revision:0,html,title:this.o.title(),narration:'',focusId:null,sourceHash:null};
    await this.render(this.document,()=>serial===this.generation && this.active);
    this.focus(this.document.focusId,false);
    $('canvas-script').textContent=spokenText(this.document);
    if(serial!==this.generation || !this.active)return;
    if(scroll) $('canvas-stage').scrollIntoView({block:'start',behavior:'smooth'});
    this.o.onChange?.();
  }
  close() { this.cancel(); this.active=false; $('canvas-workspace').hidden=true; document.body.classList.remove('canvas-active'); this.o.onChange?.(); }
  setWorking(value, message='Cerebras is rewriting the complete HTML and CSS.') {
    this.busy=value; $('canvas-placeholder').hidden=!value; $('canvas-stage').classList.toggle('is-working',value); $('canvas-phase').textContent=message;
    if(value) { $('canvas-frame').hidden=true;const r=$('canvas-stage').getBoundingClientRect();Object.assign($('canvas-placeholder').style,{top:`${Math.max(22,30-r.top)}px`,bottom:'auto',height:`${Math.max(260,Math.min(420,innerHeight-220))}px`}); }
    $('canvas-undo').disabled=value || !(this.document?.revision>0);
    this.o.onChange?.();
  }
  stopSpeech() {
    if(this.player||this.browserCancel)$('canvas-status').textContent='Speaking stopped. The current page is kept.';
    this.speechController?.abort(); this.speechController=null;
    if(this.player){this.player.pause(); this.player.src=''; this.player=null;}
    this.browserCancel?.(); this.browserCancel=null;
    if(this.audioURL){URL.revokeObjectURL(this.audioURL);this.audioURL=null;}
    $('canvas-stop-voice').hidden=true;this.o.playback(false);
  }
  cancel(remote=true) {
    this.generation++; this.controller?.abort(); this.controller=null; this.stopSpeech();
    if(this.busy){this.setWorking(false);$('canvas-status').textContent='Stopped. The last completed page is kept.';}
    if(remote && this.anchor()?.connectionId) this.cancelPromise=this.o.post('/api/canvas/cancel',{connectionId:this.anchor().connectionId}).catch(()=>{});
  }
  async edit(question, {read=false, voiceOwner=null}={}) {
    this.cancel(false); const serial=++this.generation, captured={...this.anchor()};
    this.controller=new AbortController(); const signal=this.controller.signal; const start=performance.now();
    try {
      await this.cancelPromise;
      if(!this.active) await this.open({scroll:false});
      if(!this.current(serial,captured)) return;
      this.userScrolled=false; this.lastQuestion=question; this.setWorking(true); $('canvas-status').textContent=question; $('canvas-script').textContent='';
      const latest=await this.o.get(`/api/canvas?connectionId=${encodeURIComponent(captured.connectionId)}`);
      if(!this.current(serial,captured))return;
      if(latest.document && latest.document.revision!==this.document?.revision){this.selected=null;await this.render(latest.document,()=>this.current(serial,captured),()=>{this.document=latest.document;});}
      if(!this.current(serial,captured))return;
      const result=await this.o.post('/api/canvas/edit',{anchor:captured,canvasRevision:this.document?.revision||0,question,...(this.document?.revision ? {} : {html:this.document?.html}),selectionId:this.selected},signal);
      if(!this.current(serial,captured)) return;
      $('canvas-phase').textContent='Checking the page and preparing the reveal.';
      await this.render(result.document,()=>this.current(serial,captured),()=>{this.document=result.document;});
      if(!this.current(serial,captured)) return;
      this.document=result.document; this.setWorking(false); $('canvas-stage').classList.remove('canvas-arriving'); void $('canvas-stage').offsetWidth; $('canvas-stage').classList.add('canvas-arriving');
      await frames();
      if(!this.current(serial,captured)) return;
      this.focus(this.document.focusId,false);
      const focused=this.focusNode(this.document.focusId);
      if(focused){const r=focused.getBoundingClientRect(),f=this.frame.getBoundingClientRect();if(r.height<=0 || r.width<=0 || getComputedStyle(focused).visibility==='hidden')throw Error('The explanation target is not visible. The page was saved, but speech was stopped.');if(!this.userScrolled && (f.top+r.top<12 || (r.height>innerHeight-220 ? f.top+r.top>100 : f.top+r.bottom>innerHeight-140)))window.scrollBy({top:f.top+r.top-70,behavior:'instant'});}
      await frames(); if(!this.current(serial,captured)) return;
      const rect=this.frame.getBoundingClientRect();
      if(rect.bottom<=0 || rect.top>=innerHeight || document.hidden) throw Error('The new page is not visible. Return to the canvas before asking again.');
      if(focused){const r=focused.getBoundingClientRect(),f=this.frame.getBoundingClientRect();if(f.top+r.bottom<=0 || f.top+r.top>=innerHeight-140)throw Error('The new explanation is outside the visible area. Scroll to it and ask to continue; speech stayed off.');}
      const ack=await this.o.post('/api/canvas/ack',{anchor:captured,canvasRevision:this.document.revision,sourceHash:this.document.sourceHash},signal);
      if(!this.current(serial,captured)) return;
      if(ack.acknowledged!==true || ack.document?.revision!==this.document.revision || ack.document?.sourceHash!==this.document.sourceHash)throw Error('The page acknowledgement did not match this revision. Speech stayed off.');
      const visibleMs=performance.now()-start;
      $('canvas-status').textContent=`${this.document.title || 'Page updated'} · saved locally. Click a section to direct the next edit.`;
      $('canvas-timing').textContent=`Request → visible page ${(visibleMs/1000).toFixed(2)}s · API ${((result.metrics?.providerMs||0)/1000).toFixed(2)}s · revision ${this.document.revision}`;
      $('canvas-script').textContent=spokenText(this.document);
      this.focus(this.document.focusId,false);
      this.o.onResult?.({question,document:this.document,metrics:{...result.metrics,visibleMs}});
      if(read && (!voiceOwner || this.o.ownsVoice(voiceOwner))) await this.speak(captured,serial,voiceOwner);
    } catch(error) {
      if(signal.aborted || serial!==this.generation) return;
      this.setWorking(false); $('canvas-status').textContent=error.message || 'The edit could not be completed. Your previous page is kept.'; this.o.error(error.message);
    } finally { if(serial===this.generation){this.controller=null;this.setWorking(false);} }
  }
  async render(value, valid=()=>this.active, onCommit=()=>{}) {
    if(!value?.html) throw Error('The model did not return a complete HTML page.');
    const candidate=this.frame.cloneNode(false);candidate.removeAttribute('id');candidate.hidden=true;
    this.frame.after(candidate);
    try {
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{cleanup();reject(Error('The HTML preview did not finish loading.'));},5000);
        const cleanup=()=>{clearTimeout(timer);candidate.removeEventListener('load',loaded);};
        const loaded=()=>{cleanup();resolve();};candidate.addEventListener('load',loaded);candidate.srcdoc=previewHTML(value.html);
      });
      if(!valid())return;
      const doc=candidate.contentDocument;
      if(!doc?.body || !doc.body.textContent.trim())throw Error('The page rendered empty.');
      for(const n of doc.querySelectorAll('section[id],article[id],header[id],main>div[id],main>svg[id],body>div[id]')) if(!n.dataset.blockId)n.dataset.blockId=n.id;
      for(const link of doc.querySelectorAll('a[href]')){link.dataset.link=link.getAttribute('href');link.removeAttribute('href');link.setAttribute('role','link');link.tabIndex=0;}
      const activateLink=event=>{
        const link=event.target.closest('a[data-link]');if(!link)return false;
        event.preventDefault();let url;try{url=new URL(link.dataset.link,'https://invalid.local');}catch{return true;}
        if(link.dataset.link.startsWith('#')){doc.getElementById(link.dataset.link.slice(1))?.scrollIntoView({block:'start'});return true;}
        if(['https:','http:'].includes(url.protocol)&&url.hostname!=='invalid.local')window.open(url.href,'_blank','noopener,noreferrer');return true;
      };
      doc.addEventListener('click',event=>{if(activateLink(event))return;const n=event.target.closest('[data-block-id],[id]');if(n){this.o.beforeEdit();this.focus(n.dataset.blockId||n.id,false);}});
      doc.addEventListener('wheel',()=>{if(this.busy)this.userScrolled=true;},{passive:true});
      doc.addEventListener('touchstart',()=>{if(this.busy)this.userScrolled=true;},{passive:true});
      doc.addEventListener('keydown',event=>{if(event.key==='Enter')activateLink(event);});
      if(!valid())return;
      this.observer?.disconnect();candidate.id='canvas-document';candidate.hidden=false;candidate.style.height='480px';const previous=this.frame;this.frame=candidate;previous.remove();
      onCommit();this.observer=new ResizeObserver(()=>{this.resize();this.focus(this.selected,false);});this.observer.observe(doc.body);
      this.resize();$('canvas-source').textContent=value.html;$('canvas-undo').disabled=!(value.revision>0);
      await frames();if(valid())this.resize();
    }finally{if(this.frame!==candidate)candidate.remove();}
  }
  focusNode(id){const doc=this.frame.contentDocument;return id&&doc?[...doc.querySelectorAll('[data-block-id],[id]')].find(n=>n.dataset.blockId===id||n.id===id):null;}
  resize(){const doc=this.frame.contentDocument;if(doc?.body)this.frame.style.height=`${Math.min(18000,Math.max(480,doc.documentElement.scrollHeight,doc.body.scrollHeight))}px`;}
  focus(id, scroll=false) {
    const node=this.focusNode(id);
    if(!node){$('canvas-frame').hidden=true;return;}
    this.selected=node.dataset.blockId||node.id; const r=node.getBoundingClientRect(),f=this.frame.getBoundingClientRect(),s=$('canvas-stage').getBoundingClientRect();
    const box=$('canvas-frame');box.hidden=this.busy;Object.assign(box.style,{left:`${f.left-s.left+r.left}px`,top:`${f.top-s.top+r.top}px`,width:`${r.width}px`,height:`${Math.min(r.height,innerHeight*.8)}px`});
    $('canvas-selection').textContent=`Selected: ${(node.querySelector('h1,h2,h3,h4')?.textContent||node.textContent).trim().slice(0,65)}`;
    if(scroll && (f.top+r.top<20||f.top+r.bottom>innerHeight-140))window.scrollBy({top:f.top+r.top-60,behavior:'smooth'});
  }
  async speak(captured,serial,owner) {
    const text=spokenText(this.document);if(!text)return;this.stopSpeech();
    const valid=()=>this.current(serial,captured)&&(!owner||this.o.ownsVoice(owner));
    if(this.o.speechEngine()==='native'){
      this.speechController=new AbortController();
      const response=await fetch('/api/canvas/speech',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({anchor:captured,canvasRevision:this.document.revision,sourceHash:this.document.sourceHash}),signal:this.speechController.signal});
      if(!response.ok){const data=await response.json();throw Error(data.error?.message||'Speech is unavailable.');}
      const blob=await response.blob();if(!valid())return;
      this.audioURL=URL.createObjectURL(blob);const player=new Audio(this.audioURL);this.player=player;
      player.addEventListener('playing',()=>{if(!valid()){this.stopSpeech();return;}$('canvas-stop-voice').hidden=false;this.o.playback(true);$('canvas-status').textContent='Professor speaking. You can interrupt at any time.';});
      player.addEventListener('ended',()=>{if(this.player===player){this.stopSpeech();$('canvas-status').textContent='Explanation complete. Ask a question or describe the next edit.';}});
      player.addEventListener('error',()=>{if(this.player!==player)return;this.stopSpeech();this.o.error('Audio playback failed. The finished script remains on the page.');});
      await player.play();
    }else this.browserCancel=this.o.speakBrowser(text,{onStart:()=>{if(valid()){$('canvas-stop-voice').hidden=false;this.o.playback(true);}else this.stopSpeech();},onEnd:()=>this.stopSpeech(),onError:()=>this.stopSpeech()});
  }
  async undo(){
    if(this.busy||!this.document?.revision)return;
    this.o.beforeEdit();this.cancel(false);const captured={...this.anchor()},serial=this.generation;
    try{await this.cancelPromise;if(!this.current(serial,captured))return;const data=await this.o.post('/api/canvas/undo',{anchor:captured,canvasRevision:this.document.revision});if(!this.current(serial,captured))return;
      await this.render(data.document,()=>this.current(serial,captured),()=>{this.document=data.document;});if(!this.current(serial,captured))return;
      this.selected=null;this.focus(null);$('canvas-script').textContent='';$('canvas-status').textContent='Previous HTML restored. Saved locally.';
    }catch(e){if(this.current(serial,captured))this.o.error(e.message);}
  }
  download(){if(!this.document)return;const url=URL.createObjectURL(new Blob([this.document.html],{type:'text/html'}));const a=document.createElement('a');a.href=url;a.download='lesson-lab-canvas.html';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
}
