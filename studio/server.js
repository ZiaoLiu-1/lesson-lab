import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {StudioCore,StudioError} from './core.js';
import {generate,MODELS,PROVIDER_CONFIG} from './provider.js';
import {validateLesson,LessonError} from './lesson.js';
import {createLocalSpeech,LocalSpeechError} from './speech.js';
import {createLocalTranscription,LocalTranscriptionError,decodeTranscriptionAudio} from './transcription.js';
import {StudioBridge,BridgeError,BRIDGE_VERSION,createBridgeAuthorization} from './bridge.js';
import {StudioCanvas,CanvasError,createCanvasGenerator} from './canvas.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const json=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
function atomic(file,data){fs.writeFileSync(file+'.tmp',JSON.stringify(data,null,2),{mode:0o600});fs.renameSync(file+'.tmp',file);}
async function readJSON(req,limit=256000){let bytes=0;const chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>limit)throw new LessonError(`The upload is too large. Keep this JSON below ${Math.floor(limit/1000)} KB.`);chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new LessonError('The request must contain valid JSON.');}}
export function createStudioServer({dataDir=process.env.STUDIO_DATA_DIR||path.join(root,'.local/studio'),port=Number(process.env.STUDIO_PORT||4320),generateImpl=generate,canvasGenerateImpl=createCanvasGenerator(),canvasTimeoutMs=30000,speechImpl=createLocalSpeech(),transcriptionImpl=createLocalTranscription(),keyConfigured=Boolean(process.env.CEREBRAS_API_KEY?.trim()),bridgeTimeoutMs=35000}={}){
 fs.mkdirSync(dataDir,{recursive:true,mode:0o700});const savedPath=path.join(dataDir,'session.json'), logPath=path.join(dataDir,'turns.jsonl'),peers=new Set();
 const transcriptions=new Set(),transcriptionAnchorKeys=['connectionId','revision','viewEpoch','pageId','selectedId'];
 const authorizeBridge=createBridgeAuthorization(dataDir);
 let lesson=validateLesson(JSON.parse(fs.readFileSync(path.join(root,'studio/course/lesson.json'),'utf8'))),savedState,startupNotice=null;
 if(fs.existsSync(savedPath)){try{const saved=JSON.parse(fs.readFileSync(savedPath,'utf8'));lesson=validateLesson(saved.lesson);savedState=saved.state;}catch{const backup=path.join(dataDir,`session-unreadable-${Date.now()}.json`);fs.copyFileSync(savedPath,backup);startupNotice='The previous save could not be read. A backup was kept locally; a fresh sample lesson is open.';}}
 const recentTurns=[];if(fs.existsSync(logPath)){const lines=fs.readFileSync(logPath,'utf8').trim().split('\n').slice(-25);for(const line of lines){try{recentTurns.push(JSON.parse(line));}catch{}}}
 let core,canvas;const stores=new WeakMap();
 function transcriptionCurrent(job){return core===job.owner&&job.anchor.connectionId===core.connectionId&&['revision','viewEpoch','pageId','selectedId'].every(key=>job.anchor[key]===core.state[key]);}
 function abortStaleTranscriptions(){for(const job of transcriptions)if(!transcriptionCurrent(job))job.abort.abort();}
 function makeCore(l,saved,staged=false){const store={enabled:!staged};const instance=new StudioCore({lesson:l,savedState:saved,generate:generateImpl,timeoutMs:PROVIDER_CONFIG.timeoutMs,ackTimeoutMs:5000,
  persist:state=>{if(store.enabled)atomic(savedPath,{lesson:l,state});},record:turn=>{recentTurns.push(turn);if(recentTurns.length>25)recentTurns.shift();fs.appendFileSync(logPath,JSON.stringify(turn)+'\n',{mode:0o600});},
  emit:(event,data)=>{abortStaleTranscriptions();canvas?.refresh();for(const peer of peers)if(peer.core===instance&&peer.connectionId===instance.connectionId&&!peer.res.destroyed)peer.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);}} );stores.set(instance,store);return instance;}
 try{core=makeCore(lesson,savedState);}catch(e){if(!savedState)throw e;fs.copyFileSync(savedPath,path.join(dataDir,`session-invalid-${Date.now()}.json`));startupNotice='The previous save did not match the lesson. A backup was kept locally; a fresh session is open.';core=makeCore(lesson);}
 const bridge=new StudioBridge({getCore:()=>core,timeoutMs:bridgeTimeoutMs,
  hasPeer:(owner,connectionId)=>[...peers].some(peer=>peer.core===owner&&peer.connectionId===connectionId&&!peer.res.destroyed&&!peer.res.writableEnded),
  sendCommand:(owner,connectionId,data)=>{for(const peer of peers)if(peer.core===owner&&peer.connectionId===connectionId&&!peer.res.destroyed&&!peer.res.writableEnded)peer.res.write(`event: bridge_command\ndata: ${JSON.stringify(data)}\n\n`);}});
 canvas=new StudioCanvas({dataDir,getCore:()=>core,generate:canvasGenerateImpl,speechImpl,timeoutMs:canvasTimeoutMs});
 function disconnect(){canvas.disconnect();for(const job of transcriptions)job.abort.abort();for(const p of peers){p.res.write('event: replaced\ndata: {"message":"This session was opened or restored in another tab."}\n\n');p.res.end();}peers.clear();bridge.disconnected();}
 function envelope(value){return{...value,config:{keyConfigured,model:core.state.model,models:MODELS.map(({id,label})=>({id,label})),speech:'browser',nativeSpeech:speechImpl.available,localTranscription:transcriptionImpl.available===true,transcriber:{available:transcriptionImpl.available===true,engine:'localWhisper'},canvas:true,startupNotice,version:'0.6.0',bridgeVersion:BRIDGE_VERSION},recentTurns:[...recentTurns]};}
 function session(){disconnect();return envelope(core.session());}
 function replace(next,nextLesson,reason,{archive=false}={}){
  // Stage all validation/session changes with persistence disabled. The live
  // request, save and SSE peers are untouched until the atomic write succeeds.
  const prepared=next.session();
  if(archive)atomic(path.join(dataDir,`session-archive-${Date.now()}.json`),core.exportSession());
  atomic(savedPath,{lesson:nextLesson,state:next.snapshot()});
  stores.get(core).enabled=false;core.invalidate(reason);disconnect();
  lesson=nextLesson;core=next;stores.get(core).enabled=true;
  return envelope(prepared);
 }
 const server=http.createServer(async(req,res)=>{
  const host=`127.0.0.1:${server.address()?.port??port}`,origin=`http://${host}`;
  try{
   if(req.headers.host!==host||(req.headers.origin&&req.headers.origin!==origin))return json(res,403,{error:{code:'origin_denied',message:'Open Lesson Lab from its local 127.0.0.1 address.'}});
   res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
   res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
   const url=new URL(req.url,origin);
   if(req.method==='GET'){
    if(url.pathname==='/api/health')return json(res,200,{ok:true,version:'0.6.0',keyConfigured,bridgeVersion:BRIDGE_VERSION});
    if(url.pathname==='/api/bridge/context'){authorizeBridge(req.headers);return json(res,200,bridge.context());}
    if(url.pathname.startsWith('/api/bridge/jobs/')){authorizeBridge(req.headers);return json(res,200,bridge.poll(url.pathname.slice('/api/bridge/jobs/'.length)));}
    if(url.pathname==='/api/canvas')return json(res,200,canvas.read(url.searchParams.get('connectionId')));
    if(url.pathname==='/api/session')return json(res,200,session());
    if(url.pathname==='/api/events'){
     const connectionId=url.searchParams.get('connectionId');core.authorize(connectionId);const owner=core;
     res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive'});res.write(': ready\n\n');
     const peer={connectionId,res,core:owner};peers.add(peer);const heartbeat=setInterval(()=>{if(!res.destroyed)res.write(': alive\n\n');},15000);
     req.on('close',()=>{clearInterval(heartbeat);peers.delete(peer);bridge.disconnected();canvas.refresh();if(owner===core&&core.connectionId===connectionId&&![...peers].some(p=>p.core===owner&&p.connectionId===connectionId&&!p.res.destroyed))canvas.disconnect();if(![...peers].some(p=>p.core===owner&&p.connectionId===connectionId&&!p.res.destroyed))for(const job of transcriptions)if(job.owner===owner&&job.anchor.connectionId===connectionId)job.abort.abort();});return;
    }
    if(url.pathname==='/api/export'){
     core.authorize(url.searchParams.get('connectionId'));res.setHeader('Content-Disposition','attachment; filename="lesson-lab-session.json"');return json(res,200,core.exportSession());
    }
    if(url.pathname==='/api/lesson-template'){res.setHeader('Content-Disposition','attachment; filename="lesson-lab-course.json"');return json(res,200,lesson);}
    if(url.pathname==='/api/benchmark')return json(res,200,JSON.parse(fs.readFileSync(path.join(root,'benchmark/evidence/runs-2026-09-18.json'),'utf8')));
    const assets={'/finale.js':['finale.js','text/javascript'],'/finale.css':['finale.css','text/css'],'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/math.js':['math.js','text/javascript'],'/canvas.js':['canvas.js','text/javascript'],'/canvas-seed.js':['canvas-seed.js','text/javascript'],'/canvas.css':['canvas.css','text/css'],'/narration.js':['narration.js','text/javascript'],'/motion.js':['motion.js','text/javascript'],'/focus.js':['focus.js','text/javascript'],'/voice.js':['voice.js','text/javascript'],'/continuous-voice.js':['continuous-voice.js','text/javascript'],'/capture-worklet.js':['capture-worklet.js','text/javascript'],'/style.css':['style.css','text/css']};
    if(assets[url.pathname]){const[f,type]=assets[url.pathname];res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store'});return res.end(fs.readFileSync(path.join(root,'studio/public',f)));}
   }
   if(req.method==='POST'&&url.pathname.startsWith('/api/')){
    if(['/api/bridge/command','/api/bridge/cancel'].includes(url.pathname))authorizeBridge(req.headers);
    if(!req.headers['content-type']?.startsWith('application/json'))return json(res,415,{error:{code:'json_required',message:'This endpoint accepts JSON only.'}});
    const input=await readJSON(req,url.pathname==='/api/import'?3000000:url.pathname==='/api/transcribe'?1000000:256000);
    if(url.pathname==='/api/bridge/command')return json(res,202,bridge.command(input));
    if(url.pathname==='/api/bridge/cancel')return json(res,200,bridge.cancel(input?.id));
    if(url.pathname==='/api/bridge/claim')return json(res,200,bridge.claim(input));
    if(url.pathname==='/api/bridge/result')return json(res,200,bridge.result(input));
    if(url.pathname==='/api/canvas/cancel')return json(res,200,canvas.cancel(input?.connectionId));
    if(url.pathname==='/api/canvas/undo')return json(res,200,canvas.undo(input));
    if(url.pathname==='/api/canvas/ack')return json(res,200,canvas.ack(input));
    if(['/api/canvas/edit','/api/canvas/speech'].includes(url.pathname)){
     const abort=new AbortController();const closed=()=>{if(!res.writableEnded)abort.abort();};res.on('close',closed);
     try{
      if(url.pathname==='/api/canvas/edit'){const result=await canvas.edit(input,{signal:abort.signal});if(!res.destroyed)return json(res,200,result);}
      else{const bytes=await canvas.speech(input,{signal:abort.signal});if(!res.destroyed){res.writeHead(200,{'Content-Type':'audio/wav','Content-Length':bytes.length,'Cache-Control':'no-store'});res.end(bytes);}}
     }finally{res.off('close',closed);}
     return;
    }
    if(url.pathname==='/api/ask')return json(res,202,bridge.execute('ask',input,()=>core.ask(input)));
    if(url.pathname==='/api/ack')return json(res,200,core.ack(input));
    if(url.pathname==='/api/control')return json(res,200,bridge.execute('control',input,()=>core.control(input)));
    if(url.pathname==='/api/audio')return json(res,200,core.audio(input));
    if(url.pathname==='/api/transcribe'){
     const owner=core,anchor=input?.anchor;
     owner.authorize(anchor?.connectionId);
     if(!anchor||typeof anchor!=='object'||Array.isArray(anchor)||Object.keys(anchor).length!==transcriptionAnchorKeys.length||!transcriptionAnchorKeys.every(key=>Object.hasOwn(anchor,key))||Object.keys(input).some(key=>!['anchor','audioBase64'].includes(key)))
      throw new StudioError('INVALID_TRANSCRIPTION_ANCHOR','Record the question from the current study page.',400);
     const job={owner,anchor:structuredClone(anchor),abort:new AbortController()};
     const stale=()=>new StudioError('STALE_TRANSCRIPTION','The page changed while you were speaking. Start the question again in the current view.',409);
     if(!transcriptionCurrent(job))throw stale();
     const bytes=decodeTranscriptionAudio(input.audioBase64);
     const closed=()=>{if(!res.writableEnded)job.abort.abort();};res.on('close',closed);transcriptions.add(job);
     try{
      const result=await transcriptionImpl.transcribe(bytes,{signal:job.abort.signal});
      if(res.destroyed)return;
      if(!transcriptionCurrent(job))throw stale();
      if(job.abort.signal.aborted)throw new LocalTranscriptionError('transcription_cancelled');
      if(typeof result?.text!=='string'||result.text.length>2000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(result.text)||!Number.isFinite(result.metrics?.transcriptionMs)||result.metrics.transcriptionMs<0)
       throw new LocalTranscriptionError('transcription_invalid_output');
      return json(res,200,{text:result.text,metrics:{transcriptionMs:result.metrics.transcriptionMs},anchor:job.anchor});
     }catch(error){if(!transcriptionCurrent(job))throw stale();throw error instanceof LocalTranscriptionError?error:new LocalTranscriptionError(job.abort.signal.aborted?'transcription_cancelled':'transcription_failed');}
     finally{transcriptions.delete(job);res.off('close',closed);}
    }
    if(url.pathname==='/api/speech'){
     core.authorize(input.connectionId);const owner=core,anchor=core.audioAnchor;
     const turn=typeof input.turnId==='string'&&!input.stepId,step=typeof input.stepId==='string'&&!input.turnId;
     if(!anchor||anchor.phase!=='ready'||anchor.connectionId!==input.connectionId||anchor.revision!==core.state.revision||anchor.viewEpoch!==core.state.viewEpoch||
      !((turn&&anchor.type==='turn'&&anchor.id===input.turnId&&core.latestCompleted?.id===input.turnId)||(step&&anchor.type==='step'&&anchor.id===input.stepId&&core.state.mode==='lesson'&&core.preparedStep().id===input.stepId)))
      throw new StudioError('STALE_AUDIO','This explanation is no longer ready to read. Continue the lesson or ask again.',409);
     // Text comes only from acknowledged content or a prepared step. Never from this request body.
     const text=core.speechText();
     const abort=new AbortController();const closed=()=>{if(!res.writableEnded)abort.abort();};res.on('close',closed);
     try{
      const bytes=await speechImpl.synthesize(text,{signal:abort.signal});
      if(res.destroyed)return;
      if(core!==owner||core.audioAnchor!==anchor||anchor.phase!=='ready')throw new StudioError('STALE_AUDIO','The page changed while preparing speech. No old audio will play.',409);
      res.writeHead(200,{'Content-Type':'audio/wav','Content-Length':bytes.length,'Cache-Control':'no-store'});res.end(bytes);
     }finally{res.off('close',closed);}
     return;
    }
    if(url.pathname==='/api/import'){
     core.authorize(input.connectionId);const next=makeCore(lesson,core.snapshot(),true);next.restoreSession(input.payload);return json(res,200,replace(next,lesson,'SESSION_RESTORED'));
    }
    if(url.pathname==='/api/lesson'){
     core.authorize(input.connectionId);const next=validateLesson(input.lesson);
     const replacement=makeCore(next,undefined,true);
     return json(res,200,replace(replacement,next,'LESSON_REPLACED',{archive:true}));
    }
   }
   return json(res,404,{error:{code:'not_found',message:'This page or endpoint does not exist.'}});
  }catch(e){if(res.headersSent){res.end();return;}const safe=e instanceof StudioError||e instanceof LessonError||e instanceof LocalSpeechError||e instanceof LocalTranscriptionError||e instanceof BridgeError||e instanceof CanvasError;json(res,safe?(e.status||409):500,{error:{code:safe?e.code:'internal_error',message:safe?e.message:'The local server could not complete this action. Your previous save has been retained.'}});}
 });
 return{server,get core(){return core;},listen:()=>new Promise((resolve,reject)=>{const failed=e=>reject(e);server.once('error',failed);server.listen(port,'127.0.0.1',()=>{server.off('error',failed);resolve();});}),close:()=>{bridge.close();try{if(core.connectionId)core.control({connectionId:core.connectionId,action:'cancel'});}catch{}disconnect();speechImpl.cancel?.();transcriptionImpl.cancel?.();server.close();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const app=createStudioServer();app.server.on('error',e=>{console.error(e.code==='EADDRINUSE'?'Lesson Lab port is already in use. Open the existing local app or set STUDIO_PORT.':'Lesson Lab could not start. Check the local configuration.');process.exitCode=1;});
 await app.listen();console.log(`Lesson Lab Studio: http://127.0.0.1:${app.server.address().port}/ (Cerebras key ${process.env.CEREBRAS_API_KEY?'configured':'missing'})`);
 for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>app.close());
}
