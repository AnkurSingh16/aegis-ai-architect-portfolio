#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const organizationName = 'aegis-ai-portfolio';
export const workspaceName = 'aegis-auth0-dev';
export const rootIdentity = 'aegis-ai-portfolio/infra/terraform/auth0:v1';
export const apiBase = 'https://app.terraform.io/api/v2';
export const bindingMarkerName = 'aegis-state-binding.json';
const freePlanIdentifiers = new Set(['free', 'free_standard']);
const paidPlanIdentifiers = new Set(['essentials', 'standard', 'premium']);
const expectedResources = [
  { address: 'auth0_resource_server.cases', module: 'root', provider: 'provider["registry.terraform.io/auth0/auth0"]', type: 'auth0_resource_server' },
  { address: 'auth0_resource_server_scope.read_cases', module: 'root', provider: 'provider["registry.terraform.io/auth0/auth0"]', type: 'auth0_resource_server_scope' },
  { address: 'auth0_resource_server_scope.write_cases', module: 'root', provider: 'provider["registry.terraform.io/auth0/auth0"]', type: 'auth0_resource_server_scope' },
  { address: 'auth0_client.local_spa', module: 'root', provider: 'provider["registry.terraform.io/auth0/auth0"]', type: 'auth0_client' },
  { address: 'auth0_connection_client.local_spa_database', module: 'root', provider: 'provider["registry.terraform.io/auth0/auth0"]', type: 'auth0_connection_client' },
];

export function classifyHcpPlan(organizationResponse, subscriptionResponse) {
  const organization = organizationResponse?.data;
  const organizationAttributes = organization?.attributes;
  const subscription = subscriptionResponse?.data;
  const subscriptionAttributes = subscription?.attributes;
  const featureSetRelationship = subscription?.relationships?.['feature-set']?.data;
  const matchingFeatureSets = subscriptionResponse?.included?.filter(
    (item) => item?.type === 'feature-sets' && item.id === featureSetRelationship?.id,
  ) ?? [];
  const featureSet = matchingFeatureSets.length === 1 ? matchingFeatureSets[0] : undefined;
  const featureSetAttributes = featureSet?.attributes;

  if (
    organization?.type !== 'organizations' || organizationAttributes?.name !== organizationName ||
    typeof organization.id !== 'string' || subscription?.type !== 'subscriptions' ||
    subscription?.relationships?.organization?.data?.id !== organization.id ||
    typeof featureSetRelationship?.id !== 'string' || matchingFeatureSets.length !== 1 ||
    featureSet?.type !== 'feature-sets' || typeof organizationAttributes['plan-is-trial'] !== 'boolean' ||
    typeof organizationAttributes['plan-expired'] !== 'boolean' ||
    typeof organizationAttributes['plan-is-enterprise'] !== 'boolean' ||
    typeof organizationAttributes['plan-identifier'] !== 'string' ||
    typeof subscriptionAttributes?.['is-active'] !== 'boolean' ||
    typeof subscriptionAttributes?.['is-public-free-tier'] !== 'boolean' ||
    typeof subscriptionAttributes?.['is-self-serve-trial'] !== 'boolean' ||
    typeof featureSetAttributes?.['is-current'] !== 'boolean' ||
    typeof featureSetAttributes?.['is-free-tier'] !== 'boolean' ||
    typeof featureSetAttributes?.identifier !== 'string'
  ) return 'unknown';

  const trial = organizationAttributes['plan-is-trial'] || subscriptionAttributes['is-self-serve-trial'];
  const expired = organizationAttributes['plan-expired'] || !subscriptionAttributes['is-active'];
  if (expired) return 'unknown';
  if (trial) return 'trial';

  const organizationPlan = organizationAttributes['plan-identifier'];
  const featurePlan = featureSetAttributes.identifier;
  const free = organizationAttributes['plan-is-enterprise'] === false && freePlanIdentifiers.has(organizationPlan) &&
    subscriptionAttributes['is-public-free-tier'] === true && subscriptionAttributes['is-self-serve-trial'] === false &&
    featureSetAttributes['is-current'] === true && featureSetAttributes['is-free-tier'] === true && freePlanIdentifiers.has(featurePlan);
  const paid = subscriptionAttributes['is-public-free-tier'] === false && subscriptionAttributes['is-self-serve-trial'] === false &&
    featureSetAttributes['is-current'] === true && featureSetAttributes['is-free-tier'] === false &&
    paidPlanIdentifiers.has(organizationPlan) && paidPlanIdentifiers.has(featurePlan);
  if (free && !paid) return 'free';
  if (paid && !free) return 'paid';
  return 'unknown';
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function failClosed(message) {
  throw new Error(`${message} Stop for manual review; do not migrate, overwrite, import, or initialize another workspace.`);
}

async function readProtectedJson(filePath, label, { missing = false } = {}) {
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    if (missing && error?.code === 'ENOENT') return undefined;
    throw new Error(`${label} is missing or unreadable.`);
  }
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error(`${label} must be a regular file with mode 0600 or stricter.`);
  }
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    throw new Error(`${label} contains invalid JSON.`);
  }
}

export function inspectBackendMetadata(metadata) {
  if (!metadata || metadata.backend?.type !== 'cloud' || !metadata.backend.config || typeof metadata.backend.config !== 'object') {
    failClosed('Local Terraform backend binding metadata is missing or is not a cloud backend.');
  }
  const config = metadata.backend.config;
  const allowedConfigKeys = new Set(['hostname', 'organization', 'token', 'workspaces']);
  const workspaceConfig = config.workspaces;
  const allowedWorkspaceKeys = new Set(['name', 'project', 'tags']);
  const emptyTags = workspaceConfig?.tags === undefined || workspaceConfig.tags === null ||
    (Array.isArray(workspaceConfig.tags) && workspaceConfig.tags.length === 0);
  const hostname = config.hostname ?? 'app.terraform.io';
  if (Object.keys(config).some((key) => !allowedConfigKeys.has(key)) ||
      hostname !== 'app.terraform.io' || config.organization !== organizationName ||
      !workspaceConfig || Object.keys(workspaceConfig).some((key) => !allowedWorkspaceKeys.has(key)) ||
      workspaceConfig.name !== workspaceName || (workspaceConfig.project !== undefined && workspaceConfig.project !== null) || !emptyTags ||
      (config.token !== undefined && config.token !== null && typeof config.token !== 'string')) {
    failClosed('Local Terraform backend metadata does not bind exactly to the expected HCP organization and workspace.');
  }
  // Do not return or hash backend config wholesale: it can contain an HCP token.
  return digest({ hostname, organization: config.organization, workspace: config.workspaces.name });
}

function normalizeInventory(stateVersion) {
  const attributes = stateVersion?.attributes;
  if (!attributes || attributes.status !== 'finalized' || attributes['resources-processed'] !== true ||
      attributes.intermediate !== false || !Array.isArray(attributes.resources)) {
    failClosed('Current HCP state version is not finalized, fully processed, or has an unknown state shape.');
  }
  const actual = attributes.resources.map((resource) => {
    if (!resource || typeof resource !== 'object' || typeof resource.name !== 'string' ||
        typeof resource.type !== 'string' || typeof resource.provider !== 'string' ||
        typeof resource.module !== 'string' || resource.count !== 1) {
      failClosed('Current HCP state resource inventory is incomplete or has an unknown shape.');
    }
    return { address: `${resource.type}.${resource.name}`, module: resource.module, provider: resource.provider, type: resource.type };
  }).sort((a, b) => a.address.localeCompare(b.address));
  const expected = [...expectedResources].sort((a, b) => a.address.localeCompare(b.address));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failClosed('Current HCP state resource inventory is not the exact Aegis Auth0 foundation inventory.');
  }
  return digest(actual);
}

function stateIdentity(stateVersion) {
  const serial = stateVersion?.attributes?.serial;
  if (stateVersion?.type !== 'state-versions' || typeof stateVersion.id !== 'string' || !stateVersion.id ||
      !Number.isSafeInteger(serial) || serial < 1) {
    failClosed('Current HCP state version identity is missing or malformed.');
  }
  return { stateVersionId: stateVersion.id, serial, inventoryHash: normalizeInventory(stateVersion) };
}

function validateMarker(marker, expected) {
  const keys = ['schemaVersion', 'rootIdentity', 'organization', 'workspace', 'workspaceId', 'backendFingerprint', 'stateVersionId', 'serial', 'inventoryHash'];
  if (!marker || typeof marker !== 'object' || Array.isArray(marker) ||
      Object.keys(marker).length !== keys.length || Object.keys(marker).some((key) => !keys.includes(key)) ||
      marker.schemaVersion !== 1 || marker.rootIdentity !== rootIdentity || marker.organization !== organizationName ||
      marker.workspace !== workspaceName || marker.workspaceId !== expected.workspaceId ||
      marker.backendFingerprint !== expected.backendFingerprint ||
      (marker.stateVersionId !== null && typeof marker.stateVersionId !== 'string') ||
      !Number.isSafeInteger(marker.serial) || marker.serial < 0 ||
      (marker.inventoryHash !== null && !/^[a-f0-9]{64}$/.test(marker.inventoryHash))) {
    failClosed('The local state ownership marker is missing, malformed, or bound to another root/workspace.');
  }
  return marker;
}

/** Read-only verification of HCP plan, workspace, backend binding and managed-state identity. */
export async function verifyHcpConfiguration({ home = os.homedir(), terraformRoot = process.cwd(), fetchImpl = fetch, mode = 'reinit' } = {}) {
  if (!['reinit', 'bind', 'repair-bootstrap'].includes(mode)) throw new Error('Unsupported HCP preflight mode.');
  const tokenPath = path.join(home, '.terraform.d', 'credentials.tfrc.json');
  const credentials = await readProtectedJson(tokenPath, 'Terraform CLI credentials');
  const token = credentials?.credentials?.['app.terraform.io']?.token;
  if (typeof token !== 'string' || token.length < 1) throw new Error('Terraform CLI credentials do not contain an app.terraform.io token. Run `terraform login` in a normal terminal.');

  const get = async (resource) => {
    let response;
    try {
      response = await fetchImpl(`${apiBase}${resource}`, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.api+json' }, redirect: 'error' });
    } catch {
      throw new Error('HCP Terraform read request failed. Check network access and CLI login.');
    }
    if (!response.ok) throw new Error(`HCP Terraform read request failed (HTTP ${response.status}). Check organization access and workspace configuration.`);
    try { return await response.json(); } catch { throw new Error('HCP Terraform returned an invalid response.'); }
  };

  const organization = await get(`/organizations/${encodeURIComponent(organizationName)}`);
  const org = organization?.data;
  if (org?.type !== 'organizations' || org.attributes?.name !== organizationName || typeof org.id !== 'string') {
    throw new Error('The configured HCP Terraform organization could not be verified.');
  }
  const subscription = await get(`/organizations/${encodeURIComponent(organizationName)}/subscription`);
  const plan = classifyHcpPlan(organization, subscription);
  if (plan !== 'free') throw new Error(`The organization subscription is not verified as Free (classification: ${plan}).`);

  const workspaceResponse = await get(`/organizations/${encodeURIComponent(organizationName)}/workspaces/${encodeURIComponent(workspaceName)}`);
  const workspace = workspaceResponse?.data;
  if (workspace?.type !== 'workspaces' || workspace.attributes?.name !== workspaceName || typeof workspace.id !== 'string') {
    throw new Error('The expected HCP Terraform workspace could not be verified.');
  }
  if (workspace.relationships?.organization?.data?.id !== org.id) throw new Error('The workspace organization does not match the expected organization.');
  if (workspace.attributes?.['execution-mode'] !== 'local') throw new Error('The workspace execution mode must be Local.');
  if (workspace.attributes?.['auto-apply'] !== false) throw new Error('Workspace auto-apply must be disabled.');

  const relation = workspace.relationships?.['current-state-version'];
  if (!workspace.relationships || !Object.hasOwn(workspace.relationships, 'current-state-version') || !relation || !Object.hasOwn(relation, 'data')) {
    failClosed('The workspace current-state-version relationship is missing or ambiguous.');
  }
  const backendMetadataPath = path.join(terraformRoot, '.terraform', 'terraform.tfstate');
  const markerPath = path.join(terraformRoot, '.terraform', bindingMarkerName);
  await verifyTerraformMetadataDirectory(path.dirname(backendMetadataPath));
  const backendMetadata = await readProtectedJson(backendMetadataPath, 'Terraform backend metadata', { missing: true });
  const backendFingerprint = backendMetadata === undefined ? null : inspectBackendMetadata(backendMetadata);
  const markerData = await readProtectedJson(markerPath, 'Local state ownership marker', { missing: true });

  if (relation.data === null) {
    if (mode === 'repair-bootstrap') {
      if (!backendMetadata || !backendFingerprint) failClosed('Empty bootstrap marker repair requires verified module-local backend metadata.');
      validateBootstrapMarkerForRepair(markerData, { workspaceId: workspace.id });
      if (markerData.backendFingerprint === backendFingerprint) failClosed('The empty bootstrap marker already matches the verified backend; no repair is needed.');
      return { organization: organizationName, plan, workspace: workspaceName, workspaceId: workspace.id,
        executionMode: 'local', autoApply: false, state: 'repairable-empty-bootstrap', backendFingerprint,
        observedMarkerFingerprint: markerData.backendFingerprint };
    }
    if (markerData !== undefined) {
      const marker = validateMarker(markerData, { workspaceId: workspace.id, backendFingerprint });
      if (marker.stateVersionId !== null || marker.serial !== 0 || marker.inventoryHash !== null) {
        failClosed('The workspace is empty but the local ownership marker records prior managed state.');
      }
    }
    return { organization: organizationName, plan, workspace: workspaceName, workspaceId: workspace.id,
      executionMode: 'local', autoApply: false, state: 'empty-bootstrap', backendFingerprint };
  }

  if (mode === 'repair-bootstrap') failClosed('Bootstrap marker repair is allowed only when HCP explicitly reports no current state.');

  const versionId = relation.data?.id;
  if (relation.data?.type !== 'state-versions' || typeof versionId !== 'string' || !versionId || !backendMetadata || !backendFingerprint) {
    failClosed('The workspace has state but its exact local backend binding cannot be proven.');
  }
  const versionResponse = await get(`/workspaces/${encodeURIComponent(workspace.id)}/current-state-version`);
  const version = versionResponse?.data;
  if (version?.id !== versionId || version?.type !== 'state-versions') failClosed('The current state version no longer matches the workspace relationship.');
  const identity = stateIdentity(version);
  const expected = { workspaceId: workspace.id, backendFingerprint };
  const marker = validateMarker(markerData, expected);
  if (mode === 'reinit') {
    if (marker.stateVersionId !== identity.stateVersionId || marker.serial !== identity.serial || marker.inventoryHash !== identity.inventoryHash) {
      failClosed('HCP state identity differs from the previously reviewed local binding marker. Re-review and explicitly re-bind after an approved apply.');
    }
  }
  return { organization: organizationName, plan, workspace: workspaceName, workspaceId: workspace.id,
    executionMode: 'local', autoApply: false, state: mode === 'bind' ? 'reviewable-managed-state' : 'verified-managed-state',
    backendFingerprint, ...identity };
}

function validateBootstrapMarkerForRepair(marker, { workspaceId }) {
  const keys = ['schemaVersion', 'rootIdentity', 'organization', 'workspace', 'workspaceId', 'backendFingerprint', 'stateVersionId', 'serial', 'inventoryHash'];
  if (!marker || typeof marker !== 'object' || Array.isArray(marker) ||
      Object.keys(marker).length !== keys.length || Object.keys(marker).some((key) => !keys.includes(key)) ||
      marker.schemaVersion !== 1 || marker.rootIdentity !== rootIdentity || marker.organization !== organizationName ||
      marker.workspace !== workspaceName || marker.workspaceId !== workspaceId ||
      (marker.backendFingerprint !== null && (typeof marker.backendFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(marker.backendFingerprint))) ||
      marker.stateVersionId !== null || marker.serial !== 0 || marker.inventoryHash !== null) {
    failClosed('Existing local marker is not an intact empty-bootstrap marker; manual review is required.');
  }
}

async function verifyTerraformMetadataDirectory(directoryPath) {
  let info;
  try { info = await lstat(directoryPath); }
  catch (error) {
    if (error?.code === 'ENOENT') return;
    throw new Error('Terraform metadata directory is unreadable.');
  }
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    failClosed('The local Terraform metadata directory must be a private, non-symlink directory.');
  }
}

export function createBindingMarker(metadata) {
  return {
    schemaVersion: 1,
    rootIdentity,
    organization: organizationName,
    workspace: workspaceName,
    workspaceId: metadata.workspaceId,
    backendFingerprint: metadata.backendFingerprint,
    stateVersionId: metadata.stateVersionId,
    serial: metadata.serial,
    inventoryHash: metadata.inventoryHash,
  };
}

async function main() {
  if (process.argv.length !== 2) {
    console.error('Usage: node infra/terraform/auth0/hcp-preflight.mjs');
    process.exitCode = 2;
    return;
  }
  try {
    const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
    const metadata = await verifyHcpConfiguration({ terraformRoot: moduleDirectory });
    console.log(JSON.stringify({
      organization: metadata.organization,
      plan: metadata.plan,
      workspace: metadata.workspace,
      executionMode: metadata.executionMode,
      autoApply: metadata.autoApply,
      state: metadata.state,
    }, null, 2));
    console.log('Preflight passed. Review this metadata before running the restricted Terraform wrapper.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'HCP Terraform preflight failed.');
    process.exitCode = 1;
  }
}

if (isMainModule(process.argv[1], import.meta.url)) await main();

function isMainModule(argvPath, moduleUrl) {
  if (!argvPath) return false;
  try { return moduleUrl === pathToFileURL(realpathSync(path.resolve(argvPath))).href; }
  catch { return false; }
}
