// Presentation only: a passage selected for a question is not a narration cursor.
export function resolveTeachingFocus({ lesson, state, marker, audio, connectionId, connected }) {
  if (!marker || !state || marker.pageId !== state.pageId) return null;
  const page = lesson?.pages.find((item) => item.id === state.pageId);
  const target = [...(page?.blocks || []), ...(state.pages[state.pageId]?.notes || [])].find((item) => item.id === marker.targetId);
  if (!target) return null;
  const current = connected && marker.connectionId === connectionId && marker.revision === state.revision && marker.viewEpoch === state.viewEpoch;
  const matchingAudio = current && audio && !audio.cancelled && audio.connectionId === connectionId
    && audio.revision === state.revision && audio.viewEpoch === state.viewEpoch
    && (marker.kind === 'lesson' ? audio.identity.stepId === marker.id : audio.identity.turnId === marker.id);
  let phase = current ? marker.phase : 'paused';
  if (matchingAudio) phase = audio.ended ? 'done' : audio.started ? 'speaking' : 'preparing';
  const labels = { ready: marker.kind === 'lesson' ? 'Current step' : 'Explaining this', preparing: 'Preparing to read', speaking: 'Now explaining', paused: 'Paused here', done: 'Just covered' };
  return { targetId: target.id, title: target.title || 'Saved note', phase, label: labels[phase] || labels.paused };
}
