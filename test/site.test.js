import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../site/', import.meta.url);
const read = name => fs.readFileSync(new URL(name, root), 'utf8');

test('showcase is a static English page with local assets and a canonical URL', () => {
  const html = read('index.html');
  assert.match(html, /<html[^>]+lang="en"/);
  assert.equal((html.match(/<h1(?:\s|>)/g) || []).length, 1);
  assert.match(html, /https:\/\/ziaoliu\.io\/pages\/lesson-lab\//);
  for (const match of html.matchAll(/(?:src|href)="([^"#]+\.(?:css|js|svg))"/g)) {
    assert(!/^https?:/.test(match[1]), `Expected local asset: ${match[1]}`);
    assert(fs.statSync(new URL(match[1], root)).isFile());
  }
});

test('showcase keeps two explicit video opt-ins and direct video fallbacks', () => {
  const html = read('index.html');
  for (const id of ['RpbIJLIoFbI', '5w6XOYipABk']) {
    assert.match(html, new RegExp(`data-video-id="${id}"`));
    assert.match(html, new RegExp(`https://(?:youtu.be/|www.youtube.com/watch\\?v=)${id}`));
  }
  assert.doesNotMatch(html, /<iframe\b/i, 'No player exists before visitor opt-in');
  assert.doesNotMatch(html, /<(?:input|textarea|form)\b/i, 'No prompts or credentials collected');
});

test('showcase JavaScript does not call a model, microphone or application API', () => {
  const js = read('app.js');
  assert.match(js, /youtube-nocookie\.com/);
  assert.doesNotMatch(js, /\bfetch\s*\(|\b(?:WebSocket|EventSource)\s*\(|getUserMedia\s*\(/);
  assert.doesNotMatch(js, /autoplay=1/);
});

test('showcase retains public source and setup documentation entry points', () => {
  const html = read('index.html');
  assert.match(html, /https:\/\/github\.com\/ZiaoLiu-1\/lesson-lab/);
  assert.match(html, /docs\/DEMO\.md/);
  assert.match(html, /docs\/BENCHMARK\.md/);
});
