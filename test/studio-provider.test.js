import test from 'node:test';import assert from 'node:assert/strict';
import {createGenerator,validateUnit,buildPrompt,unitSchema} from '../studio/provider.js';
const unit={title:'The local slope',text:'The slope is 2 at x = 1.',kind:'grounded',sourceIds:['source.local'],focusId:'p1.derivative',scene:{tangent:true,secant:false,comparison:false},note:null,claims:[{key:'slope',value:2}],reviewReason:null,functionCode:null};
const snapshot={state:{pages:{p1:{a:1,notes:[{id:'note1',text:'An earlier annotation.'}]}}},facts:{a:1,slope:2},candidateFacts:null};
test('Studio provider binds actual notes, page facts, question and model to strict structured output',async()=>{let request;const generate=createGenerator({env:{CEREBRAS_API_KEY:'test-secret'},fetchImpl:async(_,r)=>{request=r;return new Response(JSON.stringify({id:'test-id',model:'qwen-3.8-27b',usage:{prompt_tokens:100,completion_tokens:50},choices:[{finish_reason:'stop',message:{content:JSON.stringify(unit)}}]}));}});const result=await generate({question:'Why?',snapshot,model:'qwen'});const body=JSON.parse(request.body);assert.equal(body.model,'qwen-3.8-27b');assert.equal(body.reasoning_effort,'low');assert.equal(body.response_format.json_schema.strict,true);assert.match(body.messages[0].content,/An earlier annotation/);assert.match(body.messages[0].content,/ACTUAL/);assert.equal(result.metadata.usage.completion_tokens,50);assert.deepEqual(result.unit,unit);});
test('Studio rejects unexpected actions, oversize prose and unknown claim keys',()=>{assert.throws(()=>validateUnit({...unit,script:'bad'}));assert.throws(()=>validateUnit({...unit,text:'x'.repeat(2201)}));assert.throws(()=>validateUnit({...unit,claims:[{key:'invented',value:2}]}));assert.throws(()=>validateUnit({...unit,kind:'needs_review'}));});
test('Studio never applies truncated content and retains token usage',async()=>{const generate=createGenerator({env:{CEREBRAS_API_KEY:'test-secret'},fetchImpl:async()=>new Response(JSON.stringify({usage:{completion_tokens:8192},choices:[{finish_reason:'length',message:{content:JSON.stringify(unit)}}]}))});await assert.rejects(generate({question:'Explain',snapshot}),e=>e.code==='truncated'&&e.metadata.usage.completion_tokens===8192);});
test('Studio sanitizes network/auth errors and never retries',async()=>{let calls=0;const generate=createGenerator({env:{CEREBRAS_API_KEY:'test-secret'},fetchImpl:async()=>{calls++;throw Error('test-secret network detail');}});await assert.rejects(generate({question:'Explain',snapshot}),e=>!JSON.stringify(e).includes('test-secret')&&e.code==='provider_unavailable');assert.equal(calls,1);});
test('Studio deadline and cancellation cover response body reads',async()=>{const generate=createGenerator({timeoutMs:10,env:{CEREBRAS_API_KEY:'test-secret'},fetchImpl:async(_,r)=>({ok:true,json:()=>new Promise((_,reject)=>r.signal.addEventListener('abort',()=>reject(Error('stopped')),{once:true}))})});await assert.rejects(generate({question:'Explain',snapshot}),e=>e.code==='timeout');const c=new AbortController();c.abort();await assert.rejects(generate({question:'Explain',snapshot,signal:c.signal}),e=>e.code==='cancelled');});
test('Studio missing key fails locally with actionable setup message',async()=>{const generate=createGenerator({env:{},fetchImpl:()=>{throw Error('should not call');}});await assert.rejects(generate({question:'Explain',snapshot}),e=>e.code==='key_missing');assert.match(buildPrompt('Why?',snapshot),/finite, not infinitesimal/);});
test('Studio provider ignores separate reasoning and returns only the final structured teaching unit',async()=>{
 const message={content:JSON.stringify(unit)};
 Object.defineProperty(message,'reasoning',{get(){throw new Error('Separate reasoning must not be accessed.');}});
 Object.defineProperty(message,'reasoning_content',{get(){throw new Error('Separate reasoning must not be accessed.');}});
 const events=[];
 const generate=createGenerator({env:{CEREBRAS_API_KEY:'test-secret'},fetchImpl:async()=>({ok:true,status:200,json:async()=>({choices:[{finish_reason:'stop',message}]})})});
 const result=await generate({question:'Explain',snapshot,onEvent:(name,data)=>events.push({name,data})});
 assert.deepEqual(result.unit,unit);
 assert.equal(Object.hasOwn(result,'reasoning'),false);
 assert.equal(JSON.stringify({result,events}).includes('Separate reasoning'),false);
});
test('Studio rejects thinking or planning in generated fields instead of salvaging the final sentence',()=>{
 for(const overrides of [
  {text:'<think>Decide what to say.</think>The slope is 2.'},
  {text:'Analysis: first decide the schema.\nThe slope is 2.'},
  {text:'I need to respond with an explanation. The slope is 2.'},
  {note:{targetId:'p1.derivative',text:'I will update the code to show the tangent.'}},
  {title:'<think>Draft title</think>Local slope'},
 ]) assert.throws(()=>validateUnit({...unit,...overrides}),error=>error.code==='invalid_output');
 assert.equal(validateUnit({...unit,text:'We need to divide by h while h is nonzero. The quotient is 2x + h, which tends to 2x.'}).kind,'grounded');
});
test('Studio does not fall back to separate reasoning when final content is missing or invalid',async()=>{
 for(const content of [undefined,'not JSON',JSON.stringify({...unit,text:'Let me think about the answer.'})]){
  const generate=createGenerator({env:{CEREBRAS_API_KEY:'test-secret'},fetchImpl:async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content,reasoning:JSON.stringify(unit)}}]}))});
  await assert.rejects(generate({question:'Explain',snapshot}),error=>error.code==='invalid_output'&&!error.message.includes('Let me think'));
 }
});
test('Studio strict output kinds follow the effective current or candidate power without mutating the shared schema',async()=>{
 const original=structuredClone(unitSchema), unrestricted=['grounded','extension','needs_review'], changed=['extension','needs_review'];
 for(const [currentPower,candidatePower,expected] of [[2,null,unrestricted],[3,null,changed],[2,3,changed],[3,2,unrestricted],[1,null,changed],[2,5,changed],[2,null,unrestricted]]){
  let body;
  const generate=createGenerator({env:{CEREBRAS_API_KEY:'test-secret'},fetchImpl:async(_,request)=>{
   body=JSON.parse(request.body);
   return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({...unit,kind:expected[0]})}}]}));
  }});
  await generate({question:'Explain the current or requested function.',snapshot:{...snapshot,facts:{a:1,power:currentPower},candidateFacts:candidatePower===null?null:{a:1,power:candidatePower}}});
  assert.equal(body.response_format.json_schema.strict,true);
  assert.deepEqual(body.response_format.json_schema.schema.properties.kind.enum,expected,`current ${currentPower}, candidate ${candidatePower}`);
  assert.deepEqual(unitSchema,original,'A cubic request must not restrict later quadratic requests or concurrent providers.');
 }
});
