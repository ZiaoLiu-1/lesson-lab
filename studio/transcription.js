import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const MIN_SAMPLES = 3200, MAX_SAMPLES = 320000;
const MAX_WAV_BYTES = 44 + MAX_SAMPLES * 2;
const messages = {
  transcription_unavailable: [503, 'Local Whisper is unavailable. Install its executable and English model, then restart the study server.'],
  transcription_invalid_audio: [400, 'Send a 0.2 to 20 second, 16 kHz mono PCM16 WAV recording.'],
  transcription_busy: [409, 'Local transcription is already running. Wait for cancellation or completion before trying again.'],
  transcription_cancelled: [409, 'Local transcription was cancelled.'],
  transcription_timeout: [504, 'Local transcription timed out. Try a shorter question.'],
  transcription_failed: [503, 'Local transcription failed. Your lesson was not changed.'],
  transcription_invalid_output: [503, 'Local transcription did not return a usable short transcript. Try again or type your question.'],
};
export class LocalTranscriptionError extends Error {
  constructor(code) {
    const safe = Object.hasOwn(messages, code) ? code : 'transcription_failed';
    super(messages[safe][1]); this.name = 'LocalTranscriptionError'; this.code = safe; this.status = messages[safe][0];
  }
}
function validateWav(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 + MIN_SAMPLES * 2 || bytes.length > MAX_WAV_BYTES
    || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.readUInt32LE(4) !== bytes.length - 8
    || bytes.toString('ascii', 8, 16) !== 'WAVEfmt ' || bytes.readUInt32LE(16) !== 16
    || bytes.readUInt16LE(20) !== 1 || bytes.readUInt16LE(22) !== 1 || bytes.readUInt32LE(24) !== 16000
    || bytes.readUInt32LE(28) !== 32000 || bytes.readUInt16LE(32) !== 2 || bytes.readUInt16LE(34) !== 16
    || bytes.toString('ascii', 36, 40) !== 'data' || bytes.readUInt32LE(40) !== bytes.length - 44
    || (bytes.length - 44) % 2 !== 0) throw new LocalTranscriptionError('transcription_invalid_audio');
  return bytes;
}
export function decodeTranscriptionAudio(audio) {
  if (typeof audio !== 'string' || !audio.length || audio.length > Math.ceil(MAX_WAV_BYTES / 3) * 4
    || audio.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(audio)) {
    throw new LocalTranscriptionError('transcription_invalid_audio');
  }
  const bytes = Buffer.from(audio, 'base64');
  if (bytes.toString('base64') !== audio) throw new LocalTranscriptionError('transcription_invalid_audio');
  return validateWav(bytes);
}
function defaultBinary() {
  if (process.env.LESSON_LAB_WHISPER_BIN) return process.env.LESSON_LAB_WHISPER_BIN;
  const choices = [path.join(projectRoot, '.local/speech/bin/whisper-cli'), '/opt/homebrew/bin/whisper-cli', '/opt/homebrew/bin/whisper-cpp'];
  return choices.find(file => existsSync(file)) || choices[0];
}
function filesAvailable(binPath, modelPath) {
  try {
    accessSync(binPath, constants.X_OK); accessSync(modelPath, constants.R_OK);
    return statSync(binPath).isFile() && statSync(modelPath).isFile() && statSync(modelPath).size > 0;
  } catch { return false; }
}

/** One bounded local process. Paths/options are server configuration, never HTTP inputs. */
export function createLocalTranscription({
  binPath = defaultBinary(), modelPath = process.env.LESSON_LAB_WHISPER_MODEL || path.join(projectRoot, '.local/speech/models/ggml-tiny.en.bin'),
  enabled = true, spawnImpl = spawn, tempRoot = os.tmpdir(), timeoutMs = 15000,
} = {}) {
  const available = Boolean(enabled && (spawnImpl !== spawn || filesAvailable(binPath, modelPath)));
  const deadlineMs = Math.min(15000, Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : 15000);
  let active = null;
  const release = job => { if (active === job && job.finished && (!job.child || job.processDone)) active = null; };
  function stop(job, code) {
    if (job.failure) return;
    job.failure = new LocalTranscriptionError(code);
    if (job.child && !job.processDone) { try { job.child.kill('SIGKILL'); } catch {} }
    job.rejectRun?.(job.failure);
  }
  async function transcribe(audio, { signal } = {}) {
    if (!available) throw new LocalTranscriptionError('transcription_unavailable');
    validateWav(audio);
    if (signal?.aborted) throw new LocalTranscriptionError('transcription_cancelled');
    if (active) throw new LocalTranscriptionError('transcription_busy');
    const started = performance.now();
    const job = { child: null, processDone: false, finished: false, failure: null, rejectRun: null };
    active = job;
    let directory, transcript;
    const abort = () => stop(job, 'transcription_cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(job, 'transcription_timeout'), deadlineMs);
    try {
      directory = await mkdtemp(path.join(tempRoot, 'lesson-lab-transcription-')); await chmod(directory, 0o700);
      const input = path.join(directory, 'input.wav'), output = path.join(directory, 'transcript');
      await writeFile(input, audio, { mode: 0o600 });
      // The CLI truncates this pre-created private file and retains its mode.
      await writeFile(output + '.json', '', { mode: 0o600 });
      if (job.failure) throw job.failure;
      await new Promise((resolve, reject) => {
        job.rejectRun = reject;
        // Official whisper.cpp CLI: -oj writes transcription[].text to <prefix>.json.
        // stdout/stderr are deliberately discarded, including model paths and diagnostics.
        const child = spawnImpl(binPath, ['--model', modelPath, '--file', input, '--language', 'en',
          '--threads', '4', '--no-gpu', '--output-json', '--output-file', output, '--no-prints', '--no-timestamps'],
        { shell: false, stdio: ['ignore', 'ignore', 'ignore'] });
        job.child = child;
        child.once('error', () => { job.processDone = true; reject(job.failure || new LocalTranscriptionError('transcription_failed')); release(job); });
        child.once('close', code => {
          job.processDone = true;
          if (job.failure) reject(job.failure);
          else if (code === 0) resolve();
          else reject(new LocalTranscriptionError('transcription_failed'));
          release(job);
        });
      });
      if (job.failure) throw job.failure;
      const info = await stat(output + '.json');
      if (info.size < 2 || info.size > 256000) throw new LocalTranscriptionError('transcription_invalid_output');
      let result;
      try { result = JSON.parse(await readFile(output + '.json', 'utf8')); }
      catch { throw new LocalTranscriptionError('transcription_invalid_output'); }
      if (!Array.isArray(result?.transcription) || result.transcription.length > 200
        || result.transcription.some(segment => typeof segment?.text !== 'string' || segment.text.length > 2000)) {
        throw new LocalTranscriptionError('transcription_invalid_output');
      }
      transcript = result.transcription.map(segment => segment.text).join('').replace(/\s+/g, ' ').trim();
      if (transcript.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(transcript)) {
        throw new LocalTranscriptionError('transcription_invalid_output');
      }
      if (job.failure) throw job.failure;
    } catch (error) {
      throw job.failure || (error instanceof LocalTranscriptionError ? error : new LocalTranscriptionError('transcription_failed'));
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      try { if (directory) await rm(directory, { recursive: true, force: true }); }
      catch { throw new LocalTranscriptionError('transcription_failed'); }
      finally { job.finished = true; release(job); }
    }
    return { text: transcript, metrics: { transcriptionMs: +(performance.now() - started).toFixed(2) } };
  }
  return { available, engine: 'localWhisper', transcribe, cancel() { if (active) stop(active, 'transcription_cancelled'); } };
}
