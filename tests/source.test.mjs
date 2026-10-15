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

test('compiled SDK discovery explicitly classifies every tool across toolsets and connection profiles', { timeout: 60_000 }, async () => {
  const mutating = new Set(['create_site', 'start_setup', 'add_note', 'log_change', 'apply_settings_change', 'submit_issue', 'submit_issues', 'reply_issue', 'claim_issue', 'set_issue_status', 'update_issue', 'explain_snags']);
  const external = new Set(['check_install', 'start_setup', 'check_setup', 'explain_snags']);
  const calls = [];
  const scopes = ['read', 'replay', 'annotate', 'configure', 'sites:create', 'triage'];
  const api = createServer((request, response) => {
    calls.push({ method: request.method, path: request.url });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/access' && request.method === 'GET') return response.end(JSON.stringify({
      account: { id: 'synthetic-owner' }, credential: { kind: 'oauth', projects: 'all', scopes },
      projects: [{ id: 'proj_fixture', role: 'owner', permissions: ['read', 'replay', 'tokens', 'member'] }],
    }));
    response.writeHead(404).end('{}');
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const address = api.address(); assert.ok(address && typeof address === 'object');
  const toolsets = ['read', 'replay', 'annotate', 'configure', 'install', 'sites', 'feedback', 'issues'];
  const profiles = [
    ...toolsets.map(toolset => ({ name: `individual ${toolset}`, args: ['--toolsets', toolset] })),
    { name: 'all', args: ['--toolsets', 'all'] },
    { name: 'default', args: [] },
    { name: 'read and replay', args: ['--toolsets', 'read,replay'] },
    { name: 'pinned all', args: ['--toolsets', 'all', '--project', 'proj_fixture'] },
  ];
  try {
    for (const profile of profiles) {
      const client = new Client({ name: 'compiled-safety-fixture', version: '1' });
      const transport = new StdioClientTransport({ command: process.execPath, args: [cli, ...profile.args], cwd: root,
        env: { ...cleanEnv, HOOTLENS_PAT: 'synthetic_annotations_fixture', HOOTLENS_API_URL: `http://127.0.0.1:${address.port}` }, stderr: 'pipe' });
      try {
        await client.connect(transport, { timeout: 5_000 });
        const tools = (await client.listTools({}, { timeout: 5_000 })).tools;
        assert.ok(tools.some(tool => tool.name === 'whoami'), `${profile.name}: connection check is present`);
        for (const tool of tools) {
          assert.ok(tool.annotations, `${tool.name}: annotations are returned through the SDK`);
          for (const flag of ['readOnlyHint', 'destructiveHint', 'openWorldHint']) {
            assert.equal(Object.hasOwn(tool.annotations, flag), true, `${profile.name}: ${tool.name} owns ${flag}`);
            assert.equal(typeof tool.annotations[flag], 'boolean', `${profile.name}: ${tool.name}.${flag} is boolean`);
          }
          assert.equal(tool.annotations.readOnlyHint, !mutating.has(tool.name), `${tool.name}: read/write classification`);
          assert.equal(tool.annotations.destructiveHint, tool.name === 'apply_settings_change', `${tool.name}: destructive classification`);
          assert.equal(tool.annotations.openWorldHint, external.has(tool.name), `${tool.name}: external-system classification`);
        }
        if (profile.name === 'all') {
          assert.ok(tools.length >= 40, 'the compiled server offers every tool definition');
          for (const name of [...mutating, ...external]) assert.ok(tools.some(tool => tool.name === name), `${name}: override is covered`);
          assert.equal(tools.find(tool => tool.name === 'create_site').annotations.idempotentHint, true);
          assert.equal(tools.find(tool => tool.name === 'explain_snags').annotations.idempotentHint, false);
        }
        if (profile.name === 'pinned all') assert.ok(!tools.some(tool => tool.name === 'create_site'), 'metadata does not widen pinned-site access');
      } finally { await client.close(); }
    }
    assert.ok(calls.every(call => call.method === 'GET' && call.path === '/v1/access'), 'metadata discovery performs no tool action or customer-data read');
  } finally { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); }
});

test('compiled SDK duplicate checks omit unused report details and preserve matching evidence', { timeout: 30_000 }, async () => {
  const requests = [];
  const api = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/access') return response.end(JSON.stringify({ credential: { scopes: ['read', 'replay'] } }));
    if (request.url === '/v1/issues/similar' && request.method === 'POST') {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      requests.push(JSON.parse(raw));
      return response.end(JSON.stringify({ matches: [], checked: 0, scope: 'your issues' }));
    }
    response.writeHead(404).end('{}');
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const address = api.address(); assert.ok(address && typeof address === 'object');
  const client = new Client({ name: 'compiled-minimal-similarity-fixture', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, '--toolsets', 'feedback'], cwd: root,
    env: { ...cleanEnv, HOOTLENS_PAT: 'synthetic_similarity_fixture', HOOTLENS_API_URL: `http://127.0.0.1:${address.port}` }, stderr: 'pipe' });
  const context = {
    pageUrl: 'https://synthetic.example/pricing', route: '/recordings', selector: '[data-hoot-id="buy"]',
    elementKey: '[data-hoot-id="buy"]', hootId: 'buy', sourceLocation: 'src/Pricing.tsx:42',
    cohortKey: '["proj_fixture","/pricing","b","r","v","desktop"]', changeId: 'change_fixture',
    goalId: 'goal_fixture', funnelId: 'funnel_fixture', errorId: 'error_fixture',
    recordingIds: ['recording_fixture'], sessionIds: ['session_fixture'], recordingId: 'recording_fixture', sessionId: 'session_fixture',
  };
  const probe = { title: 'Buy button does not respond', projectId: 'proj_fixture', context, limit: 3 };
  try {
    await client.connect(transport, { timeout: 5_000 });
    const tool = (await client.listTools({}, { timeout: 5_000 })).tools.find(tool => tool.name === 'find_similar_issues');
    assert.ok(tool);
    const properties = tool.inputSchema.properties;
    assert.ok(!Object.hasOwn(properties, 'body'));
    assert.ok(!Object.hasOwn(properties, 'kind'));
    assert.ok(!Object.hasOwn(properties.context.properties, 'trackerVersion'));
    for (const field of Object.keys(context)) assert.ok(Object.hasOwn(properties.context.properties, field), `${field} remains available to the matcher`);
    const result = await client.callTool({ name: 'find_similar_issues', arguments: {
      ...probe, body: 'Synthetic report details that matching does not need', kind: 'bug',
      context: { ...context, trackerVersion: 'unused-fixture-version' },
    } }, undefined, { timeout: 5_000 });
    assert.ok(!result.isError);
    assert.deepEqual(requests, [probe], 'stale client fields never reach the API');
    assert.deepEqual(result.structuredContent, { matches: [], checked: 0, scope: 'your issues' });
  } finally { await client.close(); api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); }
});

test('the compiled explanation tool keeps allowance replies neutral and preserves other result states', { timeout: 30_000 }, async () => {
  let scenario = { status: 402, body: { code: 'ai_allowance', error: 'Starter limit reached. Upgrade to Growth at https://example.test/checkout.', resetsAt: Date.UTC(2026, 10, 1) } };
  const calls = [];
  const api = createServer((request, response) => {
    calls.push({ method: request.method, path: request.url });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/access') return response.end(JSON.stringify({ credential: { scopes: ['read'] } }));
    if (request.url === '/v1/projects') return response.end(JSON.stringify({ projects: [{ id: 'proj_fixture', name: 'Synthetic fixture' }] }));
    if (request.url === '/v1/projects/proj_fixture/explanations') return response.writeHead(scenario.status).end(JSON.stringify(scenario.body));
    return response.writeHead(404).end('{}');
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const address = api.address();
  assert.ok(address && typeof address === 'object');
  const client = new Client({ name: 'compiled-allowance-fixture', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, '--toolsets', 'read'], cwd: root,
    env: { ...cleanEnv, HOOTLENS_PAT: 'synthetic_compiled_allowance_fixture', HOOTLENS_API_URL: `http://127.0.0.1:${address.port}` }, stderr: 'pipe' });
  try {
    await client.connect(transport, { timeout: 5_000 });
    const tools = (await client.listTools({ cursor: '' }, { timeout: 5_000 })).tools;
    const description = tools.find(tool => tool.name === 'explain_snags').description;
    assert.doesNotMatch(description, /starter|growth|pro 2|free 10|upgrade/i);
    const call = () => client.callTool({ name: 'explain_snags', arguments: { projectId: 'proj_fixture', cohortKey: '["proj_fixture","/","b","r","v","desktop"]' } }, undefined, { timeout: 5_000 });
    const first = await call();
    assert.ok(!first.isError);
    assert.deepEqual(first.structuredContent, { status: 'allowance_used', message: 'The current AI explanation allowance is used. It resets on November 1, 2026. Saved results remain available.' });
    assert.doesNotMatch(JSON.stringify(first), /upgrade|starter|growth|checkout|example\.test/i);
    for (const resetsAt of [undefined, '2026-11-01', -1, 1.5, 8_640_000_000_000_001]) {
      scenario = { status: 402, body: { code: 'ai_allowance', error: 'Upgrade for more.', ...(resetsAt === undefined ? {} : { resetsAt }) } };
      const result = await call();
      assert.ok(!result.isError);
      assert.deepEqual(result.structuredContent, { status: 'allowance_used', message: 'The current AI explanation allowance is used. Saved results remain available.' });
    }
    for (const status of ['generated', 'cached', 'fallback']) {
      scenario = { status: 200, body: { status, explanation: { observation: 'Synthetic click evidence' } } };
      const result = await call(); assert.ok(!result.isError); assert.deepEqual(result.structuredContent, scenario.body);
    }
    scenario = { status: 403, body: { error: 'AI explanations are turned off for this project' } };
    const disabled = await call(); assert.equal(disabled.isError, true); assert.match(disabled.content[0].text, /AI explanations are turned off/);
    scenario = { status: 402, body: { code: 'other_entitlement', error: 'Other entitlement refusal' } };
    const unrelated = await call(); assert.equal(unrelated.isError, true); assert.equal(unrelated._meta['hootlens/error'].code, 'api_error');
    assert.doesNotMatch(JSON.stringify(unrelated), /allowance_used/);
    assert.equal(calls.filter(request => request.method === 'GET' && request.path === '/v1/projects').length, 1, 'the existing 403 helper confirms project access before explaining the refusal');
    assert.ok(calls.every(request => (request.method === 'GET' && ['/v1/access', '/v1/projects'].includes(request.path)) || (request.method === 'POST' && request.path === '/v1/projects/proj_fixture/explanations')));
  } finally {
    await client.close(); api.closeAllConnections(); await new Promise(resolve => api.close(resolve));
  }
});

test('the release sources match the recorded snapshot, including shared imports', async () => {
  const source = JSON.parse(await readFile(new URL('../docs/SOURCE.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const server = JSON.parse(await readFile(new URL('../server.json', import.meta.url), 'utf8'));
  assert.equal(source.version, '1.2.0');
  assert.equal(source.sourceCommit, 'fd167a771f3b819ed6932e81a538fa346a80116a');
  assert.equal(source.sourceUpdates, undefined, 'This release imports one complete immutable source commit');
  assert.equal(Object.keys(source.files).length, 80);
  assert.ok(source.files['src/cli/doctor.ts']);
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

test('the compiled server gates account setup and preserves its retry and consent contract', { timeout: 30_000 }, async () => {
  let mode = 'oauth';
  const creates = [];
  const api = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/access') {
      if (mode === 'unknown') return response.writeHead(403).end('{}');
      return response.end(JSON.stringify({ account: { id: 'synthetic-owner' }, credential: {
        kind: mode, projects: 'all', scopes: mode === 'oauth' ? ['read', 'sites:create'] : ['read'],
      }, projects: [] }));
    }
    if (request.url === '/v1/projects' && request.method === 'POST') {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      creates.push({ body: JSON.parse(raw), key: request.headers['idempotency-key'] });
      return response.writeHead(201).end(JSON.stringify({ project: { id: 'proj_created', name: 'Synthetic site' } }));
    }
    if (request.url?.startsWith('/v1/projects/proj_created/install-snippet')) return response.end(JSON.stringify({ tag: '<script data-project="proj_created"></script>', consent: 'required' }));
    response.writeHead(404).end('{}');
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const address = api.address();
  assert.ok(address && typeof address === 'object');
  async function connection(args, inspect) {
    // The fixture API supplies authority; this synthetic bearer is never sent to a real service.
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, ...args], cwd: root,
      env: { ...cleanEnv, HOOTLENS_PAT: 'synthetic_compiled_setup_fixture', HOOTLENS_API_URL: `http://127.0.0.1:${address.port}` }, stderr: 'pipe' });
    const client = new Client({ name: 'compiled-setup-fixture', version: '1.0.0' });
    try {
      await client.connect(transport, { timeout: 5_000 });
      const tools = await client.listTools({ cursor: '' }, { timeout: 5_000 });
      await inspect(client, tools.tools);
    } finally { await client.close(); }
  }
  try {
    await connection(['--toolsets', 'sites'], async (client, tools) => {
      assert.ok(tools.some(tool => tool.name === 'create_site'));
      const result = await client.callTool({ name: 'create_site', arguments: {
        name: 'Synthetic site', origins: ['https://synthetic.example'], idempotencyKey: 'compiled-setup-request',
      } }, undefined, { timeout: 5_000 });
      assert.ok(!result.isError);
      assert.deepEqual(creates, [{ key: 'compiled-setup-request', body: { name: 'Synthetic site', origins: ['https://synthetic.example'], privacy: { preset: 'balanced' }, consent: 'required' } }]);
      assert.equal(result.structuredContent.setupStatus.site, 'created');
      assert.equal(result.structuredContent.setupStatus.recording, 'not_checked');
      assert.ok(result.structuredContent.next.some(step => step.includes('read and install toolsets')));
    });
    const absent = async (_client, tools) => assert.ok(!tools.some(tool => tool.name === 'create_site'));
    await connection(['--project', 'proj_existing', '--toolsets', 'all'], absent);
    mode = 'pat';
    await connection(['--toolsets', 'all'], absent);
    mode = 'unknown';
    await connection(['--toolsets', 'all'], absent);
    assert.equal(creates.length, 1, 'negative connections never submit site creation');
  } finally {
    api.closeAllConnections();
    await new Promise(resolve => api.close(resolve));
  }
});

test('the standalone bundle reports the prepared version and CLI usage', async () => {
  const version = await run(process.execPath, [cli, '--version'], { cwd: root, env: cleanEnv, timeout: 10_000 });
  assert.equal(version.stdout.trim(), '1.2.0');
  assert.equal(version.stderr, '');
  const help = await run(process.execPath, [cli, '--help'], { cwd: root, env: cleanEnv, timeout: 10_000 });
  assert.match(help.stdout, /login\|logout\|whoami/);
  assert.match(help.stdout, /HOOTLENS_PAT/);
  const doctor = await run(process.execPath, [cli, 'doctor', '--help'], { cwd: root, env: cleanEnv, timeout: 10_000 });
  assert.match(doctor.stdout, /--authenticated/);
  assert.match(doctor.stdout, /--trust-api/);
});

test('the standalone doctor runs public probes without bearer and redacts invalid arguments', { timeout: 20_000 }, async () => {
  const requests = [];
  let origin;
  const api = createServer((request, response) => {
    requests.push({ path: request.url, auth: request.headers.authorization });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url === '/health' ? { ready: true }
      : request.url === '/.well-known/oauth-protected-resource' ? { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ['read', 'replay'] }
      : { issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`, code_challenge_methods_supported: ['S256'] }));
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${api.address().port}`;
  try {
    const result = await run(process.execPath, [cli, 'doctor', '--json', '--toolsets', 'read,replay'], { cwd: root, env: { ...cleanEnv, HOOTLENS_API_URL: origin, HOOTLENS_PAT: 'synthetic-doctor-secret' }, timeout: 15_000 });
    const report = JSON.parse(result.stdout);
    assert.equal(report.packageVersion, '1.2.0');
    assert.equal(report.ok, true);
    assert.equal(report.authenticatedMetadataVerified, false);
    assert.equal(report.investigationVerified, false);
    assert.equal(requests.length, 3);
    assert.ok(requests.every(request => !request.auth));
    assert.doesNotMatch(result.stdout, /synthetic-doctor-secret/);
    await assert.rejects(run(process.execPath, [cli, 'doctor', '--json', '--invalid', 'synthetic-doctor-secret'], { cwd: root, env: cleanEnv, timeout: 10_000 }), error => {
      assert.equal(error.code, 2);
      assert.equal(JSON.parse(error.stdout).checks[0].code, 'INVALID_OPTIONS');
      assert.doesNotMatch(error.stdout, /synthetic-doctor-secret/);
      return true;
    });
    assert.equal(requests.length, 3);
  } finally { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); }
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
    assert.equal(client.getServerVersion()?.version, '1.2.0');
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
