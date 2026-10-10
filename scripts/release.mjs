import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
export const PACKAGE = '@hootlens/mcp';
export const REPOSITORY = 'git+https://github.com/Parallel-Platforms/hootlens-mcp.git';
export const FILES = ['CHANGELOG.md', 'LICENSE', 'README.md', 'dist/cli.mjs', 'package.json'];
const hash = contents => createHash('sha256').update(contents).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));

async function inventory(directory, prefix = '', source = false) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (source && prefix === 'packages/core' && ['node_modules', 'dist'].includes(entry.name)) continue;
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await inventory(join(directory, entry.name), name, source));
    else if (entry.isFile()) files.push(name);
    else throw new Error(`Unexpected non-file entry: ${name}`);
  }
  return files.sort();
}

export function publishManifest(manifest) {
  assert.equal(manifest.private, true, 'The development root must remain private');
  assert.equal(manifest.name, PACKAGE);
  assert.match(manifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.equal(manifest.mcpName, 'com.hootlens/mcp');
  assert.deepEqual(manifest.repository, { type: 'git', url: REPOSITORY });
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.type, 'module');
  assert.deepEqual(manifest.bin, { 'hootlens-mcp': 'dist/cli.mjs' });
  assert.deepEqual(manifest.engines, { node: '>=20' });
  assert.deepEqual([...manifest.files].sort(), FILES.filter(file => file !== 'package.json'));
  assert.equal(manifest.homepage, 'https://hootlens.com/docs/MCP.md');
  assert.deepEqual(manifest.bugs, { url: 'https://github.com/Parallel-Platforms/hootlens-mcp/issues', email: 'support@hootlens.com' });
  for (const key of ['description', 'author']) assert.equal(typeof manifest[key], 'string');
  assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.every(value => typeof value === 'string'));
  // Explicit allowlist: development scripts, workspaces, dependencies and credentials never enter the package.
  const keys = ['name', 'version', 'description', 'mcpName', 'type', 'license', 'author', 'homepage', 'repository', 'bugs', 'keywords', 'bin', 'files', 'engines'];
  return { ...Object.fromEntries(keys.map(key => [key, manifest[key]])), private: false, publishConfig: { access: 'public', provenance: true } };
}

export async function verifySource(directory = root) {
  const [manifest, snapshot, server, lock, version] = await Promise.all([
    json(join(directory, 'package.json')), json(join(directory, 'docs/SOURCE.json')),
    json(join(directory, 'server.json')), json(join(directory, 'package-lock.json')),
    readFile(join(directory, 'src/version.ts'), 'utf8'),
  ]);
  const stagedManifest = publishManifest(manifest);
  assert.equal(snapshot.package, PACKAGE);
  assert.equal(snapshot.version, manifest.version);
  assert.equal(snapshot.releaseTag, `mcp-v${manifest.version}`);
  assert.match(snapshot.sourceCommit, /^[a-f0-9]{40}$/);
  assert.equal(server.name, stagedManifest.mcpName);
  assert.equal(server.version, manifest.version);
  assert.equal(server.packages.length, 1);
  assert.equal(server.packages[0].registryType, 'npm');
  assert.equal(server.packages[0].identifier, PACKAGE);
  assert.equal(server.packages[0].version, manifest.version);
  assert.equal(version.match(/export const MCP_PACKAGE_VERSION = '([^']+)';/)?.[1], manifest.version);
  assert.equal(lock.name, PACKAGE);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].name, PACKAGE);
  assert.equal(lock.packages[''].version, manifest.version);
  const files = [...await inventory(join(directory, 'src'), 'src', true), ...await inventory(join(directory, 'packages/core'), 'packages/core', true), 'server.json', 'LICENSE', 'CHANGELOG.md'].sort();
  assert.deepEqual(Object.keys(snapshot.files).sort(), files, 'Snapshot must cover all release and shared source');
  for (const file of files) {
    const contents = (await readFile(join(directory, file), 'utf8')).replaceAll('\r\n', '\n');
    assert.equal(hash(contents), snapshot.files[file], `Source snapshot mismatch: ${file}`);
  }
  return { stagedManifest, snapshot };
}

export async function verifyStage(directory, receipt) {
  assert.deepEqual(await inventory(directory), FILES, 'Staged package has unexpected or missing files');
  assert.deepEqual(await json(join(directory, 'package.json')), receipt.manifest, 'Staged manifest differs');
  assert.deepEqual(Object.keys(receipt.sha256).sort(), FILES);
  for (const file of FILES) assert.equal(hash(await readFile(join(directory, file))), receipt.sha256[file], `Staged bytes changed: ${file}`);
}

export async function stageRelease(directory = root) {
  const { stagedManifest, snapshot } = await verifySource(directory);
  const release = join(directory, '.release');
  await mkdir(release, { recursive: true });
  const build = await mkdtemp(join(release, 'build-'));
  await run(process.execPath, [join(directory, 'scripts/build.mjs'), '--out-dir', build], { cwd: directory, maxBuffer: 4 * 1024 * 1024 });
  const builtVersion = await run(process.execPath, [join(build, 'cli.mjs'), '--version'], { cwd: directory });
  assert.equal(builtVersion.stdout.trim(), stagedManifest.version, 'Built executable must report the staged version');
  assert.equal(builtVersion.stderr, '');
  const target = join(release, 'package');
  // Refuse an old stage instead of silently carrying stale files into a release.
  await mkdir(target);
  await mkdir(join(target, 'dist'));
  await copyFile(join(build, 'cli.mjs'), join(target, 'dist/cli.mjs'));
  for (const file of ['README.md', 'LICENSE', 'CHANGELOG.md']) await copyFile(join(directory, file), join(target, file));
  await writeFile(join(target, 'package.json'), `${JSON.stringify(stagedManifest, null, 2)}\n`);
  const commit = (await run('git', ['rev-parse', 'HEAD'], { cwd: directory })).stdout.trim();
  assert.match(commit, /^[a-f0-9]{40}$/);
  const receipt = {
    manifest: stagedManifest,
    publicCommit: commit,
    cleanCheckout: (await run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: directory })).stdout === '',
    importedSourceCommit: snapshot.sourceCommit,
    sha256: Object.fromEntries(await Promise.all(FILES.map(async file => [file, hash(await readFile(join(target, file)))]))),
  };
  await verifyStage(target, receipt);
  await writeFile(join(release, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

export function verifyTarball(bytes, receipt) {
  const archive = gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 });
  assert.equal(archive.length % 512, 0, 'Truncated tar block');
  const files = new Map();
  let terminated = false;
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      assert.ok(archive.length - offset >= 1024, 'Missing tar terminator');
      assert.ok(archive.subarray(offset).every(byte => byte === 0), 'Unexpected data after tar terminator');
      terminated = true;
      break;
    }
    const text = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const sizeText = text(124, 12).trim();
    assert.match(sizeText, /^[0-7]+$/);
    const size = parseInt(sizeText, 8);
    const checksum = parseInt(text(148, 8).trim(), 8);
    assert.equal(checksum, header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0), 'Invalid tar header checksum');
    const name = text(0, 100);
    assert.equal(text(345, 155), '', 'Tar prefixes are not allowed');
    assert.ok(['', '0'].includes(text(156, 1)), 'Only regular files are allowed in a package');
    assert.ok(name.startsWith('package/'));
    const file = name.slice('package/'.length);
    assert.ok(FILES.includes(file), `Unexpected packed file: ${name}`);
    assert.ok(!files.has(file), `Duplicate packed file: ${name}`);
    assert.ok(offset + 512 + size <= archive.length, 'Truncated tar entry');
    files.set(file, archive.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(terminated, 'Missing tar terminator');
  assert.deepEqual([...files.keys()].sort(), FILES, 'Packed package has missing files');
  assert.deepEqual(JSON.parse(files.get('package.json').toString('utf8')), receipt.manifest);
  for (const [file, contents] of files) assert.equal(hash(contents), receipt.sha256[file], `Packed bytes differ: ${file}`);
}

export async function packRelease(directory = root) {
  const receipt = await json(join(directory, '.release/receipt.json'));
  const { stagedManifest } = await verifySource(directory);
  assert.deepEqual(receipt.manifest, stagedManifest, 'Receipt must match current release identity');
  assert.equal(receipt.publicCommit, (await run('git', ['rev-parse', 'HEAD'], { cwd: directory })).stdout.trim());
  await verifyStage(join(directory, '.release/package'), receipt);
  assert.ok(process.env.npm_execpath, 'Run through npm run release:pack');
  const packed = await run(process.execPath, [process.env.npm_execpath, 'pack', './.release/package', '--pack-destination', './.release', '--json', '--ignore-scripts'], { cwd: directory });
  const records = JSON.parse(packed.stdout);
  assert.equal(records.length, 1);
  assert.equal(records[0].name, PACKAGE);
  assert.equal(records[0].version, receipt.manifest.version);
  const filename = `hootlens-mcp-${receipt.manifest.version}.tgz`;
  assert.equal(records[0].filename, filename);
  assert.deepEqual(records[0].files.map(file => file.path).sort(), FILES);
  verifyTarball(await readFile(join(directory, '.release', filename)), receipt);
  return { filename, receipt };
}

export function assertPublishContext(env, version, head, status) {
  assert.equal(env.GITHUB_ACTIONS, 'true');
  assert.equal(env.GITHUB_REPOSITORY, 'Parallel-Platforms/hootlens-mcp');
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.equal(env.GITHUB_REF, `refs/tags/mcp-v${version}`, 'Publication requires the matching public release tag');
  assert.equal(env.RELEASE_VERSION, version, 'Explicit release confirmation must match');
  assert.match(head, /^[a-f0-9]{40}$/);
  assert.equal(env.GITHUB_SHA, head);
  assert.equal(status, '', 'Public source checkout must be clean');
}

export function assertUnpublished(response) {
  void response.body?.cancel().catch(() => undefined);
  assert.equal(response.status, 404, 'Release version must be unpublished; other registry responses fail closed');
}

export async function verifyPublish(env, directory = root, fetcher = fetch) {
  const { stagedManifest } = await verifySource(directory);
  const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: directory })).stdout.trim();
  const status = (await run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: directory })).stdout;
  assertPublishContext(env, stagedManifest.version, head, status);
  const response = await fetcher(`https://registry.npmjs.org/@hootlens%2fmcp/${stagedManifest.version}`, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
  assertUnpublished(response);
  return stagedManifest.version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...extra] = process.argv.slice(2);
  assert.equal(extra.length, 0);
  if (command === 'stage') console.log(`Prepared ${PACKAGE}@${(await stageRelease()).manifest.version}; no publication occurred.`);
  else if (command === 'pack') console.log(`Validated ${(await packRelease()).filename}; no publication occurred.`);
  else if (command === 'verify-publish') console.log(`Publication conditions checked for ${await verifyPublish(process.env)}.`);
  else throw new Error('Usage: node scripts/release.mjs stage|pack|verify-publish');
}
