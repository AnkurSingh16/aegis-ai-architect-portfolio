import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { diagnosePlanDocument, diagnosePlanJson, runPlanDiagnostic, sameHcpIdentity,
  assertDiagnosticInvocation, createTerraformDiagnosticAdapters, parsePinnedAuth0ProviderVersion,
  summarizeDriftAgainstProviderSchema, terraformManagedAttributesByResource } from './diagnose-browser-origin-plan.mjs';

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

const auth0ProviderAddress = 'registry.terraform.io/auth0/auth0';

function schemaAttribute({ required = false, optional = false, computed = false, sensitive = false } = {}) {
  return {
    ...(required ? { required: true } : {}),
    ...(optional ? { optional: true } : {}),
    ...(computed ? { computed: true } : {}),
    ...(sensitive ? { sensitive: true } : {}),
    type: 'string',
  };
}

function providerSchemaFixture(attributes, formatVersion = '1.0', additionalResources = {}) {
  return JSON.stringify({ format_version: formatVersion, provider_schemas: {
    [auth0ProviderAddress]: { resource_schemas: {
      auth0_client: { version: 4, block: { attributes } }, ...additionalResources,
    } },
  } });
}

const pinnedLockFixture = `provider "registry.terraform.io/auth0/auth0" {
  version = "1.59.0"
  constraints = "= 1.59.0"
}`;

function schemaDrift(before, after, beforeSensitive = {}, afterSensitive = {}, afterUnknown = {}) {
  return [{ address: 'auth0_client.local_spa', mode: 'managed', type: 'auth0_client', name: 'local_spa',
    provider_name: auth0ProviderAddress, change: { actions: ['update'], before, after,
      before_sensitive: beforeSensitive, after_sensitive: afterSensitive, after_unknown: afterUnknown } }];
}

test('accepts only the exact pinned Auth0 provider lock entry', () => {
  assert.equal(parsePinnedAuth0ProviderVersion(pinnedLockFixture), '1.59.0');
  assert.equal(parsePinnedAuth0ProviderVersion(pinnedLockFixture.replace('1.59.0', '1.60.0')), null);
  assert.equal(parsePinnedAuth0ProviderVersion(`${pinnedLockFixture}\n${pinnedLockFixture}`), null);
  assert.equal(parsePinnedAuth0ProviderVersion('provider "registry.terraform.io/other/provider" { version = "1.59.0" }'), null);
});

test('classifies drift attributes with the pinned provider schema without exposing values or unknown names', () => {
  const schema = providerSchemaFixture({
    id: schemaAttribute({ computed: true }),
    callbacks: schemaAttribute({ optional: true, computed: true }),
    grant_types: schemaAttribute({ optional: true }),
    client_secret: schemaAttribute({ optional: true, sensitive: true }),
    app_type: schemaAttribute({ optional: true }),
  });
  const drift = schemaDrift(
    { id: secretSentinel, callbacks: ['old'], grant_types: ['authorization_code'], client_secret: secretSentinel,
      [secretSentinel]: 'before' },
    { id: `${secretSentinel}-new`, callbacks: ['new'], grant_types: ['implicit'], client_secret: `${secretSentinel}-new`,
      [secretSentinel]: 'after' },
    { client_secret: true }, { client_secret: true }, {});
  const result = summarizeDriftAgainstProviderSchema(drift, schema, '1.59.0');
  const entry = result.entries[0];
  assert.equal(result.provider, auth0ProviderAddress);
  assert.equal(result.pinnedVersion, '1.59.0');
  assert.equal(result.schemaAvailability, 'available');
  assert.equal(result.driftClassification, 'partial');
  assert.deepEqual(entry.classifications, {
    computedOnly: 1, optionalComputed: 1, configurable: 1, sensitive: 1, unknownUnrecognized: 1,
  });
  assert.equal(entry.configurableSettingAffected, true);
  assert.equal(entry.securityRelevantSettingAffected, true);
  assert.deepEqual(entry.safeNonSensitiveAttributeNames.sort(), ['callbacks', 'grant_types']);
  assert.equal(JSON.stringify(result).includes(secretSentinel), false);
  assert.equal(JSON.stringify(result).includes('client_secret'), false);
});

test('classifies computed-only SPA drift as nonconfigurable when the schema says so', () => {
  const schema = providerSchemaFixture({ id: schemaAttribute({ computed: true }), name: schemaAttribute({ computed: true }) });
  const drift = schemaDrift({ id: 'synthetic-before', name: 'synthetic-name' }, { id: 'synthetic-after', name: 'normalized-name' });
  const entry = summarizeDriftAgainstProviderSchema(drift, schema, '1.59.0').entries[0];
  assert.deepEqual(entry.classifications, { computedOnly: 2, optionalComputed: 0, configurable: 0, sensitive: 0, unknownUnrecognized: 0 });
  assert.equal(entry.configurableSettingAffected, false);
  assert.deepEqual(entry.safeNonSensitiveAttributeNames, ['name']);
});

test('accepts realistic omitted false schema flags and rejects malformed or impossible attribute modes', () => {
  const schema = providerSchemaFixture({
    id: schemaAttribute({ computed: true }),
    callbacks: schemaAttribute({ optional: true }),
    identifier: schemaAttribute({ required: true }),
    web_origins: schemaAttribute({ optional: true, computed: true }),
    client_secret: schemaAttribute({ optional: true, sensitive: true }),
    malformed_flag: { optional: 'yes', type: 'string' },
    impossible_mode: { required: true, optional: true, type: 'string' },
    sensitive_without_mode: { sensitive: true, type: 'string' },
    no_mode: { type: 'string' },
  });
  const before = Object.fromEntries(['id', 'callbacks', 'identifier', 'web_origins', 'client_secret', 'malformed_flag',
    'impossible_mode', 'sensitive_without_mode', 'no_mode'].map((key) => [key, `synthetic-${key}-before`]));
  const after = Object.fromEntries(Object.keys(before).map((key) => [key, `synthetic-${key}-after`]));
  const result = summarizeDriftAgainstProviderSchema(schemaDrift(before, after, {}, {}, {}), schema, '1.59.0');
  const entry = result.entries[0];
  assert.deepEqual(entry.classifications, {
    computedOnly: 1, optionalComputed: 1, configurable: 2, sensitive: 1, unknownUnrecognized: 4,
  });
  assert.equal(result.schemaAvailability, 'available');
  assert.equal(result.driftClassification, 'partial');
  assert.equal(entry.configurableSettingAffected, true);
  assert.deepEqual(entry.safeNonSensitiveAttributeNames, ['callbacks', 'web_origins']);
  assert.equal(JSON.stringify(result).includes('synthetic-'), false);
  assert.equal(JSON.stringify(result).includes('client_secret'), false);
});

test('distinguishes an available provider schema from missing resource or attribute schema coverage', () => {
  const schema = providerSchemaFixture({});
  const drift = schemaDrift({ provider_added_attribute: 'before' }, { provider_added_attribute: 'after' });
  const result = summarizeDriftAgainstProviderSchema(drift, schema, '1.59.0');
  assert.equal(result.schemaAvailability, 'available');
  assert.equal(result.driftClassification, 'partial');
  assert.equal(result.entries[0].classificationStatus, 'partial');
  assert.equal(result.entries[0].classifications.unknownUnrecognized, 1);
  const missingResourceSchema = providerSchemaFixture({}, '1.0', {});
  const otherTypeDrift = [{ ...drift[0], type: 'auth0_connection_client', name: 'local_spa_database',
    address: 'auth0_connection_client.local_spa_database' }];
  const missing = summarizeDriftAgainstProviderSchema(otherTypeDrift, missingResourceSchema, '1.59.0');
  assert.equal(missing.schemaAvailability, 'available');
  assert.equal(missing.driftClassification, 'partial');
  assert.equal(missing.entries[0].classificationStatus, 'unavailable');
  assert.equal(missing.configurableSettingAffected, null);
  assert.equal(missing.securityRelevantSettingAffected, null);
  const noAttributesDrift = [{ ...otherTypeDrift[0], change: { actions: ['update'], before: {}, after: {} } }];
  const missingNoAttributes = summarizeDriftAgainstProviderSchema(noAttributesDrift, missingResourceSchema, '1.59.0');
  assert.equal(missingNoAttributes.driftClassification, 'partial');
  assert.equal(missingNoAttributes.configurableSettingAffected, null);
  assert.equal(missingNoAttributes.securityRelevantSettingAffected, null);
});

test('uses the matching pinned provider schema for each expected Auth0 resource type', () => {
  const schema = providerSchemaFixture({}, '1.0', {
    auth0_resource_server: { version: 2, block: { attributes: { identifier: schemaAttribute({ required: true }) } } },
    auth0_resource_server_scope: { version: 1, block: { attributes: { scope: schemaAttribute({ required: true }) } } },
    auth0_connection_client: { version: 0, block: { attributes: { connection_id: schemaAttribute({ required: true }) } } },
  });
  const entries = [
    ['auth0_resource_server.cases', 'auth0_resource_server', 'cases', 'identifier'],
    ['auth0_resource_server_scope.read_cases', 'auth0_resource_server_scope', 'read_cases', 'scope'],
    ['auth0_connection_client.local_spa_database', 'auth0_connection_client', 'local_spa_database', 'connection_id'],
  ].map(([address, type, name, attribute]) => ({ address, mode: 'managed', type, name,
    provider_name: auth0ProviderAddress, change: { actions: ['update'], before: { [attribute]: 'before' }, after: { [attribute]: 'after' } } }));
  const result = summarizeDriftAgainstProviderSchema(entries, schema, '1.59.0');
  assert.equal(result.schemaAvailability, 'available');
  assert.equal(result.driftClassification, 'complete');
  for (const entry of result.entries) {
    assert.equal(entry.classifications.configurable, 1);
    assert.equal(entry.classifications.unknownUnrecognized, 0);
    assert.equal(entry.configurableSettingAffected, true);
  }
});

test('fails closed when provider schema, pinned version, or drift identity is malformed', () => {
  const schema = providerSchemaFixture({ app_type: schemaAttribute({ optional: true }) });
  const malformed = summarizeDriftAgainstProviderSchema(schemaDrift({ app_type: 'spa' }, { app_type: 'native' }), '{bad-json', '1.59.0');
  assert.equal(malformed.schemaAvailability, 'unavailable');
  assert.equal(malformed.driftClassification, 'unavailable');
  assert.equal(malformed.configurableSettingAffected, null);
  const wrongVersion = summarizeDriftAgainstProviderSchema(schemaDrift({ app_type: 'spa' }, { app_type: 'native' }), schema, '1.60.0');
  assert.equal(wrongVersion.schemaAvailability, 'unavailable');
  const foreignDrift = schemaDrift({ app_type: 'spa' }, { app_type: 'native' });
  foreignDrift[0].provider_name = 'unapproved.provider';
  assert.equal(summarizeDriftAgainstProviderSchema(foreignDrift, schema, '1.59.0').entries[0].resource, 'unexpected');
});

test('treats malformed drift sensitivity and unknown masks as unclassified', () => {
  const schema = providerSchemaFixture({ callbacks: schemaAttribute({ optional: true }) });
  const drift = schemaDrift({ callbacks: ['before'] }, { callbacks: ['after'] });
  drift[0].change.after_unknown = 'malformed-mask';
  const entry = summarizeDriftAgainstProviderSchema(drift, schema, '1.59.0').entries[0];
  assert.equal(entry.classifications.unknownUnrecognized, 1);
  assert.equal(entry.configurableAttributeCount, 0);
  assert.equal(entry.configurableSettingAffected, null);
  assert.equal(entry.securityRelevantSettingAffected, null);
  assert.deepEqual(entry.safeNonSensitiveAttributeNames, []);
});

test('reports malformed root mask metadata even when no attribute keys are discoverable', () => {
  const schema = providerSchemaFixture({ callbacks: schemaAttribute({ optional: true }) });
  const drift = schemaDrift({}, {});
  drift[0].change.after_unknown = 'malformed-mask';
  const result = summarizeDriftAgainstProviderSchema(drift, schema, '1.59.0');
  const entry = result.entries[0];
  assert.equal(result.schemaAvailability, 'available');
  assert.equal(result.driftClassification, 'partial');
  assert.equal(entry.classifications.unknownUnrecognized, 1);
  assert.equal(entry.classificationStatus, 'partial');
  assert.equal(entry.configurableSettingAffected, null);
  assert.equal(entry.securityRelevantSettingAffected, null);
  assert.deepEqual(entry.safeNonSensitiveAttributeNames, []);
});

function plannedBrowserChanges({ extraSpaChange = false, unknownSpaChange = false, maskApprovedUrl = null, malformedMask = false } = {}) {
  const addresses = [
    'auth0_resource_server.cases',
    'auth0_resource_server_scope.read_cases',
    'auth0_resource_server_scope.write_cases',
    'auth0_client.local_spa',
    'auth0_connection_client.local_spa_database',
  ];
  return addresses.map((address) => {
    const [type, name] = address.split('.');
    const before = { id: `synthetic-${name}`, name };
    let after = clone(before);
    const isSpa = address === 'auth0_client.local_spa';
    if (isSpa) {
      Object.assign(before, {
        app_type: 'spa',
        callbacks: ['http://127.0.0.1:49321/auth/callback'],
        web_origins: ['http://127.0.0.1:49321'],
        allowed_logout_urls: ['http://127.0.0.1:49321'],
        allowed_origins: ['http://127.0.0.1:49321'],
      });
      after = { ...clone(before),
        callbacks: [...before.callbacks, 'http://127.0.0.1:5173/'],
        web_origins: [...before.web_origins, 'http://127.0.0.1:5173'],
        allowed_logout_urls: [...before.allowed_logout_urls, 'http://127.0.0.1:5173'],
      };
      if (extraSpaChange) after.name = `${name}-changed`;
    }
    const change = { actions: isSpa ? ['update'] : ['no-op'], before, after, after_unknown: {} };
    if (isSpa && unknownSpaChange) change.after_unknown = { name: true };
    if (isSpa && maskApprovedUrl) change.after_unknown = { [maskApprovedUrl]: true };
    if (isSpa && malformedMask) change.after_unknown = secretSentinel;
    return { address, mode: 'managed', type, name, provider_name: auth0ProviderAddress, change };
  });
}

test('distinguishes the approved three-URL planned update from Auth0 resource drift', () => {
  const plan = { ...clone(baseline), resource_changes: plannedBrowserChanges() };
  const summary = diagnosePlanDocument(plan, providerSchemaFixture({}), '1.59.0').plannedBrowserOriginUpdate;
  assert.equal(summary.resourceInventoryMatches, true);
  assert.deepEqual(summary.targetActions, ['update']);
  assert.equal(summary.changedApprovedUrlCount, 3);
  assert.equal(summary.unexpectedChangedAttributeCount, 0);
  assert.equal(summary.unknownChangedAttributeCount, 0);
  assert.equal(summary.targetUrlValuesMatch, true);
  assert.equal(summary.onlyApprovedUrlChanges, true);
  assert.equal(JSON.stringify(summary).includes('synthetic'), false);
});

test('rejects planned SPA changes outside the three approved URLs and reports unknown attributes safely', () => {
  const extra = diagnosePlanDocument({ ...clone(baseline), resource_changes: plannedBrowserChanges({ extraSpaChange: true }) },
    providerSchemaFixture({}), '1.59.0').plannedBrowserOriginUpdate;
  assert.equal(extra.unexpectedChangedAttributeCount, 1);
  assert.equal(extra.onlyApprovedUrlChanges, false);
  const unknown = diagnosePlanDocument({ ...clone(baseline), resource_changes: plannedBrowserChanges({ unknownSpaChange: true }) },
    providerSchemaFixture({}), '1.59.0').plannedBrowserOriginUpdate;
  assert.equal(unknown.unknownChangedAttributeCount, 1);
  assert.equal(unknown.onlyApprovedUrlChanges, null);
  assert.equal(JSON.stringify(unknown).includes('name'), false);
});

test('fails closed when approved URL values are unknown or their masks are malformed', () => {
  for (const [options, expectedMaskedCount] of [[{ maskApprovedUrl: 'callbacks' }, 1], [{ malformedMask: true }, 3]]) {
    const summary = diagnosePlanDocument({ ...clone(baseline), resource_changes: plannedBrowserChanges(options) },
      providerSchemaFixture({}), '1.59.0').plannedBrowserOriginUpdate;
    assert.equal(summary.targetUrlValuesMatch, false);
    assert.equal(summary.maskedApprovedUrlCount, expectedMaskedCount);
    assert.equal(summary.onlyApprovedUrlChanges, null);
  }
});

test('compares refreshed drift with the post-refresh pre-action baseline using counts only', () => {
  const schema = providerSchemaFixture({ name: schemaAttribute({ optional: true, computed: true }) });
  const planned = plannedBrowserChanges();
  const target = planned.find((item) => item.address === 'auth0_client.local_spa');
  target.change.before.name = 'refreshed-baseline';
  target.change.after.name = 'desired-update';
  const matching = summarizeDriftAgainstProviderSchema(
    schemaDrift({ name: 'stale-state' }, { name: 'refreshed-baseline' }), schema, '1.59.0', planned);
  assert.deepEqual(matching.entries[0].plannedValueComparison, { matchesRefreshed: 1, differsFromRefreshed: 0, unavailable: 0 });
  const differing = summarizeDriftAgainstProviderSchema(
    schemaDrift({ name: 'stale-state' }, { name: 'provider-normalized' }), schema, '1.59.0', planned);
  assert.deepEqual(differing.entries[0].plannedValueComparison, { matchesRefreshed: 0, differsFromRefreshed: 1, unavailable: 0 });
  assert.equal(JSON.stringify(matching).includes('desired-update'), false);
  assert.equal(JSON.stringify(differing).includes('provider-normalized'), false);
});

test('reports each drift field using allowlisted names, pinned schema mode, ownership, and three distinct value comparisons', () => {
  const schema = providerSchemaFixture({
    callbacks: schemaAttribute({ optional: true }),
    allowed_clients: schemaAttribute({ optional: true }),
    grant_types: schemaAttribute({ optional: true }),
    client_secret: schemaAttribute({ optional: true, sensitive: true }),
  });
  const planned = plannedBrowserChanges();
  const target = planned.find((item) => item.address === 'auth0_client.local_spa');
  target.change.before.callbacks = ['refreshed-callback'];
  target.change.after.callbacks = ['desired-callback'];
  target.change.before.allowed_clients = ['refreshed-client'];
  target.change.after.allowed_clients = ['desired-client'];
  target.change.before.grant_types = ['authorization_code'];
  target.change.after.grant_types = ['authorization_code'];
  target.change.before.client_secret = 'synthetic-sensitive-value';
  target.change.after.client_secret = 'synthetic-sensitive-value';
  target.change.before_sensitive = {};
  target.change.after_unknown = {};
  target.change.after_sensitive = {};
  target.change.before_sensitive.client_secret = true;
  target.change.after_sensitive.client_secret = true;

  const drift = schemaDrift(
    { callbacks: ['saved-callback'], allowed_clients: ['saved-client'], grant_types: ['old-grant'], client_secret: 'hidden-before' },
    { callbacks: ['refreshed-callback'], allowed_clients: ['remote-client'], grant_types: ['authorization_code'], client_secret: 'hidden-after' },
    { client_secret: true }, { client_secret: true }, {});
  const result = summarizeDriftAgainstProviderSchema(drift, schema, '1.59.0', planned).entries[0];
  assert.deepEqual(result.attributeFindings, [
    { attribute: 'callbacks', providerSchemaMode: 'configurable', configurationOwnership: 'terraform-managed',
      securityRelevance: true, savedStateVsRefreshedRemote: 'differs', remoteMatchesRefreshedPreActionBaseline: 'matches',
      remoteMatchesPlannedDesiredValue: 'differs', operatorReviewRequired: true },
    { attribute: 'allowed_clients', providerSchemaMode: 'configurable', configurationOwnership: 'not-explicitly-managed-origin-unverified',
      securityRelevance: true, savedStateVsRefreshedRemote: 'differs', remoteMatchesRefreshedPreActionBaseline: 'differs',
      remoteMatchesPlannedDesiredValue: 'differs', operatorReviewRequired: true },
    { attribute: 'grant_types', providerSchemaMode: 'configurable', configurationOwnership: 'terraform-managed',
      securityRelevance: true, savedStateVsRefreshedRemote: 'differs', remoteMatchesRefreshedPreActionBaseline: 'matches',
      remoteMatchesPlannedDesiredValue: 'matches', operatorReviewRequired: true },
    { attribute: 'unidentified', providerSchemaMode: 'sensitive', configurationOwnership: 'unidentified',
      securityRelevance: 'unverified', savedStateVsRefreshedRemote: 'unavailable', remoteMatchesRefreshedPreActionBaseline: 'unavailable',
      remoteMatchesPlannedDesiredValue: 'unavailable', operatorReviewRequired: true },
  ]);
  assert.equal(JSON.stringify(result).includes('client_secret'), false);
  assert.equal(JSON.stringify(result).includes('hidden-after'), false);
  assert.equal(JSON.stringify(result).includes('synthetic-sensitive-value'), false);
});

test('attributes explicitly configured on other managed resources are not mislabeled as defaults', () => {
  const schema = providerSchemaFixture({}, '1.0', {
    auth0_resource_server: { version: 2, block: { attributes: { signing_alg: schemaAttribute({ optional: true }) } } },
  });
  const drift = [{ address: 'auth0_resource_server.cases', mode: 'managed', type: 'auth0_resource_server', name: 'cases',
    provider_name: auth0ProviderAddress, change: { actions: ['update'], before: { signing_alg: 'HS256' }, after: { signing_alg: 'RS256' } } }];
  const result = summarizeDriftAgainstProviderSchema(drift, schema, '1.59.0').entries[0];
  assert.deepEqual(result.attributeFindings, [{ attribute: 'signing_alg', providerSchemaMode: 'configurable',
    configurationOwnership: 'terraform-managed', securityRelevance: true, savedStateVsRefreshedRemote: 'differs',
    remoteMatchesRefreshedPreActionBaseline: 'unavailable', remoteMatchesPlannedDesiredValue: 'unavailable', operatorReviewRequired: true }]);
});

test('keeps schema attributes with potentially sensitive names unidentified even when values are masked from output', () => {
  const schema = providerSchemaFixture({ encryption_key: schemaAttribute({ optional: true }) });
  const result = summarizeDriftAgainstProviderSchema(
    schemaDrift({ encryption_key: 'SYNTHETIC_ENCRYPTION_VALUE_BEFORE' }, { encryption_key: 'SYNTHETIC_ENCRYPTION_VALUE_AFTER' }),
    schema, '1.59.0').entries[0];
  assert.deepEqual(result.attributeFindings.map(({ attribute, providerSchemaMode, configurationOwnership }) =>
    ({ attribute, providerSchemaMode, configurationOwnership })), [{ attribute: 'unidentified',
    providerSchemaMode: 'configurable', configurationOwnership: 'unidentified' }]);
  assert.equal(JSON.stringify(result).includes('encryption_key'), false);
  assert.equal(JSON.stringify(result).includes('SYNTHETIC_ENCRYPTION_VALUE'), false);
});

test('keeps the production Terraform ownership map synchronized with current resource declarations', () => {
  const source = readFileSync(new URL('./main.tf', import.meta.url), 'utf8');
  const resourceDeclarations = Object.keys(terraformManagedAttributesByResource);
  const configuredResources = [...source.matchAll(/^resource "([a-z][a-z0-9_]*)" "([a-z][a-z0-9_]*)" \{/gm)]
    .map((match) => `${match[1]}.${match[2]}`).sort();
  assert.deepEqual(configuredResources, [...resourceDeclarations].sort());
  for (const resourceAddress of resourceDeclarations) {
    const [type, name] = resourceAddress.split('.');
    const heading = `resource "${type}" "${name}" {`;
    const start = source.indexOf(heading);
    assert.notEqual(start, -1, `missing Terraform resource ${type}.${name}`);
    const nextResource = source.indexOf('\nresource "', start + heading.length);
    const body = source.slice(start, nextResource < 0 ? source.length : nextResource);
    const declared = [...body.matchAll(/^ {2}([a-z][a-z0-9_]*)\s*(?:=|\{)/gm)].map((match) => match[1]).sort();
    assert.deepEqual(declared, [...terraformManagedAttributesByResource[resourceAddress]].sort(),
      `ownership map differs from HCL for ${type}.${name}`);
  }
});

test('does not compare provider-sensitive values even when the plan omits sensitivity masks', () => {
  const schema = providerSchemaFixture({ client_secret: schemaAttribute({ optional: true, sensitive: true }) });
  const planned = plannedBrowserChanges();
  const target = planned.find((item) => item.address === 'auth0_client.local_spa');
  target.change.before.client_secret = 'synthetic-before-secret';
  target.change.after.client_secret = 'synthetic-after-secret';
  const result = summarizeDriftAgainstProviderSchema(
    schemaDrift({ client_secret: 'synthetic-stale' }, { client_secret: 'synthetic-before-secret' }),
    schema, '1.59.0', planned);
  assert.deepEqual(result.entries[0].plannedValueComparison, { matchesRefreshed: 0, differsFromRefreshed: 0, unavailable: 1 });
  assert.equal(JSON.stringify(result).includes('synthetic-'), false);
});

test('does not compare attributes with unknown or incomplete provider schema metadata', () => {
  const schema = providerSchemaFixture({ unknown_property: schemaAttribute(), incomplete_property: { optional: true, sensitive: null } });
  const planned = plannedBrowserChanges();
  const target = planned.find((item) => item.address === 'auth0_client.local_spa');
  for (const name of ['unknown_property', 'incomplete_property']) {
    target.change.before[name] = 'synthetic-before';
    target.change.after[name] = 'synthetic-after';
  }
  const result = summarizeDriftAgainstProviderSchema(schemaDrift(
    { unknown_property: 'synthetic-old', incomplete_property: 'synthetic-old' },
    { unknown_property: 'synthetic-before', incomplete_property: 'synthetic-before' }), schema, '1.59.0', planned);
  assert.deepEqual(result.entries[0].plannedValueComparison, { matchesRefreshed: 0, differsFromRefreshed: 0, unavailable: 2 });
  assert.equal(JSON.stringify(result).includes('unknown_property'), false);
  assert.equal(JSON.stringify(result).includes('synthetic-'), false);
});

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
    'formatVersion', 'optionalFields', 'outputChangeSummary', 'plannedBrowserOriginSigningCandidate', 'plannedBrowserOriginUpdate', 'providerSchemaSummary',
    'requiredFields', 'resourceDriftSummary', 'terraformVersion'].sort());
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
  assert.equal(summary.verifiedNoOp, true);
  assert.deepEqual(summary.outputs.map(({ name, actions, beforeAfterEqual, afterUnknown, afterSensitive }) =>
    ({ name, actions, beforeAfterEqual, afterUnknown, afterSensitive })), [
    { name: 'issuer', actions: ['no-op'], beforeAfterEqual: true, afterUnknown: false, afterSensitive: false },
    { name: 'audience', actions: ['no-op'], beforeAfterEqual: true, afterUnknown: false, afterSensitive: false },
    { name: 'spa_client_id', actions: ['no-op'], beforeAfterEqual: true, afterUnknown: false, afterSensitive: false },
  ]);
  assert.equal(JSON.stringify(summary).includes(secretSentinel), false);
});

const expectedAddresses = [
  'auth0_resource_server.cases',
  'auth0_resource_server_scope.read_cases',
  'auth0_resource_server_scope.write_cases',
  'auth0_client.local_spa',
  'auth0_connection_client.local_spa_database',
];
const plannedBefore = {
  id: 'synthetic-spa-id', name: 'Aegis AI Local SPA', app_type: 'spa',
  callbacks: ['http://127.0.0.1:49321/auth/callback'],
  allowed_logout_urls: ['http://127.0.0.1:49321'],
  web_origins: ['http://127.0.0.1:49321'],
  allowed_origins: ['http://127.0.0.1:49321'],
  jwt_configuration: [{ alg: '', lifetime_in_seconds: 3600, scopes: {}, secret_encoded: false }],
  client_secret: secretSentinel,
};
function expandedCandidatePlan() {
  const outputChanges = Object.fromEntries([
    ['issuer', 'https://synthetic.auth0.example/'],
    ['audience', 'https://aegis.synthetic.example/api'],
    ['spa_client_id', 'synthetic-spa-id'],
  ].map(([name, value]) => [name, outputChange(value, value)]));
  const resourceChanges = expectedAddresses.map((address) => {
    const [type, name] = address.split('.');
    const base = { address, mode: 'managed', type, name, provider_name: auth0ProviderAddress };
    if (address !== 'auth0_client.local_spa') {
      const value = { id: `synthetic-${name}` };
      return { ...base, change: { actions: ['no-op'], before: value, after: clone(value),
        after_unknown: {}, before_sensitive: {}, after_sensitive: {} } };
    }
    const after = clone(plannedBefore);
    after.callbacks.push('http://127.0.0.1:5173/');
    after.allowed_logout_urls.push('http://127.0.0.1:5173');
    after.web_origins.push('http://127.0.0.1:5173');
    after.jwt_configuration[0].alg = 'RS256';
    return { ...base, change: { actions: ['update'], before: clone(plannedBefore), after,
      after_unknown: {}, before_sensitive: { client_secret: true }, after_sensitive: { client_secret: true } } };
  });
  return { ...clone(baseline), resource_changes: resourceChanges, output_changes: outputChanges };
}

test('reports the exact URL and RS256 candidate while making no deployment authorization claim', () => {
  const document = expandedCandidatePlan();
  const report = diagnosePlanDocument(document);
  const candidate = report.plannedBrowserOriginSigningCandidate;
  assert.deepEqual(candidate.approvedUrlAdditions, {
    callback: 'http://127.0.0.1:5173/', logout: 'http://127.0.0.1:5173', webOrigin: 'http://127.0.0.1:5173',
  });
  assert.equal(candidate.approvedUrlValuesMatch, true);
  assert.deepEqual(candidate.jwtAlgorithmClassifications, { before: 'empty-string', after: 'RS256' });
  assert.equal(candidate.jwtAlgorithmTransition, 'empty-string -> RS256');
  assert.equal(candidate.jwtNestedFieldsUnchanged, true);
  assert.equal(candidate.jwtValuesKnownAndNonSensitive, true);
  assert.equal(candidate.otherResourceAttributeChangeCount, 0);
  assert.equal(candidate.noOtherResourceAttributeChanges, true);
  assert.equal(candidate.noUnexpectedOrUnknownValues, true);
  assert.equal(candidate.verifiedNoOpOutputs, true);
  assert.equal(candidate.candidateScopeMatches, true);
  assert.equal(candidate.resourceDriftBlocksDeployment, false);
  assert.equal(candidate.resourceDriftAuthorized, false);
  assert.equal(candidate.diagnosticAuthorizesDeployment, false);
  assert.deepEqual(report.failedValidationRuleIds, []);
  assert.equal(JSON.stringify(report).includes(secretSentinel), false);
});

for (const [label, mutate, expectedBefore, expectedAfter, expectedCandidate = false, expectedDashboardDifference = true] of [
  ['RS256 remains RS256', (target) => { target.before.jwt_configuration[0].alg = 'RS256'; }, 'RS256', 'RS256', false, true],
  ['standard ES512 becomes RS256', (target) => { target.before.jwt_configuration[0].alg = 'ES512'; }, 'ES512', 'RS256', false, true],
  ['empty algorithm becomes RS256', (target) => { target.before.jwt_configuration[0].alg = ''; }, 'empty-string', 'RS256', true, true],
  ['whitespace algorithm becomes RS256', (target) => { target.before.jwt_configuration[0].alg = ' \t '; }, 'whitespace-only', 'RS256', false, true],
  ['capitalization mismatch becomes RS256', (target) => { target.before.jwt_configuration[0].alg = 'hs256'; }, 'capitalization-mismatch', 'RS256', false, true],
  ['unexpected string becomes RS256 without disclosure', (target) => { target.before.jwt_configuration[0].alg = 'SYNTHETIC-UNRECOGNIZED-ALG'; }, 'unexpected-nonstandard', 'RS256', false, true],
  ['missing algorithm becomes RS256', (target) => { delete target.before.jwt_configuration[0].alg; }, 'missing', 'RS256', false, null],
  ['missing block becomes RS256', (target) => { delete target.before.jwt_configuration; }, 'missing', 'RS256', false, null],
  ['explicit false whole-block masks remain known', (target) => {
    target.before_sensitive = { jwt_configuration: false };
    target.after_unknown = { jwt_configuration: false };
    target.after_sensitive = { jwt_configuration: false };
  }, 'empty-string', 'RS256', true, true],
  ['unexpected desired HS256', (target) => { target.after.jwt_configuration[0].alg = 'HS256'; }, 'empty-string', 'HS256'],
  ['malformed known value', (target) => { target.after.jwt_configuration[0].alg = 42; }, 'empty-string', 'malformed'],
  ['unknown after algorithm', (target) => { target.after_unknown = { jwt_configuration: [{ alg: true }] }; }, 'empty-string', 'unknown-or-sensitive'],
  ['omitted unknown after algorithm', (target) => {
    target.after.jwt_configuration[0] = {};
    target.after_unknown = { jwt_configuration: [{ alg: true }] };
  }, 'empty-string', 'unknown-or-sensitive'],
  ['omitted unknown JWT block', (target) => {
    delete target.after.jwt_configuration;
    target.after_unknown = { jwt_configuration: true };
  }, 'empty-string', 'unknown-or-sensitive'],
  ['sensitive after algorithm', (target) => { target.after_sensitive = { client_secret: true, jwt_configuration: [{ alg: true }] }; }, 'empty-string', 'unknown-or-sensitive'],
  ['sensitive before algorithm', (target) => { target.before_sensitive = { client_secret: true, jwt_configuration: [{ alg: true }] }; }, 'unknown-or-sensitive', 'RS256', false, null],
  ['malformed metadata shape', (target) => { target.after_sensitive = { jwt_configuration: 'masked', client_secret: true }; }, 'empty-string', 'malformed'],
]) {
  test(`classifies planned JWT algorithm safely when ${label}`, () => {
    const document = expandedCandidatePlan();
    const target = document.resource_changes.find((item) => item.address === 'auth0_client.local_spa').change;
    mutate(target);
    const candidate = diagnosePlanDocument(document).plannedBrowserOriginSigningCandidate;
    assert.deepEqual(candidate.jwtAlgorithmClassifications, { before: expectedBefore, after: expectedAfter });
    assert.equal(candidate.jwtAlgorithmTransition, `${expectedBefore} -> ${expectedAfter}`);
    assert.equal(candidate.beforeAlgorithmDiffersFromDashboardObservation, expectedDashboardDifference);
    assert.equal(candidate.desiredAlgorithmIsExactlyRS256, expectedAfter === 'RS256');
    assert.equal(candidate.candidateScopeMatches, expectedCandidate);
    assert.equal(JSON.stringify(candidate).includes('masked'), false);
    assert.equal(JSON.stringify(candidate).includes('SYNTHETIC-UNRECOGNIZED-ALG'), false);
  });
}

for (const algorithm of ['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512',
  'PS256', 'PS384', 'PS512', 'EdDSA']) {
  test(`allows only the reviewed standard JWT signing algorithm label ${algorithm}`, () => {
    const document = expandedCandidatePlan();
    const target = document.resource_changes.find((item) => item.address === 'auth0_client.local_spa').change;
    target.before.jwt_configuration[0].alg = algorithm;
    const candidate = diagnosePlanDocument(document).plannedBrowserOriginSigningCandidate;
    assert.equal(candidate.jwtAlgorithmClassifications.before, algorithm);
    assert.equal(candidate.jwtAlgorithmClassifications.after, 'RS256');
    assert.equal(candidate.candidateScopeMatches, false);
    assert.equal(candidate.diagnosticAuthorizesDeployment, false);
  });
}

for (const [label, mutate] of [
  ['JWT lifetime change', (target) => { target.after.jwt_configuration[0].lifetime_in_seconds = 7200; }],
  ['JWT scopes change', (target) => { target.after.jwt_configuration[0].scopes = { openid: 'openid' }; }],
  ['missing JWT configuration', (target) => { delete target.after.jwt_configuration; }],
  ['unknown JWT configuration', (target) => { target.after_unknown = { jwt_configuration: [{ alg: true }] }; }],
  ['sensitive approved URL value', (target) => { target.after_sensitive = { client_secret: true, callbacks: [true] }; }],
  ['sensitive JWT configuration', (target) => { target.after_sensitive = { jwt_configuration: true, client_secret: true }; }],
  ['malformed JWT metadata', (target) => { target.after_sensitive = { jwt_configuration: 'sensitive', client_secret: true }; }],
  ['unexpected SPA attribute', (target) => { target.after.grant_types = ['client_credentials']; }],
  ['malformed target action shape', (target) => { target.actions = { 0: 'update', length: 1 }; }],
]) {
  test(`rejects candidate scope with ${label}`, () => {
    const document = expandedCandidatePlan();
    const target = document.resource_changes.find((item) => item.address === 'auth0_client.local_spa').change;
    mutate(target);
    const result = diagnosePlanDocument(document).plannedBrowserOriginSigningCandidate;
    assert.notEqual(result.candidateScopeMatches, true);
  });
}

test('nonempty resource drift remains a deployment blocker even when candidate scope matches', () => {
  const document = expandedCandidatePlan();
  document.resource_drift = [driftEntry('auth0_client.local_spa', { allowed_clients: [] }, { allowed_clients: ['synthetic-other-app'] })];
  const report = diagnosePlanDocument(document);
  const candidate = report.plannedBrowserOriginSigningCandidate;
  assert.equal(candidate.candidateScopeMatches, true);
  assert.equal(candidate.resourceDriftCount, 1);
  assert.equal(candidate.resourceDriftBlocksDeployment, true);
  assert.equal(candidate.resourceDriftAuthorized, false);
  assert.equal(candidate.diagnosticAuthorizesDeployment, false);
  assert.ok(report.failedValidationRuleIds.includes('plan.resource_drift.absent_or_empty_array'));
});

test('distinguishes omitted, empty and malformed drift metadata without authorizing deployment', () => {
  const absent = expandedCandidatePlan();
  delete absent.resource_drift;
  const absentCandidate = diagnosePlanDocument(absent).plannedBrowserOriginSigningCandidate;
  assert.equal(absentCandidate.resourceDriftStatus, 'absent');
  assert.equal(absentCandidate.resourceDriftBlocksDeployment, false);
  assert.equal(absentCandidate.diagnosticAuthorizesDeployment, false);

  const malformed = expandedCandidatePlan();
  malformed.resource_drift = {};
  const malformedCandidate = diagnosePlanDocument(malformed).plannedBrowserOriginSigningCandidate;
  assert.equal(malformedCandidate.resourceDriftStatus, 'malformed');
  assert.equal(malformedCandidate.resourceDriftBlocksDeployment, true);
  assert.equal(malformedCandidate.diagnosticAuthorizesDeployment, false);
});

test('malformed resource entries produce a nonmatching candidate summary instead of throwing', () => {
  const document = expandedCandidatePlan();
  document.resource_changes[0] = null;
  const report = diagnosePlanDocument(document);
  assert.equal(report.plannedBrowserOriginSigningCandidate.resourceInventoryMatches, false);
  assert.notEqual(report.plannedBrowserOriginSigningCandidate.candidateScopeMatches, true);
  assert.equal(JSON.stringify(report).includes(secretSentinel), false);
});

test('rejects changed outputs and keeps unverified no-op outputs from matching the candidate', () => {
  const document = expandedCandidatePlan();
  document.output_changes.issuer.actions = ['update'];
  const report = diagnosePlanDocument(document);
  assert.equal(report.outputChangeSummary.verifiedNoOp, false);
  assert.notEqual(report.plannedBrowserOriginSigningCandidate.candidateScopeMatches, true);
  assert.ok(report.failedValidationRuleIds.includes('plan.output_changes.absent_or_empty_object'));
});

test('rejects structurally invalid object masks for scalar no-op outputs', () => {
  const document = expandedCandidatePlan();
  document.output_changes.issuer.after_unknown = {};
  document.output_changes.audience.before_sensitive = {};
  document.output_changes.spa_client_id.after_sensitive = {};
  const report = diagnosePlanDocument(document);
  assert.equal(report.outputChangeSummary.verifiedNoOp, false);
  assert.notEqual(report.plannedBrowserOriginSigningCandidate.candidateScopeMatches, true);
  assert.ok(report.failedValidationRuleIds.includes('plan.output_changes.absent_or_empty_object'));
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
    getPinnedProviderVersion: async () => overrides.pinnedVersion ?? '1.59.0',
    runProviderSchema: async (context) => {
      calls.commands.push({ command: 'schema', context });
      if (overrides.schemaFailure) throw new Error('SYNTHETIC_PROVIDER_SCHEMA_FAILURE_SECRET');
      return overrides.schema ?? providerSchemaFixture({ app_type: schemaAttribute({ optional: true }) });
    },
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
  assert.deepEqual(calls.commands.map((item) => item.command), ['plan', 'show', 'schema']);
  assert.equal(calls.commands.some((item) => item.command === 'apply'), false);
  assert.equal(calls.preflights, 4);
  assert.equal(calls.removed.length, 1);
  assert.equal(calls.chmod.some(([file, mode]) => file.includes('.aegis-browser-origin-diagnostic-') && mode === 0o700), true);
  assert.equal(calls.chmod.some(([file, mode]) => file.endsWith('diagnostic.tfplan') && mode === 0o600), true);
  assert.equal(JSON.stringify(result).includes(secretSentinel), false);
  assert.equal(calls.commands[2].context.env.AUTH0_CLIENT_SECRET, undefined);
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

test('rechecks HCP identity after provider schema inspection and cleans on changed state', async () => {
  const { deps, calls } = makeDiagnostic({ stateAt: (count) => count === 4
    ? hcpState({ stateVersionId: 'changed-during-schema-inspection' }) : hcpState() });
  await assert.rejects(runPlanDiagnostic(deps), /diagnostic failed safely/);
  assert.deepEqual(calls.commands.map((item) => item.command), ['plan', 'show', 'schema']);
  assert.equal(calls.removed.length, 1);
});

test('reports provider schema as unavailable and cleans the plan after schema command failure', async () => {
  const { deps, calls } = makeDiagnostic({ schemaFailure: true });
  const result = await runPlanDiagnostic(deps);
  assert.equal(result.providerSchemaSummary.schemaAvailability, 'unavailable');
  assert.equal(result.providerSchemaSummary.driftClassification, 'unavailable');
  assert.equal(result.providerSchemaSummary.configurableSettingAffected, null);
  assert.equal(calls.preflights, 4);
  assert.equal(calls.removed.length, 1);
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
    queueMicrotask(() => child.stdout.emit('data', args[0] === 'show' ? JSON.stringify(baseline) :
      args[0] === 'providers' ? providerSchemaFixture({ app_type: schemaAttribute({ optional: true }) }) : ''));
    return child;
  };
  const adapters = createTerraformDiagnosticAdapters({ spawnImpl, env: { PATH: '/synthetic' } });
  await adapters.runPlan('/private/synthetic/diagnostic.tfplan', { cwd: '/synthetic', env: {} });
  const shown = await adapters.showPlan('/private/synthetic/diagnostic.tfplan', { cwd: '/synthetic', env: {} });
  const schema = await adapters.runProviderSchema({ cwd: '/synthetic', env: { AUTH0_CLIENT_SECRET: secretSentinel } });
  assert.equal(JSON.parse(shown).format_version, '1.1');
  assert.equal(JSON.parse(schema).format_version, '1.0');
  assert.deepEqual(calls.map((call) => call.args[0]), ['plan', 'show', 'providers']);
  assert.deepEqual(calls[2].args, ['providers', 'schema', '-json']);
  assert.equal(calls[2].options.env.AUTH0_CLIENT_SECRET, undefined);
  assert.equal(calls.some((call) => call.args[0] === 'apply'), false);
});

test('requires an interactive diagnostic invocation without arguments', () => {
  assert.doesNotThrow(() => assertDiagnosticInvocation({ argv: ['node', 'diagnostic.mjs'], stdinIsTTY: true, stdoutIsTTY: true, env: {} }));
  assert.throws(() => assertDiagnosticInvocation({ argv: ['node', 'diagnostic.mjs'], stdinIsTTY: false, stdoutIsTTY: true, env: {} }), /interactive/);
  assert.throws(() => assertDiagnosticInvocation({ argv: ['node', 'diagnostic.mjs', 'apply'], stdinIsTTY: true, stdoutIsTTY: true, env: {} }), /arguments/);
});
