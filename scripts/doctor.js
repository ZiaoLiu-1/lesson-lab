import fs from 'node:fs';
import {validateLesson} from '../studio/lesson.js';
import {createLocalTranscription} from '../studio/transcription.js';
let errors = 0;
const check=(name,ok,detail)=>{console.log(`${ok?'OK':'CHECK'}  ${name}: ${detail}`);if(!ok)errors++;};
check('Node',Number(process.versions.node.split('.')[0])>=24,process.version);
const keyConfigured=Boolean(process.env.CEREBRAS_API_KEY?.trim());
console.log(`INFO  Cerebras key: ${keyConfigured?'configured (hidden)':'not set; the sample works, live edits require your own key'}`);
console.log(`INFO  OpenAI key: ${process.env.OPENAI_API_KEY?.trim()?'configured (hidden)':'optional, only for the separate direct-API comparison'}`);
if(fs.existsSync('.env')&&process.platform!=='win32'){
 const mode=fs.statSync('.env').mode&0o777;
 console.log(`INFO  Secret permissions: ${mode&0o077?'run chmod 600 .env to restrict to your account':'owner-only'}`);
}
try{const lesson=validateLesson(JSON.parse(fs.readFileSync(new URL('../studio/course/lesson.json',import.meta.url))));check('Sample lesson',true,`${lesson.pages.length} pages`);}catch{check('Sample lesson',false,'invalid or missing sample');}
for(const [name,value] of [['STUDIO_PORT',process.env.STUDIO_PORT||4320],['API_PORT',process.env.API_PORT||4337]]){
 const n=Number(value);check(name,Number.isInteger(n)&&n>0&&n<65536,Number.isInteger(n)?String(n):'invalid port');
}
console.log(`INFO  Local Whisper: ${createLocalTranscription().available?'available':'optional; see docs/VOICE.md'}`);
console.log('INFO  No model request, microphone access or installation was performed.');
if(errors)process.exitCode=1;
