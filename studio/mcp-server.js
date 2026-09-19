import readline from 'node:readline';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {createBridgeClient,BridgeClientError} from './mcp-client.js';

const expected={type:'object',description:'Optional anchor from get_lesson_context. Rejects a question if the displayed page has changed.',properties:{connectionId:{type:'string'},lessonId:{type:'string'},lessonVersion:{type:['string','number']},pageId:{type:'string'},revision:{type:'integer'},viewEpoch:{type:'integer'},selectedId:{type:'string'}},additionalProperties:false};
const schema=properties=>({type:'object',properties,additionalProperties:false});
function valid(value, spec){
 const types=Array.isArray(spec.type)?spec.type:[spec.type];
 if(!types.some(type=>type==='integer'?Number.isSafeInteger(value):type==='number'?Number.isFinite(value):type==='object'?value!==null&&typeof value==='object'&&!Array.isArray(value):typeof value===type))return false;
 if(spec.enum&&!spec.enum.includes(value))return false;
 if(typeof value==='string'&&((spec.minLength&&value.trim().length<spec.minLength)||(spec.maxLength&&value.length>spec.maxLength)))return false;
 if(spec.type==='object')return (spec.required||[]).every(key=>Object.hasOwn(value,key))&&Object.entries(value).every(([key,item])=>spec.properties?.[key]?valid(item,spec.properties[key]):spec.additionalProperties!==false);
 return true;
}
export const TOOLS=[
 {name:'open_lesson',description:'Start the local Lesson Lab server if needed and return its URL. Open the returned URL with the Codex open_in_codex browser tool; this tool does not itself open a browser or rotate its session.',inputSchema:schema({}),annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}},
 {name:'get_lesson_context',description:'Read the actual displayed page, live notes, graph parameters, teaching cursor and anchor without reconnecting the browser.',inputSchema:schema({}),annotations:{readOnlyHint:true,openWorldHint:false}},
 {name:'ask_tutor',description:'Ask Cerebras about the current Lesson Lab page. Waits for the browser to validate, animate and acknowledge the answer before returning narration. Read the returned narration directly; do not regenerate the answer with another model.',inputSchema:{...schema({question:{type:'string',minLength:1,maxLength:2000},expected}),required:['question']},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true}},
 {name:'control_lesson',description:'Control the visible lesson and teaching highlight. continue restores the saved step; start explicitly restarts the current page at step one. next advances only after complete_step marks it read. parameter changes a (0.5–10). For a requested passage use page/select IDs from context then ask_tutor, without start. cancel stops pending work. Returns narration only after visible confirmation. Host voice has no playback completion callback.',inputSchema:{...schema({action:{type:'string',enum:['start','continue','next','complete_step','page','select','parameter','cancel','undo']},payload:{type:'object',properties:{a:{type:'number'},pageId:{type:'string'},selectedId:{type:'string'},stepId:{type:'string'}},additionalProperties:false},expected}),required:['action']},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}}
];
export function serveMCP({input=process.stdin,output=process.stdout,client=createBridgeClient()}={}){
 const calls=new Map();
 const send=value=>output.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
 const fail=(id,code,message)=>send({id,error:{code,message}});
 const rl=readline.createInterface({input,crlfDelay:Infinity});
 rl.on('line',async line=>{
  if(!line.trim())return;
  let m;try{if(line.length>128000)throw Error();m=JSON.parse(line);}catch{return fail(null,-32700,'Invalid JSON request.');}
  if(!m||typeof m!=='object'||Array.isArray(m))return fail(null,-32600,'Invalid JSON-RPC request.');
  if(m.method==='notifications/cancelled'){calls.get(m.params?.requestId)?.abort();return;}
  if(m.id===undefined)return;
  if(m.jsonrpc!=='2.0'||typeof m.method!=='string')return fail(m.id,-32600,'Invalid JSON-RPC request.');
  if(m.method==='initialize')return send({id:m.id,result:{protocolVersion:['2025-11-25','2025-06-18','2025-03-26','2024-11-05'].includes(m.params?.protocolVersion)?m.params.protocolVersion:'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'lesson-lab',version:'0.6.0'},instructions:'Use open_lesson and open its URL with the host browser tool. Cerebras owns live teaching content; narrate confirmed tool text. No tool can observe native Codex Voice playback timing.'}});
  if(m.method==='ping')return send({id:m.id,result:{}});
  if(m.method==='tools/list')return send({id:m.id,result:{tools:TOOLS}});
  if(m.method!=='tools/call')return fail(m.id,-32601,'Unknown method.');
  const name=m.params?.name,args=m.params?.arguments||{};
  const tool=TOOLS.find(t=>t.name===name);
  if(!tool)return fail(m.id,-32602,'Unknown tool.');
  if(!valid(args,tool.inputSchema))return fail(m.id,-32602,'Invalid tool arguments.');
  if(name==='ask_tutor'&&(typeof args.question!=='string'||!args.question.trim()||args.question.length>2000))return fail(m.id,-32602,'Provide a question of 1–2000 characters.');
  if(name==='control_lesson'&&!TOOLS[3].inputSchema.properties.action.enum.includes(args.action))return fail(m.id,-32602,'Unsupported lesson action.');
  const controller=new AbortController();calls.set(m.id,controller);
  try{
   const value=name==='open_lesson'?await client.open():name==='get_lesson_context'?await client.context():await client.command(name==='ask_tutor'?{kind:'ask',...args}:{kind:'control',...args},{signal:controller.signal});
   if(!controller.signal.aborted)send({id:m.id,result:{content:[{type:'text',text:JSON.stringify(value)}]}});
  }catch(e){send({id:m.id,result:{isError:true,content:[{type:'text',text:JSON.stringify({error:{code:controller.signal.aborted?'CANCELLED':e instanceof BridgeClientError?e.code:'INTERNAL_ERROR',message:controller.signal.aborted?'This lesson action was cancelled.':e instanceof BridgeClientError?e.message:'The local lesson bridge could not complete this request.'},speakable:false})}]}});
  }finally{calls.delete(m.id);}
 });
 rl.on('close',()=>{for(const controller of calls.values())controller.abort();});
 return rl;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)serveMCP();
