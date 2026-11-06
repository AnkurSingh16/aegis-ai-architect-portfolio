#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stdin, stdout } from 'node:process';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyHcpConfiguration } from './hcp-preflight.mjs';
import { createLocalConfigurationLoader, isAutomatedContext } from './apply-browser-origin-update.mjs';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const metadataDirectory = path.join(moduleDirectory, '.terraform');
const artifactPrefix = '.aegis-browser-origin-diagnostic-';
const maxCapturedBytes = 32 * 1024 * 1024;
const requiredFields = ['format_version', 'terraform_version', 'errored', 'complete', 'applyable', 'resource_changes'];
const optionalFields = ['resource_drift', 'deferred_changes', 'action_invocations', 'output_changes'];
const expectedResourceAddresses = Object.freeze([
  'auth0_resource_server.cases',
  'auth0_resource_server_scope.read_cases',
  'auth0_resource_server_scope.write_cases',
  'auth0_client.local_spa',
  'auth0_connection_client.local_spa_database',
]);
const expectedProviderAddress = 'registry.terraform.io/auth0/auth0';
const expectedProviderVersion = '1.59.0';
const declaredOutputNames = Object.freeze(['issuer', 'audience', 'spa_client_id']);
const approvedSpaUrls = Object.freeze({
  callbacks: { before: ['http://127.0.0.1:49321/auth/callback'], after: ['http://127.0.0.1:49321/auth/callback', 'http://127.0.0.1:5173/'] },
  web_origins: { before: ['http://127.0.0.1:49321'], after: ['http://127.0.0.1:49321', 'http://127.0.0.1:5173'] },
  allowed_logout_urls: { before: ['http://127.0.0.1:49321'], after: ['http://127.0.0.1:49321', 'http://127.0.0.1:5173'] },
});
const approvedSpaJwtAlgorithm = Object.freeze({ before: 'HS256', after: 'RS256' });
const safeProviderAttributeNames = new Set([
  'allowed_clients', 'allowed_logout_urls', 'allowed_origins', 'app_type', 'callbacks', 'description',
  'enforce_policies', 'grant_types', 'is_first_party', 'name', 'oidc_conformant', 'scope', 'signing_alg', 'web_origins',
]);
const securityRelevantAttributes = new Set([
  'allowed_clients', 'allowed_logout_urls', 'allowed_origins', 'app_type', 'callbacks', 'client_authentication_methods',
  'connection_id', 'enforce_policies', 'grant_types', 'identifier', 'is_first_party', 'oidc_conformant',
  'resource_server_identifier', 'scope', 'signing_alg', 'token_endpoint_auth_method', 'web_origins',
]);
const resourceAttributeCategories = Object.freeze({
  'auth0_resource_server.cases': {
    identity: ['id', 'identifier'],
    permissions: ['signing_alg', 'scopes', 'enforce_policies', 'allow_offline_access', 'token_lifetime',
      'token_lifetime_for_web', 'skip_consent_for_verifiable_first_party_clients', 'token_dialect'],
    clientConfiguration: [],
    other: ['name'],
  },
  'auth0_resource_server_scope.read_cases': {
    identity: ['id', 'resource_server_identifier'], permissions: [], clientConfiguration: [], other: ['scope', 'description'],
  },
  'auth0_resource_server_scope.write_cases': {
    identity: ['id', 'resource_server_identifier'], permissions: [], clientConfiguration: [], other: ['scope', 'description'],
  },
  'auth0_client.local_spa': {
    identity: ['id', 'client_id'],
    permissions: ['grant_types', 'token_endpoint_auth_method', 'client_authentication_methods'],
    clientConfiguration: ['name', 'app_type', 'callbacks', 'allowed_logout_urls', 'web_origins', 'allowed_origins',
      'oidc_conformant', 'is_first_party', 'initiate_login_uri', 'jwt_configuration', 'refresh_token', 'mobile', 'native_social_login'],
    other: ['client_metadata', 'cross_origin_auth', 'cross_origin_loc', 'custom_login_page', 'custom_login_page_on',
      'sso', 'sso_disabled', 'organization_usage', 'organization_require_behavior', 'require_pushed_authorization_requests'],
  },
  'auth0_connection_client.local_spa_database': {
    identity: ['id', 'connection_id', 'client_id'], permissions: [], clientConfiguration: [], other: [],
  },
});
const safeTerraformActions = new Set(['no-op', 'create', 'read', 'update', 'delete', 'forget', 'open', 'close']);

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function containsTrue(value) {
  if (value === true) return true;
  if (Array.isArray(value)) return value.some(containsTrue);
  if (record(value)) return Object.values(value).some(containsTrue);
  return false;
}

function maskMatchesValue(mask, value) {
  if (typeof mask === 'boolean') return true;
  if (Array.isArray(mask)) return Array.isArray(value) && mask.length === value.length &&
    mask.every((entry, index) => maskMatchesValue(entry, value[index]));
  if (record(mask)) return record(value) && Object.entries(mask).every(([key, entry]) =>
    Object.hasOwn(value, key) && maskMatchesValue(entry, value[key]));
  return false;
}

function markedAtPath(mask, key, value) {
  if (!Object.hasOwn(mask, key)) return false;
  return !maskMatchesValue(mask[key], value) || containsTrue(mask[key]);
}

function safeActions(actions) {
  if (!Array.isArray(actions) || actions.some((action) => typeof action !== 'string' || !safeTerraformActions.has(action))) return ['unknown'];
  return [...actions];
}

function booleanTreeIsValid(value) {
  if (typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.every(booleanTreeIsValid);
  if (record(value)) return Object.values(value).every(booleanTreeIsValid);
  return false;
}

function markerAppliesToAttribute(marker, key) {
  if (marker === true) return true;
  if (record(marker) || Array.isArray(marker)) return containsTrue(marker[key]);
  return false;
}

function changedAttributeSummary(address, change) {
  const categories = { identity: 0, permissions: 0, clientConfiguration: 0, other: 0 };
  const expectedCategories = resourceAttributeCategories[address];
  const before = record(change?.before) ? change.before : {};
  const after = record(change?.after) ? change.after : {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const field of ['before_sensitive', 'after_sensitive', 'after_unknown']) {
    if (record(change?.[field])) for (const key of Object.keys(change[field])) keys.add(key);
  }
  let unknownAttributeCount = 0;
  let sensitiveAttributeCount = 0;
  for (const key of keys) {
    const markerFields = ['before_sensitive', 'after_sensitive', 'after_unknown'];
    if (markerFields.some((field) => Object.hasOwn(change, field) && !booleanTreeIsValid(change[field]))) {
      unknownAttributeCount += 1;
      continue;
    }
    const sensitive = markerAppliesToAttribute(change.before_sensitive, key) || markerAppliesToAttribute(change.after_sensitive, key);
    const unknown = markerAppliesToAttribute(change.after_unknown, key);
    if (sensitive || unknown) {
      if (sensitive) sensitiveAttributeCount += 1;
      if (unknown) unknownAttributeCount += 1;
      continue;
    }
    const hasBefore = Object.hasOwn(before, key);
    const hasAfter = Object.hasOwn(after, key);
    if (hasBefore && hasAfter && isDeepStrictEqual(before[key], after[key])) continue;
    const category = expectedCategories && Object.entries(expectedCategories).find(([, allowed]) => allowed.includes(key))?.[0];
    if (category) categories[category] += 1;
    else unknownAttributeCount += 1;
  }
  return {
    changedAttributeCategories: categories,
    affectsIdentity: categories.identity > 0,
    affectsPermissions: categories.permissions > 0,
    affectsClientConfiguration: categories.clientConfiguration > 0,
    affectsOther: categories.other > 0,
    unknownAttributeCount,
    sensitiveAttributeCount,
  };
}

function summarizeResourceDrift(drift) {
  if (!Array.isArray(drift)) return { entries: [], unexpectedResourceCount: null, malformedEntryCount: null };
  let unexpectedResourceCount = 0;
  let malformedEntryCount = 0;
  const entries = drift.map((item) => {
    const isEntry = record(item);
    const corroboratedAddress = isEntry && typeof item.address === 'string' && expectedResourceAddresses.includes(item.address) &&
      item.mode === 'managed' && item.address === `${item.type}.${item.name}` &&
      item.provider_name === 'registry.terraform.io/auth0/auth0' && item.module_address === undefined &&
      item.index === undefined && item.deposed === undefined && record(item.change);
    const address = corroboratedAddress ? item.address : 'unexpected';
    if (address === 'unexpected') unexpectedResourceCount += 1;
    if (!isEntry || !record(item.change)) malformedEntryCount += 1;
    const change = isEntry && record(item.change) ? item.change : {};
    return {
      resource: address,
      actions: safeActions(change.actions),
      ...changedAttributeSummary(address, change),
    };
  });
  return { entries, unexpectedResourceCount, malformedEntryCount };
}

function expectedManagedAddress(item) {
  return record(item) && typeof item.address === 'string' && expectedResourceAddresses.includes(item.address) &&
    item.mode === 'managed' && item.address === `${item.type}.${item.name}` &&
    item.provider_name === expectedProviderAddress && item.module_address === undefined &&
    item.index === undefined && item.deposed === undefined && record(item.change);
}

function changedDriftKeys(change) {
  const before = record(change?.before) ? change.before : {};
  const after = record(change?.after) ? change.after : {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const field of ['before_sensitive', 'after_sensitive', 'after_unknown']) {
    if (record(change?.[field])) for (const key of Object.keys(change[field])) keys.add(key);
  }
  const malformedMarker = ['before_sensitive', 'after_sensitive', 'after_unknown']
    .some((field) => Object.hasOwn(change ?? {}, field) && !booleanTreeIsValid(change[field]));
  if (malformedMarker && keys.size === 0) keys.add(Symbol('malformed-marker-metadata'));
  return [...keys].filter((key) => {
    const masked = markerAppliesToAttribute(change?.before_sensitive, key) ||
      markerAppliesToAttribute(change?.after_sensitive, key) || markerAppliesToAttribute(change?.after_unknown, key);
    return malformedMarker || masked || !Object.hasOwn(before, key) || !Object.hasOwn(after, key) || !isDeepStrictEqual(before[key], after[key]);
  });
}

function unavailableProviderEntry(resource, unknownUnrecognizedCount) {
  return {
    resource,
    classificationStatus: 'unavailable',
    classifications: { computedOnly: 0, optionalComputed: 0, configurable: 0, sensitive: 0, unknownUnrecognized: unknownUnrecognizedCount },
    planUnknownValueCount: null,
    planSensitiveValueCount: null,
    configurableAttributeCount: null,
    securityRelevantAttributeCount: null,
    configurableSettingAffected: null,
    securityRelevantSettingAffected: null,
    plannedValueComparison: { matchesRefreshed: 0, differsFromRefreshed: 0, unavailable: unknownUnrecognizedCount },
    safeNonSensitiveAttributeNames: [],
  };
}

function schemaAttributeMode(attribute) {
  if (!record(attribute)) return null;
  const flagNames = ['required', 'optional', 'computed', 'sensitive'];
  if (flagNames.some((name) => Object.hasOwn(attribute, name) && typeof attribute[name] !== 'boolean')) return null;
  const required = attribute.required ?? false;
  const optional = attribute.optional ?? false;
  const computed = attribute.computed ?? false;
  const sensitive = attribute.sensitive ?? false;
  if (required && (optional || computed)) return null;
  if (!required && !optional && !computed) return null;
  return { required, optional, computed, sensitive };
}

function schemaClassification(mode) {
  if (!mode) return 'unknownUnrecognized';
  if (mode.sensitive) return 'sensitive';
  if (mode.optional && mode.computed) return 'optionalComputed';
  if (mode.computed && !mode.optional && !mode.required) return 'computedOnly';
  if (mode.required || mode.optional) return 'configurable';
  return 'unknownUnrecognized';
}

function providerSchemaRoot(schemaJson, pinnedVersion) {
  if (pinnedVersion !== expectedProviderVersion) return null;
  let schema;
  try { schema = typeof schemaJson === 'string' ? JSON.parse(schemaJson) : schemaJson; }
  catch { return null; }
  const providerSchemas = schema?.provider_schemas;
  if (!record(schema) || typeof schema.format_version !== 'string' || !/^1\.\d+$/.test(schema.format_version) ||
      !record(providerSchemas) || Object.keys(providerSchemas).length !== 1 ||
      !Object.hasOwn(providerSchemas, expectedProviderAddress)) return null;
  const provider = providerSchemas[expectedProviderAddress];
  if (!record(provider?.resource_schemas)) return null;
  return { schema, resourceSchemas: provider.resource_schemas };
}

/** Compare drift field names with the locked Auth0 provider schema without returning arbitrary keys or values. */
export function summarizeDriftAgainstProviderSchema(drift, schemaJson, pinnedVersion, plannedChanges = []) {
  const parsed = providerSchemaRoot(schemaJson, pinnedVersion);
  const plannedByAddress = new Map(Array.isArray(plannedChanges)
    ? plannedChanges.filter(expectedManagedAddress).map((item) => [item.address, item.change]) : []);
  const entries = (Array.isArray(drift) ? drift : []).map((item) => {
    const trusted = expectedManagedAddress(item);
    const resource = trusted ? item.address : 'unexpected';
    const change = record(item?.change) ? item.change : {};
    const keys = changedDriftKeys(change);
    const resourceType = trusted ? item.type : null;
    const resourceSchema = resourceType ? parsed?.resourceSchemas[resourceType] : null;
    const attributes = record(resourceSchema) && Number.isSafeInteger(resourceSchema.version) &&
      record(resourceSchema.block?.attributes) ? resourceSchema.block.attributes : null;
    if (!parsed || !trusted || !attributes) return unavailableProviderEntry(resource, keys.length);
    const counts = { computedOnly: 0, optionalComputed: 0, configurable: 0, sensitive: 0, unknownUnrecognized: 0 };
    const safeNames = new Set();
    let planUnknownValueCount = 0;
    let planSensitiveValueCount = 0;
    let configurableAttributeCount = 0;
    let securityRelevantAttributeCount = 0;
    const plannedValueComparison = { matchesRefreshed: 0, differsFromRefreshed: 0, unavailable: 0 };
    const plannedChange = plannedByAddress.get(resource);
    const driftMarkersMalformed = ['before_sensitive', 'after_sensitive', 'after_unknown']
      .some((field) => Object.hasOwn(change, field) && !booleanTreeIsValid(change[field]));
    for (const key of keys) {
      const mode = schemaAttributeMode(attributes[key]);
      const planUnknown = markerAppliesToAttribute(change.after_unknown, key);
      const planSensitive = markerAppliesToAttribute(change.before_sensitive, key) ||
        markerAppliesToAttribute(change.after_sensitive, key);
      const classification = !mode || driftMarkersMalformed ? 'unknownUnrecognized' :
        (planSensitive || mode.sensitive) ? 'sensitive' : schemaClassification(mode);
      if (planUnknown || driftMarkersMalformed) planUnknownValueCount += 1;
      if (planSensitive || mode?.sensitive) planSensitiveValueCount += 1;
      counts[classification] += 1;
      if (mode && !driftMarkersMalformed && (mode.required || mode.optional)) configurableAttributeCount += 1;
      if (!driftMarkersMalformed && securityRelevantAttributes.has(key)) securityRelevantAttributeCount += 1;
      if (safeProviderAttributeNames.has(key) && mode && !driftMarkersMalformed && !mode.sensitive && !planSensitive && !planUnknown) safeNames.add(key);
      const plannedMarkersMalformed = record(plannedChange) && ['before_sensitive', 'after_sensitive', 'after_unknown']
        .some((field) => Object.hasOwn(plannedChange, field) && !booleanTreeIsValid(plannedChange[field]));
      const refreshedBeforeAction = record(plannedChange?.before) ? plannedChange.before : null;
      const refreshedRemote = record(change.after) ? change.after : null;
      if (!refreshedBeforeAction || !refreshedRemote || !Object.hasOwn(refreshedBeforeAction, key) || !Object.hasOwn(refreshedRemote, key) ||
          plannedMarkersMalformed || driftMarkersMalformed || planUnknown || planSensitive || !mode || mode.sensitive ||
          markerAppliesToAttribute(plannedChange?.after_unknown, key) || markerAppliesToAttribute(plannedChange?.before_sensitive, key) ||
          markerAppliesToAttribute(plannedChange?.after_sensitive, key)) {
        plannedValueComparison.unavailable += 1;
      } else if (isDeepStrictEqual(refreshedBeforeAction[key], refreshedRemote[key])) plannedValueComparison.matchesRefreshed += 1;
      else plannedValueComparison.differsFromRefreshed += 1;
    }
    const unknownCount = counts.unknownUnrecognized;
    return {
      resource,
      classificationStatus: counts.unknownUnrecognized === 0 ? 'complete' : 'partial',
      classifications: counts,
      planUnknownValueCount,
      planSensitiveValueCount,
      configurableAttributeCount,
      securityRelevantAttributeCount,
      configurableSettingAffected: configurableAttributeCount > 0 ? true : unknownCount > 0 ? null : false,
      securityRelevantSettingAffected: securityRelevantAttributeCount > 0 ? true : unknownCount > 0 ? null : false,
      plannedValueComparison,
      safeNonSensitiveAttributeNames: [...safeNames].sort(),
    };
  });
  const aggregate = { computedOnly: 0, optionalComputed: 0, configurable: 0, sensitive: 0, unknownUnrecognized: 0 };
  let planUnknownValueCount = 0;
  let planSensitiveValueCount = 0;
  let configurableAttributeCount = 0;
  let securityRelevantAttributeCount = 0;
  const plannedValueComparison = { matchesRefreshed: 0, differsFromRefreshed: 0, unavailable: 0 };
  let classificationUnavailable = !parsed;
  for (const entry of entries) {
    for (const key of Object.keys(aggregate)) aggregate[key] += entry.classifications[key];
    if (entry.planUnknownValueCount === null) planUnknownValueCount = null;
    else if (planUnknownValueCount !== null) planUnknownValueCount += entry.planUnknownValueCount;
    if (entry.planSensitiveValueCount === null) planSensitiveValueCount = null;
    else if (planSensitiveValueCount !== null) planSensitiveValueCount += entry.planSensitiveValueCount;
    if (entry.configurableAttributeCount === null) configurableAttributeCount = null;
    else if (configurableAttributeCount !== null) configurableAttributeCount += entry.configurableAttributeCount;
    if (entry.securityRelevantAttributeCount === null) securityRelevantAttributeCount = null;
    else if (securityRelevantAttributeCount !== null) securityRelevantAttributeCount += entry.securityRelevantAttributeCount;
    for (const key of Object.keys(plannedValueComparison)) plannedValueComparison[key] += entry.plannedValueComparison?.[key] ?? 0;
    if (entry.classificationStatus !== 'complete' || entry.resource === 'unexpected') classificationUnavailable = true;
  }
  const knownUnknowns = aggregate.unknownUnrecognized > 0;
  return {
    provider: expectedProviderAddress,
    pinnedVersion: pinnedVersion === expectedProviderVersion ? expectedProviderVersion : null,
    formatVersion: parsed ? safeVersion(parsed.schema.format_version) : null,
    schemaAvailability: parsed ? 'available' : 'unavailable',
    driftClassification: !parsed ? 'unavailable' : entries.some((entry) => entry.classificationStatus !== 'complete') ? 'partial' : 'complete',
    classifications: aggregate,
    planUnknownValueCount,
    planSensitiveValueCount,
    configurableAttributeCount,
    securityRelevantAttributeCount,
    plannedValueComparison,
    configurableSettingAffected: configurableAttributeCount === null ? null : configurableAttributeCount > 0 ? true :
      classificationUnavailable || knownUnknowns ? null : false,
    securityRelevantSettingAffected: securityRelevantAttributeCount === null ? null : securityRelevantAttributeCount > 0 ? true :
      classificationUnavailable || knownUnknowns ? null : false,
    safeNonSensitiveAttributeNames: [...new Set(entries.flatMap((entry) => entry.safeNonSensitiveAttributeNames))].sort(),
    entries,
  };
}

function summarizePlannedBrowserOriginUpdate(resourceChanges) {
  if (!Array.isArray(resourceChanges)) return {
    resourceInventoryMatches: null, targetActions: null, changedApprovedUrlCount: null,
    unexpectedChangedAttributeCount: null, unknownChangedAttributeCount: null,
    maskedApprovedUrlCount: null, targetUrlValuesMatch: null, onlyApprovedUrlChanges: null,
  };
  const addresses = resourceChanges.map((item) => expectedManagedAddress(item) ? item.address : null);
  const resourceInventoryMatches = resourceChanges.length === expectedResourceAddresses.length &&
    addresses.every((address) => address !== null) && new Set(addresses).size === expectedResourceAddresses.length &&
    expectedResourceAddresses.every((address) => addresses.includes(address));
  const target = resourceChanges.filter((item) => record(item) && item.address === 'auth0_client.local_spa');
  if (target.length !== 1 || !record(target[0].change)) return {
    resourceInventoryMatches, targetActions: null, changedApprovedUrlCount: null,
    unexpectedChangedAttributeCount: null, unknownChangedAttributeCount: null,
    maskedApprovedUrlCount: null, targetUrlValuesMatch: null, onlyApprovedUrlChanges: false,
  };
  const targetItem = target[0];
  const change = targetItem.change;
  const before = record(change.before) ? change.before : {};
  const after = record(change.after) ? change.after : {};
  let changedApprovedUrlCount = 0;
  let unexpectedChangedAttributeCount = 0;
  let unknownChangedAttributeCount = 0;
  let maskedApprovedUrlCount = 0;
  let targetUrlValuesMatch = true;
  for (const [key, approved] of Object.entries(approvedSpaUrls)) {
    const markerFields = ['after_unknown', 'before_sensitive', 'after_sensitive'];
    if (markerFields.some((field) => Object.hasOwn(change, field) && !booleanTreeIsValid(change[field]))) {
      maskedApprovedUrlCount += 1;
      targetUrlValuesMatch = false;
    } else if (markerAppliesToAttribute(change.after_unknown, key) || markerAppliesToAttribute(change.before_sensitive, key) ||
        markerAppliesToAttribute(change.after_sensitive, key)) {
      maskedApprovedUrlCount += 1;
      targetUrlValuesMatch = false;
    }
    if (!isDeepStrictEqual(before[key], approved.before) || !isDeepStrictEqual(after[key], approved.after)) targetUrlValuesMatch = false;
    if (!Object.hasOwn(before, key) || !Object.hasOwn(after, key) || !isDeepStrictEqual(before[key], after[key])) changedApprovedUrlCount += 1;
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const field of ['after_unknown', 'before_sensitive', 'after_sensitive']) {
    if (record(change[field])) for (const key of Object.keys(change[field])) keys.add(key);
  }
  for (const key of keys) {
    if (Object.hasOwn(approvedSpaUrls, key)) continue;
    if (markerAppliesToAttribute(change.after_unknown, key)) {
      unknownChangedAttributeCount += 1;
      continue;
    }
    if (!Object.hasOwn(before, key) || !Object.hasOwn(after, key) || !isDeepStrictEqual(before[key], after[key])) {
      unexpectedChangedAttributeCount += 1;
    }
  }
  const otherActionsMatch = resourceChanges.every((item) => {
    if (!record(item) || !record(item.change)) return false;
    return item.address === 'auth0_client.local_spa'
      ? isDeepStrictEqual(item.change.actions, ['update'])
      : isDeepStrictEqual(item.change.actions, ['no-op']);
  });
  const onlyApprovedUrlChanges = unknownChangedAttributeCount > 0 || maskedApprovedUrlCount > 0 ? null :
    resourceInventoryMatches && otherActionsMatch && changedApprovedUrlCount === 3 && targetUrlValuesMatch &&
    unexpectedChangedAttributeCount === 0;
  return {
    resourceInventoryMatches,
    targetActions: safeActions(change.actions),
    changedApprovedUrlCount,
    unexpectedChangedAttributeCount,
    unknownChangedAttributeCount,
    maskedApprovedUrlCount,
    targetUrlValuesMatch,
    onlyApprovedUrlChanges,
  };
}

/** Summarize the expanded candidate without treating it as approval for drift. */
function summarizeBrowserOriginSigningCandidate(resourceChanges, outputSummary, resourceDrift) {
  const driftCount = Array.isArray(resourceDrift) ? resourceDrift.length : null;
  const resourceDriftStatus = resourceDrift === undefined ? 'absent' :
    !Array.isArray(resourceDrift) ? 'malformed' : resourceDrift.length === 0 ? 'empty' : 'nonempty';
  const fixedUrlAdditions = Object.freeze({
    callback: 'http://127.0.0.1:5173/',
    logout: 'http://127.0.0.1:5173',
    webOrigin: 'http://127.0.0.1:5173',
  });
  const empty = {
    resourceInventoryMatches: null,
    targetActions: null,
    approvedUrlAdditions: fixedUrlAdditions,
    approvedUrlValuesMatch: null,
    approvedUrlValuesKnownAndNonSensitive: null,
    jwtAlgorithmTransition: null,
    jwtNestedFieldsUnchanged: null,
    jwtValuesKnownAndNonSensitive: null,
    otherResourceAttributeChangeCount: null,
    noOtherResourceAttributeChanges: null,
    noUnexpectedOrUnknownValues: null,
    verifiedNoOpOutputs: outputSummary.verifiedNoOp,
    candidateScopeMatches: null,
    resourceDriftCount: driftCount,
    resourceDriftStatus,
    resourceDriftBlocksDeployment: resourceDriftStatus === 'nonempty' || resourceDriftStatus === 'malformed',
    resourceDriftAuthorized: false,
    diagnosticAuthorizesDeployment: false,
  };
  if (!Array.isArray(resourceChanges)) return empty;

  const addresses = resourceChanges.map((item) => expectedManagedAddress(item) ? item.address : null);
  const resourceInventoryMatches = resourceChanges.length === expectedResourceAddresses.length &&
    addresses.every((address) => address !== null) && new Set(addresses).size === expectedResourceAddresses.length &&
    expectedResourceAddresses.every((address) => addresses.includes(address));
  const targets = resourceChanges.filter((item) => record(item) && item.address === 'auth0_client.local_spa');
  if (targets.length !== 1 || !record(targets[0].change)) return { ...empty, resourceInventoryMatches, candidateScopeMatches: false };

  const target = targets[0].change;
  const before = record(target.before) ? target.before : {};
  const after = record(target.after) ? target.after : {};
  let approvedUrlValuesMatch = true;
  let approvedUrlValuesKnownAndNonSensitive = null;
  let approvedUrlChangeCount = 0;
  for (const [key, approved] of Object.entries(approvedSpaUrls)) {
    if (!isDeepStrictEqual(before[key], approved.before) || !isDeepStrictEqual(after[key], approved.after)) approvedUrlValuesMatch = false;
    if (!isDeepStrictEqual(before[key], after[key])) approvedUrlChangeCount += 1;
  }

  const beforeJwt = before.jwt_configuration;
  const afterJwt = after.jwt_configuration;
  const jwtShapeValid = Array.isArray(beforeJwt) && beforeJwt.length === 1 && record(beforeJwt[0]) &&
    Array.isArray(afterJwt) && afterJwt.length === 1 && record(afterJwt[0]);
  let jwtAlgorithmTransition = null;
  let jwtNestedFieldsUnchanged = null;
  let jwtValuesKnownAndNonSensitive = null;
  if (jwtShapeValid) {
    jwtAlgorithmTransition = beforeJwt[0].alg === approvedSpaJwtAlgorithm.before && afterJwt[0].alg === approvedSpaJwtAlgorithm.after
      ? `${approvedSpaJwtAlgorithm.before} -> ${approvedSpaJwtAlgorithm.after}` : null;
    const beforeRemainder = { ...beforeJwt[0] };
    const afterRemainder = { ...afterJwt[0] };
    delete beforeRemainder.alg;
    delete afterRemainder.alg;
    jwtNestedFieldsUnchanged = isDeepStrictEqual(beforeRemainder, afterRemainder);
    const masksValid = ['after_unknown', 'before_sensitive', 'after_sensitive'].every((field) =>
      Object.hasOwn(target, field) && record(target[field]) && booleanTreeIsValid(target[field]) &&
      maskMatchesValue(target[field], field === 'before_sensitive' ? before : after));
    jwtValuesKnownAndNonSensitive = masksValid &&
      !markedAtPath(target.after_unknown, 'jwt_configuration', afterJwt) &&
      !markedAtPath(target.before_sensitive, 'jwt_configuration', beforeJwt) &&
      !markedAtPath(target.after_sensitive, 'jwt_configuration', afterJwt);
  }
  const targetMasksValid = ['after_unknown', 'before_sensitive', 'after_sensitive'].every((field) =>
    Object.hasOwn(target, field) && record(target[field]) && booleanTreeIsValid(target[field]) &&
    maskMatchesValue(target[field], field === 'before_sensitive' ? before : after));
  approvedUrlValuesKnownAndNonSensitive = targetMasksValid && Object.keys(approvedSpaUrls).every((key) =>
    !markedAtPath(target.after_unknown, key, after[key]) && !markedAtPath(target.before_sensitive, key, before[key]) &&
    !markedAtPath(target.after_sensitive, key, after[key]));

  const excluded = new Set([...Object.keys(approvedSpaUrls), 'jwt_configuration']);
  let otherResourceAttributeChangeCount = 0;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (excluded.has(key)) continue;
    if (!Object.hasOwn(before, key) || !Object.hasOwn(after, key) || !isDeepStrictEqual(before[key], after[key])) {
      otherResourceAttributeChangeCount += 1;
    }
  }

  let resourceChangesMatch = resourceInventoryMatches && isDeepStrictEqual(targets[0].change.actions, ['update']);
  for (const item of resourceChanges) {
    if (!record(item)) {
      resourceChangesMatch = false;
      otherResourceAttributeChangeCount += 1;
      continue;
    }
    if (item.address === 'auth0_client.local_spa') continue;
    const change = record(item.change) ? item.change : {};
    const valuesEqual = record(change.before) && record(change.after) && isDeepStrictEqual(change.before, change.after);
    if (!isDeepStrictEqual(change.actions, ['no-op']) || !valuesEqual) {
      resourceChangesMatch = false;
      otherResourceAttributeChangeCount += 1;
    }
  }
  const metadataValid = resourceChanges.every((item) => {
    const change = record(item?.change) ? item.change : {};
    return record(change.before) && record(change.after) &&
      ['after_unknown', 'before_sensitive', 'after_sensitive'].every((field) =>
        Object.hasOwn(change, field) && record(change[field]) && booleanTreeIsValid(change[field]) &&
        maskMatchesValue(change[field], field === 'before_sensitive' ? change.before : change.after));
  });
  const noUnexpectedOrUnknownValues = metadataValid && resourceChanges.every((item) => !containsTrue(item.change.after_unknown));
  const noOtherResourceAttributeChanges = otherResourceAttributeChangeCount === 0;
  const candidateScopeMatches = resourceChangesMatch && approvedUrlValuesMatch && approvedUrlChangeCount === 3 &&
    jwtAlgorithmTransition !== null && jwtNestedFieldsUnchanged === true && jwtValuesKnownAndNonSensitive === true &&
    approvedUrlValuesKnownAndNonSensitive === true && noOtherResourceAttributeChanges && noUnexpectedOrUnknownValues &&
    outputSummary.verifiedNoOp === true;

  return {
    resourceInventoryMatches,
    targetActions: safeActions(target.actions),
    approvedUrlAdditions: fixedUrlAdditions,
    approvedUrlValuesMatch,
    approvedUrlValuesKnownAndNonSensitive,
    jwtAlgorithmTransition,
    jwtNestedFieldsUnchanged,
    jwtValuesKnownAndNonSensitive,
    otherResourceAttributeChangeCount,
    noOtherResourceAttributeChanges,
    noUnexpectedOrUnknownValues,
    verifiedNoOpOutputs: outputSummary.verifiedNoOp,
    candidateScopeMatches,
    resourceDriftCount: driftCount,
    resourceDriftStatus,
    resourceDriftBlocksDeployment: resourceDriftStatus === 'nonempty' || resourceDriftStatus === 'malformed',
    resourceDriftAuthorized: false,
    diagnosticAuthorizesDeployment: false,
  };
}

export function parsePinnedAuth0ProviderVersion(lockContents) {
  if (typeof lockContents !== 'string') return null;
  const blocks = [...lockContents.matchAll(/provider\s+"registry\.terraform\.io\/auth0\/auth0"\s*\{([^}]*)\}/g)];
  if (blocks.length !== 1) return null;
  const versions = [...blocks[0][1].matchAll(/^\s*version\s*=\s*"([^"]+)"\s*$/gm)].map((match) => match[1]);
  const constraints = [...blocks[0][1].matchAll(/^\s*constraints\s*=\s*"([^"]+)"\s*$/gm)].map((match) => match[1]);
  return versions.length === 1 && constraints.length === 1 && versions[0] === expectedProviderVersion &&
    ['1.59.0', '= 1.59.0'].includes(constraints[0]) ? expectedProviderVersion : null;
}

function summarizeOutputChanges(outputChanges) {
  if (!record(outputChanges)) {
    return { declaredKeysMatch: outputChanges === undefined ? null : false, unexpectedOutputCount: null,
      verifiedNoOp: outputChanges === undefined || (record(outputChanges) && Object.keys(outputChanges).length === 0) ? null : false,
      outputs: declaredOutputNames.map((name) => ({ name, actions: null, beforeAfterEqual: null,
        afterUnknown: null, beforeSensitive: null, afterSensitive: null })) };
  }
  const actualNames = Object.keys(outputChanges);
  const declaredKeysMatch = actualNames.length === declaredOutputNames.length && declaredOutputNames.every((name) => Object.hasOwn(outputChanges, name));
  const outputs = declaredOutputNames.map((name) => {
    const change = outputChanges[name];
    const valid = record(change);
    const afterUnknown = valid && typeof change.after_unknown === 'boolean' ? change.after_unknown : null;
    const beforeSensitive = valid && typeof change.before_sensitive === 'boolean' ? change.before_sensitive : null;
    const afterSensitive = valid && typeof change.after_sensitive === 'boolean' ? change.after_sensitive : null;
    const valuesPresent = valid && Object.hasOwn(change, 'before') && Object.hasOwn(change, 'after');
    return {
      name,
      actions: valid ? safeActions(change.actions) : null,
      beforeAfterEqual: valuesPresent && afterUnknown === false &&
        beforeSensitive !== null && afterSensitive !== null
        ? isDeepStrictEqual(change.before, change.after) : null,
      afterUnknown,
      beforeSensitive,
      afterSensitive,
    };
  });
  const verifiedNoOp = declaredKeysMatch && outputs.every((output) => output.actions?.length === 1 && output.actions[0] === 'no-op' &&
    output.beforeAfterEqual === true && output.afterUnknown === false && output.beforeSensitive === false && output.afterSensitive === false);
  return { declaredKeysMatch, unexpectedOutputCount: actualNames.filter((name) => !declaredOutputNames.includes(name)).length,
    verifiedNoOp, outputs };
}

function safeVersion(value) {
  return typeof value === 'string' && /^\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9.]+)?(?:\+[A-Za-z0-9.]+)?$/.test(value) &&
    value.length <= 64 ? value : null;
}

function actionSummary(changes) {
  if (!Array.isArray(changes) || changes.some((item) => !record(item) || !record(item.change) ||
      !Array.isArray(item.change.actions) || item.change.actions.some((action) => typeof action !== 'string'))) {
    return { add: null, update: null, destroy: null, unclassified: null, matchesExpected: null };
  }
  let add = 0;
  let update = 0;
  let destroy = 0;
  let unclassified = 0;
  for (const item of changes) {
    const actions = item.change.actions;
    if (actions.includes('create')) add += 1;
    if (actions.includes('delete')) destroy += 1;
    if (actions.length === 1 && actions[0] === 'update') update += 1;
    if (!['no-op', 'create', 'update', 'delete'].includes(actions.join(',')) &&
        !(['delete', 'create'].every((action) => actions.includes(action)) && actions.length === 2)) unclassified += 1;
  }
  return { add, update, destroy, unclassified,
    matchesExpected: add === 0 && update === 1 && destroy === 0 && unclassified === 0 };
}

function countField(document, key) {
  if (key === 'output_changes') return record(document?.[key]) ? Object.keys(document[key]).length : null;
  return Array.isArray(document?.[key]) ? document[key].length : null;
}

/** Return only allowlisted plan metadata and rule identifiers; never return plan values. */
export function diagnosePlanDocument(document, schemaJson, pinnedVersion) {
  const isObject = record(document);
  const requiredPresent = Object.fromEntries(requiredFields.map((key) => [key, isObject && Object.hasOwn(document, key)]));
  const optionalPresent = Object.fromEntries(optionalFields.map((key) => [key, isObject && Object.hasOwn(document, key)]));
  const formatVersion = safeVersion(document?.format_version);
  const terraformVersion = safeVersion(document?.terraform_version);
  const errors = [];
  const outputChangeSummary = summarizeOutputChanges(document?.output_changes);

  if (!isObject) errors.push('plan.document.object');
  if (typeof document?.format_version !== 'string') errors.push('plan.format_version.string');
  else if (!/^1\.\d+$/.test(document.format_version)) errors.push('plan.format_version.supported_major');
  if (typeof document?.terraform_version !== 'string') errors.push('plan.terraform_version.string');
  if (document?.errored !== false) errors.push('plan.errored.false');
  if (document?.complete !== true) errors.push('plan.complete.true');
  if (document?.applyable !== true) errors.push('plan.applyable.true');
  if (!Array.isArray(document?.resource_changes)) errors.push('plan.resource_changes.array');
  if (isObject && document.resource_drift !== undefined &&
      (!Array.isArray(document.resource_drift) || document.resource_drift.length !== 0)) {
    errors.push('plan.resource_drift.absent_or_empty_array');
  }
  if (isObject && document.deferred_changes !== undefined &&
      (!Array.isArray(document.deferred_changes) || document.deferred_changes.length !== 0)) {
    errors.push('plan.deferred_changes.absent_or_empty_array');
  }
  if (isObject && document.action_invocations !== undefined &&
      (!Array.isArray(document.action_invocations) || document.action_invocations.length !== 0)) {
    errors.push('plan.action_invocations.absent_or_empty_array');
  }
  if (isObject && document.output_changes !== undefined &&
      (!record(document.output_changes) || (Object.keys(document.output_changes).length > 0 && outputChangeSummary.verifiedNoOp !== true))) {
    errors.push('plan.output_changes.absent_or_empty_object');
  }

  const actions = actionSummary(document?.resource_changes);
  if (Array.isArray(document?.resource_changes) && actions.matchesExpected === null) {
    errors.push('plan.resource_changes.items.actions_array');
  } else if (actions.matchesExpected === false) errors.push('plan.actions.expected_0_add_1_update_0_destroy');
  return Object.freeze({
    formatVersion,
    terraformVersion,
    requiredFields: requiredPresent,
    optionalFields: optionalPresent,
    booleans: {
      errored: typeof document?.errored === 'boolean' ? document.errored : null,
      complete: typeof document?.complete === 'boolean' ? document.complete : null,
      applyable: typeof document?.applyable === 'boolean' ? document.applyable : null,
      expected: { errored: false, complete: true, applyable: true },
    },
    counts: {
      resourceChanges: countField(document, 'resource_changes'),
      resourceDrift: countField(document, 'resource_drift'),
      deferredChanges: countField(document, 'deferred_changes'),
      actionInvocations: countField(document, 'action_invocations'),
      outputChanges: countField(document, 'output_changes'),
    },
    actionCounts: actions,
    resourceDriftSummary: summarizeResourceDrift(document?.resource_drift),
    providerSchemaSummary: summarizeDriftAgainstProviderSchema(document?.resource_drift, schemaJson, pinnedVersion, document?.resource_changes),
    outputChangeSummary,
    plannedBrowserOriginUpdate: summarizePlannedBrowserOriginUpdate(document?.resource_changes),
    plannedBrowserOriginSigningCandidate: summarizeBrowserOriginSigningCandidate(document?.resource_changes, outputChangeSummary, document?.resource_drift),
    failedValidationRuleIds: Object.freeze(errors),
  });
}

export function diagnosePlanJson(jsonText, schemaJson, pinnedVersion) {
  let document;
  try { document = JSON.parse(jsonText); }
  catch {
    return Object.freeze({
      formatVersion: null, terraformVersion: null,
      requiredFields: Object.fromEntries(requiredFields.map((key) => [key, false])),
      optionalFields: Object.fromEntries(optionalFields.map((key) => [key, false])),
      booleans: { errored: null, complete: null, applyable: null,
        expected: { errored: false, complete: true, applyable: true } },
      counts: { resourceChanges: null, resourceDrift: null, deferredChanges: null, actionInvocations: null, outputChanges: null },
      actionCounts: { add: null, update: null, destroy: null, unclassified: null, matchesExpected: null },
      resourceDriftSummary: { entries: [], unexpectedResourceCount: null, malformedEntryCount: null },
      providerSchemaSummary: summarizeDriftAgainstProviderSchema(undefined, schemaJson, pinnedVersion),
      outputChangeSummary: summarizeOutputChanges(undefined),
      plannedBrowserOriginUpdate: summarizePlannedBrowserOriginUpdate(undefined),
      plannedBrowserOriginSigningCandidate: summarizeBrowserOriginSigningCandidate(undefined, summarizeOutputChanges(undefined), undefined),
      failedValidationRuleIds: Object.freeze(['plan.json.parse']),
    });
  }
  return diagnosePlanDocument(document, schemaJson, pinnedVersion);
}

export function sameHcpIdentity(left, right) {
  const fields = ['organization', 'plan', 'workspace', 'workspaceId', 'executionMode', 'autoApply', 'state',
    'backendFingerprint', 'stateVersionId', 'serial', 'inventoryHash'];
  const valid = (value) => record(value) && fields.every((key) => Object.hasOwn(value, key)) &&
    value.organization === 'aegis-ai-portfolio' && value.plan === 'free' && value.workspace === 'aegis-auth0-dev' &&
    typeof value.workspaceId === 'string' && value.workspaceId.length > 0 && value.executionMode === 'local' &&
    value.autoApply === false && value.state === 'verified-managed-state' &&
    /^[a-f0-9]{64}$/.test(value.backendFingerprint) && typeof value.stateVersionId === 'string' && value.stateVersionId.length > 0 &&
    Number.isSafeInteger(value.serial) && value.serial > 0 && /^[a-f0-9]{64}$/.test(value.inventoryHash);
  return valid(left) && valid(right) && fields.every((key) => left[key] === right[key]);
}

async function createPrivateDirectory({ lstatImpl = lstat, chmodImpl = chmod, readdirImpl = readdir,
  mkdtempImpl = mkdtemp, rmImpl = rm } = {}) {
  const metadata = await lstatImpl(metadataDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Terraform metadata directory is unsafe.');
  if ((metadata.mode & 0o077) !== 0) await chmodImpl(metadataDirectory, 0o700);
  if ((await lstatImpl(metadataDirectory)).mode & 0o077) throw new Error('Terraform metadata permissions are too broad.');
  const entries = await readdirImpl(metadataDirectory);
  if (entries.some((entry) => entry.startsWith(artifactPrefix) || entry.startsWith('.aegis-browser-origin-update-'))) {
    throw new Error('A stale diagnostic plan artifact exists; it was not opened or changed. Stop for manual review.');
  }
  const directory = await mkdtempImpl(path.join(metadataDirectory, artifactPrefix));
  try {
    await chmodImpl(directory, 0o700);
    const secured = await lstatImpl(directory);
    if (!secured.isDirectory() || secured.isSymbolicLink() || (secured.mode & 0o077) !== 0) {
      throw new Error('unsafe private diagnostic directory');
    }
  }
  catch {
    try { await rmImpl(directory, { recursive: true, force: false }); }
    catch { throw new Error('Private diagnostic setup and cleanup failed; inspect the local artifact manually.'); }
    throw new Error('Private diagnostic directory permissions failed; inspect the local artifact manually.');
  }
  return directory;
}

async function removePrivateDirectory(directory, { rmImpl = rm } = {}) {
  try { await rmImpl(directory, { recursive: true, force: false }); }
  catch { throw new Error('Private diagnostic cleanup failed; inspect the artifact manually.'); }
}

async function captureTerraform(args, { cwd, env, signal, spawnImpl = spawn }) {
  return await new Promise((resolve, reject) => {
    const child = spawnImpl('terraform', args, { cwd, env, signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdoutText = '';
    let stderrText = '';
    let byteLength = 0;
    let overflow = false;
    let spawnFailed = false;
    const collect = (target, chunk) => {
      byteLength += Buffer.byteLength(chunk);
      if (byteLength > maxCapturedBytes) {
        overflow = true;
        child.kill('SIGTERM');
        return;
      }
      if (target === 'stdout') stdoutText += chunk;
      else stderrText += chunk;
    };
    child.stdout.setEncoding('utf8').on('data', (chunk) => collect('stdout', chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => collect('stderr', chunk));
    // Node emits `close` after `error`; wait for termination before the caller
    // removes the private directory, especially when AbortSignal cancels a child.
    child.once('error', () => { spawnFailed = true; });
    child.once('close', (code) => {
      if (spawnFailed) reject(new Error('Terraform diagnostic command could not be started.'));
      else if (overflow) reject(new Error('Terraform diagnostic output exceeded its safe memory limit.'));
      else if (code !== 0) reject(new Error('Terraform diagnostic command failed; details were suppressed.'));
      else resolve({ stdout: stdoutText, stderr: stderrText });
    });
  });
}

function terraformEnvironment(config, env = process.env) {
  const inherited = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SSL_CERT_FILE', 'SSL_CERT_DIR']
    .filter((key) => env[key]).map((key) => [key, env[key]]));
  return { ...inherited, AUTH0_DOMAIN: config.auth0Domain, AUTH0_CLIENT_ID: config.auth0ClientId,
    AUTH0_CLIENT_SECRET: config.auth0ClientSecret, TF_VAR_auth0_domain: config.auth0Domain,
    TF_IN_AUTOMATION: '1', TF_INPUT: '0', TF_LOG: 'off' };
}

function providerSchemaEnvironment(env = process.env) {
  const inherited = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SSL_CERT_FILE', 'SSL_CERT_DIR']
    .filter((key) => env[key]).map((key) => [key, env[key]]));
  return { ...inherited, TF_IN_AUTOMATION: '1', TF_INPUT: '0', TF_LOG: 'off' };
}

async function readPinnedProviderVersion() {
  const lock = await readFile(path.join(moduleDirectory, '.terraform.lock.hcl'), 'utf8');
  return parsePinnedAuth0ProviderVersion(lock);
}

/** Fixed read-only orchestration: this module has no Terraform apply path. */
export async function runPlanDiagnostic(deps = {}) {
  const { verifyHcp, loadConfiguration, runPlan, showPlan, runProviderSchema, getPinnedProviderVersion } = deps;
  if (![verifyHcp, loadConfiguration, runPlan, showPlan, runProviderSchema, getPinnedProviderVersion].every((fn) => typeof fn === 'function')) {
    throw new Error('Read-only diagnostic adapters are incomplete.');
  }
  const fs = deps.fs ?? {};
  const signal = deps.signal;
  const pinnedVersion = await getPinnedProviderVersion();
  if (pinnedVersion !== expectedProviderVersion) throw new Error('Pinned Auth0 provider version did not verify.');
  const stateBefore = await verifyHcp({ mode: 'reinit', terraformRoot: moduleDirectory });
  if (!sameHcpIdentity(stateBefore, stateBefore)) throw new Error('HCP state ownership did not verify.');
  const config = await loadConfiguration();
  const directory = await createPrivateDirectory(fs);
  let result;
  let operationError;
  try {
    if (signal?.aborted) throw new Error('Diagnostic cancelled.');
    const planPath = path.join(directory, 'diagnostic.tfplan');
    const context = { cwd: moduleDirectory, env: terraformEnvironment(config, deps.env), signal };
    await runPlan(planPath, context);
    const planStat = await (fs.lstatImpl ?? lstat)(planPath);
    if (!planStat.isFile() || planStat.isSymbolicLink()) throw new Error('Diagnostic plan artifact is not a regular file.');
    await (fs.chmodImpl ?? chmod)(planPath, 0o600);
    const securedPlanStat = await (fs.lstatImpl ?? lstat)(planPath);
    if (!securedPlanStat.isFile() || securedPlanStat.isSymbolicLink() || (securedPlanStat.mode & 0o077) !== 0) {
      throw new Error('Diagnostic plan artifact permissions are too broad.');
    }
    const stateAfterPlan = await verifyHcp({ mode: 'reinit', terraformRoot: moduleDirectory });
    if (!sameHcpIdentity(stateBefore, stateAfterPlan)) throw new Error('HCP state identity changed during diagnostics.');
    if (signal?.aborted) throw new Error('Diagnostic cancelled.');
    const json = await showPlan(planPath, context);
    const stateAfterShow = await verifyHcp({ mode: 'reinit', terraformRoot: moduleDirectory });
    if (!sameHcpIdentity(stateBefore, stateAfterShow)) throw new Error('HCP state identity changed during diagnostics.');
    if (signal?.aborted) throw new Error('Diagnostic cancelled.');
    let schemaJson = null;
    try {
      schemaJson = await runProviderSchema({ cwd: moduleDirectory, env: providerSchemaEnvironment(deps.env), signal });
    } catch {
      // Keep the plan summary useful while classifying unavailable schema data as unknown.
    }
    const stateAfterSchema = await verifyHcp({ mode: 'reinit', terraformRoot: moduleDirectory });
    if (!sameHcpIdentity(stateBefore, stateAfterSchema)) throw new Error('HCP state identity changed during diagnostics.');
    if (signal?.aborted) throw new Error('Diagnostic cancelled.');
    result = diagnosePlanJson(json, schemaJson, pinnedVersion);
  } catch (error) {
    operationError = error;
  }
  let cleanupError;
  try { await removePrivateDirectory(directory, fs); }
  catch (error) { cleanupError = error; }
  if (cleanupError) throw cleanupError;
  if (operationError) throw new Error('Read-only plan diagnostic failed safely; details were suppressed.');
  return result;
}

export function createTerraformDiagnosticAdapters({ spawnImpl = spawn, env = process.env } = {}) {
  return {
    runPlan: async (planPath, context) => {
      const args = ['plan', '-input=false', '-no-color', `-out=${planPath}`];
      await captureTerraform(args, { ...context, spawnImpl });
    },
    showPlan: async (planPath, context) => {
      const result = await captureTerraform(['show', '-json', planPath], { ...context, env: context.env ?? env, spawnImpl });
      return result.stdout;
    },
    runProviderSchema: async (context = {}) => {
      const result = await captureTerraform(['providers', 'schema', '-json'], {
        cwd: context.cwd ?? moduleDirectory,
        env: providerSchemaEnvironment(context.env ?? env),
        signal: context.signal,
        spawnImpl,
      });
      return result.stdout;
    },
  };
}

export function assertDiagnosticInvocation({ argv = process.argv, stdinIsTTY = stdin.isTTY,
  stdoutIsTTY = stdout.isTTY, env = process.env } = {}) {
  if (argv.length !== 2 || !stdinIsTTY || !stdoutIsTTY || isAutomatedContext(env)) {
    throw new Error('Diagnostic requires a direct interactive terminal and accepts no arguments.');
  }
}

async function main() {
  assertDiagnosticInvocation();
  const originalUmask = process.umask(0o077);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const configLoader = createLocalConfigurationLoader();
    const result = await runPlanDiagnostic({
      verifyHcp: (options) => verifyHcpConfiguration({ ...options, home: os.homedir() }),
      loadConfiguration: () => configLoader(),
      getPinnedProviderVersion: readPinnedProviderVersion,
      ...createTerraformDiagnosticAdapters(),
      signal: controller.signal,
    });
    stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    process.umask(originalUmask);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => {
    stdout.write('Read-only plan diagnostic stopped safely; no plan details were emitted.\n');
    process.exitCode = 1;
  });
}
