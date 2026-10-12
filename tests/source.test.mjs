import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createServer } from 'node:http';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('../dist/cli.mjs', import.meta.url));
const cleanEnv = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]));

test('the release sources match the recorded snapshot, including shared imports', async () => {
  const source = JSON.parse(await readFile(new URL('../docs/SOURCE.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const server = JSON.parse(await readFile(new URL('../server.json', import.meta.url), 'utf8'));
  assert.equal(source.version, '1.1.0');
  assert.equal(source.sourceCommit, '683b3ac9294e9db795607470dc632c13f79d68b8');
  assert.equal(manifest.version, source.version);
  assert.equal(server.version, source.version);
  assert.equal(server.packages[0].version, source.version);
  assert.equal(manifest.mcpName, server.name);
  assert.equal(manifest.private, true);
  async function inventory(path) {
    const files = [];
    for (const entry of await readdir(new URL(`../${path}/`, import.meta.url), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) files.push(...await inventory(child));
      else if (entry.isFile()) files.push(child);
      else assert.fail(`Unexpected source entry: ${child}`);
    }
    return files;
  }
  const actualFiles = [...await inventory('src'), ...await inventory('packages/core'), 'server.json', 'LICENSE', 'CHANGELOG.md'];
  assert.deepEqual(actualFiles.sort(), Object.keys(source.files).sort(), 'Snapshot covers the complete server and shared source inventory');
  for (const [path, expected] of Object.entries(source.files)) {
    assert.match(path, /^(src\/|packages\/core\/|server\.json$|LICENSE$|CHANGELOG\.md$)/);
    assert.ok(!path.includes('..'));
    const contents = (await readFile(new URL(`../${path}`, import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
    assert.equal(createHash('sha256').update(contents).digest('hex'), expected, path);
  }
});

test('the standalone bundle reports the prepared version and CLI usage', async () => {
  const version = await run(process.execPath, [cli, '--version'], { cwd: root, env: cleanEnv, timeout: 10_000 });
  assert.equal(version.stdout.trim(), '1.1.0');
  assert.equal(version.stderr, '');
  const help = await run(process.execPath, [cli, '--help'], { cwd: root, env: cleanEnv, timeout: 10_000 });
  assert.match(help.stdout, /login\|logout\|whoami/);
  assert.match(help.stdout, /HOOTLENS_PAT/);
});

test('the built stdio server discovers read tools, defaults to a pinned project and returns API denial', { timeout: 30_000 }, async () => {
  const calls = [];
  const api = createServer((request, response) => {
    calls.push({ method: request.method, path: request.url, auth: request.headers.authorization });
    response.setHeader('Content-Type', 'application/json');
    if (request.headers.authorization !== 'Bearer hl_pat_public_source_fixture') {
      response.writeHead(401).end(JSON.stringify({ error: 'Invalid fixture credential' }));
    } else if (request.url === '/v1/access') {
      response.end(JSON.stringify({ credential: { scopes: ['read'] } }));
    } else if (request.url === '/v1/projects') {
      response.end(JSON.stringify({ projects: [{ id: 'proj_fixture', name: 'Synthetic fixture', role: 'viewer' }] }));
    } else if (request.url?.startsWith('/v1/projects/proj_fixture/recordings')) {
      response.end(JSON.stringify({ recordings: [{ id: 'r_fixture', path: '/synthetic' }] }));
    } else {
      response.writeHead(403).end(JSON.stringify({ error: 'Project is outside this fixture grant' }));
    }
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const address = api.address();
  assert.ok(address && typeof address === 'object');
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, '--project', 'proj_fixture', '--toolsets', 'read'], cwd: root,
    env: { ...cleanEnv, HOOTLENS_PAT: 'hl_pat_public_source_fixture', HOOTLENS_API_URL: `http://127.0.0.1:${address.port}` }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  const client = new Client({ name: 'public-source-fixture', version: '1.0.0' });
  try {
    await client.connect(transport, { timeout: 10_000 });
    assert.equal(client.getServerVersion()?.version, '1.1.0');
    const tools = await client.listTools({ cursor: '' }, { timeout: 5_000 });
    assert.ok(tools.tools.some(tool => tool.name === 'list_recordings'));
    assert.ok(!tools.tools.some(tool => ['add_note', 'log_change', 'configure', 'submit_issue'].includes(tool.name)));
    const projects = await client.callTool({ name: 'list_projects', arguments: {} }, undefined, { timeout: 5_000 });
    assert.equal(projects.isError, undefined);
    assert.equal(projects.structuredContent?.pinnedProjectId, 'proj_fixture');
    const recordings = await client.callTool({ name: 'list_recordings', arguments: { limit: 1 } }, undefined, { timeout: 5_000 });
    assert.equal(recordings.structuredContent?.recordings[0].id, 'r_fixture');
    assert.ok(calls.some(call => call.path.startsWith('/v1/projects/proj_fixture/recordings')));
    const denied = await client.callTool({ name: 'list_recordings', arguments: { projectId: 'proj_denied', limit: 1 } }, undefined, { timeout: 5_000 });
    assert.equal(denied.isError, true);
    assert.ok(calls.some(call => call.path.startsWith('/v1/projects/proj_denied/recordings')));
    assert.ok(calls.every(call => call.method === 'GET'));
    assert.ok(!stderr.includes('hl_pat_public_source_fixture'));
  } finally {
    await client.close();
    api.closeAllConnections();
    await new Promise(resolve => api.close(resolve));
  }
});
