// Browser speech only. Importing this module never reads window or opens a microphone.
const noop = () => {};
const messages = {
  unsupported: 'Speech recognition is unavailable here. Use OS dictation or type your question.',
  'not-allowed': 'Microphone access was denied. Allow it in browser settings, or use OS dictation or text.',
  'service-not-allowed': 'This browser cannot use its recognition service. Use OS dictation or text.',
  'audio-capture': 'No working microphone was found. Check your input device, or type your question.',
  network: 'The browser speech service could not connect. Check your connection, or use OS dictation or text.',
  'no-speech': 'No speech was recognized. Try again, use OS dictation, or type your question.',
  aborted: 'Speech input was interrupted. Select the microphone to try again.',
  'language-not-supported': 'English recognition is unavailable in this browser. Use OS dictation or text.',
  'recognition-timeout': 'Speech input timed out. The microphone has been stopped; try again or type your question.',
  'recognition-failed': 'Speech input could not start or finish. Try again, use OS dictation, or type your question.',
  'invalid-anchor': 'The current page selection could not be captured. Select a section and try again.',
  'user-gesture-required': 'Select the microphone button to start speech input.',
  'synthesis-unsupported': 'Speech playback is unavailable in this browser. The answer remains available as text.',
  'no-local-voice': 'No local English voice is available yet. Enable an English system voice and try again; text is ready.',
  'invalid-voice': 'Choose an available local English voice. Remote voices are not used.',
  'selected-voice-unavailable': 'The selected local English voice is no longer available. Choose another local voice and try again.',
  'empty-speech': 'There is no text to read aloud.',
  'speech-timeout': 'Local speech did not start. Select Read aloud to retry, or read the answer as text.',
  'speech-no-start': 'Speech ended before playback started. The answer remains available as text.',
  'speech-failed': 'Local speech playback failed. The answer remains available as text.',
};

function immutableAnchor(value, seen = new Set()) {
  if (value === null || ['string', 'boolean', 'undefined'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || seen.has(value)) throw new TypeError('Anchor must be plain data');
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError('Anchor must be plain data');
  }
  seen.add(value);
  const entries = Object.entries(value).map(([key, item]) => [key, immutableAnchor(item, seen)]);
  seen.delete(value);
  return Object.freeze(Array.isArray(value) ? entries.map(([, item]) => item) : Object.fromEntries(entries));
}

/**
 * onState({state,message,capabilities}), onError({code,message,source}),
 * onTranscript({text,anchor}), onInterrupt(). Call start only from a user gesture.
 * `scope` supplies browser globals; `timers` supplies setTimeout/clearTimeout for tests.
 * One controller owns the page's speech queue. See ../VOICE.md for integration rules.
 */
export class VoiceController {
  constructor({ onTranscript = noop, onState = noop, onError = noop, onInterrupt = noop,
    scope = globalThis, timers = globalThis, timeouts = {} } = {}) {
    this._scope = scope;
    this._timers = timers;
    this._timeouts = { start: 15000, stop: 5000, recognition: 90000, speechStart: 10000, ...timeouts };
    this._callbacks = { onTranscript, onState, onError, onInterrupt };
    this._recognition = null;
    this._speech = null;
    this._voiceURI = null;
    this._epoch = 0;
    this._destroyed = false;
    this.state = 'idle';
    this.message = 'Microphone off. Select the microphone when you are ready.';
    this._voicesChanged = () => {
      if (!this._destroyed) this._setState(this.state, this.message);
    };
    this._scope.speechSynthesis?.addEventListener?.('voiceschanged', this._voicesChanged);
  }

  _recognitionClass() { return this._scope.SpeechRecognition || this._scope.webkitSpeechRecognition; }

  _localVoices() {
    try {
      return Array.from(this._scope.speechSynthesis?.getVoices?.() || [])
        .filter(voice => voice.localService === true && /^en(?:[-_]|$)/i.test(voice.lang || ''));
    } catch { return []; }
  }

  capabilities() {
    const synth = this._scope.speechSynthesis;
    return {
      recognition: typeof this._recognitionClass() === 'function',
      synthesis: typeof this._scope.SpeechSynthesisUtterance === 'function'
        && typeof synth?.speak === 'function' && typeof synth?.cancel === 'function',
      localVoices: this._localVoices().map(({ name, lang, voiceURI }) => ({ name, lang, voiceURI })),
    };
  }

  // Select a voice for subsequent utterances; ''/null restore automatic local selection.
  // A successful change emits no state callback and does not start or restart audio.
  setVoice(voiceURI) {
    if (this._destroyed) return false;
    if (voiceURI === '' || voiceURI === null) {
      this._voiceURI = null;
      return true;
    }
    if (typeof voiceURI !== 'string' || !voiceURI
      || !this._localVoices().some(voice => voice.voiceURI === voiceURI)) {
      this._report('invalid-voice', 'synthesis');
      return false;
    }
    this._voiceURI = voiceURI;
    return true;
  }

  _setState(state, message) {
    this.state = state;
    this.message = message;
    this._callbacks.onState({ state, message, capabilities: this.capabilities() });
  }

  _report(code, source, callback = noop) {
    const error = { code, source, message: messages[code] || messages[source === 'recognition' ? 'recognition-failed' : 'speech-failed'] };
    this._setState(code === 'unsupported' ? 'unsupported' : code === 'aborted' ? 'idle' : 'error', error.message);
    this._callbacks.onError(error);
    callback(error);
  }

  _later(session, name, delay, callback) {
    this._clearTimer(session, name);
    session.timers[name] = this._timers.setTimeout(callback, delay);
    session.timers[name]?.unref?.();
  }

  _clearTimer(session, name) {
    if (session.timers[name] !== undefined) this._timers.clearTimeout(session.timers[name]);
    delete session.timers[name];
  }

  _clearTimers(session) {
    for (const name of Object.keys(session.timers)) this._clearTimer(session, name);
  }

  _releaseRecognition(session, abort = true) {
    if (this._recognition !== session) return;
    this._recognition = null; // Invalidate before abort(), which may synchronously dispatch events.
    this._clearTimers(session);
    if (abort) {
      try {
        if (typeof session.api.abort === 'function') session.api.abort();
        else session.api.stop();
      } catch { /* The browser may already have closed its microphone. */ }
    }
  }

  _failRecognition(session, code) {
    if (this._recognition !== session) return;
    this._releaseRecognition(session);
    this._report(code, 'recognition');
  }

  _releaseSpeech(session, cancel = true) {
    if (this._speech !== session) return;
    this._speech = null;
    this._clearTimers(session);
    if (cancel) {
      try { this._scope.speechSynthesis.cancel(); } catch { /* Best effort browser cleanup. */ }
    }
  }

  _clearAll() {
    ++this._epoch;
    if (this._recognition) this._releaseRecognition(this._recognition);
    if (this._speech) this._releaseSpeech(this._speech);
  }

  start(anchor) {
    if (this._destroyed) return false;
    let captured;
    try { captured = immutableAnchor(anchor); }
    catch { this._report('invalid-anchor', 'recognition'); return false; }
    this._clearAll();
    this._callbacks.onInterrupt();
    const Recognition = this._recognitionClass();
    if (typeof Recognition !== 'function') {
      this._report('unsupported', 'recognition');
      return false;
    }
    if (this._scope.navigator?.userActivation?.isActive === false) {
      this._report('user-gesture-required', 'recognition');
      return false;
    }
    let api;
    try { api = new Recognition(); }
    catch { this._report('recognition-failed', 'recognition'); return false; }
    const session = { api, anchor: captured, epoch: this._epoch, timers: {}, started: false, stopRequested: false, stopSent: false };
    this._recognition = session;
    api.lang = 'en-US';
    api.continuous = false;
    api.interimResults = false;
    api.maxAlternatives = 1;
    api.onstart = () => {
      if (this._recognition !== session || session.started) return;
      session.started = true;
      this._clearTimer(session, 'start');
      if (session.stopRequested) this._stopRecognition(session);
      else this._setState('listening', 'Listening. Speak your question, then select Stop when finished.');
    };
    api.onresult = event => {
      if (this._recognition !== session) return;
      const finalText = [];
      for (let i = event.resultIndex || 0; i < (event.results?.length || 0); ++i) {
        if (event.results[i]?.isFinal && typeof event.results[i][0]?.transcript === 'string') {
          finalText.push(event.results[i][0].transcript.trim());
        }
      }
      const text = finalText.filter(Boolean).join(' ');
      if (!text) return;
      this._releaseRecognition(session);
      this._setState('transcribed', 'Question transcribed. Microphone off.');
      if (this._epoch === session.epoch) this._callbacks.onTranscript({ text, anchor: session.anchor });
    };
    api.onerror = event => this._failRecognition(session, event.error || 'recognition-failed');
    api.onnomatch = () => this._failRecognition(session, 'no-speech');
    api.onend = () => {
      if (this._recognition !== session) return;
      this._releaseRecognition(session, false);
      this._report('no-speech', 'recognition');
    };
    this._later(session, 'start', this._timeouts.start, () => this._failRecognition(session, 'recognition-timeout'));
    this._later(session, 'maximum', this._timeouts.recognition, () => this._failRecognition(session, 'recognition-timeout'));
    this._setState('starting', 'Starting microphone. Browser recognition may send audio to its speech service.');
    if (this._recognition !== session) return false;
    try { api.start(); }
    catch (error) {
      this._failRecognition(session, error.name === 'NotAllowedError' ? 'not-allowed' : 'recognition-failed');
      return false;
    }
    return this._recognition === session;
  }

  _stopRecognition(session) {
    if (this._recognition !== session || session.stopSent) return;
    try {
      session.stopSent = true;
      session.api.stop();
    } catch (error) {
      session.stopSent = false;
      // Some engines reject stop while permission/startup is pending. Retry once onstart fires.
      if (!(error.name === 'InvalidStateError' && !session.started)) this._failRecognition(session, 'recognition-failed');
    }
  }

  stop() {
    const session = this._recognition;
    if (!session || session.stopRequested) return false;
    session.stopRequested = true;
    this._later(session, 'stop', this._timeouts.stop, () => this._failRecognition(session, 'recognition-timeout'));
    this._setState('stopping', 'Finishing speech input. Waiting for the final transcript…');
    this._stopRecognition(session);
    return true;
  }

  cancel() {
    this._clearAll();
    if (!this._destroyed) this._setState('idle', 'Microphone and speech off.');
  }

  speak(text, { onStart = noop, onEnd = noop, onError = noop } = {}) {
    if (this._destroyed) return noop;
    this._clearAll();
    if (!this.capabilities().synthesis) {
      this._report('synthesis-unsupported', 'synthesis', onError);
      return noop;
    }
    if (typeof text !== 'string' || !text.trim()) {
      this._report('empty-speech', 'synthesis', onError);
      return noop;
    }
    const voices = this._localVoices();
    const selected = this._voiceURI ? voices.find(v => v.voiceURI === this._voiceURI) : null;
    if (this._voiceURI && !selected) {
      this._report('selected-voice-unavailable', 'synthesis', onError);
      return noop;
    }
    const voice = selected || voices.find(v => v.default)
      || voices.find(v => /\bSamantha\b/i.test(v.name || ''))
      || voices.find(v => /\bAlex\b/i.test(v.name || ''))
      || voices.find(v => /^en-US$/i.test(v.lang)) || voices[0];
    if (!voice) {
      this._report('no-local-voice', 'synthesis', onError);
      return noop;
    }
    let utterance;
    try { utterance = new this._scope.SpeechSynthesisUtterance(text.trim()); }
    catch { this._report('speech-failed', 'synthesis', onError); return noop; }
    utterance.voice = voice; // Always an explicit localService === true English voice.
    utterance.lang = voice.lang;
    const session = { utterance, timers: {}, started: false };
    this._speech = session;
    const fail = code => {
      if (this._speech !== session) return;
      this._releaseSpeech(session);
      this._report(code, 'synthesis', onError);
    };
    utterance.onstart = () => {
      if (this._speech !== session || session.started) return;
      session.started = true;
      this._clearTimer(session, 'start');
      this._setState('speaking', `Reading aloud with ${voice.name}, a local English voice.`);
      if (this._speech === session) onStart();
    };
    utterance.onend = () => {
      if (this._speech !== session) return;
      if (!session.started) { fail('speech-no-start'); return; }
      this._releaseSpeech(session, false);
      this._setState('idle', 'Finished reading. Microphone off.');
      onEnd();
    };
    utterance.onerror = () => fail('speech-failed');
    this._later(session, 'start', this._timeouts.speechStart, () => fail('speech-timeout'));
    this._setState('speech-queued', `Preparing local speech with ${voice.name}.`);
    if (this._speech === session) {
      try { this._scope.speechSynthesis.speak(utterance); }
      catch { fail('speech-failed'); }
    }
    return () => {
      if (this._speech !== session) return;
      this._releaseSpeech(session);
      this._setState('idle', 'Speech stopped. Microphone off.');
    };
  }

  destroy() {
    this.cancel();
    this._destroyed = true;
    this._scope.speechSynthesis?.removeEventListener?.('voiceschanged', this._voicesChanged);
  }
}

export default VoiceController;
