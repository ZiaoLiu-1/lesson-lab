import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const errors = {
  speech_unavailable: [503, 'Local audio generation is unavailable on this computer. Use browser speech or read the text.'],
  speech_invalid_text: [400, 'Speech text must contain between 1 and 2600 characters.'],
  speech_busy: [409, 'Local audio generation is already running. Cancel it or wait before trying again.'],
  speech_cancelled: [409, 'Local audio generation was cancelled.'],
  speech_timeout: [504, 'Local audio generation timed out. The answer remains available as text.'],
  speech_failed: [503, 'Local audio generation failed. The answer remains available as text.'],
  speech_invalid_audio: [503, 'Local speech did not produce a usable WAV file. The answer remains available as text.'],
};

export class LocalSpeechError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(errors, code) ? code : 'speech_failed';
    super(errors[safeCode][1]);
    this.name = 'LocalSpeechError';
    this.code = safeCode;
    this.status = errors[safeCode][0];
  }
}

function validWav(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF'
    || buffer.toString('ascii', 8, 12) !== 'WAVE'
    || buffer.readUInt32LE(4) + 8 !== buffer.length) return false;
  let format = false; let data = false;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const tag = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (size > buffer.length - start) return false;
    if (tag === 'fmt ') {
      if (size < 16) return false;
      format = buffer.readUInt16LE(start) === 1 && buffer.readUInt16LE(start + 2) === 1
        && buffer.readUInt32LE(start + 4) === 22050 && buffer.readUInt16LE(start + 14) === 16;
    }
    if (tag === 'data') data = size > 0 && size % 2 === 0;
    offset = start + size + (size % 2);
  }
  return format && data;
}

/**
 * macOS-only file synthesis, never host playback. The caller must authorize text.
 * synthesize(text, {signal}) returns an audio/wav Buffer after deleting temporary files.
 * All options are server/test configuration, never request-controlled paths or commands.
 * A cancelled process retains the single-job lock until its close event arrives.
 */
export function createLocalSpeech({
  enabled = process.platform === 'darwin', spawnImpl = spawn, tempRoot = os.tmpdir(), timeoutMs = 20000,
} = {}) {
  const available = Boolean(enabled && (spawnImpl !== spawn || existsSync('/usr/bin/say')));
  const deadlineMs = Math.min(20000, Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : 20000);
  let active = null;
  const release = job => {
    if (active === job && job.finished && (!job.child || job.processDone)) active = null;
  };
  const stop = (job, code) => {
    if (job.failure) return;
    job.failure = new LocalSpeechError(code);
    if (job.child && !job.processDone) {
      try { job.child.kill('SIGKILL'); } catch { /* Keep failure sanitized and the process lock held. */ }
    }
    job.rejectRun?.(job.failure);
  };

  async function synthesize(text, { signal } = {}) {
    if (!available) throw new LocalSpeechError('speech_unavailable');
    if (typeof text !== 'string' || !text.trim() || text.length > 2600 || text.includes('\0')) {
      throw new LocalSpeechError('speech_invalid_text');
    }
    if (signal?.aborted) throw new LocalSpeechError('speech_cancelled');
    if (active) throw new LocalSpeechError('speech_busy');
    const job = { child: null, processDone: false, finished: false, failure: null, rejectRun: null };
    active = job;
    let directory;
    const abort = () => stop(job, 'speech_cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(job, 'speech_timeout'), deadlineMs);
    try {
      directory = await mkdtemp(path.join(tempRoot, 'lesson-lab-speech-'));
      await chmod(directory, 0o700);
      if (job.failure) throw job.failure;
      const file = path.join(directory, 'speech.wav');
      await new Promise((resolve, reject) => {
        job.rejectRun = reject;
        // Fixed executable/voice/format. Text is stdin data, never shell or argv code.
        const child = spawnImpl('/usr/bin/say', [
          '-v', 'Samantha', '-o', file, '--file-format=WAVE', '--data-format=LEI16@22050', '--channels=1', '-f', '-',
        ], { shell: false, stdio: ['pipe', 'ignore', 'ignore'] });
        job.child = child;
        child.once('error', () => {
          job.processDone = true;
          reject(job.failure || new LocalSpeechError('speech_failed'));
          release(job);
        });
        child.once('close', code => {
          job.processDone = true;
          if (job.failure) reject(job.failure);
          else if (code === 0) resolve();
          else reject(new LocalSpeechError('speech_failed'));
          release(job);
        });
        child.stdin.on('error', () => stop(job, 'speech_failed'));
        try { child.stdin.end(text); } catch { stop(job, 'speech_failed'); }
      });
      if (job.failure) throw job.failure;
      const info = await stat(file);
      if (info.size > 16 * 1024 * 1024) throw new LocalSpeechError('speech_invalid_audio');
      const buffer = await readFile(file);
      if (job.failure) throw job.failure;
      if (!validWav(buffer)) throw new LocalSpeechError('speech_invalid_audio');
      return buffer;
    } catch (error) {
      throw job.failure || (error instanceof LocalSpeechError ? error : new LocalSpeechError('speech_failed'));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      try {
        if (directory) await rm(directory, { recursive: true, force: true });
      } catch {
        // Never return generated audio when private-file cleanup fails.
        throw new LocalSpeechError('speech_failed');
      } finally {
        job.finished = true;
        release(job);
      }
    }
  }

  return { available, synthesize, cancel() { if (active) stop(active, 'speech_cancelled'); } };
}
