export class LessonError extends Error {constructor(message){super(message);this.code='invalid_lesson';this.status=400;}}
export const QUADRATIC_MIN_A=0.5,QUADRATIC_MAX_A=10;
// Historical version-1 lessons declared maxA:5. Only this adapter metadata
// changes; IDs, version, teaching text and saved learning state remain intact.
export function normalizeLessonRange(lesson){
 const out=structuredClone(lesson);
 if(out.example?.kind==='quadratic'&&out.example.minA===QUADRATIC_MIN_A&&out.example.maxA===5)out.example.maxA=QUADRATIC_MAX_A;
 return out;
}
const fail=m=>{throw new LessonError(m);};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=(v,name,max=4000)=>{if(typeof v!=='string'||!v.trim()||v.length>max)fail(`${name} must be nonempty text (up to ${max} characters).`);return v;};
const id=(v,name)=>{if(typeof v!=='string'||!/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(v)||['prototype','constructor','__proto__'].includes(v))fail(`${name} is not a safe stable ID.`);return v;};
const list=(v,name,min,max)=>{if(!Array.isArray(v)||v.length<min||v.length>max)fail(`${name} must contain ${min}–${max} items.`);return v;};
export function validateLesson(input){
 if(!object(input))fail('A lesson JSON object is required.');
 if(JSON.stringify(input).length>200000)fail('The lesson exceeds 200 KB.');
 const seen=new Set();const unique=(v,name)=>{const value=id(v,name);if(seen.has(value))fail(`Duplicate ID: ${value}`);seen.add(value);return value;};
 const out={id:id(input.id,'Lesson ID'),version:text(input.version,'Version',40),title:text(input.title,'Title',160),subtitle:text(input.subtitle,'Subtitle',300)};
 const ex=input.example;if(!object(ex)||ex.kind!=='quadratic'||ex.minA!==QUADRATIC_MIN_A||![5,QUADRATIC_MAX_A].includes(ex.maxA)||!Number.isFinite(ex.initialA)||ex.initialA<QUADRATIC_MIN_A||ex.initialA>ex.maxA)fail('This version supports a quadratic example with a between 0.5 and 10 (legacy maxA:5 lessons are upgraded).');
 out.example={kind:'quadratic',initialA:ex.initialA,minA:QUADRATIC_MIN_A,maxA:QUADRATIC_MAX_A};
 out.sources=list(input.sources,'Sources',1,40).map(s=>{if(!object(s))fail('Invalid source.');const item={id:unique(s.id,'Source ID'),title:text(s.title,'Source title',200)};if(s.url!==undefined){let u;try{u=new URL(s.url);}catch{fail('Source URL must be HTTPS.');}if(u.protocol!=='https:'||u.username||u.password||String(s.url).length>1000)fail('Source URL must be HTTPS without credentials.');item.url=u.href;}return item;});
 out.pages=list(input.pages,'Pages',1,20).map(p=>{
  if(!object(p))fail('Invalid page.');const page={id:unique(p.id,'Page ID'),title:text(p.title,'Page title',160),eyebrow:text(p.eyebrow,'Page label',100),summary:text(p.summary,'Page summary',700)};
  page.blocks=list(p.blocks,'Page blocks',1,12).map(b=>{if(!object(b))fail('Invalid block.');const block={id:unique(b.id,'Block ID'),title:text(b.title,'Block title',160),text:text(b.text,'Block text')};if(b.formula!==undefined)block.formula=text(b.formula,'Formula',250);return block;});
  page.steps=list(p.steps,'Teaching steps',1,12).map(s=>{if(!object(s)||!page.blocks.some(b=>b.id===s.targetId))fail('A teaching step must target a block on its own page.');return{id:unique(s.id,'Step ID'),targetId:s.targetId,text:text(s.text,'Step text',1500)};});
  page.quickQuestions=list(p.quickQuestions,'Quick questions',1,5).map(q=>text(q,'Question',300));
  if(p.quiz!==undefined){const q=p.quiz;if(!object(q))fail('Invalid quiz.');const options=list(q.options,'Quiz options',2,5).map(o=>({id:id(o.id,'Option ID'),text:text(o.text,'Option text',500)}));if(new Set(options.map(o=>o.id)).size!==options.length||!options.some(o=>o.id===q.answerId))fail('Quiz options need unique IDs and a matching answer.');page.quiz={id:unique(q.id,'Quiz ID'),question:text(q.question,'Quiz question',700),options,answerId:q.answerId,explanation:text(q.explanation,'Quiz explanation',1500)};}
  return page;
 });
 return out;
}
