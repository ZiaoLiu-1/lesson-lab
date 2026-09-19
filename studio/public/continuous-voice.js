const RATE = 16000;
const FRAME_MS = 20;

export function encodeWav(frames) {
  const length = frames.reduce((total, frame) => total + frame.length, 0);
  if (length < RATE / 5 || length > RATE * 20) throw new Error('Speak for between 0.2 and 20 seconds per turn.');
  const bytes = new ArrayBuffer(44 + length * 2), view = new DataView(bytes);
  const tag = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  tag(0, 'RIFF'); view.setUint32(4, 36 + length * 2, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true); view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, 'data'); view.setUint32(40, length * 2, true);
  let offset = 44;
  for (const frame of frames) for (const sample of frame) {
    const value = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
    view.setInt16(offset, Math.round(value * (value < 0 ? 32768 : 32767)), true); offset += 2;
  }
  return bytes;
}

/** Energy VAD over echo-cancelled PCM. It is not speaker identification.
 * The onset is deliberately earlier than final recognition so an interruption
 * can stop output while the new utterance is still being captured.
 */
export class VoiceSegmenter {
  constructor({ onStart = () => {}, onComplete = () => {}, onDiscard = () => {}, silenceMs = 620, startMs = 120, minimumVoicedMs = 240, maxMs = 20000 } = {}) {
    Object.assign(this, { onStart, onComplete, onDiscard, silenceMs, startMs, minimumVoicedMs, maxMs });
    this.playback = false; this.floor = 0.002; this.reset();
  }
  reset({ draining = false } = {}) { this.frames = null; this.pre = []; this.onset = 0; this.quiet = 0; this.voiced = 0; this.elapsed = 0; this.lastSpeech = null; this.draining = draining; }
  push(frame, now) {
    if (!(frame instanceof Float32Array) || frame.length !== 320 || !Number.isFinite(now)) return;
    const clean = frame.map(value => Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0);
    const rms = Math.sqrt(clean.reduce((sum, value) => sum + value * value, 0) / clean.length);
    const threshold = Math.max(this.playback ? 0.02 : 0.012, this.floor * 3.5);
    const voiced = rms >= threshold;
    if (this.draining) {
      // Never reinterpret the tail of an overlong utterance as a new question.
      this.quiet = voiced ? 0 : this.quiet + FRAME_MS;
      if (this.quiet >= this.silenceMs) this.reset();
      return;
    }
    if (!this.frames) {
      this.pre.push(clean); if (this.pre.length > 12) this.pre.shift();
      this.onset = voiced ? this.onset + FRAME_MS : 0;
      if (!voiced && !this.playback) this.floor = Math.max(0.0005, Math.min(0.009, this.floor * 0.97 + rms * 0.03));
      if (this.onset < this.startMs) return;
      this.frames = this.pre; this.pre = [];
      this.elapsed = this.frames.length * FRAME_MS; this.voiced = this.onset;
      this.started = now - this.onset; this.lastSpeech = now; this.quiet = 0;
      this.onStart({ speechStartMs: this.started });
      return;
    }
    this.frames.push(clean); this.elapsed += FRAME_MS;
    if (voiced) { this.voiced += FRAME_MS; this.quiet = 0; this.lastSpeech = now; }
    else this.quiet += FRAME_MS;
    if (this.elapsed >= this.maxMs) {
      const draining = this.quiet < this.silenceMs;
      this.reset({ draining });
      this.onDiscard('too-long');
      return;
    }
    if (this.quiet < this.silenceMs) return;
    const segment = { frames: this.frames, speechStartMs: this.started, speechEndMs: this.lastSpeech, limited: false };
    const keep = this.voiced >= this.minimumVoicedMs;
    this.reset();
    if (keep) this.onComplete(segment); else this.onDiscard();
  }
}

/** One explicit Start owns a microphone until Stop, hide or disconnect.
 * Audio stays on the local machine; only the resulting text goes to Cerebras.
 * The browser may decline echo cancellation. Report settings, never promise it.
 */
export class ContinuousVoiceController {
  constructor({ onSpeechStart = () => null, onTranscript = () => {}, onState = () => {}, onError = () => {}, transcribe, scope = globalThis, now = () => performance.now() } = {}) {
    Object.assign(this, { onSpeechStart, onTranscript, onState, onError, transcribe, scope, now });
    this.active = false; this.listening = false; this.streamSettings = {};
    this.epoch = 0; this.serial = 0; this.current = null; this.recognition = null;
    this.segmenter = new VoiceSegmenter({
      onStart: meta => this.begin(meta), onComplete: segment => void this.complete(segment),
      onDiscard: reason => {
        this.current = null; this.recognition?.abort(); this.recognition = null;
        this.status('listening', reason === 'too-long'
          ? 'That question reached the 20-second recording limit and was not sent. Pause, then repeat a shorter question. The microphone is still listening.'
          : 'Listening. Speak when you are ready.');
      },
    });
  }
  status(state, message) { this.onState({ state, message }); }
  setPlayback(value) { this.segmenter.playback = Boolean(value); }
  async start() {
    if (this.active) return true;
    const { navigator, AudioContext, webkitAudioContext, AudioWorkletNode } = this.scope;
    if (!navigator?.mediaDevices?.getUserMedia || !(AudioContext || webkitAudioContext) || !AudioWorkletNode) {
      this.onError({ code: 'microphone_unavailable', message: 'Continuous conversation needs microphone and AudioWorklet support. Open Lesson Lab in a recent Chrome browser, or keep using text.' }); return false;
    }
    this.active = true; const epoch = ++this.epoch;
    this.status('starting', 'Allow microphone access to start continuous conversation.');
    let stream, context;
    try {
      // Construct/resume in the user's click before awaiting microphone permission.
      context = new (AudioContext || webkitAudioContext)(); this.context = context;
      const resume = context.resume(); resume.catch(() => {});
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      await resume;
      if (!this.active || this.epoch !== epoch) { stream.getTracks().forEach(track => track.stop()); await context.close().catch(() => {}); return false; }
      this.stream = stream; this.streamSettings = stream.getAudioTracks()[0]?.getSettings?.() || {};
      await context.audioWorklet.addModule('/capture-worklet.js');
      if (!this.active || this.epoch !== epoch) return false;
      const source = context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(context, 'lesson-capture');
      const muted = context.createGain(); muted.gain.value = 0;
      this.source = source; this.node = node; this.muted = muted;
      source.connect(node); node.connect(muted); muted.connect(context.destination);
      node.port.onmessage = event => { if (this.active && this.epoch === epoch) this.segmenter.push(event.data, this.now()); };
      for (const track of stream.getAudioTracks()) track.addEventListener?.('ended', () => {
        if (this.active && this.epoch === epoch) { this.stop(); this.onError({ code: 'microphone_ended', message: 'The microphone disconnected. Reconnect it and start conversation again.' }); }
      });
      this.listening = true;
      this.status('listening', this.streamSettings.echoCancellation === true
        ? 'Listening continuously. You can interrupt while the tutor speaks.'
        : 'Listening continuously. Echo cancellation is not confirmed; use headphones to avoid hearing the tutor as a question.');
      return true;
    } catch (error) {
      if (stream) stream.getTracks().forEach(track => track.stop());
      if (this.epoch !== epoch) return false;
      this.stop();
      this.onError({ code: error?.name === 'NotAllowedError' ? 'microphone_denied' : 'microphone_failed', message: error?.name === 'NotAllowedError'
        ? 'Microphone access was denied. Allow it for this local page, then start conversation again.'
        : 'Continuous audio capture could not start. Try a recent Chrome browser; text and manual input remain available.' });
      return false;
    }
  }
  invalidate() {
    this.serial++; this.current = null; this.recognition?.abort(); this.recognition = null;
    // A view change must not turn a discarded utterance's tail into a question.
    this.segmenter.reset({ draining: this.active && this.segmenter.draining });
    if (this.active && this.listening) this.status('listening', 'Listening. Your next question uses the current page.');
  }
  stop() {
    this.active = false; this.listening = false; this.epoch++;
    this.invalidate(); this.segmenter.playback = false;
    if (this.node) { this.node.port.onmessage = null; this.node.disconnect(); }
    this.source?.disconnect(); this.muted?.disconnect();
    this.stream?.getTracks().forEach(track => track.stop());
    void this.context?.close().catch(() => {});
    this.node = null; this.source = null; this.muted = null; this.stream = null; this.context = null;
    this.status('off', 'Conversation off. Microphone released.');
  }
  begin(meta) {
    if (!this.active) return;
    this.recognition?.abort(); this.recognition = null;
    const current = { id: ++this.serial, epoch: this.epoch, ...meta };
    this.current = current;
    this.status('capturing', 'Listening to your question…');
    // Invoke immediately: the UI must stop playback before its first await.
    try { current.anchor = Promise.resolve(this.onSpeechStart({ utteranceId: current.id, ...meta })).catch(() => null); }
    catch { current.anchor = Promise.resolve(null); }
  }
  async complete(segment) {
    const current = this.current;
    if (!current || !this.active || current.finishing) return;
    current.finishing = true;
    const valid = () => this.active && this.current === current && this.epoch === current.epoch;
    const captured = await current.anchor;
    if (!valid()) return;
    if (!captured) { this.current = null; this.status('listening', 'The page changed while you began speaking. Please ask again in the current view.'); return; }
    const anchor = Object.freeze({ ...captured });
    const controller = new AbortController(); this.recognition = controller;
    this.status('transcribing', 'Transcribing on this computer…');
    try {
      const result = await this.transcribe({ wav: encodeWav(segment.frames), anchor, signal: controller.signal });
      if (!valid() || controller.signal.aborted) return;
      this.current = null; this.recognition = null;
      const text = typeof result?.text === 'string' ? result.text.trim() : '';
      if (!text) { this.status('listening', 'No clear speech recognized. Listening for your next question.'); return; }
      this.status('listening', 'Question sent. Keep talking to interrupt.');
      this.onTranscript({ text, anchor, utteranceId: current.id, metrics: { speechStartMs: segment.speechStartMs, speechEndMs: segment.speechEndMs, transcriptReadyMs: this.now(), transcriptionMs: result.metrics?.transcriptionMs ?? null } });
    } catch (error) {
      if (!valid() || controller.signal.aborted) return;
      this.current = null; this.recognition = null;
      this.status('listening', 'Listening. The previous question was not submitted.');
      this.onError({ code: 'transcription_failed', message: error?.message || 'Local transcription failed. Please try again or type your question.' });
    }
  }
  destroy() { this.stop(); }
}
