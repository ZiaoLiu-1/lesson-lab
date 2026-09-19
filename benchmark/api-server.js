import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApiCodeGenerator, buildApiRequest } from './api-provider.js';
const EFFORTS = ['low','medium','high'];
import { tasks,lanes,qwenLane,starterHtml,styles,promptFor,hash,outputSchema } from './tasks.js';
import { checkSource } from './validator.js';
import { summarize,toCSV } from './results.js';
const root=fileURLToPath(new URL('./',import.meta.url));
export function apiProfile(effort = 'low') {
 if(!EFFORTS.includes(effort))throw new Error('API_EFFORT must be low, medium, or high.');
 return {name:`api-${effort}`,effort,protocolVersion:`lesson-code-edit-dual-http-${effort}-v2`,defaultPort:4337,directory:`benchmark-api/2026-09-19/${effort}-v2`,lanes:[
  {...lanes[1],label:`OpenAI API · Astra · ${effort}`,reasoning:effort,route:'Direct HTTP · same request function'},
  {...qwenLane,label:`Cerebras API · Qwen · ${effort}`,reasoning:effort,route:'Direct HTTP · same request function'}]};
}
function requestFor(lane,taskId,effort) {return buildApiRequest({lane,prompt:promptFor(taskId),schema:outputSchema,effort});}
export function apiFairness(taskId,effort='low') {
 const requests=Object.fromEntries(apiProfile(effort).lanes.map(lane=>[lane.id,requestFor(lane.id,taskId,effort)]));
 const hashes=Object.values(requests).map(r=>r.matchedBodyHash);
 return {pass:new Set(hashes).size===1,allowedDifferences:['endpoint','authorization secret','model'],matchedBodyHash:hashes[0],requests};
}

// Separate direct-HTTP cohort; historical adapters, fixtures and recordings remain unchanged.
// Browser payload includes the exact API body, which is checked before dispatch; credentials stay here.
export function createApiServer({effort=process.env.API_EFFORT??'low',dataDir:configuredDataDir,generateImpl,env=process.env,maxRuns=4}={}) {
const profile=apiProfile(effort),protocolVersion=profile.protocolVersion;
const generate=generateImpl??createApiCodeGenerator({effort,env});
const dataDir=configuredDataDir??path.resolve(root,'../.local',profile.directory);
const allowedLanes=profile.lanes;
if(!Number.isSafeInteger(maxRuns)||maxRuns<1||maxRuns>100)throw new Error('Invalid explicit cohort call limit.');
for(const task of tasks)if(!apiFairness(task.id,effort).pass)throw new Error('Request bodies do not match.');
const configured=()=>Boolean(env.CEREBRAS_API_KEY?.trim()&&env.OPENAI_API_KEY?.trim());
fs.mkdirSync(path.join(dataDir,'outputs'),{recursive:true,mode:0o700});
const resultsPath=path.join(dataDir,'runs.json');
const runs=fs.existsSync(resultsPath)?JSON.parse(fs.readFileSync(resultsPath,'utf8')):[];
if(!Array.isArray(runs)||runs.some(run=>run.protocolVersion!==protocolVersion))throw new Error('Saved runs do not match this effort cohort.');
// Interrupted sessions are retained, never silently restarted.
for(const run of runs)if(['running','awaiting_render'].includes(run.status)){run.status='failed';run.error={code:'SERVER_RESTART',message:'The previous server stopped before this run finished.'};}
const save=()=>{fs.writeFileSync(resultsPath+'.tmp',JSON.stringify(runs,null,2),{mode:0o600});fs.renameSync(resultsPath+'.tmp',resultsPath);};save();
const summary=()=>({...summarize(runs),metric:'Per-run button-handler start to checked visible update; includes pre-fetch preview reset'});
let active=null;
const ackTimers=new Map();
const json=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
async function readJSON(req){let text='';for await(const chunk of req){text+=chunk;if(text.length>50000)throw new Error('Request too large');}return JSON.parse(text);}
const findRun=id=>runs.find(r=>r.runId===id);
const duration=v=>Number.isFinite(v)&&v>=0&&v<180000?v:null;
async function startRun(input,res){
 if(active)return json(res,409,{error:'BUSY',message:'Wait for the active request or cancel it.'});
 if(!allowedLanes.some(l=>l.id===input.lane)||!tasks.some(t=>t.id===input.taskId)||!['rehearsal','measured'].includes(input.phase))return json(res,400,{error:'INVALID_RUN'});
 if(!generateImpl&&!configured())return json(res,503,{error:'BOTH_API_KEYS_REQUIRED'});
 if(runs.length>=maxRuns)return json(res,409,{error:'COHORT_CALL_LIMIT',message:'This small verification cohort has reached its explicit call limit.'});
 const expected=requestFor(input.lane,input.taskId,effort);
 if(JSON.stringify(input.request)!==JSON.stringify(expected.body))return json(res,400,{error:'REQUEST_BODY_MISMATCH',message:'No provider call was made: the browser request must match the frozen API body.'});
 const started=performance.now(),controller=new AbortController(),prompt=promptFor(input.taskId);
 const run={runId:randomUUID(),pairId:typeof input.pairId==='string'?input.pairId.slice(0,100):null,protocolVersion,lane:input.lane,taskId:input.taskId,phase:input.phase,startedAt:new Date().toISOString(),status:'running',review:'pending',sourceHash:hash(starterHtml),promptHash:hash(prompt),schemaHash:hash(JSON.stringify(outputSchema)),stylesHash:hash(styles),requestEvidence:expected,events:[],browser:{renderedMs:null,uiResponseMs:null},serverMs:null,metadata:null,html:null,summary:null};
 runs.push(run);save();active={runId:run.runId,controller};
 // Ordinary JSON response: no status bytes are sent while the API is working.
 // Chrome can inspect one complete response; Network duration includes the local proxy.
 const send=data=>{if(!res.destroyed)json(res,200,{...data,runId:run.runId});};
 res.on('close',()=>{if(!res.writableEnded&&run.status==='running')controller.abort();});
 try{
  const result=await generate({lane:run.lane,prompt,schema:outputSchema,signal:controller.signal,onEvent:(name,data)=>{run.events.push({name,...data});}});
  if(controller.signal.aborted)throw Object.assign(new Error('Cancelled.'),{code:'CANCELLED'});
  run.serverMs=performance.now()-started;run.metadata=result.metadata;
  run.html=result.output?.html;run.summary=result.output?.summary;
  run.checks=checkSource(run.html);
  if(!run.checks.pass)throw Object.assign(new Error('Generated source failed the passive HTML/SVG checks.'),{code:'SOURCE_CHECK_FAILED'});
  if(typeof run.summary!=='string'||run.summary.length>2000)throw Object.assign(new Error('Invalid summary.'),{code:'INVALID_OUTPUT'});
  run.outputHash=hash(run.html);run.status='awaiting_render';save();
  fs.writeFileSync(path.join(dataDir,'outputs',run.runId+'.html'),run.html,{mode:0o600});
  send({type:'result',...run});
  ackTimers.set(run.runId,setTimeout(()=>{if(run.status==='awaiting_render'){run.status='render_failed';run.error={code:'RENDER_TIMEOUT',message:'No visible render confirmation received within 10 seconds.'};save();}ackTimers.delete(run.runId);},10000));
 }catch(error){
  run.serverMs=performance.now()-started;
  run.metadata??=error.metadata??null;
  run.status=controller.signal.aborted||error.code==='CANCELLED'?'cancelled':'failed';
  run.error={code:error.code??'PROVIDER_ERROR',message:['SOURCE_CHECK_FAILED','INVALID_OUTPUT'].includes(error.code)?error.message:'The request did not produce an accepted page. See the recorded failure code.'};
  save();send({type:'error',...run,message:run.error.message,code:run.error.code});
 }finally{if(active?.runId===run.runId)active=null;if(!res.writableEnded)res.end();}
}
const server=http.createServer(async(req,res)=>{
 try{
  const port=server.address()?.port,origin=`http://127.0.0.1:${port}`;
  if(req.headers.host!==`127.0.0.1:${port}`||req.headers.origin&&req.headers.origin!==origin)return json(res,403,{error:'ORIGIN_DENIED'});
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-src 'self' about:; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'");
  const url=new URL(req.url,origin);
  if(req.method==='GET'){
   if(url.pathname==='/api/fairness')return json(res,200,{protocolVersion,checks:tasks.map(t=>({taskId:t.id,...apiFairness(t.id,effort)}))});
   if(url.pathname==='/api/config')return json(res,200,{protocolVersion,profile:profile.name,effort,starterHtml,styles,lanes:profile.lanes,tasks:tasks.map(t=>({...t,fullPrompt:promptFor(t.id),apiRequests:apiFairness(t.id,effort).requests})),sourceHash:hash(starterHtml),keyConfigured:configured(),maxRuns,keysConfigured:{openai:Boolean(env.OPENAI_API_KEY?.trim()),cerebras:Boolean(env.CEREBRAS_API_KEY?.trim())}});
   if(url.pathname==='/api/results'||url.pathname==='/api/export.json')return json(res,200,{protocolVersion,runs,summary:summary()});
   if(url.pathname==='/api/summary')return json(res,200,summary());
   if(url.pathname==='/api/export.csv'){res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="lesson-benchmark.csv"'});return res.end(toCSV(runs));}
   const assets={'/':['public/index.html','text/html'],'/app.js':['api-public/app.js','text/javascript'],'/style.css':['public/style.css','text/css'],'/validator.js':['validator.js','text/javascript']};
   if(assets[url.pathname]){const[file,type]=assets[url.pathname];res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store'});let body=fs.readFileSync(path.join(root,file));
    if(file==='public/index.html')body=body.toString('utf8')
     .replace(/<p class="model-switch">[\s\S]*?<\/p>/,`<p class="model-switch">Both engines use the same direct HTTP function · ${effort} effort · 8,192 completion-token cap · no tools or retries. <a href="/api/fairness" target="_blank" rel="noopener">Inspect matching request bodies ↗</a></p>`)
     .replace('Cerebras API vs. GPT-6 Astra through a Codex workflow. Routes, models and orchestration differ. This is an end-to-end application comparison, not an isolated hardware benchmark.','OpenAI API vs. Cerebras API: identical application call path, different models and providers. Chrome Network records one complete JSON response from the local proxy; no status chunks are sent during generation. This does not isolate model execution or hardware speed.')
     .replace('each lane starts at its own request dispatch.', 'each app clock starts at its own button action, before preview reset and fetch. Native Network Duration starts at the HTTP request.')
     .replace('<option value="3">3</option><option value="5">5</option>','');
    return res.end(body);}
  }
  if(req.method==='POST'&&url.pathname.startsWith('/api/')){
   if(!req.headers['content-type']?.startsWith('application/json'))return json(res,415,{error:'JSON_REQUIRED'});
   const input=await readJSON(req);
   if(url.pathname==='/api/run')return await startRun(input,res);
   const run=findRun(input.runId);if(!run)return json(res,404,{error:'UNKNOWN_RUN'});
   if(url.pathname==='/api/cancel'){
    if(active?.runId===run.runId)active.controller.abort();
    else if(run.status==='awaiting_render'){run.status='cancelled';clearTimeout(ackTimers.get(run.runId));ackTimers.delete(run.runId);save();}
    return json(res,200,{ok:true});
   }
   if(url.pathname==='/api/result'){
    if(run.status!=='awaiting_render')return json(res,409,{error:'STALE_RENDER'});
    const checks=input.domChecks?.checks??(Array.isArray(input.domChecks)?input.domChecks:[]);
    const pass=input.domChecks?.pass===true&&checks.length>=5&&checks.every(c=>c.pass===true);
    run.browser={renderedMs:duration(input.renderedMs),uiResponseMs:duration(input.uiResponseMs),codeReceivedMs:duration(input.codeReceivedMs)};
    const timelineValid=run.browser.renderedMs!==null&&run.browser.codeReceivedMs!==null&&run.browser.codeReceivedMs<=run.browser.renderedMs;
    run.domChecks={pass,checks};run.status=pass&&timelineValid?'rendered':'render_failed';
    if(run.status==='render_failed')run.error={code:'RENDER_CHECK_FAILED',message:'The required update was not verified visible.'};
    clearTimeout(ackTimers.get(run.runId));ackTimers.delete(run.runId);save();return json(res,200,{ok:true,run});
   }
   if(url.pathname==='/api/review'){
    if(run.status!=='rendered'||!['pass','fail'].includes(input.verdict))return json(res,409,{error:'NOT_REVIEWABLE'});
    run.review=input.verdict;run.reviewedAt=new Date().toISOString();save();return json(res,200,{ok:true,run});
   }
  }
  return json(res,404,{error:'NOT_FOUND'});
 }catch{if(!res.headersSent)json(res,400,{error:'INVALID_REQUEST'});else res.end();}
});
const close=()=>{active?.controller.abort();for(const t of ackTimers.values())clearTimeout(t);server.close();};
return {server,profile,dataDir,close};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const app=createApiServer({dataDir:process.env.API_DATA_DIR});
 const port=Number(process.env.API_PORT??app.profile.defaultPort);
 app.server.listen(port,'127.0.0.1',()=>console.log(`Direct-HTTP code-edit comparison (${app.profile.name}): http://127.0.0.1:${port}`));
 process.on('SIGTERM',app.close);
 process.on('SIGINT',app.close);
}
