import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { assertInteractiveInvocation, createLocalConfigurationLoader, isAutomatedContext, parseSpaName,
  createTerraformRunner, runBrowserOriginUpdateGate, settleApprovalOnAbort, validateBrowserOriginUpdatePlan,
  expectedResourceAddresses, organizationName, workspaceName, targetAddress } from './apply-browser-origin-update.mjs';

const previous = {
  id: 'synthetic-spa-client-id', name: 'Aegis AI Local SPA', app_type: 'spa',
  callbacks: ['http://127.0.0.1:49321/auth/callback'],
  allowed_logout_urls: ['http://127.0.0.1:49321'],
  web_origins: ['http://127.0.0.1:49321'],
  allowed_origins: ['http://127.0.0.1:49321'],
  jwt_configuration: [{ alg: '', lifetime_in_seconds: 3600, scopes: {}, secret_encoded: false }],
  client_secret: 'SYNTHETIC_SECRET_MUST_NEVER_BE_LOGGED',
};
const desired = {
  ...previous,
  callbacks: [...previous.callbacks, 'http://127.0.0.1:5173/'],
  allowed_logout_urls: [...previous.allowed_logout_urls, 'http://127.0.0.1:5173'],
  web_origins: [...previous.web_origins, 'http://127.0.0.1:5173'],
  jwt_configuration: [{ ...previous.jwt_configuration[0], alg: 'RS256' }],
};

const outputChanges = Object.fromEntries([
  ['issuer', 'https://dev-example.auth0.com/'],
  ['audience', 'https://aegis-ai.local/api'],
  ['spa_client_id', 'synthetic-spa-client-id'],
].map(([name, value]) => [name, { actions: ['no-op'], before: value, after: value,
  after_unknown: false, before_sensitive: false, after_sensitive: false }]));

function change(address, actions, before, after, extra = {}) {
  const [type, name] = address.split('.');
  return { address, mode: 'managed', type, name, provider_name: 'registry.terraform.io/auth0/auth0',
    change: { actions, before, after, after_unknown: {}, ...extra } };
}
function plan() {
  const items = expectedResourceAddresses.map((address) => address === targetAddress
    ? change(address, ['update'], structuredClone(previous), structuredClone(desired), {
      before_sensitive: { client_secret: true },
      after_sensitive: { client_secret: true },
      after_unknown: {},
    })
    : change(address, ['no-op'], { id: address }, { id: address }));
  return { format_version: '1.2', terraform_version: '1.9.8', errored: false, complete: true, applyable: true,
    resource_changes: items, resource_drift: [], deferred_changes: [], action_invocations: [], output_changes: structuredClone(outputChanges) };
}
const expectedSpa = { spaName: 'Aegis AI Local SPA', spaClientId: 'synthetic-spa-client-id' };

test('uses the Terraform SPA-name default and rejects malformed or duplicate overrides', () => {
  assert.equal(parseSpaName('auth0_domain = "dev-example.auth0.com"\n'), 'Aegis AI Local SPA');
  assert.equal(parseSpaName('spa_name = "Reviewed Local SPA" # approved\n'), 'Reviewed Local SPA');
  assert.throws(() => parseSpaName('spa_name = var.other\n'), /malformed/);
  assert.throws(() => parseSpaName('spa_name = "One"\nspa_name = "Two"\n'), /duplicate/);
  assert.throws(() => parseSpaName('spa_name = ""\n'), /malformed/);
});

test('production configuration loader accepts an omitted options object using only synthetic filesystem adapters', async () => {
  const fixtures = new Map([
    ['.env.auth0', 'AUTH0_DOMAIN=dev-example.auth0.com\nAUTH0_CLIENT_ID=synthetic-management-id\nAUTH0_CLIENT_SECRET=synthetic-management-secret\n'],
    ['.env.api', 'AUTH0_ISSUER=https://dev-example.auth0.com/\nAUTH0_SPA_CLIENT_ID=synthetic-spa-client-id\n'],
    ['terraform.tfvars', 'auth0_domain = "dev-example.auth0.com"\ndatabase_connection_id = "con_synthetic"\n'],
  ]);
  const reads = [];
  const loader = createLocalConfigurationLoader({
    statImpl: async (file) => ({
      isFile: () => true,
      isSymbolicLink: () => false,
      mode: 0o100600,
      fixtureName: file.split('/').at(-1),
    }),
    readFileImpl: async (file) => {
      const name = file.split('/').at(-1);
      reads.push(name);
      if (!fixtures.has(name)) throw new Error('Unexpected synthetic fixture path.');
      return fixtures.get(name);
    },
  });

  const config = await loader();

  assert.deepEqual(reads.sort(), ['.env.api', '.env.auth0', 'terraform.tfvars']);
  assert.deepEqual(config, {
    auth0Domain: 'dev-example.auth0.com',
    auth0ClientId: 'synthetic-management-id',
    auth0ClientSecret: 'synthetic-management-secret',
    spaName: 'Aegis AI Local SPA',
    spaClientId: 'synthetic-spa-client-id',
  });
});
function state(overrides = {}) {
  return { organization: organizationName, plan: 'free', workspace: workspaceName, workspaceId: 'ws-aegis-dev',
    executionMode: 'local', autoApply: false, state: 'verified-managed-state', backendFingerprint: 'backend-fingerprint',
    stateVersionId: 'sv-123', serial: 8, inventoryHash: 'inventory-hash', ...overrides };
}

function makeDeps(overrides = {}) {
  const calls = { terraform: [], preflight: [], removed: [], chmod: [], written: [], output: '' };
  const document = overrides.document ?? plan();
  const bytes = Buffer.from('synthetic-binary-plan');
  const fs = {
    lstatImpl: async (file) => ({ isDirectory: () => !file.endsWith('reviewed.tfplan'),
      isFile: () => file.endsWith('reviewed.tfplan'), isSymbolicLink: () => false,
      mode: file.endsWith('reviewed.tfplan') ? 0o600 : 0o700 }),
    readdirImpl: async () => [],
    mkdtempImpl: async () => '/private/test/.terraform/.aegis-browser-origin-update-unit',
    chmodImpl: async (file, mode) => calls.chmod.push([file, mode]),
    readFileImpl: async () => bytes,
    rmImpl: async (directory) => calls.removed.push(directory),
    ...overrides.fs,
  };
  let showCount = 0;
  const runTerraform = async (args) => {
    calls.terraform.push([...args]);
    if (args[0] === 'show') {
      showCount += 1;
      const selected = overrides.secondPlan && showCount > 1 ? overrides.secondPlan : document;
      return { code: 0, stdout: JSON.stringify(selected), stderr: 'SYNTHETIC_STDERR_SECRET' };
    }
    return { code: overrides.terraformFailure?.(args) ? 1 : 0, stdout: '', stderr: 'SYNTHETIC_STDERR_SECRET' };
  };
  let verificationCount = 0;
  const verifyHcp = async (options) => {
    calls.preflight.push(options);
    verificationCount += 1;
    return overrides.stateAt?.(verificationCount) ?? state();
  };
  const requestApproval = async (challenge, metadata) => {
    calls.challenge = challenge;
    calls.metadata = metadata;
    return overrides.approve ? overrides.approve(challenge, metadata) : true;
  };
  const deps = { runTerraform, verifyHcp, loadConfiguration: async () => ({ auth0Domain: 'dev-example.auth0.com',
    auth0ClientId: 'public-client-id', auth0ClientSecret: 'SYNTHETIC_SECRET_MUST_NEVER_BE_LOGGED', ...expectedSpa }),
    requestApproval, fs, now: overrides.now ?? (() => 1_000), io: { write: (text) => { calls.output += text; } }, ...overrides.deps };
  return { deps, calls };
}

test('validates the precise SPA URL and JWT signing updates while preserving all other attributes', () => {
  const result = validateBrowserOriginUpdatePlan(plan(), expectedSpa);
  assert.deepEqual([result.creates, result.updates, result.deletes], [0, 1, 0]);
  assert.deepEqual(result.after.callbacks, desired.callbacks);
  assert.deepEqual(result.after.web_origins, desired.web_origins);
  assert.deepEqual(result.jwtAlgorithm, { before: 'empty-string', after: 'RS256' });
});

for (const [name, mutate] of [
  ['extra resource', (p) => p.resource_changes.push(change('auth0_client.extra', ['create'], null, {}))],
  ['missing resource', (p) => p.resource_changes.pop()],
  ['resource replacement', (p) => { p.resource_changes.find((x) => x.address === targetAddress).change.actions = ['delete', 'create']; }],
  ['unexpected SPA attribute', (p) => { p.resource_changes.find((x) => x.address === targetAddress).change.after.name = 'foreign'; }],
  ['removed smoke callback', (p) => { p.resource_changes.find((x) => x.address === targetAddress).change.after.callbacks = ['http://127.0.0.1:5173/']; }],
  ['unexpected CORS change', (p) => { p.resource_changes.find((x) => x.address === targetAddress).change.after.allowed_origins.push('http://127.0.0.1:5173'); }],
  ['malformed actions', (p) => { p.resource_changes[0].change.actions = 'no-op'; }],
  ['unknown marker', (p) => { p.resource_changes.find((x) => x.address === targetAddress).change.after_unknown.name = true; }],
  ['drift', (p) => { p.resource_drift = [change('auth0_client.foreign', ['update'], {}, {})]; }],
  ['output change', (p) => { p.output_changes.audience.actions = ['update']; }],
  ['deferred change', (p) => { p.deferred_changes = [{}]; }],
  ['unsupported format', (p) => { p.format_version = '2.0'; }],
  ['malformed unknown metadata', (p) => { p.resource_changes.find((item) => item.address === targetAddress).change.after_unknown.name = 'maybe'; }],
  ['malformed before-sensitive metadata', (p) => { p.resource_changes.find((item) => item.address === targetAddress).change.before_sensitive.name = null; }],
  ['malformed after-sensitive metadata', (p) => { p.resource_changes.find((item) => item.address === targetAddress).change.after_sensitive.name = 1; }],
]) {
  test(`rejects ${name}`, () => {
    const document = plan();
    mutate(document);
    assert.throws(() => validateBrowserOriginUpdatePlan(document, expectedSpa), /Terraform/);
  });
}

for (const [name, mutate] of [
  ['a changed JWT sibling setting', (change) => { change.after.jwt_configuration[0].lifetime_in_seconds = 7200; }],
  ['a changed JWT scope', (change) => { change.after.jwt_configuration[0].scopes = { openid: 'openid' }; }],
  ['a missing JWT configuration', (change) => { delete change.before.jwt_configuration; }],
  ['an HS256 before algorithm', (change) => { change.before.jwt_configuration[0].alg = 'HS256'; }],
  ['a nonstandard before algorithm', (change) => { change.before.jwt_configuration[0].alg = 'ES512'; }],
  ['a missing before algorithm', (change) => { delete change.before.jwt_configuration[0].alg; }],
  ['a whitespace before algorithm', (change) => { change.before.jwt_configuration[0].alg = ' '; }],
  ['an unexpected after algorithm', (change) => { change.after.jwt_configuration[0].alg = 'HS256'; }],
  ['an unknown JWT algorithm', (change) => { change.after_unknown.jwt_configuration = [{ alg: true }]; }],
  ['a sensitive JWT algorithm', (change) => { change.before_sensitive.jwt_configuration = [{ alg: true }]; }],
  ['malformed nested unknown metadata', (change) => { change.after_unknown.jwt_configuration = [{ alg: 'unknown' }]; }],
  ['malformed nested sensitive metadata', (change) => { change.after_sensitive.jwt_configuration = [{ alg: null }]; }],
  ['an out-of-shape mask key', (change) => { change.after_unknown.unexpected = false; }],
  ['a wrong-length list mask', (change) => { change.after_unknown.jwt_configuration = [{}, {}]; }],
  ['an object mask for a scalar algorithm', (change) => { change.after_unknown.jwt_configuration = [{ alg: {} }]; }],
  ['the entire JWT block marked sensitive', (change) => { change.before_sensitive.jwt_configuration = true; }],
]) {
  test(`rejects ${name}`, () => {
    const document = plan();
    mutate(document.resource_changes.find((item) => item.address === targetAddress).change);
    assert.throws(() => validateBrowserOriginUpdatePlan(document, expectedSpa), /Terraform/);
  });
}

test('accepts Terraform sparse masks when all JWT values are known and non-sensitive', () => {
  for (const nestedMask of [{}, { jwt_configuration: [{}] }]) {
    const document = plan();
    const target = document.resource_changes.find((item) => item.address === targetAddress).change;
    target.after_unknown = structuredClone(nestedMask);
    target.before_sensitive = { client_secret: true, ...structuredClone(nestedMask) };
    target.after_sensitive = { client_secret: true, ...structuredClone(nestedMask) };
    assert.deepEqual(validateBrowserOriginUpdatePlan(document, expectedSpa).jwtAlgorithm, { before: 'empty-string', after: 'RS256' });
  }
});

for (const [name, mutate] of [
  ['a missing output', (outputs) => { delete outputs.issuer; }],
  ['an unexpected output', (outputs) => { outputs.unexpected = outputs.audience; }],
  ['a changed output value', (outputs) => { outputs.audience.after = 'synthetic-different-audience'; }],
  ['an unknown output value', (outputs) => { outputs.spa_client_id.after_unknown = true; }],
  ['a sensitive output value', (outputs) => { outputs.issuer.after_sensitive = true; }],
  ['an output with malformed actions', (outputs) => { outputs.audience.actions = ['read']; }],
]) {
  test(`rejects ${name}`, () => {
    const document = plan();
    mutate(document.output_changes);
    assert.throws(() => validateBrowserOriginUpdatePlan(document, expectedSpa), /output/i);
  });
}

test('rejects a plan for a different client ID, application name or non-SPA application', () => {
  const document = plan();
  assert.throws(() => validateBrowserOriginUpdatePlan(document, { ...expectedSpa, spaClientId: 'foreign-client-id' }), /identity/);
  assert.throws(() => validateBrowserOriginUpdatePlan(document, { ...expectedSpa, spaName: 'Foreign SPA' }), /identity/);
  assert.throws(() => validateBrowserOriginUpdatePlan(document), /identity/);
  for (const [key, value] of [['id', 'foreign-client-id'], ['name', 'Foreign SPA'], ['app_type', 'native']]) {
    const altered = plan();
    const target = altered.resource_changes.find((item) => item.address === targetAddress).change;
    target.before[key] = value;
    target.after[key] = value;
    assert.throws(() => validateBrowserOriginUpdatePlan(altered, expectedSpa), /identity/);
  }
});

test('Terraform runner waits for child close after cancellation before allowing private-plan cleanup', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  let spawnOptions;
  const runner = createTerraformRunner({ spawnImpl: (_command, _args, options) => {
    spawnOptions = options;
    queueMicrotask(() => child.emit('error', Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })));
    return child;
  } });
  const controller = new AbortController();
  let settled = false;
  const result = runner(['plan', '-out=private.tfplan'], { cwd: '/private/plan', env: {}, signal: controller.signal })
    .finally(() => { settled = true; });
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawnOptions.signal, controller.signal);
  assert.equal(settled, false);
  child.emit('close', null);
  await assert.rejects(result, /could not be started/);
  assert.equal(settled, true);
});

test('rejects workspace identity mismatch and stale state version before apply', async () => {
  for (const overrides of [
    { stateAt: (count) => state(count === 1 ? {} : { workspace: 'other' }) },
    { stateAt: (count) => state(count === 1 ? {} : { stateVersionId: 'changed-version' }) },
    { stateAt: () => state({ autoApply: true }) },
    { stateAt: () => state({ executionMode: 'remote' }) },
    { stateAt: () => state({ backendFingerprint: null }) },
    { stateAt: () => state({ inventoryHash: '' }) },
  ]) {
    const { deps, calls } = makeDeps(overrides);
    await assert.rejects(runBrowserOriginUpdateGate(deps), /workspace and state|identity changed/);
    assert.equal(calls.terraform.some(([command]) => command === 'apply'), false);
    assert.equal(calls.removed.length, 1);
  }
});

test('requests exact full fingerprint confirmation and applies only the saved reviewed plan', async () => {
  const { deps, calls } = makeDeps();
  const result = await runBrowserOriginUpdateGate(deps);
  assert.equal(result.applied, true);
  assert.match(calls.challenge, new RegExp(`^APPLY ${organizationName}/${workspaceName} ${targetAddress} browser-URLs-and-JWT-RS256 [a-f0-9]{64}$`));
  assert.equal(calls.metadata.expiresAt - 1_000, 5 * 60 * 1000);
  assert.deepEqual(calls.preflight, Array.from({ length: 3 }, () => ({ mode: 'reinit', terraformRoot: calls.preflight[0].terraformRoot })));
  assert.match(calls.challenge, /browser-URLs-and-JWT-RS256/);
  assert.match(calls.output, /SPA JWT signing algorithm: empty-string -> RS256/);
  const apply = calls.terraform.find(([command]) => command === 'apply');
  assert.deepEqual(apply.slice(0, 3), ['apply', '-input=false', '-no-color']);
  assert.equal(apply.some((arg) => arg.includes('auto-approve') || arg.startsWith('-target') || arg.startsWith('-replace')), false);
  assert.equal(calls.removed.length, 1);
  assert.equal(calls.chmod.some(([file, mode]) => file.endsWith('reviewed.tfplan') && mode === 0o600), true);
  assert.equal(calls.chmod.some(([file, mode]) => file.includes('.aegis-browser-origin-update-') && mode === 0o700), true);
  assert.equal(calls.output.includes('SYNTHETIC_SECRET'), false);
  assert.equal(calls.output.includes('client_secret'), false);
});

test('does not apply when confirmation is missing or stale', async () => {
  for (const overrides of [
    { approve: async () => false },
    { now: (() => { let n = 1_000; return () => { n += 5 * 60 * 1000 + 1; return n; }; })() },
  ]) {
    const { deps, calls } = makeDeps(overrides);
    await assert.rejects(runBrowserOriginUpdateGate(deps), /approval.*expired|missing|incorrect/i);
    assert.equal(calls.terraform.some(([command]) => command === 'apply'), false);
    assert.equal(calls.removed.length, 1);
  }
});

test('does not apply on interrupted operation and always cleans its plan directory', async () => {
  const controller = new AbortController();
  const { deps, calls } = makeDeps({ approve: async () => { controller.abort(); return true; }, deps: { signal: controller.signal } });
  await assert.rejects(runBrowserOriginUpdateGate(deps), /interrupted/);
  assert.equal(calls.terraform.some(([command]) => command === 'apply'), false);
  assert.equal(calls.removed.length, 1);
});

test('cleans the private plan directory on startup cancellation or configuration failure', async () => {
  const controller = new AbortController();
  controller.abort();
  const cancelled = makeDeps({ deps: { signal: controller.signal } });
  await assert.rejects(runBrowserOriginUpdateGate(cancelled.deps), /interrupted/);
  assert.equal(cancelled.calls.terraform.length, 0);
  assert.equal(cancelled.calls.removed.length, 1);

  const failedConfig = makeDeps({ deps: { loadConfiguration: async () => { throw new Error('synthetic config failure'); } } });
  await assert.rejects(runBrowserOriginUpdateGate(failedConfig.deps), /synthetic config failure/);
  assert.equal(failedConfig.calls.terraform.length, 0);
  assert.equal(failedConfig.calls.removed.length, 1);
});

test('fails closed on cleanup failure and stale private artifacts', async () => {
  const first = makeDeps({ fs: { rmImpl: async () => { throw new Error('raw filesystem detail'); } } });
  await assert.rejects(runBrowserOriginUpdateGate(first.deps), /cleanup failed/);
  const stale = makeDeps({ fs: { readdirImpl: async () => ['.aegis-browser-origin-update-leftover'] } });
  await assert.rejects(runBrowserOriginUpdateGate(stale.deps), /previous private plan artifact/);
  assert.equal(stale.calls.terraform.length, 0);
});

test('failed plan or apply does not retry and cleans private files', async () => {
  const planFailure = makeDeps({ terraformFailure: (args) => args[0] === 'plan' });
  await assert.rejects(runBrowserOriginUpdateGate(planFailure.deps), /Terraform operation failed/);
  assert.equal(planFailure.calls.terraform.filter(([command]) => command === 'plan').length, 1);
  assert.equal(planFailure.calls.removed.length, 1);
  const applyFailure = makeDeps({ terraformFailure: (args) => args[0] === 'apply' });
  await assert.rejects(runBrowserOriginUpdateGate(applyFailure.deps), /Terraform operation failed/);
  assert.equal(applyFailure.calls.terraform.filter(([command]) => command === 'apply').length, 1);
  assert.equal(applyFailure.calls.removed.length, 1);
});

test('detects saved plan replacement before apply', async () => {
  let read = 0;
  const replaced = makeDeps({ fs: { readFileImpl: async () => Buffer.from(`plan-${++read}`) } });
  await assert.rejects(runBrowserOriginUpdateGate(replaced.deps), /plan changed/);
  assert.equal(replaced.calls.terraform.some(([command]) => command === 'apply'), false);
});

test('entrypoint automation detection is fail closed for test and Codex contexts', () => {
  assert.equal(isAutomatedContext({}), false);
  assert.equal(isAutomatedContext({ CI: 'true' }), true);
  assert.equal(isAutomatedContext({ CODEX_THREAD_ID: 'test' }), true);
});

test('entrypoint requires a real terminal, no arguments and no automated context', () => {
  assert.doesNotThrow(() => assertInteractiveInvocation({ argv: ['node', 'gate.mjs'], stdinIsTTY: true, stdoutIsTTY: true, env: {} }));
  assert.throws(() => assertInteractiveInvocation({ argv: ['node', 'gate.mjs'], stdinIsTTY: false, stdoutIsTTY: true, env: {} }), /interactive/);
  assert.throws(() => assertInteractiveInvocation({ argv: ['node', 'gate.mjs'], stdinIsTTY: true, stdoutIsTTY: false, env: {} }), /interactive/);
  assert.throws(() => assertInteractiveInvocation({ argv: ['node', 'gate.mjs', '--yes'], stdinIsTTY: true, stdoutIsTTY: true, env: {} }), /interactive/);
  assert.throws(() => assertInteractiveInvocation({ argv: ['node', 'gate.mjs'], stdinIsTTY: true, stdoutIsTTY: true, env: { CI: 'true' } }), /interactive/);
});

test('rejects a non-file or broadly permissioned plan artifact before inspection', async () => {
  for (const planFile of [
    { isFile: () => false, isSymbolicLink: () => false, mode: 0o600 },
    { isFile: () => true, isSymbolicLink: () => true, mode: 0o600 },
    { isFile: () => true, isSymbolicLink: () => false, mode: 0o644 },
  ]) {
    let reads = 0;
    const { deps, calls } = makeDeps({ fs: { lstatImpl: async (file) => file.endsWith('reviewed.tfplan')
      ? planFile : { isDirectory: () => true, isSymbolicLink: () => false, mode: 0o700 },
      readFileImpl: async () => { reads += 1; return Buffer.from('synthetic-plan'); } } });
    await assert.rejects(runBrowserOriginUpdateGate(deps), /plan artifact/);
    assert.equal(reads, 0);
    assert.equal(calls.terraform.some(([command]) => command === 'apply'), false);
    assert.equal(calls.removed.length, 1);
  }
});

test('cancellation settles a pending approval prompt without accepting it', async () => {
  const controller = new AbortController();
  let finishPrompt;
  const pendingPrompt = new Promise((resolve) => { finishPrompt = resolve; });
  const result = settleApprovalOnAbort(pendingPrompt, controller.signal);
  controller.abort();
  assert.equal(await result, false);
  finishPrompt(true);
});

test('abort while awaiting confirmation cleans up and never applies', async () => {
  const controller = new AbortController();
  let promptStarted;
  const started = new Promise((resolve) => { promptStarted = resolve; });
  const { deps, calls } = makeDeps({ deps: { signal: controller.signal,
    requestApproval: (_challenge, { signal }) => new Promise((resolve) => {
      promptStarted();
      signal.addEventListener('abort', () => resolve(false), { once: true });
    }) } });
  const operation = runBrowserOriginUpdateGate(deps);
  await started;
  controller.abort();
  await assert.rejects(operation, /approval.*missing|incorrect|expired/i);
  assert.equal(calls.terraform.some(([command]) => command === 'apply'), false);
  assert.equal(calls.removed.length, 1);
});
