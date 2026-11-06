import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { assertStateApplyInvocation, confirmationPhrase, createStateReconciliationAdapters,
  reviewConfirmation, runStateReconciliationApply } from './apply-state-reconciliation.mjs';

const provider = 'registry.terraform.io/auth0/auth0';
const sensitiveKey = 'synthetic_sensitive_attribute';
const secretSentinel = 'SYNTHETIC_SENSITIVE_STATE_VALUE';
const credentialSentinel = 'SYNTHETIC_AUTH0_CREDENTIAL_VALUE';
const planBytes = Buffer.from('synthetic saved refresh-only plan bytes');
const schema = JSON.stringify({ format_version: '1.0', provider_schemas: { [provider]: { resource_schemas: {
  auth0_client: { version: 4, block: { attributes: {
    allowed_clients: { optional: true, type: ['list', 'string'] },
    async_approval_notification_channels: { optional: true, type: ['list', 'string'] },
    client_aliases: { optional: true, type: ['list', 'string'] },
    client_metadata: { optional: true, type: ['map', 'string'] },
    [sensitiveKey]: { optional: true, sensitive: true, type: 'string' },
  } } },
} } } });

function validPlan(overrides = {}) {
  const before = { allowed_clients: null, async_approval_notification_channels: null, client_aliases: null,
    client_metadata: null, [sensitiveKey]: secretSentinel };
  const after = { allowed_clients: [], async_approval_notification_channels: [], client_aliases: [],
    client_metadata: {}, [sensitiveKey]: secretSentinel };
  return { format_version: '1.2', terraform_version: '1.17.1', errored: false, complete: true, applyable: true,
    resource_changes: [], resource_drift: [{ address: 'auth0_client.local_spa', mode: 'managed', type: 'auth0_client',
      name: 'local_spa', provider_name: provider, change: { actions: ['update'], before, after,
        before_sensitive: { [sensitiveKey]: true }, after_sensitive: { [sensitiveKey]: true }, after_unknown: {} } }],
    output_changes: {}, deferred_changes: [], action_invocations: [], ...overrides };
}
function identity(overrides = {}) {
  return { organization: 'aegis-ai-portfolio', plan: 'free', workspace: 'aegis-auth0-dev', workspaceId: 'workspace-fixture',
    executionMode: 'local', autoApply: false, state: 'verified-managed-state', backendFingerprint: 'a'.repeat(64),
    stateVersionId: 'state-v7', serial: 7, inventoryHash: 'b'.repeat(64), ...overrides };
}
function fsFixture({ cleanupFails = false, alteredPlan = false, unsafeMode = false } = {}) {
  let reads = 0;
  const calls = { removed: [], chmod: [], reads: 0 };
  return { calls, fs: {
    lstatImpl: async (file) => file.endsWith('state-reconciliation.tfplan')
      ? { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
        mode: unsafeMode ? 0o100644 : 0o100600, dev: 1, ino: 2, size: planBytes.length, mtimeMs: 11 }
      : { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, mode: 0o40700 },
    chmodImpl: async (file, mode) => calls.chmod.push([file, mode]),
    readdirImpl: async () => [],
    mkdtempImpl: async () => '/module/.terraform/.aegis-state-reconciliation-apply-test',
    readFileImpl: async () => { reads += 1; calls.reads = reads; return alteredPlan && reads > 1 ? Buffer.from('altered plan bytes') : planBytes; },
    rmImpl: async (directory) => { if (cleanupFails) throw new Error('synthetic cleanup error'); calls.removed.push(directory); },
  } };
}
function makeAdapters({ fs = fsFixture(), onVerify, onPlan, onShow, onSchema, onApply, applyPlanImpl, review = true, phrase,
  controller } = {}) {
  let checks = 0;
  const modes = [];
  const applyCalls = [];
  const deps = {
    fs: fs.fs,
    signal: controller?.signal,
    env: {},
    getPinnedProviderVersion: async () => '1.59.0',
    verifyHcp: async ({ mode }) => {
      checks += 1;
      modes.push(mode);
      if (onVerify) return onVerify(checks, mode);
      if (mode === 'bind') return identity({ state: 'reviewable-managed-state', stateVersionId: 'state-v8', serial: 8 });
      return identity();
    },
    loadConfiguration: async () => ({ auth0Domain: 'dev.synthetic.invalid', auth0ClientId: 'public-synthetic-client',
      auth0ClientSecret: credentialSentinel }),
    runProviderSchema: async () => onSchema ? onSchema() : schema,
    runPlan: async (planPath) => { if (onPlan) await onPlan(planPath); },
    showPlan: async () => JSON.stringify(onShow ? onShow() : validPlan()),
    approveReviewedSettings: async ({ warning, shapes, summary }) => {
      assert.equal(warning.includes('allowed_clients'), true);
      assert.equal(Object.keys(shapes).length, 4);
      assert.equal(summary.sensitiveComparison, 'equal');
      return review;
    },
    confirmFingerprint: async ({ fingerprint, workspace, intent }) => {
      assert.equal(workspace, 'aegis-auth0-dev');
      assert.equal(intent, 'state-only reconciliation');
      return phrase ?? confirmationPhrase(fingerprint);
    },
    applyPlan: async (planPath, context) => {
      applyCalls.push({ planPath, context });
      if (applyPlanImpl) return await applyPlanImpl(planPath, context);
      if (onApply) await onApply(planPath, context);
    },
  };
  return { deps, fs, modes, applyCalls, get checks() { return checks; } };
}

test('applies only the reviewed same plan and verifies new HCP state without rebinding local metadata', async () => {
  const fixture = makeAdapters();
  const result = await runStateReconciliationApply(fixture.deps);
  assert.equal(fixture.applyCalls.length, 1);
  assert.match(fixture.applyCalls[0].planPath, /state-reconciliation\.tfplan$/);
  assert.equal(fixture.applyCalls[0].context.env.AUTH0_CLIENT_SECRET, credentialSentinel);
  assert.equal(result.result, 'state-only-reconciliation-applied-and-verified');
  assert.equal(result.stateVersionAdvanced, true);
  assert.equal(result.inventoryUnchanged, true);
  assert.equal(result.localBindingUpdated, false);
  assert.equal(result.browserUpdatePerformed, false);
  assert.equal(fixture.modes.at(-1), 'bind');
  assert.equal(fixture.fs.calls.removed.length, 1);
  assert.ok(fixture.fs.calls.chmod.some(([, mode]) => mode === 0o700));
  assert.ok(fixture.fs.calls.chmod.some(([, mode]) => mode === 0o600));
  assert.equal(JSON.stringify(result).includes(secretSentinel), false);
  assert.equal(JSON.stringify(result).includes(credentialSentinel), false);
});

test('stops before apply for wrong workspace or a state-version change', async () => {
  const foreign = makeAdapters({ onVerify: () => identity({ workspace: 'foreign-workspace' }) });
  await assert.rejects(runStateReconciliationApply(foreign.deps), /state identity/i);
  assert.equal(foreign.applyCalls.length, 0);

  for (const changedFields of [
    { stateVersionId: 'state-replaced' },
    { backendFingerprint: 'c'.repeat(64) },
    { inventoryHash: 'd'.repeat(64) },
    { serial: 99 },
  ]) {
    const changed = makeAdapters({ onVerify: (count, mode) => mode === 'reinit' && count >= 5
      ? identity(changedFields)
      : mode === 'bind' ? identity({ state: 'reviewable-managed-state', stateVersionId: 'state-v8', serial: 8 }) : identity() });
    await assert.rejects(runStateReconciliationApply(changed.deps), /stopped safely/);
    assert.equal(changed.applyCalls.length, 0);
    assert.equal(changed.fs.calls.removed.length, 1);
  }
});

test('rejects drift scope changes, nonempty resource actions, and sensitive comparison failures', async () => {
  const extra = validPlan();
  extra.resource_drift[0].change.after.allowed_clients = ['synthetic-client'];
  const extraFixture = makeAdapters({ onShow: () => extra });
  await assert.rejects(runStateReconciliationApply(extraFixture.deps), /stopped safely/);
  assert.equal(extraFixture.applyCalls.length, 0);

  const action = makeAdapters({ onShow: () => validPlan({ resource_changes: [{ actions: ['update'] }] }) });
  await assert.rejects(runStateReconciliationApply(action.deps), /stopped safely/);
  assert.equal(action.applyCalls.length, 0);

  const sensitive = validPlan();
  sensitive.resource_drift[0].change.after[sensitiveKey] = 'different-sensitive-synthetic-value';
  const sensitiveFixture = makeAdapters({ onShow: () => sensitive });
  await assert.rejects(runStateReconciliationApply(sensitiveFixture.deps), /stopped safely/);
  assert.equal(sensitiveFixture.applyCalls.length, 0);

  const missingSchema = makeAdapters({ onSchema: async () => '{bad schema' });
  await assert.rejects(runStateReconciliationApply(missingSchema.deps), /stopped safely/);
  assert.equal(missingSchema.applyCalls.length, 0);
});

test('rejects an altered fingerprint after authorization and never retries an apply failure', async () => {
  let approved = false;
  const altered = makeAdapters({ fs: fsFixture({ alteredPlan: true }) });
  altered.deps.approveReviewedSettings = async () => { approved = true; return true; };
  await assert.rejects(runStateReconciliationApply(altered.deps), /stopped safely/);
  assert.equal(approved, false, 'plan changes during show must be rejected before human approval');
  assert.equal(altered.applyCalls.length, 0);
  assert.equal(altered.fs.calls.removed.length, 1);

  const failed = makeAdapters({ onApply: async () => { throw new Error('synthetic apply failure'); } });
  await assert.rejects(runStateReconciliationApply(failed.deps), /do not retry/i);
  assert.equal(failed.applyCalls.length, 1);
  assert.equal(failed.modes.includes('bind'), false);
  assert.equal(failed.fs.calls.removed.length, 1);
});


test('post-apply HCP mismatch stops after one write attempt without rebinding', async () => {
  const mismatches = [
    { inventoryHash: 'c'.repeat(64) },
    { stateVersionId: 'state-v7', serial: 8 },
    { stateVersionId: 'state-v8', serial: 7 },
    { stateVersionId: 'state-v8', serial: 8, workspace: 'foreign-workspace' },
    { stateVersionId: 'state-v8', serial: 8, backendFingerprint: 'c'.repeat(64) },
    { stateVersionId: 'state-v8', serial: 8, executionMode: 'remote' },
    { stateVersionId: 'state-v8', serial: 8, autoApply: true },
    { stateVersionId: 'state-v8', serial: 8, plan: 'paid' },
    { stateVersionId: 'state-v8', serial: 8, workspaceId: '' },
  ];
  for (const mismatch of mismatches) {
    let bindChecks = 0;
    const fixture = makeAdapters({ onVerify: (_count, mode) => {
      if (mode === 'bind') { bindChecks += 1; return identity({ state: 'reviewable-managed-state',
        stateVersionId: 'state-v8', serial: 8, ...mismatch }); }
      return identity();
    } });
    await assert.rejects(runStateReconciliationApply(fixture.deps), /may have partially written state; do not retry/i);
    assert.equal(fixture.applyCalls.length, 1);
    assert.equal(bindChecks, 1);
    assert.equal(fixture.modes.at(-1), 'bind');
    assert.equal(fixture.fs.calls.removed.length, 1);
  }
});

test('cancellation during apply waits for child close before cleanup and never retries', async () => {
  const controller = new AbortController();
  const fs = fsFixture();
  let resolveStarted;
  const started = new Promise((resolve) => { resolveStarted = resolve; });
  let childClosed = false;
  const cleanupAfterClose = fs.fs.rmImpl;
  fs.fs.rmImpl = async (...args) => {
    assert.equal(childClosed, true, 'private files must remain until the apply child closes');
    return await cleanupAfterClose(...args);
  };
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  const adapters = createStateReconciliationAdapters({ spawnImpl: () => {
    resolveStarted();
    controller.signal.addEventListener('abort', () => {
      child.emit('error', Object.assign(new Error('synthetic abort'), { name: 'AbortError' }));
      setTimeout(() => { childClosed = true; child.emit('close', null); }, 15);
    }, { once: true });
    return child;
  } });
  const fixture = makeAdapters({ fs, controller, applyPlanImpl: async (planPath, context) =>
    await adapters.applyPlan(planPath, { ...context, signal: controller.signal }) });
  const operation = runStateReconciliationApply(fixture.deps);
  await started;
  controller.abort();
  await assert.rejects(operation, /may have partially written state; do not retry/i);
  assert.equal(childClosed, true);
  assert.equal(fixture.applyCalls.length, 1);
  assert.equal(fixture.modes.includes('bind'), false);
  assert.equal(fs.calls.removed.length, 1);
});

test('requires both review and exact fingerprint-bound apply confirmation', async () => {
  assert.equal(reviewConfirmation.includes('allowed_clients-null-to-empty-array'), true);
  assert.equal(confirmationPhrase('a'.repeat(64)), 'APPLY STATE ONLY aegis-ai-portfolio/aegis-auth0-dev sha256:' + 'a'.repeat(64));
  assert.throws(() => confirmationPhrase('bad'), /malformed/);
  const rejectedReview = makeAdapters({ review: false });
  await assert.rejects(runStateReconciliationApply(rejectedReview.deps), /stopped safely/);
  assert.equal(rejectedReview.applyCalls.length, 0);
  const wrongPhrase = makeAdapters({ phrase: 'wrong confirmation' });
  await assert.rejects(runStateReconciliationApply(wrongPhrase.deps), /stopped safely/);
  assert.equal(wrongPhrase.applyCalls.length, 0);
});

test('cancellation and cleanup failures stop without retry or rebind', async () => {
  const controller = new AbortController();
  const cancelled = makeAdapters({ controller, review: true });
  cancelled.deps.confirmFingerprint = async () => { controller.abort(); return confirmationPhrase('a'.repeat(64)); };
  await assert.rejects(runStateReconciliationApply(cancelled.deps), /stopped safely/);
  assert.equal(cancelled.applyCalls.length, 0);
  assert.equal(cancelled.fs.calls.removed.length, 1);

  const cleanupFailure = makeAdapters({ fs: fsFixture({ cleanupFails: true }), review: false });
  await assert.rejects(runStateReconciliationApply(cleanupFailure.deps), /cleanup failed/i);
  assert.equal(cleanupFailure.applyCalls.length, 0);

  const postApplyCleanupFailure = makeAdapters({ fs: fsFixture({ cleanupFails: true }) });
  await assert.rejects(runStateReconciliationApply(postApplyCleanupFailure.deps), /apply was attempted.*do not retry/i);
  assert.equal(postApplyCleanupFailure.applyCalls.length, 1);
});

test('Terraform adapters expose fixed planning, inspection, and single saved-plan apply commands only', async () => {
  const calls = [];
  const adapters = createStateReconciliationAdapters({ spawnImpl: (_command, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    const output = args[0] === 'providers' ? '{"synthetic":"schema"}' :
      args[0] === 'show' ? '{"synthetic":"plan"}' : 'SENSITIVE_TERRAFORM_STDOUT_SENTINEL';
    queueMicrotask(() => { child.stdout.end(output); child.stderr.end(''); child.emit('close', 0); });
    return child;
  } });
  const context = { cwd: '/module', env: {}, signal: undefined };
  const schemaOutput = await adapters.runProviderSchema(context);
  const planCommandOutput = await adapters.runPlan('/private/plan.tfplan', context);
  const planOutput = await adapters.showPlan('/private/plan.tfplan', context);
  const applyCommandOutput = await adapters.applyPlan('/private/plan.tfplan', context);
  assert.equal(schemaOutput, '{"synthetic":"schema"}');
  assert.equal(planOutput, '{"synthetic":"plan"}');
  assert.equal(planCommandOutput, '');
  assert.equal(applyCommandOutput, '');
  assert.equal(JSON.stringify([schemaOutput, planOutput, planCommandOutput, applyCommandOutput]).includes('SENSITIVE_TERRAFORM_STDOUT_SENTINEL'), false);
  assert.deepEqual(calls, [
    ['providers', 'schema', '-json'],
    ['plan', '-refresh-only', '-input=false', '-no-color', '-lock=true', '-out=/private/plan.tfplan'],
    ['show', '-json', '/private/plan.tfplan'],
    ['apply', '-input=false', '-no-color', '-lock=true', '/private/plan.tfplan'],
  ]);
  assert.equal(calls.flat().some((arg) => arg === '-auto-approve' || arg === '-lock=false' || arg.startsWith('-target')), false);
  assert.equal(createHash('sha256').update(planBytes).digest('hex').length, 64);
});

test('blocks automated or noninteractive invocations', () => {
  assert.throws(() => assertStateApplyInvocation({ argv: ['node', 'script', 'anything'], stdinIsTTY: true, stdoutIsTTY: true, env: {} }), /interactive/);
  assert.throws(() => assertStateApplyInvocation({ argv: ['node', 'script'], stdinIsTTY: false, stdoutIsTTY: true, env: {} }), /interactive/);
});
