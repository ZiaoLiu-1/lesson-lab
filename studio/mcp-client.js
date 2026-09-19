import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const projectRoot=fileURLToPath(new URL('../',import.meta.url));
export class BridgeClientError extends Error {
 constructor(code,message){
  super(String(message).replace(/\bBearer\s+\S+/gi,'Bearer [redacted]').replace(/\bcsk-[A-Za-z0-9_-]+/g,'[redacted]').replace(/\b[a-f0-9]{64}\b/gi,'[redacted]'));
  this.code=/^[A-Z][A-Z0-9_]{0,79}$/.test(code)?code:'BRIDGE_ERROR';
 }
}
export function createBridgeClient({root=projectRoot,port=Number(process.env.STUDIO_PORT||4320),dataDir=process.env.STUDIO_DATA_DIR||path.join(root,'.local/studio'),fetchImpl=fetch,launch=true,pollMs=120,waitMs=40000}={}){
 if(!Number.isInteger(port)||port<1||port>65535)throw new BridgeClientError('CONFIGURATION','STUDIO_PORT must be a local TCP port.');
 const origin=`http://127.0.0.1:${port}`;
 let starting;
 async function health(){
  let response;
  try{response=await fetchImpl(`${origin}/api/health`,{signal:AbortSignal.timeout(1200),redirect:'error'});}catch{return null;}
  let value;try{value=await response.json();}catch{}
  if(!response.ok||value?.ok!==true||value.bridgeVersion!=='1')throw new BridgeClientError('SERVER_VERSION','This port is running a different or older service. Restart Lesson Lab with the current project code.');
  return value;
 }
 async function request(route,{body,signal}={}){
  if(!await health())throw new BridgeClientError('OFFLINE','Lesson Lab is offline. Call open_lesson first.');
  let token;try{token=fs.readFileSync(path.join(dataDir,'bridge.token'),'utf8').trim();}catch{throw new BridgeClientError('PAIRING','The local bridge token is unavailable. Check that Codex and Lesson Lab use the same local data directory.');}
  if(!/^[a-f0-9]{64}$/.test(token))throw new BridgeClientError('PAIRING','The local bridge token is invalid. Restart Lesson Lab.');
  let response;
  try{response=await fetchImpl(origin+route,{method:body===undefined?'GET':'POST',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000),headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});}catch(e){if(signal?.aborted)throw e;throw new BridgeClientError('OFFLINE','The local lesson service did not respond. Reopen Lesson Lab and try again.');}
  let value;try{value=await response.json();}catch{throw new BridgeClientError('PROTOCOL','The local lesson service returned an invalid response.');}
  if(!response.ok)throw new BridgeClientError(value.error?.code||'BRIDGE_ERROR',value.error?.message||'The lesson could not perform that action.');
  return value;
 }
 async function start(){
  if(await health())return;
  if(!launch)throw new BridgeClientError('OFFLINE','Lesson Lab is offline.');
  if(!starting)starting=(async()=>{
   fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
   const log=fs.openSync(path.join(dataDir,'service.log'),'a',0o600);
   let child;try{child=spawn(process.execPath,[`--env-file-if-exists=${path.join(root,'.env')}`,path.join(root,'studio/server.js')],{cwd:root,env:{...process.env,STUDIO_PORT:String(port),STUDIO_DATA_DIR:dataDir},detached:true,stdio:['ignore',log,log]});child.on('error',()=>{});child.unref();}finally{fs.closeSync(log);}
   for(let i=0;i<30;i++){await delay(120);if(await health())return;}
   throw new BridgeClientError('START_FAILED','Lesson Lab could not start. Run npm start in the project to inspect its local setup.');
  })().finally(()=>{starting=null;});
  await starting;
 }
 async function open(){await start();const context=await request('/api/bridge/context');return {url:origin+'/',...context,nextAction:'Show this URL with open_in_codex, reusing the existing reader. Once connected, reacquire context. For normal teaching or resuming use control_lesson with continue; start explicitly restarts the current page at step one. For a requested passage, use page/select IDs from context then ask_tutor; do not call start after selecting it. Opening alone does not change the teaching cursor. Narrate only confirmed visible content.'};}
 async function command(command,{signal}={}){
  signal?.throwIfAborted();
  const job=await request('/api/bridge/command',{body:command,signal});
  const id=job.id;
  if(typeof id!=='string')throw new BridgeClientError('PROTOCOL','The lesson service did not return a job ID.');
  const started=Date.now();let finished=false;
  try{
   while(Date.now()-started<waitMs){
    signal?.throwIfAborted();
    const state=await request(`/api/bridge/jobs/${encodeURIComponent(id)}`,{signal});
    if(state.status==='completed'){finished=true;return {jobId:id,visible:true,...state.result,narration:state.result?.unit?`${state.result.unit.title}. ${state.result.unit.text}`:state.result?.step?.text||null,voiceTiming:'Native Codex Voice playback is controlled by the host. This tool confirms the displayed content, not speech start/end.'};}
    if(['failed','cancelled','expired'].includes(state.status)){finished=true;throw new BridgeClientError(state.error?.code||'BRIDGE_FAILED',state.error?.message||'The page did not confirm this action.');}
    await delay(pollMs,undefined,{signal});
   }
   throw new BridgeClientError('TIMEOUT','The page did not confirm the action in time. No unconfirmed explanation should be narrated.');
  }finally{if(!finished)await request('/api/bridge/cancel',{body:{id}}).catch(()=>{});}
 }
 return {open,context:()=>request('/api/bridge/context'),command};
}
