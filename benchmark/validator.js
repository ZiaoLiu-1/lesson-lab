// Shared task checks; these verify explicit geometry/labels, not all prose semantics.
export const targetSelectors = {T1:['#tangent','#tangent-note'],T2:['#tangent','#secant','#secant-note'],T3:['#tangent-card','#curve-card']};
export function checkDocument(doc, taskId) {
 const checks=[]; const add=(name,pass)=>checks.push({name,pass:Boolean(pass)});
 const one=id=>{const nodes=doc.querySelectorAll('#'+id);return nodes.length===1?nodes[0]:null;};
 const attrs=(el,values)=>el&&Object.entries(values).every(([key,value])=>el.getAttribute(key)===String(value));
 const svgElement=(id,tag)=>{const el=one(id);return el?.localName===tag&&el.namespaceURI==='http://www.w3.org/2000/svg'&&one('lesson-graph')?.contains(el);};
 add('One lesson root',one('lesson-root'));
 add('Original graph viewBox',attrs(one('lesson-graph'),{viewBox:'0 0 360 260'}));
 add('Original parabola preserved',attrs(one('curve'),{d:'M 40 200 Q 180 200 320 40',fill:'none',stroke:'#1e293b'}));
 add('Original point preserved',attrs(one('current-point'),{cx:180,cy:160,r:5}));
 add('Graph elements have SVG semantics',svgElement('curve','path')&&svgElement('current-point','circle'));
 add('Original lesson text preserved',one('intro')?.textContent==='For f(x) = x², start at x = 1. The point is (1, 1).'&&doc.querySelector('#lesson-root h2')?.textContent==='One curve. Two kinds of change.'&&[...doc.querySelectorAll('.caption')].some(el=>el.textContent==='A prepared lesson. Ask for a visual explanation.'));
 if(taskId==='T1'||taskId==='T2') add('Tangent geometry',attrs(one('tangent'),{x1:40,y1:240,x2:320,y2:80,stroke:'#2563eb','stroke-width':3}));
 if(taskId==='T1'||taskId==='T2') add('Tangent is a line in the graph',svgElement('tangent','line'));
 if(taskId==='T1')add('Tangent label',one('tangent-note')?.textContent.includes('Tangent slope: 2'));
 if(taskId==='T2') {add('Secant geometry',attrs(one('secant'),{x1:180,y1:160,x2:320,y2:40,stroke:'#d97706','stroke-width':3}));add('Secant label',one('secant-note')?.textContent.includes('Secant slope: 3'));}
 if(taskId==='T2')add('Secant is a line in the graph',svgElement('secant','line'));
 if(taskId==='T3'){add('Comparison section',one('comparison'));add('Tangent change label',one('tangent-card')?.textContent.includes('Tangent change: 2'));add('Curve change label',one('curve-card')?.textContent.includes('Curve change: 3'));}
 add('Known task',Object.hasOwn(targetSelectors,taskId));
 return {pass:checks.every(c=>c.pass),checks};
}
const tags=new Set('div section article p h2 h3 span strong em ul li br svg g path circle line text title desc'.split(' '));
const attributes=new Set('id class role aria-label viewBox x y x1 y1 x2 y2 cx cy r d fill stroke stroke-width stroke-dasharray font-size font-weight text-anchor width height'.split(' '));
export function checkSource(html) {
 const checks=[];const add=(name,pass)=>checks.push({name,pass:Boolean(pass)});
 add('Bounded HTML source',typeof html==='string'&&html.length>100&&html.length<16000);
 if(typeof html!=='string')return {pass:false,checks};
 let valid=true; const ids=new Set();
 for(const token of html.match(/<[^>]*>/g)||[]) {
  const match=token.match(/^<(\/)?([A-Za-z][A-Za-z0-9]*)([\s\S]*?)\/?\s*>$/);
  if(!match||!tags.has(match[2])){valid=false;break;}
  if(match[1]){if(match[3].trim())valid=false;continue;}
  let remainder=match[3],attr;
  while(remainder.trim()){
   attr=remainder.match(/^\s+([A-Za-z][A-Za-z0-9-]*)\s*=\s*(["'])(.*?)\2/s);
   if(!attr||!attributes.has(attr[1])||/[<>&]|url\s*\(|javascript:|data:|https?:/i.test(attr?.[3]||'')){valid=false;break;}
   if(attr[1]==='id'){if(ids.has(attr[3]))valid=false;ids.add(attr[3]);}
   remainder=remainder.slice(attr[0].length);
  }
 }
 add('Passive allowlisted HTML/SVG only',valid&&html.replace(/<[^>]*>/g,'').indexOf('<')===-1);
 add('Single preserved root',ids.has('lesson-root')&&/^\s*<div\s+id=["']lesson-root["']/.test(html)&&/<\/div>\s*$/.test(html));
 return {pass:checks.every(c=>c.pass),checks};
}
