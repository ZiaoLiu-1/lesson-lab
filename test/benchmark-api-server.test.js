import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApiServer, apiFairness } from '../benchmark/api-server.js';
import { starterHtml, promptFor, outputSchema } from '../benchmark/tasks.js';

async function fixture(t, options={}) {
 const dataDir=await mkdtemp(path.join(tmpdir(),'lesson-dual-api-test-'));
 const inputs=[];
 const app=createApiServer({dataDir,env:{},generateImpl:async input=>{
  inputs.push(input);return {output:{html:starterHtml,summary:'Offline fixture.'},metadata:{lane:input.lane}};
 },...options});
 app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 const origin=`http://127.0.0.1:${app.server.address().port}`;
 t.after(async()=>{if(app.server.listening){const ended=once(app.server,'close');app.close();app.server.closeAllConnections();await ended;}await rm(dataDir,{recursive:true,force:true});});
 return {app,inputs,dataDir,origin,get:async p=>(await fetch(origin+p)).json(),post:(p,body)=>fetch(origin+p,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(body)})};
}

test('direct HTTP config exposes matched full payloads and accurate route labels without credentials',async t=>{
 const f=await fixture(t,{env:{OPENAI_API_KEY:'fake-openai-secret',CEREBRAS_API_KEY:'fake-cerebras-secret'}});
 const config=await f.get('/api/config');
 assert.equal(config.protocolVersion,'lesson-code-edit-dual-http-low-v2');
 assert(config.keyConfigured);assert.equal(config.maxRuns,4);
 assert(!JSON.stringify(config).includes('fake-'));
 assert(config.lanes.every(l=>l.route==='Direct HTTP · same request function'));
 for(const task of config.tasks){const a=structuredClone(task.apiRequests.astra.body);const c=structuredClone(task.apiRequests['cerebras-qwen'].body);assert.notEqual(a.model,c.model);delete a.model;delete c.model;assert.deepEqual(a,c);assert.equal(a.messages[0].content,promptFor(task.id));assert.deepEqual(a.response_format.json_schema.schema,outputSchema);}
 const html=await(await fetch(f.origin+'/')).text();assert(!html.includes('through a Codex workflow'));assert.match(html,/Both engines use the same direct HTTP function/);
 const client=await(await fetch(f.origin+'/app.js')).text();assert.match(client,/apiRequests\[id\]\.body/);
 assert((await f.get('/api/fairness')).checks.every(c=>c.pass));assert.equal(f.inputs.length,0);
});

test('tampered browser prompt is rejected before any provider call; matching requests retain separate evidence',async t=>{
 const f=await fixture(t,{maxRuns:2});
 const base={lane:'astra',taskId:'T1',phase:'rehearsal',pairId:'offline-only'};
 const expected=apiFairness('T1').requests.astra;
 const tampered=structuredClone(expected.body);tampered.messages[0].content+=' changed';
 let response=await f.post('/api/run',{...base,request:tampered});assert.equal(response.status,400);assert.equal((await response.json()).error,'REQUEST_BODY_MISMATCH');assert.equal(f.inputs.length,0);
 for(const lane of ['astra','cerebras-qwen']){
  response=await f.post('/api/run',{...base,lane,request:apiFairness('T1').requests[lane].body});
  const result=(await response.text()).trim().split('\n').map(JSON.parse).find(e=>e.type==='result');
  assert(result);assert.equal(result.requestEvidence.matchedBodyHash,expected.matchedBodyHash);
  assert.equal(result.protocolVersion,'lesson-code-edit-dual-http-low-v2');
  await f.post('/api/cancel',{runId:result.runId});
 }
 response=await f.post('/api/run',{...base,request:expected.body});assert.equal(response.status,409);assert.equal((await response.json()).error,'COHORT_CALL_LIMIT');assert.equal(f.inputs.length,2);
 const records=JSON.parse(await readFile(path.join(f.dataDir,'runs.json'),'utf8'));assert.equal(records.length,2);assert(records.every(r=>r.status==='cancelled'));
});

test('both real credentials are required before inference, without asymmetric fallback',async t=>{
 const f=await fixture(t,{generateImpl:undefined,env:{CEREBRAS_API_KEY:'fake-only'}});
 const response=await f.post('/api/run',{lane:'astra',taskId:'T1',phase:'rehearsal',request:apiFairness('T1').requests.astra.body});
 assert.equal(response.status,503);assert.equal((await response.json()).error,'BOTH_API_KEYS_REQUIRED');assert.equal((await f.get('/api/results')).runs.length,0);
});

test('an inconsistent returned-source and visible timeline is retained as a render failure',async t=>{
 const f=await fixture(t);
 const response=await f.post('/api/run',{lane:'astra',taskId:'T1',phase:'rehearsal',request:apiFairness('T1').requests.astra.body});
 const result=(await response.text()).trim().split('\n').map(JSON.parse).find(e=>e.type==='result');
 const ack=await(await f.post('/api/result',{runId:result.runId,codeReceivedMs:101,renderedMs:100,uiResponseMs:1,domChecks:{pass:true,checks:Array.from({length:5},(_,i)=>({name:`Offline ${i}`,pass:true}))}})).json();
 assert.equal(ack.run.status,'render_failed');assert.equal(ack.run.error.code,'RENDER_CHECK_FAILED');
 assert.match((await f.get('/api/results')).summary.metric,/button-handler/);
});
