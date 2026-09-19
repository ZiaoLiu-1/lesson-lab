// Shared by the provider, trusted server and browser. This is a narrow draft
// detector, not a mathematical or general semantic verifier.
const thinkingTag = /<\/?(?:think|thinking|analysis|reasoning)\b[^>]*>|<\|(?:analysis|reasoning)\|>|\[(?:think|analysis|reasoning)\]/i;
const closedThinkingBlock = /<(think|thinking|analysis|reasoning)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const draftHeading = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?(?:analysis|internal\s+(?:analysis|reasoning)|chain[ -]of[ -]thought|reasoning|thinking|thoughts|planning|draft(?:\s+(?:answer|response))?)(?:\*\*)?\s*:/i;
const planning = [
  /\blet me (?:think|reason|plan)\b/i,
  /\b(?:i|we)\s+(?:need to|have to|must|should|will|am going to|are going to)\s+(?:respond|reply|output|return|generate|produce|draft|format|compose)\b/i,
  /\b(?:i['’]ll|we['’]ll)\s+(?:respond|reply|output|return|generate|produce|draft|format|compose)\b/i,
  /\b(?:i|we)\s+(?:need to|have to|must|should|will|am going to|are going to)\s+(?:update|edit|modify|write|change)\s+(?:(?:the|this|a|some)\s+)?(?:code|html|javascript|json|schema|response|answer|prompt|file|app|application|ui)\b/i,
  /\b(?:i['’]ll|we['’]ll)\s+(?:update|edit|modify|write|change)\s+(?:(?:the|this|a|some)\s+)?(?:code|html|javascript|json|schema|response|answer|prompt|file|app|application|ui)\b/i,
];
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export const PROFESSOR_INSTRUCTIONS = `Speak as a patient, precise university professor addressing one learner directly. The narration is the final sentence-by-sentence teaching script, ready to read aloud. Start with the answer or concept, use the current example when useful, and end with one brief understanding check only when it helps. Keep a warm, concise tone without canned acknowledgements. Explain valid mathematical steps when requested, but never narrate private thinking, planning, tool use, code-writing workflow, schema choices, or self-instructions such as "let me think", "I need to respond", or "I will update the code". Resolve calculations and revisions before writing. Do not include analysis/thinking headings or tags, abandoned drafts, or repeated titles. A derivation that teaches the learner is welcome; internal deliberation about how to produce the answer is not narration.`;

export function cleanNarration(text) {
  if (typeof text !== 'string' || text.length > 16000 || controls.test(text)) return '';
  const cleaned = text.replace(closedThinkingBlock, '').trim();
  if (!cleaned || thinkingTag.test(cleaned) || draftHeading.test(cleaned) || planning.some(pattern => pattern.test(cleaned))) return '';
  return cleaned;
}

// New provider output must already be final. Unlike the defensive playback
// path, validation does not silently salvage a response containing a draft.
export function isFinalNarration(text) {
  return typeof text === 'string' && !thinkingTag.test(text) && cleanNarration(text).length > 0;
}

export function spokenText(unit) {
  if (!unit || typeof unit !== 'object' || Array.isArray(unit)) return '';
  // An explicit but invalid/empty narration must not fall back to other text.
  return cleanNarration(Object.hasOwn(unit, 'narration') ? unit.narration : unit.text);
}
