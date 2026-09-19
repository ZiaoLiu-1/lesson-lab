import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { computeExample, expressionFor, formatFunction } from '../studio/public/math.js';
const source = await readFile(new URL('../studio/public/app.js', import.meta.url), 'utf8');
function actual(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source); assert.ok(match, name);
  const next = /\n(?:async )?function \w+\(/g; next.lastIndex = match.index + match[0].length;
  return source.slice(match.index, next.exec(source)?.index ?? source.length);
}
class Node {
  constructor() { this.attributes = {}; this.dataset = {}; this.children = []; this.textContent = ''; }
  setAttribute(name, value) { this.attributes[name] = value; }
  get lastChild() { return this.children.at(-1); }
}
function fixture() {
  const nodes = Object.fromEntries(['curve', 'tangent', 'secant', 'point', 'pointLabel', 'endpoint', 'endpointLabel', 'xAxis', 'yAxis', 'xLabel'].map(name => [name, new Node()]));
  nodes.grid = Array.from({ length: 6 }, () => ({ line: new Node(), text: new Node() }));
  nodes.ticks = [-1, 0, 1, 2].map(x => ({ x, line: new Node(), text: new Node() }));
  const elements = new Map(); const content = { a: 10, power: 3, functionCode: '10 * x ** 3', scene: { tangent: true, secant: true, comparison: true } };
  const context = vm.createContext({ nodes, computeExample, expressionFor, formatFunction,
    ui: { state: { pageId: 'p1' }, previewA: null, lesson: { id: 'lesson', version: '1', example: { minA: 0.5, maxA: 10 } } }, document: { activeElement: null },
    $(id) { if (!elements.has(id)) elements.set(id, new Node()); return elements.get(id); },
    pageState: () => content, initializeGraph() {}, motion: { cancel() {}, to(key, data) { data.update(data.to, 1); return Promise.resolve(); } },
  });
  context.$('graph-legend').children = [new Node(), new Node(), new Node()];
  const comparison = context.$('computed-comparison'); comparison.children = [new Node(), new Node(), new Node()];
  comparison.children[0].children = [new Node()]; comparison.children[1].children = [new Node()];
  const names = ['number', 'setText', 'graphY', 'graphCoefficients', 'graphFunction', 'graphFacts', 'graphExtent', 'graphAttributes', 'drawGraph', 'renderGraph'];
  vm.runInContext(`let graphNodes = nodes, graphValue = null, graphPage = null;\n${source.match(/^const graphX = .*$/m)[0]}\n${names.map(actual).join('\n')}`, context);
  context.graphX = vm.runInContext('graphX', context);
  const target = (a, power) => ({ ...context.graphCoefficients(a, power), ...context.graphExtent(power), tangent: 1, secant: 1, endpoint: 1, comparison: 1 });
  return { context, nodes, content, target };
}

test('the rendered cubic has correct negative branch, endpoint 80 and tangent endpoint 40', () => {
  const f = fixture(); const value = f.target(10, 3); f.context.drawGraph(value, value, 1);
  assert.equal(f.context.graphFunction(value, -1), -10); assert.equal(f.context.graphFunction(value, 2), 80);
  const facts = f.context.graphFacts(value); assert.equal(facts.slope, 30); assert.equal(facts.tangentEndY, 40);
  assert.equal(Number(f.nodes.endpoint.attributes.cy), f.context.graphY(80, value));
  const tangent = f.nodes.tangent.attributes;
  const atTwo = Number(tangent.y1) + (Number(tangent.y2) - Number(tangent.y1)) * (f.context.graphX(2) - Number(tangent.x1)) / (Number(tangent.x2) - Number(tangent.x1));
  assert.ok(Math.abs(atTwo - f.context.graphY(40, value)) < 1e-9);
  assert.match(f.nodes.endpointLabel.textContent, /2, 80/); assert.match(f.context.$('computed-comparison').lastChild.textContent, /tangent goes from 10 to 40; the curve goes from 10 to 80/);
  assert.doesNotMatch(f.nodes.curve.attributes.d, /NaN|Infinity/);
});

test('power transitions interpolate integer-power coefficients without invalid fractional exponents or replacing nodes', () => {
  const f = fixture(), old = f.target(1, 2), target = f.target(10, 3); const identity = f.nodes.curve;
  for (const progress of [0, 0.1, 0.5, 0.9, 1]) {
    const value = Object.fromEntries(Object.keys(target).map(key => [key, old[key] + (target[key] - old[key]) * progress]));
    assert.doesNotThrow(() => f.context.drawGraph(value, target, progress));
    assert.equal(f.nodes.curve, identity); assert.doesNotMatch(f.nodes.curve.attributes.d, /NaN|Infinity/);
    assert.ok(Math.abs(f.context.graphFunction(value, -1) - ((1 - progress) - 10 * progress)) < 1e-9);
    if (progress > 0 && progress < 1) assert.match(f.context.$('graph-heading').textContent, /Transition/);
  }
  assert.equal(f.context.$('graph-heading').textContent, 'f(x) = 10x³');
});

test('all supported powers fit the fixed-per-power range with negatives and tangent geometry', () => {
  const f = fixture();
  for (const power of [1, 2, 3, 4, 5]) for (const a of [0.5, 1, 10]) {
    const value = f.target(a, power), facts = f.context.graphFacts(value);
    for (const x of [-1.05, -1, 0, 1, 2, 2.12]) {
      for (const y of [f.context.graphFunction(value, x), facts.y + facts.slope * (x - 1)]) {
        const screenY = f.context.graphY(y, value); assert.ok(screenY >= 24 - 1e-8 && screenY <= 290 + 1e-8, `${a}*x**${power} at ${x}`);
      }
    }
  }
});

test('source inspection shows the exact validated provider expression and slider preview does not pretend it is saved', () => {
  const f = fixture(); f.context.renderGraph();
  assert.equal(f.context.$('live-function-code').textContent, 'function f(x) { return 10 * x ** 3; }');
  assert.equal(f.context.$('graph-heading').textContent, 'f(x) = 10x³');
  f.context.ui.previewA = 5; f.context.renderGraph();
  assert.equal(f.context.$('graph-heading').textContent, 'f(x) = 5x³');
  assert.equal(f.context.$('live-function-code').textContent, 'function f(x) { return 10 * x ** 3; }');
  assert.match(f.context.$('graph-footnote').textContent, /preview has not changed the saved code/);
});
