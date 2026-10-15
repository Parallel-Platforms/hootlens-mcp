import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

// Run once per evidence directory. This executes only the fixed published package
// against an in-memory loopback API. Installation and signature verification are
// separate preparation steps. No current developer credentials are inherited.
const EXPECTED_SHA = '3e1dcb8ff564df456f5394267d4c802890182f4127c409e1191205a20fc08cc7';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const [invocationPath, invocationSha256] = process.argv.slice(2);
assert.ok(invocationPath && /^[a-f0-9]{64}$/.test(invocationSha256 ?? ''),
  'Usage: node run.mjs <reviewed invocation.json> <reviewed SHA-256>');
const invocationBytes = await readFile(resolve(invocationPath));
assert.equal(sha256(invocationBytes), invocationSha256, 'Reviewed invocation binding');
const invocation = JSON.parse(invocationBytes);
assert.equal(invocation.schemaVersion, 1);
for (const binding of invocation.bindings) {
  assert.equal(sha256(await readFile(binding.path)), binding.sha256, `Frozen ${binding.name}`);
}
assert.equal(resolve(invocation.helper), fileURLToPath(import.meta.url), 'Reviewed helper path');
const artifact = resolve(invocation.artifact);
const scannerRoot = resolve(invocation.scannerRoot);
const dependencyRoot = resolve(invocation.dependencyRoot);
const output = resolve(invocation.output);
const bytes = await readFile(artifact);
assert.equal(sha256(bytes), EXPECTED_SHA, 'Exact previously verified published tarball');
const scannerPackage = JSON.parse(await readFile(join(scannerRoot, 'package.json'), 'utf8'));
assert.equal(scannerPackage.name, 'mcptrustchecker');
assert.equal(scannerPackage.version, '1.17.0');
const scannerCli = join(scannerRoot, 'dist', 'cli', 'index.js');
assert.equal(sha256(await readFile(scannerCli)), '347a0ef0ed422b5e78f173d83f5b10a96832d2bd78c93169b0a7678ef47adfc0', 'Reviewed scanner entry');
const sdkPackage = JSON.parse(await readFile(join(dependencyRoot, 'node_modules', '@modelcontextprotocol', 'client', 'package.json'), 'utf8'));
assert.equal(sdkPackage.version, '2.3.1', 'Reviewed fixture SDK');
const require = createRequire(join(dependencyRoot, 'package.json'));
const { Client } = require('@modelcontextprotocol/client');
const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');
await mkdir(output, { recursive: true });
const lock = await open(join(output, 'run.lock'), 'wx');
await lock.writeFile(JSON.stringify({ startedAt: new Date().toISOString(), pid: process.pid, artifactSha256: EXPECTED_SHA }) + '\n');
await lock.close();
const startedAt = new Date().toISOString();
const receipt = { startedAt, artifactSha256: EXPECTED_SHA, scannerVersion: '1.17.0',
  packageVersion: '1.1.0', mode: 'exact artifact, offline source and synthetic loopback runtime',
  completed: false, profiles: [], checks: [], childrenClosed: false, fixtureClosed: false };
const children = new Set();
const clients = new Set();
const processObservations = [];
const calls = [];
let api;
let mode = 'owner';
let phase = 'preparation';
const callTimeout = 5_000;
const syntheticCredential = 'synthetic_release_110_only';
const mutations = new Map();
const previews = new Map();
const allowedEnvironment = new Set(['path', 'systemroot', 'temp', 'tmp', 'comspec']);
const cleanEnv = Object.fromEntries(Object.entries(process.env)
  .filter(([key, value]) => value !== undefined && allowedEnvironment.has(key.toLowerCase())));
const scratchHome = join(output, 'home');
await mkdir(scratchHome);
const env = { ...cleanEnv, HOME: scratchHome, USERPROFILE: scratchHome, NO_PAGER: '1' };
await writeFile(join(output, '.hootlens.json'), '{}\n', { flag: 'wx' });
let deadlineExceeded = false;
const assertActive = () => assert.equal(deadlineExceeded, false, 'Helper deadline is terminal');
const run = promisify(execFile);
async function stopChild(child, observation) {
  if (observation.closed) return;
  if (process.platform === 'win32') {
    try { await run('taskkill', ['/PID', String(child.pid), '/T', '/F'], { env, timeout: 10_000, maxBuffer: 100_000 }); }
    catch (error) { observation.treeStopError = error instanceof Error ? error.message : String(error); }
  }
  if (!observation.closed) child.kill('SIGKILL');
}
const watchdog = setTimeout(() => {
  deadlineExceeded = true;
  for (const child of children) void stopChild(child, processObservations.find(row => row.pid === child.pid));
  for (const client of clients) void client.close();
  api?.closeAllConnections();
  void writeFile(join(output, 'deadline.json'), JSON.stringify({ at: new Date().toISOString(), phase, deadlineMs: 240_000 }) + '\n');
  process.exitCode = 1;
}, 240_000);

async function command(name, args, timeout = 60_000) {
  assertActive();
  const child = spawn(process.execPath, args, { cwd: output, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  const observation = { kind: 'scanner-process', name, pid: child.pid, closed: false };
  processObservations.push(observation);
  let stdout = ''; let stderr = ''; let overflow = false;
  const append = (value, chunk) => value + chunk;
  child.stdout.on('data', chunk => { stdout = append(stdout, chunk); if (stdout.length > 4_000_000 && !overflow) { overflow = true; void stopChild(child, observation); } });
  child.stderr.on('data', chunk => { stderr = append(stderr, chunk); if (stderr.length > 1_000_000 && !overflow) { overflow = true; void stopChild(child, observation); } });
  const timer = setTimeout(() => { observation.timedOut = true; void stopChild(child, observation); }, timeout);
  const result = await new Promise((yes, no) => {
    child.once('error', no);
    child.once('close', (code, signal) => { Object.assign(observation, { closed: true, code, signal }); yes({ code, signal }); });
  }).finally(() => { clearTimeout(timer); children.delete(child); });
  await writeFile(join(output, `${name}.stdout.json`), stdout);
  await writeFile(join(output, `${name}.stderr.txt`), stderr);
  await writeFile(join(output, `${name}.exit.json`), JSON.stringify({ ...result, overflow, timeoutMs: timeout }) + '\n');
  assert.equal(overflow, false, `${name}: bounded output`);
  assert.equal(result.code, 0, `${name}: exited successfully (${result.signal ?? 'no signal'})`);
  assert.equal(observation.timedOut, undefined, `${name}: no deadline exceeded`);
  assertActive();
  return JSON.parse(stdout);
}

const scopesFor = () => mode === 'owner' ? ['read', 'replay', 'annotate', 'configure', 'sites:create', 'triage']
  : mode === 'pat' ? ['read', 'replay'] : mode === 'read' ? ['read'] : ['read', 'replay'];
const project = { id: 'proj_fixture', name: 'Synthetic release fixture', role: 'owner', origins: ['https://synthetic.example'] };
const respond = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };

async function fixture(request, response) {
  if (deadlineExceeded) return respond(response, 503, { error: 'Synthetic fixture deadline ended' });
  let raw = '';
  for await (const chunk of request) { raw += chunk; if (raw.length > 50_000) return respond(response, 413, { error: 'Fixture body too large' }); }
  const body = raw ? JSON.parse(raw) : undefined;
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  const row = { phase, mode, method: request.method, path, ...(body ? { body } : {}),
    ...(request.headers['idempotency-key'] ? { idempotencyKey: request.headers['idempotency-key'] } : {}) };
  calls.push(row);
  if (request.headers.authorization !== `Bearer ${syntheticCredential}`) return respond(response, 401, { error: 'Invalid synthetic credential' });
  if (path === '/v1/access') {
    if (mode === 'unknown') return respond(response, 403, { error: 'Fixture discovery unavailable' });
    return respond(response, 200, { account: { id: 'synthetic-owner' }, credential: {
      kind: mode === 'pat' ? 'pat' : 'oauth', projects: 'all', scopes: scopesFor(),
    }, projects: [{ ...project, permissions: mode === 'read' ? ['read'] : ['read', 'replay', 'tokens', 'member'] }] });
  }
  if (path === '/v1/projects' && request.method === 'GET') return respond(response, 200, { projects: [project] });
  if (path === '/v1/projects' && request.method === 'POST') {
    const key = request.headers['idempotency-key'];
    const previous = mutations.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(body)) return respond(response, 409, { code: 'idempotency_conflict', error: 'The idempotency key was reused with different arguments' });
    if (!previous) mutations.set(key, body);
    return respond(response, previous ? 200 : 201, { project: { id: 'proj_created', name: body.name } });
  }
  if (path === '/v1/projects/proj_created/install-snippet') return respond(response, 200, {
    tag: '<script data-project="proj_created" data-consent="required"></script>', consent: 'required',
  });
  if (path === '/v1/projects/proj_fixture/settings-changes/preview' && request.method === 'POST') {
    if (body.changes.privacy?.preset === 'full') return respond(response, 403, { code: 'privacy_weakening_refused', error: 'Privacy cannot get looser' });
    const token = 'synthetic_preview_token_110';
    previews.set(token, body.changes);
    return respond(response, 200, { changed: true, token, expiresAt: Date.now() + 600_000,
      diff: [{ area: 'privacy', action: 'preset', summary: 'Use strict privacy' }], effects: [], warnings: [] });
  }
  if (path === '/v1/projects/proj_fixture/settings-changes/apply' && request.method === 'POST') {
    if (body.token === 'synthetic_expired_token_110') return respond(response, 410, { code: 'preview_expired', error: 'The preview expired' });
    if (body.token === 'synthetic_stale_token_110') return respond(response, 409, { code: 'settings_changed', error: 'Settings changed since preview' });
    if (!previews.has(body.token)) return respond(response, 403, { error: 'Unknown fixture preview' });
    return respond(response, 200, { applied: true, appliedAt: Date.now(), diff: [{ area: 'privacy', action: 'preset', summary: 'Use strict privacy' }], areas: ['privacy'] });
  }
  if (path === '/v1/projects/proj_fixture/recordings' && mode === 'redirect') {
    response.writeHead(302, { Location: `${origin}/redirect-sentinel` }); return response.end();
  }
  if (path.startsWith('/v1/projects/outside/')) return respond(response, 403, { error: 'Project is outside this fixture grant' });
  return respond(response, 404, { error: 'Route is outside the synthetic fixture' });
}

const mutating = new Set(['create_site', 'start_setup', 'add_note', 'log_change', 'apply_settings_change', 'submit_issue', 'submit_issues', 'reply_issue', 'claim_issue', 'set_issue_status', 'update_issue', 'explain_snags']);
const external = new Set(['check_install', 'start_setup', 'check_setup', 'explain_snags']);
async function connection(profile, args, inspect) {
  assertActive();
  phase = profile;
  const client = new Client({ name: 'hoot-lens-release-security-fixture', version: '1' });
  clients.add(client);
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, ...args], cwd: output,
    env: { ...env, HOOTLENS_PAT: syntheticCredential, HOOTLENS_API_URL: origin }, stderr: 'pipe' });
  let stderr = '';
  const observation = { kind: 'fixture-SDK-transport', name: profile, pid: null, closeCalled: false, closeEvent: false, closed: false };
  processObservations.push(observation);
  const closeTransport = transport.close.bind(transport);
  transport.close = async () => {
    observation.closeCalled = true;
    observation.pid ??= transport.pid;
    const priorOnClose = transport.onclose;
    transport.onclose = () => { observation.closeEvent = true; priorOnClose?.(); };
    await closeTransport();
    observation.pidAfterClose = transport.pid;
    if (observation.pid !== null && observation.pid !== undefined) {
      try { process.kill(observation.pid, 0); observation.pidStillExists = true; }
      catch (error) { observation.pidStillExists = error?.code !== 'ESRCH'; }
    }
    observation.closed = observation.closeEvent && observation.pidAfterClose === null && observation.pidStillExists === false;
  };
  transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  try {
    await client.connect(transport, { timeout: callTimeout });
    observation.pid = transport.pid;
    assertActive();
    assert.equal(client.getServerVersion().version, '1.1.0');
    const tools = (await client.listTools({}, { timeout: callTimeout })).tools;
    for (const tool of tools) {
      for (const flag of ['readOnlyHint', 'destructiveHint', 'openWorldHint']) assert.equal(typeof tool.annotations?.[flag], 'boolean', `${tool.name}.${flag}`);
      assert.equal(tool.annotations.readOnlyHint, !mutating.has(tool.name), `${tool.name}: write annotation`);
      assert.equal(tool.annotations.destructiveHint, tool.name === 'apply_settings_change', `${tool.name}: destructive annotation`);
      assert.equal(tool.annotations.openWorldHint, external.has(tool.name), `${tool.name}: external effects annotation`);
    }
    receipt.profiles.push({ name: profile, mode, args, toolCount: tools.length, tools: tools.map(tool => tool.name) });
    const checkedClient = new Proxy(client, { get(target, property) {
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? (...parameters) => { assertActive(); return value.apply(target, parameters); } : value;
    } });
    await inspect(checkedClient, tools);
  } finally {
    await client.close();
    clients.delete(client);
    assert.equal(observation.closed, true, `${profile}: SDK close event and owned PID absence observed`);
    await writeFile(join(output, `${profile}.stderr.txt`), stderr);
  }
}
let cli; let origin;
try {
  const extracted = join(output, 'artifact');
  await mkdir(extracted);
  await run('tar', ['-xzf', artifact, '-C', extracted], { env, timeout: 10_000, maxBuffer: 1_000_000 });
  cli = join(extracted, 'package', 'dist', 'cli.mjs');
  const manifest = JSON.parse(await readFile(join(extracted, 'package', 'package.json'), 'utf8'));
  assert.equal(manifest.version, '1.1.0');
  assert.equal(manifest.name, '@hootlens/mcp');
  phase = 'source-scan';
  if (['remaining-runtime', 'remaining-profiles'].includes(invocation.mode)) {
    const sourceExit = JSON.parse(await readFile(invocation.priorSourceExit, 'utf8'));
    assert.equal(sourceExit.code, 0);
    assert.equal(sourceExit.signal, null);
    assert.equal(sourceExit.overflow, false);
    const sourceBytes = await readFile(invocation.priorSourceReport);
    const source = JSON.parse(sourceBytes);
    assert.equal(source.tool.version, '1.17.0');
    assert.equal(resolve(source.target.source.origin), artifact);
    receipt.sourceReportSha256 = sha256(sourceBytes);
    receipt.sourceReportReused = true;
    receipt.sourceReportPath = invocation.priorSourceReport;
    receipt.checks.push({ name: 'exact offline artifact source scan retained from first attempt', status: 'passed' });
    if (invocation.mode === 'remaining-profiles') {
      const runtimeExit = JSON.parse(await readFile(invocation.priorRuntimeExit, 'utf8'));
      assert.equal(runtimeExit.code, 0);
      assert.equal(runtimeExit.signal, null);
      assert.equal(runtimeExit.overflow, false);
      const runtimeBytes = await readFile(invocation.priorRuntimeReport);
      const runtime = JSON.parse(runtimeBytes);
      assert.equal(runtime.tool.version, '1.17.0');
      assert.equal(runtime.target.server.version, '1.1.0');
      const prior = JSON.parse(await readFile(invocation.priorProfileReceipt, 'utf8'));
      assert.equal(prior.artifactSha256, EXPECTED_SHA);
      assert.equal(prior.childrenClosed, true);
      assert.equal(prior.fixtureClosed, true);
      assert.equal(prior.completed, false);
      assert.ok(prior.error.includes('mutating.has(tool.name)'));
      assert.ok(prior.checks.some(row => row.name.startsWith('site creation validation') && row.status === 'passed'));
      assert.equal(prior.profiles.find(row => row.name === 'owner-all').toolCount, 44);
      const readReplay = prior.profiles.find(row => row.name === 'read-replay');
      assert.deepEqual(readReplay.tools.filter(name => mutating.has(name)), ['explain_snags']);
      assert.deepEqual(readReplay.tools.filter(name => external.has(name)), ['explain_snags']);
      receipt.retainedProfiles = prior.profiles;
      receipt.retainedChecks = prior.checks;
      receipt.runtimeReportSha256 = sha256(runtimeBytes);
      receipt.runtimeReportReused = true;
      receipt.runtimeReportPath = invocation.priorRuntimeReport;
      receipt.checks.push({ name: 'read/replay effect boundary retained from actual discovery', status: 'observed',
        finding: 'explain_snags is still offered; it can contact a provider and consume account allowance',
        effectfulTools: ['explain_snags'], modelCallsMade: 0 });
    }
  } else {
    assert.equal(invocation.mode, 'full', 'Explicit reviewed execution mode');
    const source = await command('source-scan', [scannerCli, 'scan', artifact, '--json', '--surface', '--details', '--no-lock', '--no-pager']);
    receipt.sourceReportSha256 = sha256(await readFile(join(output, 'source-scan.stdout.json')));
    receipt.checks.push({ name: 'exact offline artifact source scan', status: 'passed', reportCount: source.reports?.length ?? 1 });
  }
  api = createServer((request, response) => { void fixture(request, response).catch(() => respond(response, 500, { error: 'Synthetic fixture failed' })); });
  await new Promise((resolve, reject) => {
    api.once('error', reject);
    api.listen(0, '127.0.0.1', () => { api.removeListener('error', reject); resolve(); });
  });
  const address = api.address(); assert.ok(address && typeof address === 'object');
  origin = `http://127.0.0.1:${address.port}`;
  if (invocation.mode !== 'remaining-profiles') {
  phase = 'runtime-scan';
  await command('runtime-scan', [scannerCli, 'scan', '--command', `node ${cli.replaceAll('\\', '/')} --toolsets all`,
    '--env', `HOOTLENS_PAT=${syntheticCredential}`, '--env', `HOOTLENS_API_URL=${origin}`, '--json', '--surface', '--details', '--no-lock', '--no-pager']);
  receipt.runtimeReportSha256 = sha256(await readFile(join(output, 'runtime-scan.stdout.json')));
  assert.ok(calls.every(row => row.method === 'GET' && ['/v1/access', '/v1/projects'].includes(row.path)), 'Scanner metadata acquisition makes no effect call');
  receipt.checks.push({ name: 'runtime scan metadata-only fixture calls', status: 'passed' });
  mode = 'owner';
  await connection('owner-all', ['--toolsets', 'all'], async (client, tools) => {
    await writeFile(join(output, 'tools.json'), JSON.stringify(tools, null, 2) + '\n');
    const prompts = await client.listPrompts({}, { timeout: callTimeout });
    const resources = await client.listResources({}, { timeout: callTimeout });
    const templates = await client.listResourceTemplates({}, { timeout: callTimeout });
    await writeFile(join(output, 'resources.json'), JSON.stringify({ prompts, resources, templates }, null, 2) + '\n');
    const apps = [];
    for (const resource of resources.resources.filter(row => row.uri.startsWith('ui://'))) {
      const result = await client.readResource({ uri: resource.uri }, { timeout: callTimeout });
      const content = result.contents[0];
      const html = content.text;
      apps.push({ uri: resource.uri, mimeType: content.mimeType, bytes: Buffer.byteLength(html), sha256: sha256(html), meta: content._meta,
        directNetworkPrimitives: /\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket\s*\(/.test(html),
        absoluteHostStrings: [...new Set([...html.matchAll(/https?:\/\/[a-zA-Z0-9.-]+/g)].map(match => match[0]))] });
    }
    await writeFile(join(output, 'apps.json'), JSON.stringify(apps, null, 2) + '\n');
    assert.equal(apps.length, 3);
    assert.ok(tools.some(tool => tool.name === 'create_site'));
    assert.equal(tools.find(tool => tool.name === 'create_site').annotations.idempotentHint, true);
    assert.equal(tools.find(tool => tool.name === 'load_replay')._meta.ui.visibility[0], 'app');
    const args = { name: 'Synthetic site', origins: ['https://synthetic.example'], idempotencyKey: 'release-security-request-110' };
    for (let retry = 0; retry < 2; retry++) {
      const result = await client.callTool({ name: 'create_site', arguments: args }, undefined, { timeout: callTimeout });
      assert.ok(!result.isError);
      assert.equal(result.structuredContent.projectId, 'proj_created');
      assert.equal(result.structuredContent.setupStatus.recording, 'not_checked');
      assert.equal(result.structuredContent.setupStatus.consent, 'required');
    }
    assert.equal(mutations.size, 1, 'Fixture deduplicates the two identically forwarded requests');
    assert.deepEqual(mutations.get(args.idempotencyKey), { name: args.name, origins: args.origins, privacy: { preset: 'balanced' }, consent: 'required' });
    const beforeInvalid = calls.length;
    const invalid = await client.callTool({ name: 'create_site', arguments: { ...args, origins: ['https://user:password@synthetic.example/path?key=value#fragment'] } }, undefined, { timeout: callTimeout });
    assert.equal(invalid.isError, true);
    assert.equal(calls.length, beforeInvalid, 'Invalid origin is rejected before API call');
    const preview = await client.callTool({ name: 'preview_settings_change', arguments: { projectId: 'proj_fixture', changes: { privacy: { preset: 'strict' } } } }, undefined, { timeout: callTimeout });
    assert.ok(!preview.isError);
    const applied = await client.callTool({ name: 'apply_settings_change', arguments: { projectId: 'proj_fixture', token: preview.structuredContent.token } }, undefined, { timeout: callTimeout });
    assert.ok(!applied.isError);
    assert.deepEqual(calls.find(row => row.path.endsWith('/apply')).body, { token: 'synthetic_preview_token_110' });
    const refused = await client.callTool({ name: 'preview_settings_change', arguments: { projectId: 'proj_fixture', changes: { privacy: { preset: 'full' } } } }, undefined, { timeout: callTimeout });
    assert.equal(refused.isError, true);
    assert.match(JSON.stringify(refused), /privacy_weakening_refused/);
    for (const token of ['synthetic_expired_token_110', 'synthetic_stale_token_110']) {
      const result = await client.callTool({ name: 'apply_settings_change', arguments: { projectId: 'proj_fixture', token } }, undefined, { timeout: callTimeout });
      assert.equal(result.isError, true);
    }
    receipt.checks.push({ name: 'site creation validation, required consent, stable retry forwarding and settings preview/apply/refusal forwarding', status: 'passed', limit: 'API behavior is synthetic, not hosted authorization or atomicity proof' });
  });
  await connection('read-replay', ['--toolsets', 'read,replay'], async (_client, tools) => {
    assert.deepEqual(tools.filter(tool => mutating.has(tool.name)).map(tool => tool.name), ['explain_snags']);
    assert.deepEqual(tools.filter(tool => external.has(tool.name)).map(tool => tool.name), ['explain_snags']);
    receipt.checks.push({ name: 'read/replay effect boundary', status: 'observed',
      finding: 'explain_snags remains offered and can consume allowance through the model provider', modelCallsMade: 0 });
  });
  }
  mode = 'owner';
  await connection('pinned-all', ['--toolsets', 'all', '--project', 'proj_fixture'], async (_client, tools) => assert.ok(!tools.some(tool => tool.name === 'create_site')));
  mode = 'pat';
  await connection('pat-all', ['--toolsets', 'all'], async (_client, tools) => {
    assert.ok(!tools.some(tool => ['create_site', 'apply_settings_change', 'add_note', 'claim_issue'].includes(tool.name)));
    assert.ok(tools.some(tool => tool.name === 'start_setup'), 'Read/replay scopes do not themselves hide install/feedback writes');
  });
  mode = 'unknown';
  await connection('unknown-all', ['--toolsets', 'all'], async (_client, tools) => {
    assert.ok(!tools.some(tool => ['create_site', 'claim_issue'].includes(tool.name)));
    receipt.checks.push({ name: 'unknown access discovery surface', status: 'observed', caution: 'configure and annotate remain offered when scopes are unknown; API enforcement remains required' });
  });
  mode = 'read';
  await connection('viewer-read', ['--toolsets', 'read'], async (client, tools) => {
    assert.ok(!tools.some(tool => tool.name === 'get_session_narrative'));
    const result = await client.callTool({ name: 'list_recordings', arguments: { projectId: 'outside', limit: 1 } }, undefined, { timeout: callTimeout });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /outside|unknown_project/);
  });
  mode = 'redirect';
  await connection('redirect-refused', ['--toolsets', 'read'], async client => {
    const result = await client.callTool({ name: 'list_recordings', arguments: { projectId: 'proj_fixture', limit: 1 } }, undefined, { timeout: callTimeout });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /unavailable|Could not reach/);
    assert.ok(!calls.some(row => row.path === '/redirect-sentinel'), 'Redirect target was not requested');
  });
  assertActive();
  receipt.completed = true;
} catch (error) {
  receipt.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  for (const child of children) await stopChild(child, processObservations.find(row => row.pid === child.pid));
  for (const client of clients) await client.close();
  receipt.managedProcessObservations = processObservations;
  receipt.childrenClosed = processObservations.every(row => row.closed);
  receipt.deadlineExceeded = deadlineExceeded;
  if (deadlineExceeded || !receipt.childrenClosed) { receipt.completed = false; process.exitCode = 1; }
  if (api) { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); }
  receipt.fixtureClosed = true;
  receipt.finishedAt = new Date().toISOString();
  receipt.fixtureRequests = calls;
  receipt.realCredentialsUsed = false;
  receipt.productionRequests = 0;
  receipt.emailsSent = 0;
  receipt.cloudMutations = 0;
  receipt.limits = ['No production API, hosted authorization, tenant isolation, cloud indexes or physical retention tested.',
    'Fixture models denial, idempotency and settings states; it verifies published CLI forwarding and validation, not hosted enforcement.',
    'Read/replay toolsets restrict offered tools. Scopes and pins do not independently enforce access; the API must enforce it.',
    'Scanner observations are heuristic and not a blanket security certification. Runtime metadata scan does not execute all tool effects.',
    'Scanner server disposal relies on the vendor SDK finally-close; scanner-process exits and fixture SDK transport closes are observed, not an OS-wide process census.',
    'Client-native rendering, browser login, keychain and operating-system integrations are outside this run.'];
  await writeFile(join(output, 'run-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ completed: receipt.completed, profiles: receipt.profiles.length, fixtureRequests: calls.length,
    childrenClosed: receipt.childrenClosed, fixtureClosed: receipt.fixtureClosed, ...(receipt.error ? { error: receipt.error } : {}) }));
}
