import fs from 'node:fs';
import { createHash } from 'node:crypto';
export const protocolVersion = 'lesson-code-edit-v1';
export const starterHtml = fs.readFileSync(new URL('./starter.html', import.meta.url), 'utf8');
export const styles = fs.readFileSync(new URL('./lesson.css', import.meta.url), 'utf8');
export const hash = text => createHash('sha256').update(text).digest('hex');
export const outputSchema = {type:'object',properties:{html:{type:'string'},summary:{type:'string'}},required:['html','summary'],additionalProperties:false};
export const tasks = [
 {id:'T1',title:'Annotate the tangent',prompt:'Help me see the slope at x = 1. Add a blue tangent to the graph and a short explanation below it. Use a line with id="tangent", x1="40", y1="240", x2="320", y2="80", stroke="#2563eb", and stroke-width="3". Add a visible paragraph with id="tangent-note" containing the exact label "Tangent slope: 2" and explain that this is the local slope at x = 1. Keep the existing curve and point.'},
 {id:'T2',title:'Compare a finite step',prompt:'Show why the tangent and the curve predict different changes from x = 1 to x = 2. Add the blue tangent line (id="tangent", x1="40", y1="240", x2="320", y2="80", stroke="#2563eb", stroke-width="3") and an orange secant line (id="secant", x1="180", y1="160", x2="320", y2="40", stroke="#d97706", stroke-width="3"). Below the graph add a paragraph id="secant-note" containing "Secant slope: 3" and explain that on this interval the curve rises by 3 while the tangent rises by 2. Keep the existing curve and point. Do not call this unit step infinitesimal.'},
 {id:'T3',title:'Correct a misconception',prompt:'Add two compact comparison cards below the graph in a section id="comparison". Use article id="tangent-card" containing "Tangent change: 2" and article id="curve-card" containing "Curve change: 3". Explain that these exact changes are for x = 1 to x = 2: the tangent rises from 1 to 3; the curve rises from 1 to 4. Conclude that the derivative 2 at x = 1 describes local slope and does not make the curve linear. Keep the existing curve and point.'}
];
export const commonPrompt = `You are editing an English teaching page. Perform exactly the requested code change on the supplied original HTML fragment. Return a JSON object with exactly two strings: html (the complete updated fragment) and summary (one short English sentence). Do not use tools or access files. All needed source and facts are below.
The unchanged host supplies CSS for the IDs used in the task. Produce real HTML and SVG code; do not return a patch, Markdown fences, JavaScript, style tags, external resources, event handlers, links, comments, or a full HTML document. Preserve the single outer div id="lesson-root" and the original IDs, curve path, point coordinates, graph viewBox, and existing text. Add only the elements needed for the task. Keep the fragment under 16000 characters. Use quoted attributes.
Allowed tags: div, section, article, p, h2, h3, span, strong, em, ul, li, br, svg, g, path, circle, line, text, title, desc.
Allowed attributes: id, class, role, aria-label, viewBox, x, y, x1, y1, x2, y2, cx, cy, r, d, fill, stroke, stroke-width, stroke-dasharray, font-size, font-weight, text-anchor, width, height. No inline style. Use ordinary short English; math text is plain Unicode, not LaTeX.
Verified facts: f(x)=x²; f(1)=1; f(2)=4; f'(1)=2. The tangent at x=1 is L(x)=2x-1. From x=1 to x=2, the tangent rises by exactly 2, while the curve rises by exactly 3; the secant slope is 3. A derivative is local, not an exact finite change in the curve. The graph uses pixel X=40+140*x, Y=200-40*y. Thus the tangent endpoints are (40,240),(320,80), and the secant endpoints are (180,160),(320,40).
The host will check required IDs, numeric geometry, exact labels, and preservation of the baseline. Human visual/content review is separate.`;
export function promptFor(taskId) {
 const task=tasks.find(t=>t.id===taskId); if(!task) throw new Error('Unknown task');
 return `${commonPrompt}\n\nTASK ${task.id}:\n${task.prompt}\n\nORIGINAL HTML:\n${starterHtml}`;
}
export const lanes=[{id:'cerebras',label:'Cerebras API',model:'gpt-oss-120b',route:'Direct API',reasoning:'low'},{id:'astra',label:'GPT-6 Astra',model:'gpt-6-astra',route:'Codex CLI · ChatGPT quota',reasoning:'low'}];
export const qwenLane={id:'cerebras-qwen',label:'Cerebras API · Qwen',model:'qwen-3.8-27b',route:'Direct API',reasoning:'low'};
