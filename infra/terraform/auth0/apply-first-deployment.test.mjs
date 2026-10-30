import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  expectedResourceAddresses,
  isAutomatedContext,
  redactText,
  runFirstDeploymentGate,
  validatePlanDocument,
} from './apply-first-deployment.mjs';
import { organizationName, rootIdentity, workspaceName } from './hcp-preflight.mjs';

const temporaryDirectories = new Set();
const fakeAuth0Secret = 'synthetic-auth0-client-secret-for-test';
const fakeHcpToken = 'synthetic-hcp-token-for-first-apply-tests';
const testModuleDirectory = path.dirname(new URL(import.meta.url).pathname);

afterEach(async () => {
  await Promise.all([...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
  temporaryDirectories.clear();
});

function validPlanDocument(overrides = {}) {
  const resources = expectedResourceAddresses.map((address) => {
    const [type, name] = address.split('.');
    return {
      address, mode: 'managed', type, name, provider_name: 'registry.terraform.io/auth0/auth0',
      change: { actions: ['create'], before: null, after: {}, after_unknown: {}, before_sensitive: {}, after_sensitive: {}, replace_paths: [] },
    };
  });
  return {
    format_version: '1.2', terraform_version: '1.9.8', errored: false, complete: true, applyable: true,
    variables: {
      database_connection_id: { value: 'con_synthetic_test' },
      auth0_domain: { value: 'example.us.auth0.com' },
      api_identifier: { value: 'https://aegis-ai.local/api' },
      spa_name: { value: 'Aegis AI Local SPA' },
    },
    resource_changes: resources, resource_drift: [], output_changes: {
      audience: { actions: ['create'], before: null }, issuer: { actions: ['create'], before: null }, spa_client_id: { actions: ['create'], before: null },
    },
    ...overrides,
  };
}

function makeOutput() {
  let contents = '';
  return { stream: { isTTY: true, write(value) { contents += String(value); } }, get text() { return contents; } };
}

async function makeFixture({ preflightStates, applyCode = 0, planDocument = validPlanDocument(), confirmation = true, planOutput } = {}) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'aegis-first-apply-test-'));
  temporaryDirectories.add(temp);
  const home = path.join(temp, 'home');
  const moduleDirectory = path.join(temp, 'infra', 'terraform', 'auth0');
  const metadataDirectory = path.join(moduleDirectory, '.terraform');
  await mkdir(path.join(home, '.terraform.d'), { recursive: true, mode: 0o700 });
  await mkdir(metadataDirectory, { recursive: true, mode: 0o700 });
  await chmod(metadataDirectory, 0o700);

  const credentialsPath = path.join(temp, '.env.auth0');
  await writeFile(credentialsPath, [
    `AUTH0_DOMAIN=${JSON.stringify('example.us.auth0.com')}`,
    `AUTH0_CLIENT_ID=${JSON.stringify('synthetic-client-id')}`,
    `AUTH0_CLIENT_SECRET=${JSON.stringify(fakeAuth0Secret)}`,
    '',
  ].join('\n'), { mode: 0o600 });
  await chmod(credentialsPath, 0o600);
  const tfvarsPath = path.join(moduleDirectory, 'terraform.tfvars');
  await writeFile(tfvarsPath, [
    'database_connection_id = "con_synthetic_test"',
    'api_identifier = "https://aegis-ai.local/api"',
    'spa_name = "Aegis AI Local SPA"',
    '',
  ].join('\n'), { mode: 0o600 });
  await writeFile(path.join(home, '.terraform.d', 'credentials.tfrc.json'), JSON.stringify({
    credentials: { 'app.terraform.io': { token: fakeHcpToken } },
  }), { mode: 0o600 });
  const backend = { backend: { type: 'cloud', config: {
    hostname: 'app.terraform.io', organization: organizationName, workspaces: { name: workspaceName, project: null, tags: [] },
  } } };
  await writeFile(path.join(metadataDirectory, 'terraform.tfstate'), JSON.stringify(backend), { mode: 0o600 });
  const backendFingerprint = createHash('sha256').update(JSON.stringify({
    hostname: 'app.terraform.io', organization: organizationName, workspace: workspaceName,
  })).digest('hex');
  const marker = {
    schemaVersion: 1, rootIdentity, organization: organizationName, workspace: workspaceName,
    workspaceId: 'ws-synthetic', backendFingerprint, stateVersionId: null, serial: 0, inventoryHash: null,
  };
  await writeFile(path.join(metadataDirectory, 'aegis-state-binding.json'), JSON.stringify(marker), { mode: 0o600 });

  const output = makeOutput();
  const input = { isTTY: true };
  const calls = [];
  const directories = [];
  let preflightCall = 0;
  let prompted = false;
  const hcpResponse = () => ({
    organization: organizationName, plan: 'free', workspace: workspaceName, workspaceId: 'ws-synthetic',
    executionMode: 'local', autoApply: false, state: 'empty-bootstrap', backendFingerprint,
  });
  const defaultStates = preflightStates ?? [hcpResponse(), hcpResponse()];
  const preflight = async () => defaultStates[Math.min(preflightCall++, defaultStates.length - 1)];
  const targetCheck = async ({ credentials, connectionId, apiIdentifier, spaName }) => {
    assert.equal(credentials.AUTH0_DOMAIN, 'example.us.auth0.com');
    assert.equal(connectionId, 'con_synthetic_test');
    assert.equal(apiIdentifier, 'https://aegis-ai.local/api');
    assert.equal(spaName, 'Aegis AI Local SPA');
  };
  const terraform = async (_command, args, { env, secrets }) => {
    calls.push({ args, env, secrets });
    const result = (value) => ({ ...value, stdout: redactText(value.stdout, secrets), stderr: redactText(value.stderr, secrets) });
    if (args[0] === 'plan') {
      await writeFile(args[3].slice('-out='.length), 'synthetic-private-plan', { mode: 0o600 });
      return result({ code: 0, stdout: 'Plan: 5 to add, 0 to change, 0 to destroy.', stderr: '' });
    }
    if (args[0] === 'show' && args[1] === '-json') {
      return result({ code: 0, stdout: JSON.stringify(planDocument), stderr: '' });
    }
    if (args[0] === 'show') return result({ code: 0, stdout: planOutput ?? 'Reviewed sanitized plan.', stderr: '' });
    if (args[0] === 'apply') return result({ code: applyCode, stdout: `apply output ${fakeAuth0Secret}`, stderr: '' });
    throw new Error(`Unexpected mocked Terraform command ${args[0]}`);
  };
  const prompt = async (message) => {
    prompted = true;
    const match = /^Type exactly "(.+)" to apply this saved plan: $/.exec(message);
    assert.ok(match, 'confirmation must identify this deployment');
    return confirmation ? match[1] : 'incorrect confirmation';
  };
  const createPlanDirectory = async (prefix) => {
    const directory = await mkdtemp(prefix);
    directories.push(directory);
    return directory;
  };
  const run = (overrides = {}) => runFirstDeploymentGate({
    env: { HOME: home }, home, cwd: moduleDirectory, credentialsPath, tfvarsPath, metadataDirectory,
    input, output: output.stream, argv: ['node', 'apply-first-deployment.mjs'], preflight, targetCheck,
    terraform, createPlanDirectory, prompt,
    removePlanDirectory: async (directory) => rm(directory, { recursive: true, force: false }),
    ...overrides,
  });
  return { temp, home, moduleDirectory, metadataDirectory, credentialsPath, tfvarsPath, output, calls, directories, run, get prompted() { return prompted; } };
}

describe('first Auth0 deployment plan validation', () => {
  it('accepts only the five expected root Auth0 resources with create-only actions', () => {
    assert.deepEqual(validatePlanDocument(validPlanDocument()), {
      creates: 5, updates: 0, deletes: 0, addresses: expectedResourceAddresses,
    });
  });

  it('rejects unexpected resources, duplicate addresses, update/delete/replace/import actions, drift, and unknown fields', () => {
    const base = validPlanDocument();
    assert.throws(() => validatePlanDocument(validPlanDocument({
      resource_changes: [...base.resource_changes, { ...base.resource_changes[0], address: 'auth0_action.unrelated', type: 'auth0_action', name: 'unrelated' }],
    })), /exactly the five/);
    assert.throws(() => validatePlanDocument(validPlanDocument({
      resource_changes: [...base.resource_changes.slice(0, 4), base.resource_changes[0]],
    })), /resource addresses/);
    for (const actions of [['update'], ['delete'], ['delete', 'create'], ['create', 'delete']]) {
      const resources = base.resource_changes.map((resource, index) => index === 0
        ? { ...resource, change: { ...resource.change, actions } } : resource);
      assert.throws(() => validatePlanDocument(validPlanDocument({ resource_changes: resources })), /unexpected resource action/);
    }
    const imported = base.resource_changes.map((resource, index) => index === 0
      ? { ...resource, change: { ...resource.change, importing: { id: 'foreign-id' } } } : resource);
    assert.throws(() => validatePlanDocument(validPlanDocument({ resource_changes: imported })), /unexpected resource action/);
    assert.throws(() => validatePlanDocument(validPlanDocument({ resource_drift: [{ address: 'auth0_client.foreign' }] })), /contains drift/);
    assert.throws(() => validatePlanDocument(validPlanDocument({ unexpected: true })), /unsupported/);
    assert.throws(() => validatePlanDocument(validPlanDocument({ format_version: '2.0' })), /unsupported/);
  });

  it('rejects stale, incomplete, unknown-provider, nested-module, and output-mutation plans', () => {
    const base = validPlanDocument();
    assert.throws(() => validatePlanDocument(validPlanDocument({ complete: false })), /incomplete/);
    assert.throws(() => validatePlanDocument(validPlanDocument({ applyable: false })), /incomplete/);
    const badProvider = base.resource_changes.map((resource, index) => index === 1
      ? { ...resource, provider_name: 'registry.terraform.io/hashicorp/aws' } : resource);
    assert.throws(() => validatePlanDocument(validPlanDocument({ resource_changes: badProvider })), /unexpected resource action/);
    const nested = base.resource_changes.map((resource, index) => index === 1
      ? { ...resource, module_address: 'module.foreign' } : resource);
    assert.throws(() => validatePlanDocument(validPlanDocument({ resource_changes: nested })), /unexpected resource action/);
    assert.throws(() => validatePlanDocument(validPlanDocument({ output_changes: { other_output: { actions: ['create'] } } })), /unexpected output/);
    assert.doesNotThrow(() => validatePlanDocument(validPlanDocument({ output_changes: {
      audience: { actions: ['create'], before: null }, issuer: { actions: ['create'], before: null }, spa_client_id: { actions: ['create'], before: null },
    } })));
  });
});

describe('first Auth0 deployment authorization boundary', () => {
  it('rejects Codex, CI, and test execution contexts', () => {
    assert.equal(isAutomatedContext({ CODEX_HOME: '/private/codex' }), true);
    assert.equal(isAutomatedContext({ OPENAI_CODEX_SESSION: '1' }), true);
    assert.equal(isAutomatedContext({ CI: 'true' }), true);
    assert.equal(isAutomatedContext({ NODE_ENV: 'test' }), true);
    assert.equal(isAutomatedContext({ HOME: '/Users/operator' }), false);
  });

  it('rejects non-TTY invocation before reading credentials or starting Terraform', async () => {
    const result = await makeFixture();
    await assert.rejects(result.run({ input: { isTTY: false } }), /interactive terminal/);
    assert.equal(result.calls.length, 0);
    assert.equal(result.prompted, false);
    const cli = spawnSync(process.execPath, [path.join(testModuleDirectory, 'apply-first-deployment.mjs')], {
      encoding: 'utf8', env: { HOME: result.home, NODE_ENV: 'test' },
    });
    assert.notEqual(cli.status, 0);
    assert.match(cli.stdout + cli.stderr, /interactive terminal/);
  });

  it('cancels without apply and cleans the private plan artifact when confirmation is wrong', async () => {
    const result = await makeFixture({ confirmation: false });
    const outcome = await result.run();
    assert.deepEqual(outcome, { applied: false, reason: 'cancelled' });
    assert.equal(result.calls.some((call) => call.args[0] === 'apply'), false);
    assert.equal(result.prompted, true);
    assert.equal(result.directories.length, 1);
    await assert.rejects(lstat(result.directories[0]), { code: 'ENOENT' });
  });

  it('applies only the exact reviewed saved plan and never passes auto-approve or user arguments', async () => {
    const result = await makeFixture();
    const outcome = await result.run();
    assert.deepEqual(outcome, { applied: true, reason: 'success' });
    const commands = result.calls.map(({ args }) => args[0]);
    assert.deepEqual(commands, ['plan', 'show', 'show', 'show', 'apply']);
    const applied = result.calls.at(-1).args;
    assert.equal(applied.length, 4);
    assert.equal(applied[1], '-input=false');
    assert.equal(applied.includes('-auto-approve'), false);
    assert.equal(applied[2], '-no-color');
    assert.match(applied[3], /\.aegis-first-apply-.+\/plan\.tfplan$/);
    assert.equal(result.calls[0].env.DATABASE_URL, undefined);
    assert.equal(result.calls[0].env.TF_CLI_ARGS_apply, undefined);
    assert.equal(result.output.text.includes(fakeAuth0Secret), false);
    assert.equal(result.output.text.includes(fakeHcpToken), false);
    assert.equal(result.output.text.includes('5 creates, 0 changes, 0 destroys'), true);
    await assert.rejects(lstat(result.directories[0]), { code: 'ENOENT' });
  });

  it('fails closed on wrong confirmation, stale/nonempty preflight, foreign workspace, and backend mismatch', async () => {
    const stale = await makeFixture({ preflightStates: [
      { organization: organizationName, workspace: workspaceName, workspaceId: 'ws-synthetic', executionMode: 'local', autoApply: false, state: 'empty-bootstrap', backendFingerprint: 'a'.repeat(64) },
    ] });
    await assert.rejects(stale.run(), /HCP preflight did not prove|ownership marker does not prove/);
    assert.equal(stale.calls.length, 0);

    const foreign = await makeFixture({ preflightStates: [
      { organization: organizationName, workspace: 'other-workspace', workspaceId: 'ws-synthetic', executionMode: 'local', autoApply: false, state: 'empty-bootstrap', backendFingerprint: 'b'.repeat(64) },
    ] });
    await assert.rejects(foreign.run(), /exact empty Aegis development bootstrap/);
    assert.equal(foreign.calls.length, 0);

    const nonempty = await makeFixture({ preflightStates: [
      { organization: organizationName, workspace: workspaceName, workspaceId: 'ws-synthetic', executionMode: 'local', autoApply: false, state: 'verified-managed-state', backendFingerprint: 'c'.repeat(64) },
    ] });
    await assert.rejects(nonempty.run(), /exact empty Aegis development bootstrap/);
    assert.equal(nonempty.calls.length, 0);
  });

  it('fails closed on missing ownership metadata, invalid credentials, trial plans, remote execution, and auto-apply', async () => {
    const missingMarker = await makeFixture();
    await rm(path.join(missingMarker.metadataDirectory, 'aegis-state-binding.json'));
    await assert.rejects(missingMarker.run(), /ownership marker is missing/);
    assert.equal(missingMarker.calls.length, 0);

    const unsafeCredential = await makeFixture();
    await chmod(unsafeCredential.credentialsPath, 0o644);
    await assert.rejects(unsafeCredential.run(), /mode 0600/);
    assert.equal(unsafeCredential.calls.length, 0);

    const replacedStateMarker = await makeFixture();
    const markerPath = path.join(replacedStateMarker.metadataDirectory, 'aegis-state-binding.json');
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    marker.stateVersionId = 'sv-foreign';
    marker.serial = 1;
    await writeFile(markerPath, JSON.stringify(marker), { mode: 0o600 });
    await assert.rejects(replacedStateMarker.run(), /ownership marker does not prove/);
    assert.equal(replacedStateMarker.calls.length, 0);

    for (const changes of [
      { plan: 'trial' },
      { executionMode: 'remote' },
      { autoApply: true },
      { organization: 'foreign-org' },
      { state: 'unknown' },
    ]) {
      const rejected = await makeFixture({ preflightStates: [{
        organization: organizationName, plan: 'free', workspace: workspaceName,
        workspaceId: 'ws-synthetic', executionMode: 'local', autoApply: false,
        state: 'empty-bootstrap',
        backendFingerprint: createHash('sha256').update(JSON.stringify({ hostname: 'app.terraform.io', organization: organizationName, workspace: workspaceName })).digest('hex'),
        ...changes,
      }] });
      await assert.rejects(rejected.run(), /exact empty Aegis development bootstrap/);
      assert.equal(rejected.calls.length, 0);
    }
  });

  it('does not apply after the second HCP preflight changes or the Auth0 target check fails', async () => {
    const fingerprint = createHash('sha256').update(JSON.stringify({ hostname: 'app.terraform.io', organization: organizationName, workspace: workspaceName })).digest('hex');
    const changed = await makeFixture({ preflightStates: [
      { organization: organizationName, workspace: workspaceName, workspaceId: 'ws-synthetic', executionMode: 'local', autoApply: false, state: 'empty-bootstrap', backendFingerprint: fingerprint },
      { organization: organizationName, workspace: workspaceName, workspaceId: 'ws-replaced', executionMode: 'local', autoApply: false, state: 'empty-bootstrap', backendFingerprint: fingerprint },
    ] });
    await assert.rejects(changed.run(), /HCP preflight did not prove|ownership marker does not prove/);
    assert.equal(changed.calls.some((call) => call.args[0] === 'apply'), false);
    assert.equal(changed.directories.length, 0, 'HCP mismatch must stop before creating a temporary plan directory');

    const targetChanged = await makeFixture();
    await assert.rejects(targetChanged.run({ targetCheck: async () => { throw new Error('target mismatch'); } }), /target mismatch/);
    assert.equal(targetChanged.calls.length, 0);
  });

  it('does not apply if the saved plan inputs do not match the reviewed Auth0 target', async () => {
    const mismatchedConnection = await makeFixture({ planDocument: validPlanDocument({ variables: {
      database_connection_id: { value: 'con_foreign' }, auth0_domain: { value: 'example.us.auth0.com' },
    } }) });
    await assert.rejects(mismatchedConnection.run(), /plan inputs do not match/);
    assert.equal(mismatchedConnection.calls.some((call) => call.args[0] === 'apply'), false);
    await assert.rejects(lstat(mismatchedConnection.directories[0]), { code: 'ENOENT' });

    const mismatchedDomain = await makeFixture({ planDocument: validPlanDocument({ variables: {
      database_connection_id: { value: 'con_synthetic_test' }, auth0_domain: { value: 'foreign.example.com' },
    } }) });
    await assert.rejects(mismatchedDomain.run(), /plan inputs do not match/);
    assert.equal(mismatchedDomain.calls.some((call) => call.args[0] === 'apply'), false);
  });

  it('uses read-only Auth0 inventory response shapes and fails closed when object totals are incomplete', async () => {
    const createFetch = ({ clients = { clients: [], total: 0 }, servers = { resource_servers: [], total: 0 } } = {}) => async (url, options) => {
      if (url.endsWith('/oauth/token')) {
        assert.equal(options.method, 'POST');
        const body = JSON.parse(options.body);
        assert.equal(body.scope, 'read:connections read:clients read:resource_servers');
        assert.equal(body.client_secret, fakeAuth0Secret);
        return { ok: true, json: async () => ({ access_token: 'synthetic-management-token' }) };
      }
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.Authorization, 'Bearer synthetic-management-token');
      if (url.endsWith('/api/v2/connections/con_synthetic_test')) {
        return { ok: true, json: async () => ({ id: 'con_synthetic_test', strategy: 'auth0' }) };
      }
      if (url.includes('/api/v2/clients?')) return { ok: true, json: async () => clients };
      if (url.includes('/api/v2/resource-servers?')) return { ok: true, json: async () => servers };
      throw new Error('Unexpected read-only Auth0 request');
    };

    const valid = await makeFixture();
    const outcome = await valid.run({ targetCheck: undefined, fetchImpl: createFetch() });
    assert.deepEqual(outcome, { applied: true, reason: 'success' });

    for (const inventory of [
      { clients: { clients: [], total: 1 }, servers: { resource_servers: [], total: 0 } },
      { clients: { clients: [], total: 0 }, servers: { resource_servers: [] } },
      { clients: { clients: [], total: 0 }, servers: { resource_servers: Array.from({ length: 100 }, (_, index) => ({ identifier: `https://foreign-${index}.example` })), total: 101 } },
      { clients: { clients: [{ name: 'Aegis AI Local SPA' }], total: 1 }, servers: { resource_servers: [], total: 0 } },
      { clients: { clients: [], total: 0 }, servers: { resource_servers: [{ identifier: 'https://aegis-ai.local/api' }], total: 1 } },
    ]) {
      const invalid = await makeFixture();
      const expectedMessage = inventory.clients?.total !== inventory.clients?.clients?.length || !Array.isArray(inventory.servers?.resource_servers) || inventory.servers.total !== inventory.servers.resource_servers.length
        ? /inventory is incomplete/ : /already exists/;
      await assert.rejects(invalid.run({ targetCheck: undefined, fetchImpl: createFetch(inventory) }), expectedMessage);
      assert.equal(invalid.calls.length, 0);
    }
  });

  it('detects saved-plan replacement during confirmation and cleans its private directory', async () => {
    const result = await makeFixture();
    await assert.rejects(result.run({ prompt: async (message) => {
      const planPath = result.calls.find(({ args }) => args[0] === 'plan').args[3].slice('-out='.length);
      await writeFile(planPath, 'replaced-plan-content', { mode: 0o600 });
      return /^Type exactly "(.+)" to apply this saved plan: $/.exec(message)[1];
    } }), /plan changed before apply/);
    assert.equal(result.calls.some((call) => call.args[0] === 'apply'), false);
    await assert.rejects(lstat(result.directories[0]), { code: 'ENOENT' });
  });

  it('does not bind or retry after a partial apply failure and still cleans the plan', async () => {
    const result = await makeFixture({ applyCode: 1 });
    await assert.rejects(result.run(), /Do not retry automatically/);
    assert.equal(result.calls.filter((call) => call.args[0] === 'apply').length, 1);
    assert.equal(result.calls.some((call) => call.args[0] === 'bind-reviewed-state'), false);
    assert.equal(result.calls.some((call) => call.args[0] === 'destroy'), false);
    await assert.rejects(lstat(result.directories[0]), { code: 'ENOENT' });
  });

  it('redacts credentials after output chunks are reconstructed, and never emits plan JSON', async () => {
    const joined = `output ${fakeAuth0Secret}`;
    const reconstructedChunks = `${joined.slice(0, 17)}${joined.slice(17)}`;
    assert.equal(redactText(reconstructedChunks, [fakeAuth0Secret]).includes(fakeAuth0Secret), false);
    const result = await makeFixture({ planOutput: JSON.stringify({ value: fakeAuth0Secret }) });
    await result.run();
    assert.equal(result.output.text.includes(fakeAuth0Secret), false);
    assert.equal(result.output.text.includes('format_version'), false);
  });

  it('refuses leftover plan artifacts and cleans a temporary plan after malformed plan JSON', async () => {
    const stale = await makeFixture();
    await mkdir(path.join(stale.metadataDirectory, '.aegis-first-apply-stale'), { mode: 0o700 });
    await assert.rejects(stale.run(), /prior private deployment plan artifact/);
    assert.equal(stale.calls.length, 0);

    const malformed = await makeFixture();
    await assert.rejects(malformed.run({ terraform: async (_command, args) => {
      malformed.calls.push({ args });
      if (args[0] === 'plan') {
        await writeFile(args[3].slice('-out='.length), 'private-plan', { mode: 0o600 });
        return { code: 0, stdout: '5 adds', stderr: '' };
      }
      return { code: 0, stdout: '{not-json', stderr: '' };
    } }), /malformed plan JSON/);
    assert.equal(malformed.calls.some(({ args }) => args[0] === 'apply'), false);
    await assert.rejects(lstat(malformed.directories[0]), { code: 'ENOENT' });
  });

  it('keeps the existing Terraform wrapper read-only for apply, destroy, import, state, and unsafe plan arguments', () => {
    const wrapper = path.join(testModuleDirectory, 'terraform-local.mjs');
    for (const denied of ['apply', 'destroy', 'import', 'state', 'plan -out=secret.tfplan', 'init -reconfigure']) {
      const cli = spawnSync(process.execPath, [wrapper, ...denied.split(' ')], {
        encoding: 'utf8', env: { HOME: os.tmpdir() },
      });
      assert.notEqual(cli.status, 0, `${denied} must remain denied by the read-only wrapper`);
      assert.match(cli.stdout + cli.stderr, /unsupported|not allowed|allowlist|refus|unavailable/i);
    }
  });
});
