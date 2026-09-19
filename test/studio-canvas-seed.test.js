import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldEditCanvas } from '../studio/public/canvas-seed.js';

test('explicit page, style, and source edits enter the HTML canvas', () => {
  for (const question of [
    'Redesign this entire page with a midnight blue background.',
    'Change the coefficient to 15.',
    'Add a visual section explaining the tangent.',
    'Turn this entire page into a Cerebras-inspired website.',
    'Change f(x) to 10x³.',
    'Replace the graph with a worked diagram.',
    'Could you please change the background to navy?',
    'I would like you to add a new section.',
    'Keep the facts. Now, change the theme.',
  ]) assert.equal(shouldEditCanvas(question, false), true, question);
});

test('ordinary learning questions stay in the prepared lesson before entering canvas', () => {
  for (const question of [
    'Why is the tangent a local approximation?',
    'Explain the difference between tangent and secant.',
    'Is the slope at x = 1 equal to two?',
    'Show me another example.',
    'What does coefficient mean?',
    'What is the rate of change of the function?',
    'What happens if I change the graph?',
    'Can you explain HTML?',
    'Do not change the page. Explain the tangent.',
  ]) assert.equal(shouldEditCanvas(question, false), false, question);
});

test('a follow-up about the active canvas stays with its actual HTML source', () => {
  assert.equal(shouldEditCanvas('Why is this true?', false), false);
  assert.equal(shouldEditCanvas('Why is this true?', true), true);
  assert.equal(shouldEditCanvas('Make it clearer.', true), true);
});
