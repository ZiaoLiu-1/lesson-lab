#!/usr/bin/env node
// Project-local, pinned speech dependencies. No global install, microphone, or API key.
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, open, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(project, '.local', 'speech');
const version = '1.9.4';
const source = path.join(root, `whisper.cpp-${version}`);
const model = path.join(root, 'models', 'ggml-tiny.en.bin');
const cli = path.join(source, 'build', 'bin', 'whisper-cli');
const modelRevision = '5359861c739e955e79d9a303bcbc70fb988958b1';
const modelHash = '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f';
const modelBytes = 77704715;
const sourceHash = '57e280cee375ab02425b806ad5146b99f6eb9357e3c2b31357c8a6af2e2e44ae';
const cmakeVersion = '4.1.2';
const cmakeHash = '415396a7320856c64bd27ca00950b2bbb161604bff60ae5ebf256e2ca08b81ab';
const cmakeBytes = 49242707;
const cmakeRoot = path.join(root, `cmake-${cmakeVersion}`);
const cmake = path.join(cmakeRoot, 'cmake', 'data', 'bin', 'cmake');
const stableCli = path.join(root, 'bin', 'whisper-cli');

async function exists(file) { try { await access(file); return true; } catch { return false; } }
async function executable(file) { try { await access(file, constants.X_OK); return (await stat(file)).isFile(); } catch { return false; } }
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function checked(file, expected, bytes) {
  if (!await exists(file)) return false;
  if ((bytes && (await stat(file)).size !== bytes) || await sha256(file) !== expected)
    throw new Error(`Existing file did not match the pinned artifact; left untouched: ${file}`);
  return true;
}
async function stableLink(target, link) {
  await mkdir(path.dirname(link), { recursive: true, mode: 0o700 });
  const relative = path.relative(path.dirname(link), target);
  try {
    const item = await lstat(link);
    if (!item.isSymbolicLink() || await readlink(link) !== relative)
      throw new Error(`An existing runtime link differs; left untouched: ${link}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await symlink(relative, link);
  }
}
async function download(url, file, expected, bytes, maxBytes = 200 * 1024 * 1024) {
  if (await checked(file, expected, bytes)) return;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.part`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);
  let output;
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`Artifact download failed (HTTP ${response.status}).`);
    output = await open(temporary, 'wx', 0o600);
    let size = 0;
    const hash = createHash('sha256');
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes || (bytes && size > bytes)) throw new Error('Artifact exceeded its byte limit.');
      hash.update(chunk);
      await output.writeFile(chunk);
    }
    if ((bytes && size !== bytes) || hash.digest('hex') !== expected) throw new Error('Artifact hash or size mismatch.');
    await output.sync(); await output.close(); output = null;
    // Do not replace a file created by another setup process.
    if (await exists(file)) throw new Error(`Destination appeared during download: ${file}`);
    await rename(temporary, file);
  } finally {
    clearTimeout(timer); controller.abort();
    await output?.close(); await rm(temporary, { force: true });
  }
}
async function run(command, args, { cwd = root, timeoutMs = 600000 } = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: false });
    let expired = false;
    const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      code === 0 && !expired ? resolve() : reject(new Error(expired ? 'Local setup command timed out.' : `Local setup command failed (${code}).`));
    });
  });
}
async function install() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('This pinned setup supports Apple Silicon macOS only. Configure another local Whisper runtime explicitly.');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lockPath = path.join(root, '.setup.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch(() => { throw new Error('Local voice setup is already running, or its lock needs inspection.'); });
  try {
    if (!await exists(cmake)) {
      console.log(`Preparing project-local CMake ${cmakeVersion} (no global install).`);
      const metadata = await fetch(`https://pypi.org/pypi/cmake/${cmakeVersion}/json`, { signal: AbortSignal.timeout(20000) }).then(r => {
        if (!r.ok) throw new Error('Could not read official CMake package metadata.'); return r.json();
      });
      const wheel = metadata.urls.find(item => item.filename === `cmake-${cmakeVersion}-py3-none-macosx_10_10_universal2.whl`);
      if (!wheel || wheel.digests?.sha256 !== cmakeHash || wheel.size !== cmakeBytes || !wheel.url.startsWith('https://files.pythonhosted.org/'))
        throw new Error('Official CMake package metadata differs from the pinned artifact.');
      const archive = path.join(root, 'downloads', `cmake-${cmakeVersion}.whl`);
      await download(wheel.url, archive, cmakeHash, cmakeBytes);
      const stage = await mkdtemp(path.join(root, '.cmake-'));
      try {
        await run('/usr/bin/unzip', ['-q', archive, '-d', stage], { timeoutMs: 60000 });
        if (await exists(cmakeRoot)) throw new Error('An incomplete CMake directory exists; left untouched.');
        await rename(stage, cmakeRoot);
      } finally { await rm(stage, { recursive: true, force: true }); }
    }
    if (!await exists(source)) {
      console.log(`Downloading pinned whisper.cpp v${version} source.`);
      const archive = path.join(root, 'downloads', `whisper.cpp-v${version}.tar.gz`);
      await download(`https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v${version}.tar.gz`, archive, sourceHash);
      const stage = await mkdtemp(path.join(root, '.source-'));
      try {
        await run('/usr/bin/tar', ['-xzf', archive, '-C', stage], { timeoutMs: 60000 });
        await rename(path.join(stage, `whisper.cpp-${version}`), source);
      } finally { await rm(stage, { recursive: true, force: true }); }
    }
    // The app uses short CPU CLI jobs; no resident speech service is required.
    console.log('Building local whisper-cli. The app uses --no-gpu for predictable startup.');
    await run(cmake, ['-S', source, '-B', path.join(source, 'build'), '-DCMAKE_BUILD_TYPE=Release', '-DWHISPER_BUILD_IS_DEV=OFF', '-DWHISPER_BUILD_EXAMPLES=ON', '-DWHISPER_BUILD_SERVER=OFF', '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_SDL2=OFF', '-DGGML_METAL=ON']);
    await run(cmake, ['--build', path.join(source, 'build'), '--config', 'Release', '--target', 'whisper-cli', '-j', '4']);
    console.log('Downloading and checking the pinned English tiny model.');
    await download(`https://huggingface.co/ggerganov/whisper.cpp/resolve/${modelRevision}/ggml-tiny.en.bin`, model, modelHash, modelBytes);
    await stableLink(cli, stableCli);
    const manifest = {
      format: 'lesson-lab-local-voice', version: 1, runtimeVersion: version,
      sourceSha256: sourceHash, cli, stableCli, model, modelRepoRevision: modelRevision,
      modelSha256: modelHash, modelBytes, setupAt: new Date().toISOString(),
      sourceUrl: `https://github.com/ggml-org/whisper.cpp/releases/tag/v${version}`,
      modelMetadataUrl: `https://huggingface.co/api/models/ggerganov/whisper.cpp/revision/${modelRevision}?blobs=true`,
      note: 'Installed dependencies only; not a real microphone or end-to-end voice test.'
    };
    const manifestPath = path.join(root, 'runtime.json');
    if (!await exists(manifestPath)) await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(manifest, null, 2));
  } finally { await lock.close(); await rm(lockPath, { force: true }); }
}
async function check() {
  const result = { cli: stableCli, cliAvailable: await executable(stableCli), model, modelValid: await checked(model, modelHash, modelBytes) };
  console.log(JSON.stringify(result, null, 2));
  if (!result.cliAvailable || !result.modelValid) {
    console.log('Run node scripts/setup-local-voice.js --install to download pinned dependencies into .local/speech. No global packages or microphone are used.');
    process.exitCode = 1;
  }
}
const args = process.argv.slice(2);
if (args.length > 1 || (args.length && !['--install', '--check'].includes(args[0]))) {
  console.error('Usage: node scripts/setup-local-voice.js [--check | --install]'); process.exitCode = 1;
} else {
  try { if (args[0] === '--install') await install(); else await check(); }
  catch (error) { console.error(`Local voice setup failed: ${error.message}`); process.exitCode = 1; }
}
