import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanNarration, isFinalNarration, spokenText } from '../studio/public/narration.js';

test('final teaching derivations are preserved rather than mistaken for internal planning', () => {
  const teaching = 'We need to divide by h while h is nonzero.\n[(x + h)² − x²] / h = 2x + h.\nAs h tends to zero, the slope tends to 2x. What is the slope at x = 1?';
  assert.equal(cleanNarration(teaching), teaching);
  assert.equal(isFinalNarration(teaching), true);
  assert.equal(cleanNarration('For h < 0, the same algebra applies.'), 'For h < 0, the same algebra applies.');
});

test('playback strips only fully closed thinking blocks; new output must already be final', () => {
  const raw = '<think>Draft calculations that must not be read.</think> The local slope is 2. <analysis>Another private draft.</analysis>';
  assert.equal(cleanNarration(raw), 'The local slope is 2.');
  assert.equal(isFinalNarration(raw), false);
  assert.equal(cleanNarration('<THINK>draft</THINK>\nThe tangent is a local linear model.'), 'The tangent is a local linear model.');
  assert.equal(cleanNarration('<think>draft only</think>'), '');
});

test('unclosed tags, explicit draft headers and agent-planning prose fail closed', () => {
  for (const raw of ['<think>The slope is 2.', 'The slope is 2.</think>', '<think>nested <think>draft</think> remainder</think>',
    'Analysis: I should answer the question.\nFinal: The slope is 2.', '**Thinking:** choose the explanation.',
    '# Internal reasoning: this is a draft.', '[analysis] draft', '<|analysis|> draft',
    'Let me think about the right response.', 'The slope is 2. I need to return valid JSON.',
    'We should generate a teaching unit.', 'I will update the code and then explain.', "I'll write the response now.",
    'The slope\u000bis 2.']) {
    assert.equal(cleanNarration(raw), '', raw);
    assert.equal(isFinalNarration(raw), false, raw);
  }
});

test('speech reads explicit final narration or legacy text, never a title or reasoning field', () => {
  const legacy = { title: 'A repeated heading', text: 'The slope is 2.' };
  Object.defineProperty(legacy, 'reasoning', { get() { throw new Error('Reasoning must never be read.'); } });
  assert.equal(spokenText(legacy), 'The slope is 2.');
  assert.equal(spokenText({ ...legacy, narration: 'Look at the marked point.' }), 'Look at the marked point.');
  for (const narration of ['', null, undefined, 2, '<think>Only a draft.</think>']) {
    assert.equal(spokenText({ text: 'Must not become an implicit fallback.', narration }), '');
  }
  assert.equal(spokenText({ title: 'Not a spoken fallback', reasoning: 'Not narration' }), '');
  assert.equal(spokenText(null), '');
});
