import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runRefreshOnlyPlan, validateRefreshOnlyPlan, expectedResourceAddresses,
  assertRefreshOnlyInvocation, createRefreshOnlyAdapters, refreshOnlyConfirmation } from './plan-state-reconciliation.mjs';

const provider = 'registry.terraform.io/auth0/auth0';
const secretSentinel = 'SYNTHETIC_SENSITIVE_VALUE_MUST_NOT_BE_EMITTED';
const sensitiveKey = 'synthetic_sensitive_value';
const schema = JSON.stringify({ format_version: '1.0', provider_schemas: { [provider]: { resource_schemas: {
  auth0_client: { version: 4, block: { attributes: {
    allowed_clients: { optional: true, type: ['list', 'string'] },
    async_approval_notification_channels: { optional: true, type: ['list', 'string'] },
    client_aliases: { optional: true, type: ['list', 'string'] },
    client_metadata: { optional: true, type: ['map', 'string'] },
    [sensitiveKey]: { optional: true, sensitive: true, type: 'string' },
  } } },
} } } });
function resource(address, action = ['no-op'], before = {}, after = before) {
  const [type, name] = address.split('.');
  return { address, mode: 'managed', type, name, provider_name: provider,
    change: { actions: action, before: structuredClone(before), after: structuredClone(after), after_unknown: {} } };
}
function validPlan(overrides = {}) {
  const before = { allowed_clients: null, async_approval_notification_channels: null, client_aliases: null,
    client_metadata: null, [sensitiveKey]: secretSentinel };
  const after = { allowed_clients: [], async_approval_notification_channels: [], client_aliases: [],
    client_metadata: {}, [sensitiveKey]: secretSentinel };
  const beforeSensitive = { [sensitiveKey]: true };
  const afterSensitive = { [sensitiveKey]: true };
  const resourceDrift = [{ address: 'auth0_client.local_spa', mode: 'managed', type: 'auth0_client', name: 'local_spa',
    provider_name: provider, change: { actions: ['update'], before, after, before_sensitive: beforeSensitive,
      after_sensitive: afterSensitive, after_unknown: {} } }];
  const document = { format_version: '1.2', terraform_version: '1.17.1', errored: false, complete: true, applyable: true,
    resource_changes: [],
    resource_drift: resourceDrift, deferred_changes: [], action_invocations: [], output_changes: {
      issuer: { actions: ['no-op'], before: 'https://issuer.invalid/', after: 'https://issuer.invalid/', after_unknown: false, before_sensitive: false, after_sensitive: false },
      audience: { actions: ['no-op'], before: 'https://audience.invalid/api', after: 'https://audience.invalid/api', after_unknown: false, before_sensitive: false, after_sensitive: false },
      spa_client_id: { actions: ['no-op'], before: 'synthetic-public-client', after: 'synthetic-public-client', after_unknown: false, before_sensitive: false, after_sensitive: false },
    }, ...overrides };
  return document;
}
const identity = (overrides = {}) => ({ organization: 'aegis-ai-portfolio', plan: 'free', workspace: 'aegis-auth0-dev',
  workspaceId: 'synthetic-workspace-id', executionMode: 'local', autoApply: false, state: 'verified-managed-state',
  backendFingerprint: 'a'.repeat(64), stateVersionId: 'synthetic-state-v1', serial: 7, inventoryHash: 'b'.repeat(64), ...overrides });
function fsFixture({ cleanupFails = false } = {}) {
  const calls = { chmod: [], removed: [] };
  return { calls, fs: {
    lstatImpl: async (file) => file.endsWith('refresh-only.tfplan')
      ? { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, mode: 0o100600 }
      : { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, mode: 0o40700 },
    chmodImpl: async (file, mode) => calls.chmod.push([file, mode]),
    readdirImpl: async () => [],
    mkdtempImpl: async () => '/module/.terraform/.aegis-state-reconciliation-test',
    rmImpl: async (directory) => { if (cleanupFails) throw new Error('synthetic cleanup failure'); calls.removed.push(directory); },
  } };
}
function adapters({ onVerify, onPlan, onShow, onSchema, fs = fsFixture() } = {}) {
  let verification = 0;
  return { fs, state: fs, verifyCalls: () => verification,
    deps: {
      getPinnedProviderVersion: async () => '1.59.0',
      verifyHcp: async () => { verification += 1; return onVerify ? onVerify(verification) : identity(); },
      loadConfiguration: async () => ({ auth0Domain: 'dev.example.invalid', auth0ClientId: 'synthetic-client', auth0ClientSecret: 'synthetic-secret' }),
      runProviderSchema: async () => onSchema ? onSchema() : schema,
      runPlan: async () => { if (onPlan) await onPlan(); },
      showPlan: async () => JSON.stringify(onShow ? onShow() : validPlan()),
      fs: fs.fs,
    } };
}

test('accepts only the exact intended four null-to-empty drift shapes and equal sensitive value', () => {
  const summary = validateRefreshOnlyPlan(validPlan(), schema);
  assert.deepEqual(summary, { result: 'accepted-read-only-refresh-plan', mode: 'refresh-only-plan', terraformVersion: '1.17.1',
    jsonFormatVersion: '1.2', stateInventoryCount: 5, resourceDriftCount: 1, approvedShapeChanges: 4,
    sensitiveComparison: 'equal', outputChanges: 'none', remoteResourceActions: 0, stateWritePerformed: false });
  assert.equal(JSON.stringify(summary).includes(secretSentinel), false);
  assert.equal(JSON.stringify(summary).includes(sensitiveKey), false);
});

test('accepts Terraform 1.17 JSON omission of empty resource_changes and proposed_unknown fields', () => {
  const document = validPlan();
  delete document.resource_changes;
  delete document.proposed_unknown;
  assert.equal(validateRefreshOnlyPlan(document, schema).result, 'accepted-read-only-refresh-plan');
});

test('rejects HCP identity, state-version, and inventory mismatches during rechecks', async () => {
  const stale = adapters({ onVerify: (count) => count >= 3 ? identity({ stateVersionId: 'synthetic-replaced-state' }) : identity() });
  await assert.rejects(runRefreshOnlyPlan(stale.deps), /stopped safely/);
  assert.equal(stale.state.calls.removed.length, 1);
  const foreign = adapters({ onVerify: () => identity({ workspace: 'foreign-workspace' }) });
  await assert.rejects(runRefreshOnlyPlan(foreign.deps), /state identity/i);
});

test('rejects unavailable, different, or malformed sensitive value comparisons without disclosure', () => {
  const different = validPlan();
  different.resource_drift[0].change.after[sensitiveKey] = 'DIFFERENT_SYNTHETIC_SECRET';
  assert.throws(() => validateRefreshOnlyPlan(different, schema), /sensitive drift|schema/i);
  const missingMask = validPlan();
  delete missingMask.resource_drift[0].change.before_sensitive;
  assert.throws(() => validateRefreshOnlyPlan(missingMask, schema), /sensitive drift|schema/i);
  const unknown = validPlan();
  unknown.resource_drift[0].change.after_unknown[sensitiveKey] = true;
  assert.throws(() => validateRefreshOnlyPlan(unknown, schema), /sensitive drift|schema/i);
  assert.throws(() => validateRefreshOnlyPlan(validPlan(), '{malformed'), /sensitive drift|schema/i);
  for (const document of [different, missingMask, unknown]) {
    const error = (() => { try { validateRefreshOnlyPlan(document, schema); } catch (caught) { return caught.message; } })();
    assert.equal(error.includes(secretSentinel), false);
    assert.equal(error.includes('DIFFERENT_SYNTHETIC_SECRET'), false);
  }
});

test('rejects shape mismatches, extra drift, replacements, resources, output changes and unknown values', () => {
  const mutations = [
    (doc) => { doc.resource_drift[0].change.after.allowed_clients = ['synthetic-client']; },
    (doc) => { doc.resource_drift[0].change.after.client_metadata = { synthetic: 'value' }; },
    (doc) => { doc.resource_drift[0].change.after.unexpected = 'extra'; },
    (doc) => { doc.resource_drift.push(structuredClone(doc.resource_drift[0])); },
    (doc) => { doc.resource_changes.push(resource(expectedResourceAddresses[0], ['create'], {}, { name: 'synthetic' })); },
    (doc) => { doc.resource_changes.push(resource(expectedResourceAddresses[0], ['delete'], { name: 'synthetic' }, {})); },
    (doc) => { doc.resource_changes.push(resource(expectedResourceAddresses[0], ['delete', 'create'], { name: 'synthetic' }, { name: 'replacement' })); },
    (doc) => { doc.resource_changes.push({}); },
    (doc) => { doc.output_changes.issuer.after = 'different'; },
    (doc) => { doc.output_changes.unexpected = { actions: ['no-op'] }; },
    (doc) => { doc.action_invocations = [{ action: 'unexpected' }]; },
    (doc) => { doc.deferred_changes = [{}]; },
    (doc) => { doc.complete = false; },
    (doc) => { doc.proposed_unknown = { unknown: true }; },
    (doc) => { doc.proposed_unknown = 'malformed'; },
    (doc) => { doc.resource_changes = { malformed: true }; },
  ];
  for (const mutate of mutations) {
    const document = validPlan();
    mutate(document);
    assert.throws(() => validateRefreshOnlyPlan(document, schema), /plan|drift|inventory|schema|output/i);
  }
});

test('read-only orchestration uses protected cleanup on success, failure, cancellation, and stale state', async () => {
  const success = adapters();
  const result = await runRefreshOnlyPlan(success.deps);
  assert.equal(result.stateWritePerformed, false);
  assert.equal(success.state.calls.removed.length, 1);
  assert.ok(success.state.calls.chmod.some(([, mode]) => mode === 0o700));
  assert.ok(success.state.calls.chmod.some(([, mode]) => mode === 0o600));

  const failure = adapters({ onShow: () => ({ malformed: true }) });
  await assert.rejects(runRefreshOnlyPlan(failure.deps), /stopped safely/);
  assert.equal(failure.state.calls.removed.length, 1);

  const schemaFailure = adapters({ onSchema: () => { throw new Error('synthetic schema failure'); } });
  await assert.rejects(runRefreshOnlyPlan(schemaFailure.deps), /stopped safely/);
  assert.equal(schemaFailure.state.calls.removed.length, 1);

  const unsafeFile = fsFixture();
  unsafeFile.fs.lstatImpl = async (file) => file.endsWith('refresh-only.tfplan')
    ? { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, mode: 0o100644 }
    : { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, mode: 0o40700 };
  const unsafePlan = adapters({ fs: unsafeFile });
  await assert.rejects(runRefreshOnlyPlan(unsafePlan.deps), /stopped safely/);
  assert.equal(unsafePlan.state.calls.removed.length, 1);

  const controller = new AbortController();
  const cancelled = adapters({ onPlan: () => controller.abort() });
  cancelled.deps.signal = controller.signal;
  await assert.rejects(runRefreshOnlyPlan(cancelled.deps), /stopped safely/);
  assert.equal(cancelled.state.calls.removed.length, 1);

  const cleanupFailure = adapters({ fs: fsFixture({ cleanupFails: true }) });
  await assert.rejects(runRefreshOnlyPlan(cleanupFailure.deps), /cleanup failed/i);

  const staleFs = fsFixture();
  staleFs.fs.readdirImpl = async () => ['.aegis-state-reconciliation-prior'];
  const staleArtifact = adapters({ fs: staleFs });
  await assert.rejects(runRefreshOnlyPlan(staleArtifact.deps), /prior private Terraform artifact/i);
  assert.equal(staleArtifact.state.calls.removed.length, 0);
});

test('waits for a cancelled Terraform child to close before cleaning its private plan directory', async () => {
  const controller = new AbortController();
  const order = [];
  const fakeFs = fsFixture();
  fakeFs.fs.rmImpl = async () => { order.push('cleanup'); };
  const readOnlyAdapters = createRefreshOnlyAdapters({ spawnImpl: (...spawnArguments) => {
    const args = spawnArguments[1];
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => order.push('kill');
    if (args[0] === 'plan') {
      setTimeout(() => { controller.abort(); child.stdout.end(''); child.stderr.end(''); order.push('child-close'); child.emit('close', 1); }, 1);
    } else setTimeout(() => { child.stdout.end(''); child.stderr.end(''); child.emit('close', 0); }, 1);
    return child;
  } });
  const fixture = adapters({ fs: fakeFs });
  fixture.deps.signal = controller.signal;
  fixture.deps.runPlan = readOnlyAdapters.runPlan;
  fixture.deps.showPlan = readOnlyAdapters.showPlan;
  await assert.rejects(runRefreshOnlyPlan(fixture.deps), /stopped safely/);
  assert.ok(order.indexOf('child-close') >= 0);
  assert.ok(order.indexOf('cleanup') > order.indexOf('child-close'));
});

test('requires a direct interactive no-argument invocation and exposes only fixed plan arguments', async () => {
  assert.equal(refreshOnlyConfirmation, 'PLAN ONLY aegis-ai-portfolio/aegis-auth0-dev refresh-only');
  assert.throws(() => assertRefreshOnlyInvocation({ argv: ['node', 'script', '-x'], stdinIsTTY: true, stdoutIsTTY: true, env: {} }), /interactive/);
  assert.throws(() => assertRefreshOnlyInvocation({ argv: ['node', 'script'], stdinIsTTY: false, stdoutIsTTY: true, env: {} }), /interactive/);
  const seen = [];
  const adapters = createRefreshOnlyAdapters({ spawnImpl: (command, args) => {
    seen.push([command, args]);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => { child.stdout.end(''); child.stderr.end(''); child.emit('close', 0); });
    return child;
  } });
  await adapters.runPlan('/private/plan', { cwd: '/module', env: {}, signal: undefined });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0][1].slice(0, 6), ['plan', '-refresh-only', '-input=false', '-no-color', '-lock=true', '-out=/private/plan']);
  assert.equal(seen[0][1].some((arg) => /apply|destroy|refresh|target|auto-approve/.test(arg) && arg !== '-refresh-only'), false);
});
