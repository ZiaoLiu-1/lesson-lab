import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {validateLesson} from '../studio/lesson.js';
const lesson=JSON.parse(fs.readFileSync(new URL('../studio/course/lesson.json',import.meta.url)));
test('Studio supplied lesson has resolvable steps and deterministic quiz answers',()=>{const out=validateLesson(lesson);assert.equal(out.pages.length,3);for(const p of out.pages){assert.ok(p.steps.every(s=>p.blocks.some(b=>b.id===s.targetId)));assert.ok(p.quiz.options.some(o=>o.id===p.quiz.answerId));}});
test('Studio rejects polluted IDs, duplicate blocks and cross-page step references',()=>{for(const edit of [l=>l.pages[0].id='__proto__',l=>l.pages[1].blocks[0].id=l.pages[0].blocks[0].id,l=>l.pages[1].steps[0].targetId=l.pages[0].blocks[0].id]){const l=structuredClone(lesson);edit(l);assert.throws(()=>validateLesson(l));}});
test('Studio course imports reject external URL schemes and unsupported example engines',()=>{const l=structuredClone(lesson);l.sources[0].url='javascript:alert(1)';assert.throws(()=>validateLesson(l));delete l.sources[0].url;l.example.kind='execute-javascript';assert.throws(()=>validateLesson(l));});
test('Studio normalizes only the legacy quadratic upper bound and preserves lesson content/version',()=>{
 const legacy=structuredClone(lesson);legacy.example.maxA=5;
 const normalized=validateLesson(legacy);
 assert.deepEqual(normalized,validateLesson(lesson));assert.equal(normalized.example.maxA,10);assert.equal(normalized.version,'1.0.0');
 assert.equal(legacy.example.maxA,5);
 const upper=structuredClone(lesson);upper.example.initialA=10;
 assert.equal(validateLesson(upper).example.initialA,10);
 for(const edit of [l=>l.example.maxA=11,l=>l.example.minA=0,l=>l.example.initialA=10.01,
  l=>{l.example.maxA=5;l.example.initialA=6;}]){
  const invalid=structuredClone(lesson);edit(invalid);assert.throws(()=>validateLesson(invalid));
 }
});
