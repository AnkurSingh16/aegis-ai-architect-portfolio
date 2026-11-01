import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { diagnosePlanDocument, diagnosePlanJson, runPlanDiagnostic, sameHcpIdentity,
  assertDiagnosticInvocation, createTerraformDiagnosticAdapters } from './diagnose-browser-origin-plan.mjs';

const secretSentinel = 'SYNTHETIC_PLAN_SECRET_SENTINEL_DO_NOT_EMIT';
const baseline = {
  format_version: '1.1',
  terraform_version: '1.9.8',
  errored: false,
  complete: true,
  applyable: true,
  resource_changes: [
    { change: { actions: ['no-op'] } },
    { change: { actions: ['no-op'] } },
    { change: { actions: ['no-op'] } },
    { change: { actions: ['update'] } },
    { change: { actions: ['no-op'] } },
  ],
  resource_drift: [],
  deferred_changes: [],
  action_invocations: [],
  output_changes: {},
};

function clone(value) { return structuredClone(value); }

test('reports only allowlisted versions, field flags, counts, rule IDs, and expected action counts', () => {
  const document = { ...clone(baseline), sensitive_value: secretSentinel,
    resource_changes: baseline.resource_changes.map((item) => ({ ...item, change: { ...item.change, before: { token: secretSentinel } } })) };
  const report = diagnosePlanDocument(document);
  assert.equal(report.formatVersion, '1.1');
  assert.equal(report.terraformVersion, '1.9.8');
  assert.deepEqual(report.booleans, { errored: false, complete: true, applyable: true,
    expected: { errored: false, complete: true, applyable: true } });
  assert.deepEqual(report.counts, { resourceChanges: 5, resourceDrift: 0, deferredChanges: 0, actionInvocations: 0, outputChanges: 0 });
  assert.deepEqual(report.actionCounts, { add: 0, update: 1, destroy: 0, unclassified: 0, matchesExpected: true });
  assert.deepEqual(report.failedValidationRuleIds, []);
  assert.equal(JSON.stringify(report).includes(secretSentinel), false);
  assert.deepEqual(Object.keys(report).sort(), ['actionCounts', 'booleans', 'counts', 'failedValidationRuleIds',
    'formatVersion', 'optionalFields', 'outputChangeSummary', 'requiredFields', 'resourceDriftSummary', 'terraformVersion'].sort());
});

const rejected = [
  ['non-object document', null, 'plan.document.object'],
  ['missing format version', ((p) => { delete p.format_version; return p; })(clone(baseline)), 'plan.format_version.string'],
  ['unsupported major format version', { ...clone(baseline), format_version: '2.0' }, 'plan.format_version.supported_major'],
  ['malformed format version', { ...clone(baseline), format_version: 'one' }, 'plan.format_version.supported_major'],
  ['missing Terraform version', ((p) => { delete p.terraform_version; return p; })(clone(baseline)), 'plan.terraform_version.string'],
  ['errored true', { ...clone(baseline), errored: true }, 'plan.errored.false'],
  ['complete false', { ...clone(baseline), complete: false }, 'plan.complete.true'],
  ['applyable false', { ...clone(baseline), applyable: false }, 'plan.applyable.true'],
  ['missing resource changes', ((p) => { delete p.resource_changes; return p; })(clone(baseline)), 'plan.resource_changes.array'],
  ['malformed resource changes', { ...clone(baseline), resource_changes: {} }, 'plan.resource_changes.array'],
  ['malformed resource action entry', { ...clone(baseline), resource_changes: [{ change: { actions: secretSentinel } }] }, 'plan.resource_changes.items.actions_array'],
  ['nonempty drift', { ...clone(baseline), resource_drift: [{ change: { actions: ['update'] } }] }, 'plan.resource_drift.absent_or_empty_array'],
  ['malformed drift', { ...clone(baseline), resource_drift: {} }, 'plan.resource_drift.absent_or_empty_array'],
  ['nonempty deferred changes', { ...clone(baseline), deferred_changes: [{}] }, 'plan.deferred_changes.absent_or_empty_array'],
  ['malformed deferred changes', { ...clone(baseline), deferred_changes: {} }, 'plan.deferred_changes.absent_or_empty_array'],
  ['nonempty action invocations', { ...clone(baseline), action_invocations: [{}] }, 'plan.action_invocations.absent_or_empty_array'],
  ['malformed action invocations', { ...clone(baseline), action_invocations: {} }, 'plan.action_invocations.absent_or_empty_array'],
  ['nonempty output changes', { ...clone(baseline), output_changes: { result: { value: secretSentinel } } }, 'plan.output_changes.absent_or_empty_object'],
  ['malformed output changes', { ...clone(baseline), output_changes: [] }, 'plan.output_changes.absent_or_empty_object'],
];

for (const [label, document, expectedRule] of rejected) {
  test(`diagnoses ${label} with a stable rule identifier`, () => {
    const report = diagnosePlanDocument(document);
    assert.ok(report.failedValidationRuleIds.includes(expectedRule));
    assert.equal(JSON.stringify(report).includes(secretSentinel), false);
  });
}

test('optional fields may be absent and missing counts are reported as unavailable', () => {
  const document = clone(baseline);
  for (const key of ['resource_drift', 'deferred_changes', 'action_invocations', 'output_changes']) delete document[key];
  const report = diagnosePlanDocument(document);
  assert.deepEqual(report.failedValidationRuleIds, []);
  assert.deepEqual(report.optionalFields, { resource_drift: false, deferred_changes: false, action_invocations: false, output_changes: false });
  assert.deepEqual(report.counts, { resourceChanges: 5, resourceDrift: null, deferredChanges: null, actionInvocations: null, outputChanges: null });
});

test('does not echo malformed version strings that could contain unrelated input', () => {
  const document = { ...clone(baseline), format_version: `1.${secretSentinel}`, terraform_version: secretSentinel };
  const report = diagnosePlanDocument(document);
  assert.equal(report.formatVersion, null);
  assert.equal(report.terraformVersion, null);
  assert.equal(JSON.stringify(report).includes(secretSentinel), false);
});

test('diagnoses malformed JSON without including parser details or source text', () => {
  const report = diagnosePlanJson(`{${secretSentinel}`);
  assert.deepEqual(report.failedValidationRuleIds, ['plan.json.parse']);
  assert.equal(JSON.stringify(report).includes(secretSentinel), false);
});

test('reports action summary mismatch without exposing resource values', () => {
  const document = clone(baseline);
  document.resource_changes[3].change.actions = ['delete', 'create'];
  document.resource_changes[3].change.before = { secret: secretSentinel };
  const report = diagnosePlanDocument(document);
  assert.deepEqual(report.actionCounts, { add: 1, update: 0, destroy: 1, unclassified: 0, matchesExpected: false });
  assert.ok(report.failedValidationRuleIds.includes('plan.actions.expected_0_add_1_update_0_destroy'));
  assert.equal(JSON.stringify(report).includes(secretSentinel), false);
});

test('marks unsupported resource actions unclassified and rejects the expected action summary', () => {
  const document = clone(baseline);
  document.resource_changes[0].change.actions = ['forget'];
  const report = diagnosePlanDocument(document);
  assert.equal(report.actionCounts.unclassified, 1);
  assert.equal(report.actionCounts.matchesExpected, false);
  assert.ok(report.failedValidationRuleIds.includes('plan.actions.expected_0_add_1_update_0_destroy'));
});

function outputChange(before, after, actions = ['no-op'], flags = {}) {
  return { actions, before, after, after_unknown: false,
    before_sensitive: false, after_sensitive: false, ...flags };
}

function driftEntry(address, before, after, actions = ['update'], flags = {}) {
  const [type, name] = address.split('.');
  return { address, mode: 'managed', type, name, provider_name: 'registry.terraform.io/auth0/auth0',
    change: { actions, before, after, before_sensitive: {}, after_sensitive: {}, after_unknown: {}, ...flags } };
}

test('classifies the three declared no-op outputs without exposing their values', () => {
  const document = clone(baseline);
  document.output_changes = {
    issuer: outputChange(secretSentinel, secretSentinel),
    audience: outputChange(secretSentinel, secretSentinel),
    spa_client_id: outputChange(secretSentinel, secretSentinel),
  };
  const summary = diagnosePlanDocument(document).outputChangeSummary;
  assert.equal(summary.declaredKeysMatch, true);
  assert.equal(summary.unexpectedOutputCount, 0);
  assert.deepEqual(summary.outputs.map(({ name, actions, beforeAfterEqual, afterUnknown, afterSensitive }) =>
    ({ name, actions, beforeAfterEqual, afterUnknown, afterSensitive })), [
    { name: 'issuer', actions: ['no-op'], beforeAfterEqual: true, afterUnknown: false, afterSensitive: false },
    { name: 'audience', actions: ['no-op'], beforeAfterEqual: true, afterUnknown: false, afterSensitive: false },
    { name: 'spa_client_id', actions: ['no-op'], beforeAfterEqual: true, afterUnknown: false, afterSensitive: false },
  ]);
  assert.equal(JSON.stringify(summary).includes(secretSentinel), false);
});

test('classifies changes to all three declared outputs while suppressing output values', () => {
  const document = clone(baseline);
  document.output_changes = {
    issuer: outputChange(secretSentinel, `${secretSentinel}-new`, ['update']),
    audience: outputChange(secretSentinel, `${secretSentinel}-new`, ['update']),
    spa_client_id: outputChange(secretSentinel, `${secretSentinel}-new`, ['update']),
  };
  const summary = diagnosePlanDocument(document).outputChangeSummary;
  assert.equal(summary.declaredKeysMatch, true);
  assert.equal(summary.outputs.every((entry) => entry.actions[0] === 'update' && entry.beforeAfterEqual === false), true);
  assert.equal(JSON.stringify(summary).includes(secretSentinel), false);
});

test('reports declared output unknown and sensitive flags without output values', () => {
  const document = clone(baseline);
  document.output_changes = {
    issuer: outputChange(secretSentinel, secretSentinel, ['update'], { after_unknown: true, after_sensitive: true }),
    audience: outputChange(secretSentinel, `${secretSentinel}-new`, ['update'], { after_sensitive: true }),
    spa_client_id: outputChange(secretSentinel, secretSentinel, ['no-op']),
  };
  const outputs = diagnosePlanDocument(document).outputChangeSummary.outputs;
  assert.equal(outputs[0].beforeAfterEqual, null);
  assert.equal(outputs[0].afterUnknown, true);
  assert.equal(outputs[0].afterSensitive, true);
  assert.equal(outputs[1].beforeAfterEqual, false);
  assert.equal(outputs[1].afterUnknown, false);
  assert.equal(outputs[1].afterSensitive, true);
  assert.equal(JSON.stringify(outputs).includes(secretSentinel), false);
});

test('does not report output equality when after-unknown or sensitivity markers are missing or malformed', () => {
  const document = clone(baseline);
  const missing = outputChange('synthetic-before', 'synthetic-after', ['update']);
  delete missing.before_sensitive;
  const malformed = outputChange('synthetic-before', 'synthetic-after', ['update'], { after_sensitive: 'invalid' });
  const missingUnknown = outputChange('synthetic-before', 'synthetic-after', ['update']);
  delete missingUnknown.after_unknown;
  document.output_changes = {
    issuer: missing,
    audience: malformed,
    spa_client_id: missingUnknown,
  };
  const outputs = diagnosePlanDocument(document).outputChangeSummary.outputs;
  assert.equal(outputs[0].beforeSensitive, null);
  assert.equal(outputs[0].beforeAfterEqual, null);
  assert.equal(outputs[1].afterSensitive, null);
  assert.equal(outputs[1].beforeAfterEqual, null);
  assert.equal(outputs[2].afterUnknown, null);
  assert.equal(outputs[2].beforeAfterEqual, null);
});

test('classifies drift on the managed SPA with only allowlisted categories', () => {
  const document = clone(baseline);
  document.resource_drift = [driftEntry('auth0_client.local_spa',
    { client_id: secretSentinel, callbacks: ['http://127.0.0.1:49321/auth/callback'] },
    { client_id: `${secretSentinel}-changed`, callbacks: ['http://127.0.0.1:49321/auth/callback', `${secretSentinel}-url`] })];
  const summary = diagnosePlanDocument(document).resourceDriftSummary;
  assert.equal(summary.unexpectedResourceCount, 0);
  assert.equal(summary.entries[0].resource, 'auth0_client.local_spa');
  assert.deepEqual(summary.entries[0].actions, ['update']);
  assert.deepEqual(summary.entries[0].changedAttributeCategories,
    { identity: 1, permissions: 0, clientConfiguration: 1, other: 0 });
  assert.equal(summary.entries[0].affectsIdentity, true);
  assert.equal(summary.entries[0].affectsClientConfiguration, true);
  assert.equal(Object.keys(summary.entries[0]).some((key) => key === 'client_id' || key === 'callbacks'), false);
  assert.equal(JSON.stringify(summary).includes(secretSentinel), false);
});

test('classifies drift on another expected managed resource', () => {
  const document = clone(baseline);
  document.resource_drift = [driftEntry('auth0_resource_server.cases',
    { identifier: 'synthetic-before', signing_alg: 'RS256' }, { identifier: 'synthetic-after', signing_alg: 'HS256' })];
  const entry = diagnosePlanDocument(document).resourceDriftSummary.entries[0];
  assert.equal(entry.resource, 'auth0_resource_server.cases');
  assert.deepEqual(entry.changedAttributeCategories, { identity: 1, permissions: 1, clientConfiguration: 0, other: 0 });
  assert.equal(entry.affectsPermissions, true);
});

test('reports unexpected drift addresses only as unexpected', () => {
  const document = clone(baseline);
  document.resource_drift = [driftEntry(`unapproved.${secretSentinel}`, { extra_secret_key: secretSentinel }, { extra_secret_key: 'changed' })];
  const summary = diagnosePlanDocument(document).resourceDriftSummary;
  assert.equal(summary.unexpectedResourceCount, 1);
  assert.equal(summary.entries[0].resource, 'unexpected');
  assert.equal(summary.entries[0].unknownAttributeCount, 1);
  assert.equal(JSON.stringify(summary).includes(secretSentinel), false);
});

test('requires drift address, managed mode, provider, and resource fields to agree', () => {
  for (const mutate of [
    (entry) => { entry.mode = 'data'; },
    (entry) => { entry.provider_name = `unapproved.${secretSentinel}`; },
    (entry) => { entry.type = 'unexpected'; },
    (entry) => { entry.index = 0; },
    (entry) => { entry.module_address = 'module.foreign'; },
    (entry) => { entry.deposed = 'old'; },
  ]) {
    const document = clone(baseline);
    const entry = driftEntry('auth0_client.local_spa', { name: 'before' }, { name: 'after' });
    mutate(entry);
    document.resource_drift = [entry];
    const summary = diagnosePlanDocument(document).resourceDriftSummary;
    assert.equal(summary.entries[0].resource, 'unexpected');
    assert.equal(summary.unexpectedResourceCount, 1);
    assert.equal(JSON.stringify(summary).includes(secretSentinel), false);
  }
});

test('counts sensitive and unknown drift attributes without exposing names or values', () => {
  const document = clone(baseline);
  document.resource_drift = [driftEntry('auth0_client.local_spa',
    { client_id: secretSentinel }, { client_id: `${secretSentinel}-changed` }, ['update'], {
      after_unknown: { client_id: true }, before_sensitive: { client_id: true }, after_sensitive: { client_id: true },
    })];
  const entry = diagnosePlanDocument(document).resourceDriftSummary.entries[0];
  assert.equal(entry.sensitiveAttributeCount, 1);
  assert.equal(entry.unknownAttributeCount, 1);
  assert.deepEqual(entry.changedAttributeCategories, { identity: 0, permissions: 0, clientConfiguration: 0, other: 0 });
  assert.equal(JSON.stringify(entry).includes(secretSentinel), false);
});

test('counts equal placeholders marked sensitive or unknown instead of treating them as unchanged', () => {
  const document = clone(baseline);
  document.resource_drift = [driftEntry('auth0_client.local_spa',
    { client_id: null }, { client_id: null }, ['update'], {
      after_unknown: { client_id: true }, before_sensitive: { client_id: true }, after_sensitive: { client_id: true },
    })];
  const entry = diagnosePlanDocument(document).resourceDriftSummary.entries[0];
  assert.equal(entry.unknownAttributeCount, 1);
  assert.equal(entry.sensitiveAttributeCount, 1);
  assert.deepEqual(entry.changedAttributeCategories, { identity: 0, permissions: 0, clientConfiguration: 0, other: 0 });
});

test('treats root-level sensitive and unknown markers as applying to changed attributes', () => {
  const document = clone(baseline);
  document.resource_drift = [driftEntry('auth0_client.local_spa',
    { client_id: 'synthetic-before' }, { client_id: 'synthetic-after' }, ['update'], {
      after_unknown: true, before_sensitive: true, after_sensitive: true,
    })];
  const entry = diagnosePlanDocument(document).resourceDriftSummary.entries[0];
  assert.equal(entry.unknownAttributeCount, 1);
  assert.equal(entry.sensitiveAttributeCount, 1);
  assert.deepEqual(entry.changedAttributeCategories, { identity: 0, permissions: 0, clientConfiguration: 0, other: 0 });
});

test('counts unexpected output keys without revealing their names and reports malformed output actions safely', () => {
  const document = clone(baseline);
  document.output_changes = {
    issuer: outputChange('before', 'after', ['update']),
    audience: outputChange('same', 'same'),
    spa_client_id: outputChange('before', 'after', [secretSentinel]),
    [secretSentinel]: { value: secretSentinel },
  };
  const summary = diagnosePlanDocument(document).outputChangeSummary;
  assert.equal(summary.declaredKeysMatch, false);
  assert.equal(summary.unexpectedOutputCount, 1);
  assert.deepEqual(summary.outputs[2].actions, ['unknown']);
  assert.equal(JSON.stringify(summary).includes(secretSentinel), false);
});

test('reports the unexpected output count as unavailable when output_changes is malformed', () => {
  const summary = diagnosePlanDocument({ ...clone(baseline), output_changes: [] }).outputChangeSummary;
  assert.equal(summary.declaredKeysMatch, false);
  assert.equal(summary.unexpectedOutputCount, null);
});

function hcpState(overrides = {}) {
  return { organization: 'aegis-ai-portfolio', plan: 'free', workspace: 'aegis-auth0-dev', workspaceId: 'synthetic-workspace',
    executionMode: 'local', autoApply: false, state: 'verified-managed-state', backendFingerprint: 'a'.repeat(64),
    stateVersionId: 'synthetic-state-version', serial: 10, inventoryHash: 'b'.repeat(64), ...overrides };
}

function makeDiagnostic(overrides = {}) {
  const calls = { commands: [], preflights: 0, removed: [], chmod: [], output: '' };
  let preflightNumber = 0;
  const deps = {
    verifyHcp: async () => {
      preflightNumber += 1;
      calls.preflights = preflightNumber;
      return overrides.stateAt?.(preflightNumber) ?? hcpState();
    },
    loadConfiguration: async () => ({ auth0Domain: 'dev-example.auth0.com', auth0ClientId: 'synthetic-id',
      auth0ClientSecret: secretSentinel }),
    runPlan: async (planPath, context) => {
      calls.commands.push({ command: 'plan', planPath, context });
      if (overrides.runPlanImpl) return overrides.runPlanImpl(planPath, context);
      overrides.onPlanStart?.(planPath, context);
      if (overrides.waitForPlanCancellation) {
        await new Promise((resolve, reject) => {
          if (context.signal?.aborted) reject(new Error('synthetic cancellation'));
          else context.signal?.addEventListener('abort', () => reject(new Error('synthetic cancellation')), { once: true });
        });
      }
      if (overrides.planFailure) throw new Error('SYNTHETIC_TERRAFORM_FAILURE_SECRET');
    },
    showPlan: async (planPath, context) => {
      calls.commands.push({ command: 'show', planPath, context });
      if (overrides.showFailure) throw new Error('SYNTHETIC_SHOW_FAILURE_SECRET');
      return overrides.json ?? JSON.stringify(baseline);
    },
    fs: {
      lstatImpl: async (file) => ({
        isDirectory: () => !file.endsWith('diagnostic.tfplan'),
        isFile: () => file.endsWith('diagnostic.tfplan'),
        isSymbolicLink: () => false,
        mode: file.endsWith('diagnostic.tfplan') ? 0o600 : 0o700,
      }),
      readdirImpl: async () => overrides.staleEntries ?? [],
      mkdtempImpl: async () => '/private/synthetic/.terraform/.aegis-browser-origin-diagnostic-unit',
      chmodImpl: async (file, mode) => calls.chmod.push([file, mode]),
      rmImpl: async (directory) => calls.removed.push(directory),
      ...overrides.fs,
    },
    io: { write: (text) => { calls.output += text; } },
  };
  if (overrides.signal) deps.signal = overrides.signal;
  return { deps, calls };
}

test('diagnostic only invokes fixed plan and show stages and cleans private files', async () => {
  const { deps, calls } = makeDiagnostic({ json: JSON.stringify({ ...clone(baseline), sensitive: secretSentinel }) });
  const result = await runPlanDiagnostic(deps);
  assert.deepEqual(calls.commands.map((item) => item.command), ['plan', 'show']);
  assert.equal(calls.commands.some((item) => item.command === 'apply'), false);
  assert.equal(calls.preflights, 3);
  assert.equal(calls.removed.length, 1);
  assert.equal(calls.chmod.some(([file, mode]) => file.includes('.aegis-browser-origin-diagnostic-') && mode === 0o700), true);
  assert.equal(calls.chmod.some(([file, mode]) => file.endsWith('diagnostic.tfplan') && mode === 0o600), true);
  assert.equal(JSON.stringify(result).includes(secretSentinel), false);
  assert.equal(calls.output.includes(secretSentinel), false);
});

test('fails before show when HCP state ownership or version changes during planning', async () => {
  for (const changed of [{ stateVersionId: 'changed-version' }, { inventoryHash: 'changed-inventory' },
    { backendFingerprint: 'foreign-backend' }, { workspaceId: 'foreign-workspace' }]) {
    const { deps, calls } = makeDiagnostic({ stateAt: (count) => count === 1 ? hcpState() : hcpState(changed) });
    await assert.rejects(runPlanDiagnostic(deps), /diagnostic failed safely/);
    assert.deepEqual(calls.commands.map((item) => item.command), ['plan']);
    assert.equal(calls.removed.length, 1);
  }
});

test('cleans up on plan, show, malformed JSON and cancellation failures', async () => {
  const controller = new AbortController();
  controller.abort();
  for (const overrides of [
    { planFailure: true },
    { showFailure: true },
    { json: `{${secretSentinel}` },
    { signal: controller.signal },
  ]) {
    const { deps, calls } = makeDiagnostic(overrides);
    if (overrides.json) {
      const result = await runPlanDiagnostic(deps);
      assert.deepEqual(result.failedValidationRuleIds, ['plan.json.parse']);
    } else await assert.rejects(runPlanDiagnostic(deps));
    assert.equal(calls.removed.length, 1);
    assert.equal(calls.output.includes(secretSentinel), false);
  }
});

test('cancellation during an in-flight plan prevents show and cleans private artifacts', async () => {
  const controller = new AbortController();
  let planStarted;
  const started = new Promise((resolve) => { planStarted = resolve; });
  const { deps, calls } = makeDiagnostic({ signal: controller.signal, waitForPlanCancellation: true,
    onPlanStart: () => planStarted() });
  const pending = runPlanDiagnostic(deps);
  await started;
  controller.abort();
  await assert.rejects(pending, /diagnostic failed safely/);
  assert.deepEqual(calls.commands.map((item) => item.command), ['plan']);
  assert.equal(calls.removed.length, 1);
});

test('waits for the cancelled Terraform child to close before removing its private plan directory', async () => {
  const controller = new AbortController();
  let childStarted;
  const started = new Promise((resolve) => { childStarted = resolve; });
  let childClosed = false;
  let removedAfterClose = false;
  const spawnImpl = (_binary, _args, options) => {
    const stream = () => Object.assign(new EventEmitter(), { setEncoding() { return this; } });
    const child = new EventEmitter();
    child.stdout = stream();
    child.stderr = stream();
    child.kill = () => {};
    options.signal.addEventListener('abort', () => {
      child.emit('error', Object.assign(new Error('aborted'), { name: 'AbortError' }));
      setTimeout(() => { childClosed = true; child.emit('close', null); }, 15);
    }, { once: true });
    childStarted();
    return child;
  };
  const adapters = createTerraformDiagnosticAdapters({ spawnImpl, env: { PATH: '/synthetic' } });
  const { deps, calls } = makeDiagnostic({ signal: controller.signal,
    runPlanImpl: adapters.runPlan,
    fs: { rmImpl: async (directory) => { removedAfterClose = childClosed; calls.removed.push(directory); } },
  });
  const pending = runPlanDiagnostic(deps);
  await started;
  controller.abort();
  await assert.rejects(pending, /diagnostic failed safely/);
  assert.equal(childClosed, true);
  assert.equal(removedAfterClose, true);
  assert.deepEqual(calls.commands.map((item) => item.command), ['plan']);
});

test('removes a new private directory when permission setup fails', async () => {
  const { deps, calls } = makeDiagnostic({ fs: { chmodImpl: async (file) => {
    if (file.includes('.aegis-browser-origin-diagnostic-')) throw new Error('synthetic permission failure');
  } } });
  await assert.rejects(runPlanDiagnostic(deps), /Private diagnostic directory permissions failed/);
  assert.equal(calls.commands.length, 0);
  assert.equal(calls.removed.length, 1);
});

test('does not reuse stale diagnostic or update-gate plan artifacts', async () => {
  for (const staleEntries of [['.aegis-browser-origin-diagnostic-old'], ['.aegis-browser-origin-update-old']]) {
    const { deps, calls } = makeDiagnostic({ staleEntries });
    await assert.rejects(runPlanDiagnostic(deps), /stale diagnostic plan artifact/);
    assert.equal(calls.commands.length, 0);
    assert.equal(calls.removed.length, 0);
  }
});

test('fails closed on cleanup failure and verifies expected HCP identity fields', async () => {
  const { deps } = makeDiagnostic();
  deps.fs.rmImpl = async () => { throw new Error('synthetic cleanup failure'); };
  await assert.rejects(runPlanDiagnostic(deps), /cleanup failed/);
  assert.equal(sameHcpIdentity(hcpState(), hcpState()), true);
  assert.equal(sameHcpIdentity(hcpState(), hcpState({ autoApply: true })), false);
});

test('only builds Terraform commands for plan and show, never apply', async () => {
  const calls = [];
  const spawnImpl = (binary, args, options) => {
    calls.push({ binary, args, options });
    const stream = () => Object.assign(new EventEmitter(), { setEncoding() { return this; } });
    const child = { stdout: stream(), stderr: stream(),
      once(event, handler) { if (event === 'close') queueMicrotask(() => handler(0)); return this; },
      kill() {} };
    queueMicrotask(() => child.stdout.emit('data', args[0] === 'show' ? JSON.stringify(baseline) : ''));
    return child;
  };
  const adapters = createTerraformDiagnosticAdapters({ spawnImpl, env: { PATH: '/synthetic' } });
  await adapters.runPlan('/private/synthetic/diagnostic.tfplan', { cwd: '/synthetic', env: {} });
  const shown = await adapters.showPlan('/private/synthetic/diagnostic.tfplan', { cwd: '/synthetic', env: {} });
  assert.equal(JSON.parse(shown).format_version, '1.1');
  assert.deepEqual(calls.map((call) => call.args[0]), ['plan', 'show']);
  assert.equal(calls.some((call) => call.args[0] === 'apply'), false);
});

test('requires an interactive diagnostic invocation without arguments', () => {
  assert.doesNotThrow(() => assertDiagnosticInvocation({ argv: ['node', 'diagnostic.mjs'], stdinIsTTY: true, stdoutIsTTY: true, env: {} }));
  assert.throws(() => assertDiagnosticInvocation({ argv: ['node', 'diagnostic.mjs'], stdinIsTTY: false, stdoutIsTTY: true, env: {} }), /interactive/);
  assert.throws(() => assertDiagnosticInvocation({ argv: ['node', 'diagnostic.mjs', 'apply'], stdinIsTTY: true, stdoutIsTTY: true, env: {} }), /arguments/);
});
