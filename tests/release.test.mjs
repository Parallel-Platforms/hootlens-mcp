import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { assertPublishContext, assertUnpublished, FILES, publishManifest, verifySource, verifyStage, verifyTarball } from '../scripts/release.mjs';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('publication preserves package identity and omits all development and lifecycle fields', () => {
  const result = publishManifest({ ...manifest, scripts: { prepublishOnly: 'bad command' }, dependencies: { accidental: '*' }, token: 'synthetic_do_not_ship' });
  assert.equal(result.name, '@hootlens/mcp');
  assert.equal(result.version, manifest.version);
  assert.equal(result.mcpName, 'com.hootlens/mcp');
  assert.equal(result.private, false);
  assert.deepEqual(result.publishConfig, { access: 'public', provenance: true });
  for (const key of ['scripts', 'dependencies', 'devDependencies', 'workspaces', 'token']) assert.ok(!(key in result));
  for (const change of [
    { private: false }, { name: '@other/mcp' }, { mcpName: 'com.other/mcp' }, { version: '1.0.2-dev' }, { version: '01.0.2' },
    { repository: { type: 'git', url: 'git+https://github.com/Parallel-Platforms/hootlens.git' } },
    { bin: { 'hootlens-mcp': 'src/cli.ts' } }, { files: [...manifest.files, '.env.local'] },
    { bugs: { ...manifest.bugs, token: 'synthetic' } }, { engines: { node: '>=18' } },
  ]) assert.throws(() => publishManifest({ ...manifest, ...change }));
});

test('release preparation verifies the full recorded source and version identity', async () => {
  const verified = await verifySource();
  assert.equal(verified.stagedManifest.version, verified.snapshot.version);
  assert.equal(verified.snapshot.sourceCommit, '3431912d0c5c39f6eaa6f0f314627a9957a34c13');
});

test('changed, extra and wrong-version source cannot prepare a release', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hootlens-release-source-test-'));
  const snapshot = JSON.parse(await readFile(new URL('../docs/SOURCE.json', import.meta.url), 'utf8'));
  try {
    for (const file of [...Object.keys(snapshot.files), 'docs/SOURCE.json', 'package.json', 'package-lock.json']) {
      await mkdir(dirname(join(directory, file)), { recursive: true });
      await writeFile(join(directory, file), await readFile(new URL(`../${file}`, import.meta.url)));
    }
    await verifySource(directory);
    const original = await readFile(join(directory, 'src/api.ts'));
    await writeFile(join(directory, 'src/api.ts'), 'changed source');
    await assert.rejects(verifySource(directory), /Source snapshot mismatch/);
    await writeFile(join(directory, 'src/api.ts'), original);
    await writeFile(join(directory, 'src/unrecorded.ts'), 'export const unexpected = true;');
    await assert.rejects(verifySource(directory), /Snapshot must cover/);
    await rm(join(directory, 'src/unrecorded.ts'));
    const server = JSON.parse(await readFile(join(directory, 'server.json'), 'utf8'));
    await writeFile(join(directory, 'server.json'), JSON.stringify({ ...server, version: '9.9.9' }));
    await assert.rejects(verifySource(directory));
  } finally {
    assert.ok(directory.startsWith(join(tmpdir(), 'hootlens-release-source-test-')));
    await rm(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const staged = publishManifest(manifest);
  const contents = Object.fromEntries(FILES.map(file => [file, Buffer.from(file === 'package.json' ? JSON.stringify(staged) : `synthetic ${file}\n`)]));
  const receipt = { manifest: staged, sha256: Object.fromEntries(FILES.map(file => [file, hash(contents[file])])) };
  return { contents, receipt };
}

function tar(entries) {
  const chunks = [];
  for (const { name, contents, type = '0' } of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${contents.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.fill(32, 148, 156);
    header.write(type, 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
    chunks.push(header, contents, Buffer.alloc((512 - contents.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

test('packed bytes reject extra files, path traversal, symlinks, duplicates, changed content and manifest', () => {
  const { contents, receipt } = fixture();
  const entries = FILES.map(file => ({ name: `package/${file}`, contents: contents[file] }));
  verifyTarball(tar(entries), receipt);
  for (const bad of [
    [...entries, { name: 'package/.env.local', contents: Buffer.from('synthetic') }],
    [...entries, { name: 'package/../leak', contents: Buffer.from('synthetic') }],
    entries.slice(1), [...entries, entries[0]],
    entries.map((entry, index) => index === 0 ? { ...entry, type: '2' } : entry),
    entries.map((entry, index) => index === 0 ? { ...entry, contents: Buffer.from('changed') } : entry),
    entries.map(entry => entry.name === 'package/package.json' ? { ...entry, contents: Buffer.from(JSON.stringify({ ...receipt.manifest, version: '9.9.9' })) } : entry),
  ]) assert.throws(() => verifyTarball(tar(bad), receipt));
  assert.throws(() => verifyTarball(Buffer.from('not gzip'), receipt));
  const raw = gunzipSync(tar(entries));
  assert.throws(() => verifyTarball(gzipSync(raw.subarray(0, raw.length - 1024)), receipt), /Missing tar terminator/);
  assert.throws(() => verifyTarball(gzipSync(raw.subarray(0, raw.length - 1)), receipt), /Truncated tar block/);
  const corrupt = Buffer.from(raw);
  corrupt[0] ^= 1;
  assert.throws(() => verifyTarball(gzipSync(corrupt), receipt), /Invalid tar header checksum/);
});

test('stage validation catches unexpected files and changed bytes before packing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hootlens-release-test-'));
  const { contents, receipt } = fixture();
  try {
    await mkdir(join(directory, 'dist'));
    for (const file of FILES) await writeFile(join(directory, file), contents[file]);
    await verifyStage(directory, receipt);
    await writeFile(join(directory, '.env.local'), 'synthetic fixture only');
    await assert.rejects(verifyStage(directory, receipt));
    await rm(join(directory, '.env.local'));
    await writeFile(join(directory, 'dist/cli.mjs'), 'changed');
    await assert.rejects(verifyStage(directory, receipt), /Staged bytes changed/);
  } finally {
    assert.ok(directory.startsWith(join(tmpdir(), 'hootlens-release-test-')));
    await rm(directory, { recursive: true, force: true });
  }
});

test('publication requires explicit matching tag/version, public hosted CI and a clean exact checkout', () => {
  const head = 'a'.repeat(40);
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'Parallel-Platforms/hootlens-mcp', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REF: `refs/tags/mcp-v${manifest.version}`, RELEASE_VERSION: manifest.version, GITHUB_SHA: head };
  assertPublishContext(env, manifest.version, head, '');
  for (const change of [
    { GITHUB_ACTIONS: 'false' }, { GITHUB_REPOSITORY: 'Parallel-Platforms/hootlens' },
    { RUNNER_ENVIRONMENT: 'self-hosted' }, { GITHUB_REF: 'refs/heads/main' },
    { RELEASE_VERSION: '9.9.9' }, { RELEASE_VERSION: '' }, { GITHUB_SHA: 'b'.repeat(40) },
  ]) assert.throws(() => assertPublishContext({ ...env, ...change }, manifest.version, head, ''));
  assert.throws(() => assertPublishContext(env, manifest.version, head, ' M src/tools.ts\n'));
});

test('existing versions and registry outages refuse publication, without waiting on cancellation', () => {
  let canceled = 0;
  const response = status => ({ status, body: { cancel: () => { canceled++; return new Promise(() => {}); } } });
  assertUnpublished(response(404));
  for (const status of [200, 301, 401, 429, 500, 503]) assert.throws(() => assertUnpublished(response(status)));
  assert.equal(canceled, 7);
});
