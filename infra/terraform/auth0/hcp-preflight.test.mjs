import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import { bindingMarkerName, classifyHcpPlan, createBindingMarker, inspectBackendMetadata, verifyHcpConfiguration } from './hcp-preflight.mjs';

const temporaryDirectories = new Set();
const syntheticToken = 'synthetic-hcp-test-token-never-real';

afterEach(async () => {
  await Promise.all([...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
  temporaryDirectories.clear();
});

async function makeHome({ permissions = 0o600, content } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'aegis-hcp-preflight-'));
  temporaryDirectories.add(home);
  const credentialDirectory = path.join(home, '.terraform.d');
  await mkdir(credentialDirectory, { mode: 0o700 });
  const credentialPath = path.join(credentialDirectory, 'credentials.tfrc.json');
  await writeFile(credentialPath, content ?? JSON.stringify({ credentials: { 'app.terraform.io': { token: syntheticToken } } }), { mode: permissions });
  await chmod(credentialPath, permissions);
  return home;
}

function responses({ organization, subscription, workspace } = {}) {
  const org = organization ?? { data: { type: 'organizations', id: 'org-1', attributes: {
    name: 'aegis-ai-portfolio', 'plan-identifier': 'free_standard', 'plan-is-trial': false,
    'plan-expired': false, 'plan-is-enterprise': false,
  } } };
  const sub = subscription ?? { data: {
    type: 'subscriptions', id: 'subscription-1', attributes: {
      'is-active': true, 'is-public-free-tier': true, 'is-self-serve-trial': false,
    }, relationships: {
      organization: { data: { id: 'org-1', type: 'organizations' } },
      'feature-set': { data: { id: 'feature-set-1', type: 'feature-sets' } },
    },
  }, included: [{ type: 'feature-sets', id: 'feature-set-1', attributes: {
    identifier: 'free_standard', 'is-current': true, 'is-free-tier': true,
  } }] };
  const ws = workspace ?? { data: {
    type: 'workspaces', id: 'ws-1', attributes: { name: 'aegis-auth0-dev', 'execution-mode': 'local', 'auto-apply': false },
    relationships: { organization: { data: { id: 'org-1' } }, 'current-state-version': { data: null } },
  } };
  return async (url, options) => {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${syntheticToken}`);
    if (url.endsWith('/organizations/aegis-ai-portfolio')) return jsonResponse(org);
    if (url.endsWith('/organizations/aegis-ai-portfolio/subscription')) return jsonResponse(sub);
    if (url.endsWith('/workspaces/aegis-auth0-dev')) return jsonResponse(ws);
    throw new Error('Unexpected mocked endpoint');
  };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const managedResources = [
  ['auth0_resource_server', 'cases'],
  ['auth0_resource_server_scope', 'read_cases'],
  ['auth0_resource_server_scope', 'write_cases'],
  ['auth0_client', 'local_spa'],
  ['auth0_connection_client', 'local_spa_database'],
].map(([type, name]) => ({ type, name, provider: 'provider["registry.terraform.io/auth0/auth0"]', module: 'root', count: 1 }));
const normalizedInventory = managedResources.map(({ type, name, provider, module }) => ({
  address: `${type}.${name}`, module, provider, type,
})).sort((a, b) => a.address.localeCompare(b.address));
const managedInventoryHash = createHash('sha256').update(JSON.stringify(normalizedInventory)).digest('hex');

async function prepareManagedState(home, terraformRoot, { workspaceId = 'ws-1', backendWorkspace = 'aegis-auth0-dev', stateVersionId = 'version-1', serial = 1, markerStateVersionId = stateVersionId, markerSerial = serial, resources = managedResources } = {}) {
  const metadataDirectory = path.join(terraformRoot, '.terraform');
  await mkdir(metadataDirectory, { recursive: true, mode: 0o700 });
  await chmod(metadataDirectory, 0o700);
  await writeFile(path.join(metadataDirectory, 'terraform.tfstate'), JSON.stringify({
    version: 3, serial: 1, backend: { type: 'cloud', config: {
      hostname: null, organization: 'aegis-ai-portfolio', token: null,
      workspaces: { name: backendWorkspace, project: null, tags: [] },
    } },
  }), { mode: 0o600 });
  const backendFingerprint = inspectBackendMetadata({ backend: { type: 'cloud', config: {
    hostname: null, organization: 'aegis-ai-portfolio', token: null,
    workspaces: { name: 'aegis-auth0-dev', project: null, tags: [] },
  } } });
  const stateVersion = { data: { type: 'state-versions', id: stateVersionId, attributes: {
    serial, status: 'finalized', intermediate: false, 'resources-processed': true, resources,
  } } };
  const marker = createBindingMarker({
    workspaceId, backendFingerprint, stateVersionId: markerStateVersionId, serial: markerSerial,
    inventoryHash: managedInventoryHash,
  });
  await writeFile(path.join(metadataDirectory, 'aegis-state-binding.json'), JSON.stringify(marker), { mode: 0o600 });
  await chmod(path.join(metadataDirectory, 'aegis-state-binding.json'), 0o600);
  const baseFetch = responses();
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/current-state-version')) return jsonResponse(stateVersion);
    const response = await baseFetch(url, options);
    if (!url.endsWith('/workspaces/aegis-auth0-dev')) return response;
    const body = structuredClone(await response.json());
    body.data.id = workspaceId;
    body.data.relationships['current-state-version'].data = { type: 'state-versions', id: stateVersionId };
    return jsonResponse(body);
  };
  return { fetchImpl, stateVersion };
}

async function prepareBootstrapRepair(home, terraformRoot, { backendOrganization = 'aegis-ai-portfolio', backendWorkspace = 'aegis-auth0-dev', markerFingerprint = null, markerWorkspaceId = 'ws-1', marker = undefined } = {}) {
  const metadataDirectory = path.join(terraformRoot, '.terraform');
  await mkdir(metadataDirectory, { recursive: true, mode: 0o700 });
  await chmod(metadataDirectory, 0o700);
  const backend = { backend: { type: 'cloud', config: {
    hostname: null, organization: backendOrganization, token: null,
    workspaces: { name: backendWorkspace, project: null, tags: [] },
  } } };
  await writeFile(path.join(metadataDirectory, 'terraform.tfstate'), JSON.stringify(backend), { mode: 0o600 });
  const effectiveMarker = marker ?? createBindingMarker({
    workspaceId: markerWorkspaceId,
    backendFingerprint: markerFingerprint,
    stateVersionId: null,
    serial: 0,
    inventoryHash: null,
  });
  const markerPath = path.join(metadataDirectory, bindingMarkerName);
  await writeFile(markerPath, JSON.stringify(effectiveMarker), { mode: 0o600 });
  await chmod(markerPath, 0o600);
  const backendFingerprint = backendOrganization === 'aegis-ai-portfolio' && backendWorkspace === 'aegis-auth0-dev'
    ? inspectBackendMetadata(backend)
    : null;
  return { backend, backendFingerprint, markerPath, markerContents: JSON.stringify(effectiveMarker), fetchImpl: responses() };
}

describe('HCP Terraform read-only preflight', () => {
  it('confirms the intended Free, Local, auto-apply-off empty workspace without returning credentials', async () => {
    const home = await makeHome();
    const result = await verifyHcpConfiguration({ home, fetchImpl: responses() });
    assert.equal(result.organization, 'aegis-ai-portfolio');
    assert.equal(result.plan, 'free');
    assert.equal(result.workspace, 'aegis-auth0-dev');
    assert.equal(result.executionMode, 'local');
    assert.equal(result.autoApply, false);
    assert.equal(result.state, 'empty-bootstrap');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(syntheticToken));
  });

  it('fails closed when credentials are missing, malformed, empty or too broadly readable', async () => {
    const missingHome = await mkdtemp(path.join(os.tmpdir(), 'aegis-hcp-missing-'));
    temporaryDirectories.add(missingHome);
    await assert.rejects(verifyHcpConfiguration({ home: missingHome, fetchImpl: responses() }), /credentials is missing or unreadable/);

    const malformedHome = await makeHome({ content: '{invalid json' });
    await assert.rejects(verifyHcpConfiguration({ home: malformedHome, fetchImpl: responses() }), /contains invalid JSON/);

    const emptyHome = await makeHome({ content: JSON.stringify({ credentials: { 'app.terraform.io': { token: '' } } }) });
    await assert.rejects(verifyHcpConfiguration({ home: emptyHome, fetchImpl: responses() }), /do not contain.*token/);

    const unsafeHome = await makeHome({ permissions: 0o644 });
    await assert.rejects(verifyHcpConfiguration({ home: unsafeHome, fetchImpl: responses() }), /mode 0600/);

    const directoryHome = await mkdtemp(path.join(os.tmpdir(), 'aegis-hcp-directory-'));
    temporaryDirectories.add(directoryHome);
    const directory = path.join(directoryHome, '.terraform.d');
    await mkdir(path.join(directory, 'credentials.tfrc.json'), { recursive: true });
    await assert.rejects(verifyHcpConfiguration({ home: directoryHome, fetchImpl: responses() }), /mode 0600/);
  });

  it('does not disclose the token when HCP requests fail', async () => {
    const home = await makeHome();
    await assert.rejects(
      verifyHcpConfiguration({ home, fetchImpl: async () => { throw new Error(syntheticToken); } }),
      (error) => !error.message.includes(syntheticToken) && /read request failed/.test(error.message),
    );
    await assert.rejects(
      verifyHcpConfiguration({ home, fetchImpl: async () => ({ ok: false, status: 403 }) }),
      (error) => !error.message.includes(syntheticToken) && /HTTP 403/.test(error.message),
    );
  });

  it('classifies documented Free and paid plans while rejecting trial, expired, contradictory and malformed data', () => {
    const freeOrganization = { data: { type: 'organizations', id: 'org-1', attributes: {
      name: 'aegis-ai-portfolio', 'plan-identifier': 'free_standard', 'plan-is-trial': false,
      'plan-expired': false, 'plan-is-enterprise': false,
    } } };
    const subscription = (overrides = {}, featureOverrides = {}) => ({ data: {
      type: 'subscriptions', id: 'subscription-1', attributes: {
        'is-active': true, 'is-public-free-tier': true, 'is-self-serve-trial': false, ...overrides,
      }, relationships: {
        organization: { data: { id: 'org-1', type: 'organizations' } },
        'feature-set': { data: { id: 'feature-set-1', type: 'feature-sets' } },
      },
    }, included: [{ type: 'feature-sets', id: 'feature-set-1', attributes: {
      identifier: 'free_standard', 'is-current': true, 'is-free-tier': true, ...featureOverrides,
    } }] });

    assert.equal(classifyHcpPlan(freeOrganization, subscription()), 'free');

    const paidOrganization = { data: { ...freeOrganization.data, attributes: {
      ...freeOrganization.data.attributes, 'plan-identifier': 'standard',
    } } };
    assert.equal(classifyHcpPlan(paidOrganization, subscription({ 'is-public-free-tier': false }, {
      identifier: 'standard', 'is-free-tier': false,
    })), 'paid');

    assert.equal(classifyHcpPlan(freeOrganization, subscription({ 'is-self-serve-trial': true })), 'trial');
    assert.equal(classifyHcpPlan({ data: { ...freeOrganization.data, attributes: {
      ...freeOrganization.data.attributes, 'plan-expired': true,
    } } }, subscription()), 'unknown');
    assert.equal(classifyHcpPlan(freeOrganization, subscription({ 'is-public-free-tier': false })), 'unknown');
    assert.equal(classifyHcpPlan(freeOrganization, subscription({}, { identifier: 'standard' })), 'unknown');
    assert.equal(classifyHcpPlan(freeOrganization, subscription({}, { 'is-current': false })), 'unknown');
    const foreignOrganizationSubscription = subscription();
    foreignOrganizationSubscription.data.relationships.organization.data.id = 'other-org';
    assert.equal(classifyHcpPlan(freeOrganization, foreignOrganizationSubscription), 'unknown');
    assert.equal(classifyHcpPlan(freeOrganization, { data: { type: 'subscriptions' } }), 'unknown');
    assert.equal(classifyHcpPlan(null, subscription()), 'unknown');
  });

  it('rejects wrong organization identity or any plan other than a verified Free subscription', async () => {
    const home = await makeHome();
    const wrongName = { data: { type: 'organizations', id: 'org-1', attributes: { name: 'other-org', 'plan-identifier': 'free_standard' } } };
    await assert.rejects(verifyHcpConfiguration({ home, fetchImpl: responses({ organization: wrongName }) }), /organization could not be verified/);
    const paidOrg = { data: { type: 'organizations', id: 'org-1', attributes: {
      name: 'aegis-ai-portfolio', 'plan-identifier': 'standard', 'plan-is-trial': false,
      'plan-expired': false, 'plan-is-enterprise': false,
    } } };
    const paidSubscription = { data: {
      type: 'subscriptions', id: 'subscription-1', attributes: {
        'is-active': true, 'is-public-free-tier': false, 'is-self-serve-trial': false,
      }, relationships: {
        organization: { data: { id: 'org-1' } }, 'feature-set': { data: { id: 'paid-feature-set' } },
      },
    }, included: [{ type: 'feature-sets', id: 'paid-feature-set', attributes: {
      identifier: 'standard', 'is-current': true, 'is-free-tier': false,
    } }] };
    const requested = [];
    const paidFetch = responses({ organization: paidOrg, subscription: paidSubscription });
    await assert.rejects(verifyHcpConfiguration({ home, fetchImpl: async (url, options) => {
      requested.push(new URL(url).pathname);
      return paidFetch(url, options);
    } }), /classification: paid/);
    assert.deepEqual(requested, [
      '/api/v2/organizations/aegis-ai-portfolio',
      '/api/v2/organizations/aegis-ai-portfolio/subscription',
    ]);
  });

  it('rejects wrong workspace identity, organization, execution mode or auto-apply setting', async () => {
    const home = await makeHome();
    const base = (overrides) => ({ data: { type: 'workspaces', id: 'ws-1', attributes: { name: 'aegis-auth0-dev', 'execution-mode': 'local', 'auto-apply': false, ...overrides }, relationships: { organization: { data: { id: 'org-1' } }, 'current-state-version': { data: null } } } });
    await assert.rejects(verifyHcpConfiguration({ home, fetchImpl: responses({ workspace: base({ name: 'other-workspace' }) }) }), /workspace could not be verified/);
    const wrongOrganization = base({});
    wrongOrganization.data.relationships.organization.data.id = 'other-org';
    await assert.rejects(verifyHcpConfiguration({ home, fetchImpl: responses({ workspace: wrongOrganization }) }), /organization does not match/);
    await assert.rejects(verifyHcpConfiguration({ home, fetchImpl: responses({ workspace: base({ 'execution-mode': 'remote' }) }) }), /execution mode must be Local/);
    await assert.rejects(verifyHcpConfiguration({ home, fetchImpl: responses({ workspace: base({ 'auto-apply': true }) }) }), /auto-apply must be disabled/);
  });

  it('allows only explicitly empty state during bootstrap and rejects inconclusive state relationships', async () => {
    const home = await makeHome();
    const populated = { data: { type: 'workspaces', id: 'ws-1', attributes: { name: 'aegis-auth0-dev', 'execution-mode': 'local', 'auto-apply': false }, relationships: { organization: { data: { id: 'org-1' } }, 'current-state-version': { data: { id: 'state-1' } } } } };
    await assert.rejects(verifyHcpConfiguration({ home, fetchImpl: responses({ workspace: populated }) }), /exact local backend binding cannot be proven/);
    const omitted = { data: { ...populated.data, relationships: { organization: { data: { id: 'org-1' } } } } };
    await assert.rejects(verifyHcpConfiguration({ home, fetchImpl: responses({ workspace: omitted }) }), /relationship is missing or ambiguous/);
    const unavailable = { data: { ...populated.data, relationships: { ...populated.data.relationships, 'current-state-version': null } } };
    await assert.rejects(verifyHcpConfiguration({ home, fetchImpl: responses({ workspace: unavailable }) }), /relationship is missing or ambiguous/);
  });

  it('normalizes Terraform CLI cloud metadata defaults and rejects nondefault host, project, or tags', () => {
    const actualMetadata = { backend: { type: 'cloud', config: {
      hostname: null,
      organization: 'aegis-ai-portfolio',
      token: null,
      workspaces: { name: 'aegis-auth0-dev', project: null, tags: [] },
    } } };
    const fingerprint = inspectBackendMetadata(actualMetadata);
    assert.match(fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(inspectBackendMetadata({ backend: { type: 'cloud', config: {
      ...actualMetadata.backend.config, token: 'synthetic-token-must-not-affect-fingerprint',
    } } }), fingerprint);

    const nondefaultHost = structuredClone(actualMetadata);
    nondefaultHost.backend.config.hostname = 'other.example.com';
    assert.throws(() => inspectBackendMetadata(nondefaultHost), /does not bind exactly/);

    const namedProject = structuredClone(actualMetadata);
    namedProject.backend.config.workspaces.project = 'another-project';
    assert.throws(() => inspectBackendMetadata(namedProject), /does not bind exactly/);

    const taggedWorkspace = structuredClone(actualMetadata);
    taggedWorkspace.backend.config.workspaces.tags = ['another-workspace'];
    assert.throws(() => inspectBackendMetadata(taggedWorkspace), /does not bind exactly/);
  });

  it('accepts reinitialization only when backend, workspace, state version and exact resource inventory match the local ownership marker', async () => {
    const home = await makeHome();
    const terraformRoot = await mkdtemp(path.join(os.tmpdir(), 'aegis-managed-state-'));
    temporaryDirectories.add(terraformRoot);
    const { fetchImpl } = await prepareManagedState(home, terraformRoot);
    const result = await verifyHcpConfiguration({ home, terraformRoot, fetchImpl });
    assert.equal(result.state, 'verified-managed-state');
    assert.equal(result.stateVersionId, 'version-1');
    assert.equal(result.serial, 1);
  });

  it('permits bootstrap-marker repair only for an intact empty bootstrap marker and exact module backend, without writing it', async () => {
    const home = await makeHome();
    const terraformRoot = await mkdtemp(path.join(os.tmpdir(), 'aegis-bootstrap-repair-'));
    temporaryDirectories.add(terraformRoot);
    const fixture = await prepareBootstrapRepair(home, terraformRoot);
    const result = await verifyHcpConfiguration({ home, terraformRoot, fetchImpl: fixture.fetchImpl, mode: 'repair-bootstrap' });
    assert.equal(result.state, 'repairable-empty-bootstrap');
    assert.equal(result.backendFingerprint, fixture.backendFingerprint);
    assert.match(result.backendFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(await readFile(fixture.markerPath, 'utf8'), fixture.markerContents);

    await rm(path.join(terraformRoot, '.terraform'), { recursive: true, force: true });
    const staleFingerprint = '0'.repeat(64);
    const stale = await prepareBootstrapRepair(home, terraformRoot, { markerFingerprint: staleFingerprint });
    const staleResult = await verifyHcpConfiguration({ home, terraformRoot, fetchImpl: stale.fetchImpl, mode: 'repair-bootstrap' });
    assert.equal(staleResult.state, 'repairable-empty-bootstrap');
    assert.equal(staleResult.backendFingerprint, stale.backendFingerprint);
    assert.notEqual(staleResult.backendFingerprint, staleFingerprint);
    assert.equal(await readFile(stale.markerPath, 'utf8'), stale.markerContents);
  });

  it('rejects bootstrap-marker repair for populated state, missing or malformed markers, foreign workspace/backend, and an already-correct marker', async () => {
    const home = await makeHome();
    const terraformRoot = await mkdtemp(path.join(os.tmpdir(), 'aegis-bootstrap-repair-'));
    temporaryDirectories.add(terraformRoot);

    const populated = { data: { type: 'workspaces', id: 'ws-1', attributes: {
      name: 'aegis-auth0-dev', 'execution-mode': 'local', 'auto-apply': false,
    }, relationships: { organization: { data: { id: 'org-1' } }, 'current-state-version': { data: { id: 'state-1', type: 'state-versions' } } } } };
    await prepareBootstrapRepair(home, terraformRoot);
    await assert.rejects(verifyHcpConfiguration({ home, terraformRoot, fetchImpl: responses({ workspace: populated }), mode: 'repair-bootstrap' }), /allowed only when HCP explicitly reports no current state/);

    await rm(path.join(terraformRoot, '.terraform'), { recursive: true, force: true });
    const withoutMarker = await prepareBootstrapRepair(home, terraformRoot);
    await rm(withoutMarker.markerPath);
    await assert.rejects(verifyHcpConfiguration({ home, terraformRoot, fetchImpl: withoutMarker.fetchImpl, mode: 'repair-bootstrap' }), /intact empty-bootstrap marker/);

    await rm(path.join(terraformRoot, '.terraform'), { recursive: true, force: true });
    const malformed = await prepareBootstrapRepair(home, terraformRoot, { marker: { schemaVersion: 1, serial: 0 } });
    await assert.rejects(verifyHcpConfiguration({ home, terraformRoot, fetchImpl: malformed.fetchImpl, mode: 'repair-bootstrap' }), /not an intact empty-bootstrap marker/);

    await rm(path.join(terraformRoot, '.terraform'), { recursive: true, force: true });
    const foreignWorkspace = await prepareBootstrapRepair(home, terraformRoot, { markerWorkspaceId: 'foreign-workspace-id' });
    await assert.rejects(verifyHcpConfiguration({ home, terraformRoot, fetchImpl: foreignWorkspace.fetchImpl, mode: 'repair-bootstrap' }), /not an intact empty-bootstrap marker/);

    await rm(path.join(terraformRoot, '.terraform'), { recursive: true, force: true });
    const foreignBackend = await prepareBootstrapRepair(home, terraformRoot, { backendOrganization: 'another-org' });
    await assert.rejects(verifyHcpConfiguration({ home, terraformRoot, fetchImpl: foreignBackend.fetchImpl, mode: 'repair-bootstrap' }), /does not bind exactly/);

    await rm(path.join(terraformRoot, '.terraform'), { recursive: true, force: true });
    const matchingBackend = { backend: { type: 'cloud', config: {
      hostname: null, organization: 'aegis-ai-portfolio', token: null,
      workspaces: { name: 'aegis-auth0-dev', project: null, tags: [] },
    } } };
    const fingerprint = inspectBackendMetadata(matchingBackend);
    const alreadyCorrect = await prepareBootstrapRepair(home, terraformRoot, { markerFingerprint: fingerprint });
    await assert.rejects(verifyHcpConfiguration({ home, terraformRoot, fetchImpl: alreadyCorrect.fetchImpl, mode: 'repair-bootstrap' }), /already matches the verified backend/);
    assert.equal(await readFile(alreadyCorrect.markerPath, 'utf8'), alreadyCorrect.markerContents);
  });

  it('rejects foreign inventory, workspace mismatch, missing metadata and replaced state versions', async () => {
    const home = await makeHome();
    const terraformRoot = await mkdtemp(path.join(os.tmpdir(), 'aegis-managed-state-'));
    temporaryDirectories.add(terraformRoot);
    const foreignResources = [...managedResources, { type: 'aws_instance', name: 'unrelated', provider: 'provider["registry.terraform.io/hashicorp/aws"]', module: 'root', count: 1 }];
    const foreign = await prepareManagedState(home, terraformRoot, { resources: foreignResources });
    await assert.rejects(verifyHcpConfiguration({ home, terraformRoot, fetchImpl: foreign.fetchImpl }), /not the exact Aegis Auth0 foundation inventory/);

    await rm(path.join(terraformRoot, '.terraform'), { recursive: true, force: true });
    const mismatched = await prepareManagedState(home, terraformRoot, { backendWorkspace: 'other-workspace' });
    await assert.rejects(verifyHcpConfiguration({ home, terraformRoot, fetchImpl: mismatched.fetchImpl }), /does not bind exactly/);

    await rm(path.join(terraformRoot, '.terraform', 'terraform.tfstate'));
    const missingMetadata = await prepareManagedState(home, terraformRoot);
    await rm(path.join(terraformRoot, '.terraform', 'terraform.tfstate'));
    await assert.rejects(verifyHcpConfiguration({ home, terraformRoot, fetchImpl: missingMetadata.fetchImpl }), /backend binding cannot be proven/);

    await rm(path.join(terraformRoot, '.terraform'), { recursive: true, force: true });
    const missingMarker = await prepareManagedState(home, terraformRoot);
    await rm(path.join(terraformRoot, '.terraform', 'aegis-state-binding.json'));
    await assert.rejects(verifyHcpConfiguration({ home, terraformRoot, fetchImpl: missingMarker.fetchImpl }), /marker is missing/);

    await rm(path.join(terraformRoot, '.terraform'), { recursive: true, force: true });
    const unsafeMetadata = await prepareManagedState(home, terraformRoot);
    await chmod(path.join(terraformRoot, '.terraform', 'terraform.tfstate'), 0o644);
    await assert.rejects(verifyHcpConfiguration({ home, terraformRoot, fetchImpl: unsafeMetadata.fetchImpl }), /mode 0600/);

    await rm(path.join(terraformRoot, '.terraform'), { recursive: true, force: true });
    const replaced = await prepareManagedState(home, terraformRoot, { stateVersionId: 'replacement-version', serial: 2, markerStateVersionId: 'version-1', markerSerial: 1 });
    await assert.rejects(verifyHcpConfiguration({ home, terraformRoot, fetchImpl: replaced.fetchImpl }), /differs from the previously reviewed local binding marker/);

    await rm(path.join(terraformRoot, '.terraform'), { recursive: true, force: true });
    const wrongCount = await prepareManagedState(home, terraformRoot, { resources: managedResources.map((resource) => ({ ...resource, count: resource.name === 'cases' ? 2 : 1 })) });
    await assert.rejects(verifyHcpConfiguration({ home, terraformRoot, fetchImpl: wrongCount.fetchImpl }), /incomplete or has an unknown shape/);
  });

  it('rejects unreadable API responses without including response contents', async () => {
    const home = await makeHome();
    await assert.rejects(verifyHcpConfiguration({ home, fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error(syntheticToken); } }) }), (error) => !error.message.includes(syntheticToken) && /invalid response/.test(error.message));
  });
});

describe('restricted Terraform wrapper', () => {
  it('uses authenticated cloud init with fixed arguments and refuses destructive/unlisted commands', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'aegis-terraform-wrapper-'));
    temporaryDirectories.add(temp);
    const wrapperDirectory = path.join(temp, 'infra', 'terraform', 'auth0');
    await mkdir(wrapperDirectory, { recursive: true });
    const wrapperPath = path.join(wrapperDirectory, 'terraform-local.mjs');
    await copyFile(new URL('./terraform-local.mjs', import.meta.url), wrapperPath);
    await copyFile(new URL('./hcp-preflight.mjs', import.meta.url), path.join(wrapperDirectory, 'hcp-preflight.mjs'));
    const bin = path.join(temp, 'bin');
    await mkdir(bin);
    const captured = path.join(temp, 'args.json');
    const terraform = path.join(bin, 'terraform');
    await writeFile(terraform, `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] === 'init') {
  const metadataDirectory = path.join(process.cwd(), '.terraform');
  mkdirSync(metadataDirectory, { recursive: true });
  writeFileSync(path.join(metadataDirectory, 'terraform.tfstate'), JSON.stringify({ backend: { type: 'cloud', config: {
    hostname: null, organization: 'aegis-ai-portfolio', token: null,
    workspaces: { name: 'aegis-auth0-dev', project: null, tags: [] },
  } } }), { mode: 0o666 });
}
writeFileSync(${JSON.stringify(captured)}, JSON.stringify({ args, umask: process.umask() & 0o077 }));
`);
    await chmod(terraform, 0o700);

    const credentialDirectory = path.join(temp, '.terraform.d');
    await mkdir(credentialDirectory, { mode: 0o700 });
    await writeFile(path.join(credentialDirectory, 'credentials.tfrc.json'), JSON.stringify({ credentials: { 'app.terraform.io': { token: syntheticToken } } }), { mode: 0o600 });
    const preload = path.join(temp, 'mock-hcp.mjs');
    await writeFile(preload, `
      globalThis.fetch = async (url, options) => {
        if (options.headers.Authorization !== 'Bearer synthetic-hcp-test-token-never-real') throw new Error('unexpected HCP credential source');
        if (process.env.MOCK_HCP_MODE === 'failure') return { ok: false, status: 403, json: async () => ({ errors: [{ detail: 'private response content' }] }) };
        const organization = { data: { type: 'organizations', id: 'org-1', attributes: { name: 'aegis-ai-portfolio', 'plan-identifier': 'free_standard', 'plan-is-trial': false, 'plan-expired': false, 'plan-is-enterprise': false } } };
        const subscription = { data: { type: 'subscriptions', id: 'subscription-1', attributes: { 'is-active': true, 'is-public-free-tier': true, 'is-self-serve-trial': false }, relationships: { organization: { data: { id: 'org-1' } }, 'feature-set': { data: { id: 'feature-set-1' } } } }, included: [{ type: 'feature-sets', id: 'feature-set-1', attributes: { identifier: 'free_standard', 'is-current': true, 'is-free-tier': true } }] };
        const workspace = { data: { type: 'workspaces', id: 'ws-1', attributes: { name: 'aegis-auth0-dev', 'execution-mode': 'local', 'auto-apply': false }, relationships: { organization: { data: { id: 'org-1' } }, 'current-state-version': { data: null } } } };
        return { ok: true, status: 200, json: async () => url.endsWith('/organizations/aegis-ai-portfolio') ? organization : url.endsWith('/subscription') ? subscription : workspace };
      };
    `);

    const wrapper = wrapperPath;
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: temp, MOCK_HCP_MODE: 'success' };
    const projectMetadata = path.join(wrapperDirectory, '.terraform', 'terraform.tfstate');
    const projectMarker = path.join(wrapperDirectory, '.terraform', bindingMarkerName);
    const init = spawnSync(process.execPath, ['--import', preload, wrapper, 'init'], { encoding: 'utf8', env });
    assert.equal(init.status, 0, init.stderr);
    const terraformInvocation = JSON.parse(await readFile(captured, 'utf8'));
    assert.deepEqual(terraformInvocation.args, ['init', '-input=false', '-no-color']);
    assert.equal(terraformInvocation.umask, 0o077);
    assert.equal((await stat(projectMetadata)).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(wrapperDirectory, '.terraform'))).mode & 0o777, 0o700);
    const backendMetadata = JSON.parse(await readFile(projectMetadata, 'utf8'));
    const marker = JSON.parse(await readFile(projectMarker, 'utf8'));
    assert.equal(marker.backendFingerprint, inspectBackendMetadata(backendMetadata));
    assert.equal(marker.organization, 'aegis-ai-portfolio');
    assert.equal(marker.workspace, 'aegis-auth0-dev');
    assert.notEqual(marker.backendFingerprint, null);
    assert.equal((await stat(projectMarker)).mode & 0o777, 0o600);
    assert.match(init.stdout, /HCP preflight passed/);
    assert.doesNotMatch(`${init.stdout}${init.stderr}`, new RegExp(syntheticToken));

    await rm(captured, { force: true });
    const failedPreflight = spawnSync(process.execPath, ['--import', preload, wrapper, 'init'], {
      encoding: 'utf8', env: { ...env, MOCK_HCP_MODE: 'failure' },
    });
    assert.notEqual(failedPreflight.status, 0);
    assert.match(failedPreflight.stderr, /HTTP 403/);
    assert.doesNotMatch(`${failedPreflight.stdout}${failedPreflight.stderr}`, new RegExp(syntheticToken));
    await assert.rejects(readFile(captured, 'utf8'), { code: 'ENOENT' });

    for (const denied of ['apply', 'destroy', 'import', 'state', 'plan -out=secret.tfplan', 'init -reconfigure']) {
      const result = spawnSync(process.execPath, [wrapper, ...denied.split(' ')], { encoding: 'utf8', env });
      assert.notEqual(result.status, 0, `${denied} should be denied`);
    }
  });

  it('standalone preflight resolves Terraform metadata beside its module while reading CLI credentials from HOME', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'aegis-hcp-standalone-'));
    temporaryDirectories.add(temp);
    const moduleDirectory = path.join(temp, 'infra', 'terraform', 'auth0');
    const home = temp;
    await mkdir(moduleDirectory, { recursive: true });
    const script = path.join(moduleDirectory, 'hcp-preflight.mjs');
    await copyFile(new URL('./hcp-preflight.mjs', import.meta.url), script);

    const credentialDirectory = path.join(home, '.terraform.d');
    await mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(credentialDirectory, 'credentials.tfrc.json'), JSON.stringify({
      credentials: { 'app.terraform.io': { token: syntheticToken } },
    }), { mode: 0o600 });

    const moduleMetadataDirectory = path.join(moduleDirectory, '.terraform');
    await mkdir(moduleMetadataDirectory, { mode: 0o700 });
    const moduleBackend = { backend: { type: 'cloud', config: {
      hostname: null, organization: 'aegis-ai-portfolio', token: null,
      workspaces: { name: 'aegis-auth0-dev', project: null, tags: [] },
    } } };
    await writeFile(path.join(moduleMetadataDirectory, 'terraform.tfstate'), JSON.stringify(moduleBackend), { mode: 0o600 });

    // Put a conflicting binding at repository root so a regression to repo-root resolution fails closed.
    const wrongMetadataDirectory = path.join(temp, '.terraform');
    await mkdir(wrongMetadataDirectory, { mode: 0o700 });
    await writeFile(path.join(wrongMetadataDirectory, 'terraform.tfstate'), JSON.stringify({ backend: { type: 'cloud', config: {
      hostname: null, organization: 'another-org', token: null,
      workspaces: { name: 'another-workspace', project: null, tags: [] },
    } } }), { mode: 0o600 });

    const preload = path.join(temp, 'mock-standalone.mjs');
    await writeFile(preload, `
      globalThis.fetch = async (url, options) => {
        if (options.headers.Authorization !== 'Bearer ${syntheticToken}') throw new Error('unexpected HCP credential source');
        const organization = { data: { type: 'organizations', id: 'org-1', attributes: { name: 'aegis-ai-portfolio', 'plan-identifier': 'free_standard', 'plan-is-trial': false, 'plan-expired': false, 'plan-is-enterprise': false } } };
        const subscription = { data: { type: 'subscriptions', id: 'subscription-1', attributes: { 'is-active': true, 'is-public-free-tier': true, 'is-self-serve-trial': false }, relationships: { organization: { data: { id: 'org-1' } }, 'feature-set': { data: { id: 'feature-set-1' } } } }, included: [{ type: 'feature-sets', id: 'feature-set-1', attributes: { identifier: 'free_standard', 'is-current': true, 'is-free-tier': true } }] };
        const workspace = { data: { type: 'workspaces', id: 'ws-1', attributes: { name: 'aegis-auth0-dev', 'execution-mode': 'local', 'auto-apply': false }, relationships: { organization: { data: { id: 'org-1' } }, 'current-state-version': { data: null } } } };
        return { ok: true, status: 200, json: async () => url.endsWith('/organizations/aegis-ai-portfolio') ? organization : url.endsWith('/subscription') ? subscription : workspace };
      };
    `);
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, HOME: home, NODE_OPTIONS: `--import=${preload}` }, cwd: temp });
    assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stdout, /"state": "empty-bootstrap"/, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stdout, /Preflight passed/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(syntheticToken));
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /another-org|another-workspace/);
  });
});
