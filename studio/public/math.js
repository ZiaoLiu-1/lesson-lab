// Trusted bounded monomials. Source strings are parsed, never evaluated.
export function computeExample(a, power = 2) {
  if (!Number.isFinite(a) || a < 0.5 || a > 10) throw new RangeError('Choose a coefficient from 0.5 to 10.');
  if (!Number.isInteger(power) || power < 1 || power > 5) throw new RangeError('Choose an integer power from 1 to 5.');
  const y = a, endY = a * 2 ** power, slope = a * power, tangentEndY = y + slope;
  return { a, power, x: 1, endX: 2, y, endY, slope, tangentEndY,
    curveChange: endY - y, tangentChange: slope, secantSlope: endY - y, error: endY - tangentEndY };
}
export function expressionFor(a, power = 2) { computeExample(a, power); return `${a}*x**${power}`; }
const superscripts = ['⁰', '¹', '²', '³', '⁴', '⁵'];
export function formatFunction(a, power = 2) { computeExample(a, power); return `f(x) = ${a}x${power === 1 ? '' : superscripts[power]}`; }
export function parseFunctionCode(code) {
  if (typeof code !== 'string' || code.length > 80) throw new TypeError('Use a bounded monomial expression.');
  const match = /^\s*((?:\d+(?:\.\d+)?|\.\d+))\s*\*\s*x\s*\*\*\s*([1-5])\s*$/.exec(code);
  if (!match) throw new TypeError('Use only coefficient*x**power.');
  const a = Number(match[1]), power = Number(match[2]); computeExample(a, power); return { a, power };
}

export function sceneForStep(stepId) {
  const scenes = {
    'p1.s1': [false, false, false], 'p1.s2': [true, false, false], 'p1.s3': [true, false, false],
    'p2.s1': [false, false, true], 'p2.s2': [true, false, true], 'p2.s3': [true, true, true],
    'p3.s1': [true, false, false], 'p3.s2': [true, false, true], 'p3.s3': [true, true, true]
  };
  const value = scenes[stepId];
  return value ? { tangent: value[0], secant: value[1], comparison: value[2] } : null;
}

// The core only enables changed powers for the exact bundled page templates.
// Canonical authored pages stay unchanged in lesson exports.
export function materialFor(page, facts) {
  const out = structuredClone(page), f = computeExample(facts.a, facts.power ?? 2);
  if (f.power === 2) return out;
  const { a, power, y, endY, slope, tangentEndY, curveChange, tangentChange, secantSlope, error } = f;
  const fn = formatFunction(a, power), derivative = power === 1 ? `${a}` : `${slope}x${power === 2 ? '' : superscripts[power - 1]}`;
  const tangent = `L(x) = ${y} + ${slope}(x − 1)`;
  const gap = `f(1 + h) − L(1 + h) = ${a}[(1 + h)^${power} − 1 − ${power}h]`;
  const linear = power === 1;
  const blocks = {
    'p1.function': [`The active example is ${fn}. The coefficient is ${a} and the power is ${power}. The marked point stays at x = 1, with height ${y}.`, fn],
    'p1.derivative': [`The power rule gives f′(x) = ${derivative}. At x = 1, the local slope is ${slope}. ${linear ? 'This function is linear, so its slope is constant.' : 'The slope describes this point, not the exact rise over a finite interval.'}`, `f′(1) = ${slope}`],
    'p1.tangent': [`The tangent passes through (1, ${y}) with slope ${slope}. ${linear ? 'Here the function and tangent are the same line.' : 'Close to that point it gives a linear approximation.'}`, tangent],
    'p2.curve': [`From x = 1 to x = 2, the function moves from ${y} to ${endY}. Its exact change is ${curveChange}. This is a finite unit interval.`, `f(2) − f(1) = ${endY} − ${y} = ${curveChange}`],
    'p2.tangent': [`Over that interval, the tangent moves from ${y} to ${tangentEndY}, a change of ${tangentChange}. ${linear ? 'This also equals the function’s exact change because it is linear.' : 'This is exact for the tangent and a prediction for the curve.'}`, `L(2) − L(1) = ${tangentChange}`],
    'p2.secant': [`The secant joins (1, ${y}) and (2, ${endY}). Its average slope is ${secantSlope}. ${linear ? 'It coincides with the function and tangent.' : 'The function gets steeper across this positive interval.'}`, `secant slope = (${endY} − ${y}) / (2 − 1) = ${secantSlope}`],
    'p3.claim': [linear ? `The active example ${fn} is linear: its derivative is the constant ${slope}. The tangent is exact everywhere.` : `For ${fn}, the derivative is ${derivative}. Its value changes with x. One local slope does not make the whole function linear.`, `f′(x) = ${derivative}`],
    'p3.error': [`At x = 1 + h, subtract the tangent value ${a} + ${slope}h from ${a}(1 + h)^${power}. For h = 1 the vertical gap is ${error}. This is a height difference, not an area.`, gap],
    'p3.check': [`Name the object and interval. Distinguish local slope ${slope}, average slope ${secantSlope}, and finite changes ${curveChange} for the function and ${tangentChange} for the tangent. ${linear ? 'The gap is zero because this example is linear.' : 'For small steps near x = 1, the absolute tangent error tends to zero.'}`, '']
  };
  const stepText = {
    'p1.s1': `The active function has coefficient ${a} and power ${power}. At x equals one, its height is ${y}.`,
    'p1.s2': `The power rule gives coefficient times power at x equals one. The local slope is ${slope}. ${linear ? 'The slope stays constant for this linear function.' : 'It is not the exact rise over the whole step from one to two.'}`,
    'p1.s3': `The tangent starts at height ${y} and uses slope ${slope}. At x equals two it reaches ${tangentEndY}. The function reaches ${endY}.`,
    'p2.s1': `The function starts at ${y} and ends at ${endY}. Its exact finite change is ${curveChange}.`,
    'p2.s2': `The tangent rises by ${tangentChange}, reaching ${tangentEndY}. The function reaches ${endY}. ${linear ? 'They coincide for this linear example.' : 'Keep these two objects distinct.'}`,
    'p2.s3': `The secant’s slope is ${secantSlope}. It summarizes the entire unit interval. The starting tangent has slope ${slope}.`,
    'p3.s1': linear ? `This power-one example is linear. Its slope is ${slope} everywhere, so the tangent is the function itself.` : `The starting slope is ${slope}, but the slope varies with x. The function is not linear.`,
    'p3.s2': `The function changes by ${curveChange}; the tangent changes by ${tangentChange}. Their endpoint vertical gap is ${error}. It is not an area.`,
    'p3.s3': `Before using a slope, identify the object, the interval, and whether you need a local rate or an exact finite change.`
  };
  if (!out.blocks.every(block => blocks[block.id]) || !out.steps.every(step => stepText[step.id])) return out;
  out.blocks = out.blocks.map(block => ({ ...block, text: blocks[block.id][0], formula: blocks[block.id][1], materialKind: 'program-derived' }));
  out.steps = out.steps.map(step => ({ ...step, text: stepText[step.id], materialKind: 'program-derived' }));
  out.quickQuestions = ['Explain the power rule for the active function.', 'Show the tangent and secant using the current function.', 'Restore the quadratic function and explain what changes.'];
  delete out.quiz; // The original quiz is explicitly quadratic, not a live-power quiz.
  out.materialKind = 'program-derived';
  return out;
}
