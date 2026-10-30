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
const planInputs = Object.freeze({
  connectionId: 'con_synthetic_test',
  apiIdentifier: 'https://aegis-ai.local/api',
  spaName: 'Aegis AI Local SPA',
  auth0Domain: 'example.us.auth0.com',
});

afterEach(async () => {
  await Promise.all([...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
  temporaryDirectories.clear();
});

function validPlanDocument(overrides = {}) {
  const resources = [
    {
      address: 'auth0_resource_server.cases', mode: 'managed', type: 'auth0_resource_server', name: 'cases',
      provider_name: 'registry.terraform.io/auth0/auth0',
      change: {
        actions: ['create'], before: null,
        after: { name: 'Aegis Case API', identifier: planInputs.apiIdentifier, signing_alg: 'RS256', enforce_policies: false },
        after_unknown: { id: true, client_id: true, signing_secret: true },
        before_sensitive: false, after_sensitive: { signing_secret: true }, replace_paths: [],
      },
    },
    ...[
      { address: 'auth0_resource_server_scope.read_cases', type: 'auth0_resource_server_scope', name: 'read_cases', scope: 'read:cases', description: 'Read cases for an authorized tenant membership.' },
      { address: 'auth0_resource_server_scope.write_cases', type: 'auth0_resource_server_scope', name: 'write_cases', scope: 'write:cases', description: 'Create and update cases for an authorized tenant membership.' },
    ].map((resource) => ({
      address: resource.address, mode: 'managed', type: resource.type, name: resource.name,
      provider_name: 'registry.terraform.io/auth0/auth0',
      change: {
        actions: ['create'], before: null,
        after: { scope: resource.scope, description: resource.description, resource_server_identifier: planInputs.apiIdentifier },
        after_unknown: { id: true }, before_sensitive: false, after_sensitive: {}, replace_paths: [],
      },
    })),
    {
      address: 'auth0_client.local_spa', mode: 'managed', type: 'auth0_client', name: 'local_spa',
      provider_name: 'registry.terraform.io/auth0/auth0',
      change: {
        actions: ['create'], before: null,
        after: {
          name: planInputs.spaName, app_type: 'spa', oidc_conformant: true, is_first_party: true,
          grant_types: ['authorization_code'], callbacks: ['http://127.0.0.1:49321/auth/callback'],
          allowed_origins: ['http://127.0.0.1:49321'], web_origins: ['http://127.0.0.1:49321'],
          allowed_logout_urls: ['http://127.0.0.1:49321'],
        },
        after_unknown: { id: true, client_id: true, signing_keys: true },
        before_sensitive: false, after_sensitive: { signing_keys: true }, replace_paths: [],
      },
    },
    {
      address: 'auth0_connection_client.local_spa_database', mode: 'managed', type: 'auth0_connection_client', name: 'local_spa_database',
      provider_name: 'registry.terraform.io/auth0/auth0',
      change: {
        actions: ['create'], before: null,
        after: { connection_id: planInputs.connectionId, client_id: null },
        after_unknown: { client_id: true, id: true }, before_sensitive: false, after_sensitive: {}, replace_paths: [],
      },
    },
  ];
  const configurationExpressionKeys = {
    'auth0_resource_server.cases': ['enforce_policies', 'identifier', 'name', 'signing_alg'],
    'auth0_resource_server_scope.read_cases': ['description', 'resource_server_identifier', 'scope'],
    'auth0_resource_server_scope.write_cases': ['description', 'resource_server_identifier', 'scope'],
    'auth0_client.local_spa': ['allowed_logout_urls', 'allowed_origins', 'app_type', 'callbacks', 'grant_types', 'is_first_party', 'name', 'oidc_conformant', 'web_origins'],
    'auth0_connection_client.local_spa_database': ['client_id', 'connection_id'],
  };
  const configuredResources = expectedResourceAddresses.map((address) => {
    const [type, name] = address.split('.');
    const expressions = Object.fromEntries(configurationExpressionKeys[address].map((key) => [key, {}]));
    if (address === 'auth0_connection_client.local_spa_database') {
      expressions.connection_id = { references: ['var.database_connection_id'] };
      expressions.client_id = { references: ['auth0_client.local_spa.id', 'auth0_client.local_spa'] };
    }
    return {
      address, mode: 'managed', type, name, provider_config_key: 'auth0', expressions,
    };
  });
  return {
    format_version: '1.2', terraform_version: '1.9.8', errored: false, complete: true, applyable: true,
    variables: {
      database_connection_id: { value: planInputs.connectionId },
      auth0_domain: { value: planInputs.auth0Domain },
      api_identifier: { value: planInputs.apiIdentifier },
      spa_name: { value: planInputs.spaName },
    },
    resource_changes: resources, output_changes: {
      audience: { actions: ['create'], before: null, after: planInputs.apiIdentifier, after_unknown: false },
      issuer: { actions: ['create'], before: null, after: `https://${planInputs.auth0Domain}/`, after_unknown: false },
      spa_client_id: { actions: ['create'], before: null, after: null, after_unknown: true },
    },
    configuration: {
      provider_config: {
        auth0: {
          name: 'auth0', full_name: 'registry.terraform.io/auth0/auth0',
          expressions: { domain: { references: ['var.auth0_domain'] } },
        },
      },
      root_module: { resources: configuredResources },
    },
    ...overrides,
  };
}

function validate(document = validPlanDocument(), inputs = planInputs) {
  return validatePlanDocument(document, inputs);
}

function replaceResource(document, address, update) {
  const copy = structuredClone(document);
  const resource = copy.resource_changes.find((item) => item.address === address);
  assert.ok(resource, `fixture includes ${address}`);
  update(resource);
  return copy;
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
    assert.deepEqual(validate(), {
      creates: 5, updates: 0, deletes: 0, addresses: expectedResourceAddresses,
    });
  });

  it('accepts Terraform 1.2 timestamp and absent or empty optional drift fields', () => {
    const timestamped = validPlanDocument({
      timestamp: '2026-10-31T01:23:45Z', action_invocations: [], deferred_changes: [],
      relevant_attributes: [], future_optional_metadata: { origin: 'terraform-1.x' },
    });
    assert.deepEqual(validate(timestamped).creates, 5);
    assert.deepEqual(validate(validPlanDocument({ resource_drift: [] })).creates, 5);
    assert.throws(() => validate(validPlanDocument({ timestamp: 'not-a-timestamp' })), /timestamp|format|unsupported/i);
    assert.throws(() => validate(validPlanDocument({ timestamp: '2026-02-30T01:23:45Z' })), /timestamp|format|unsupported/i);
    assert.throws(() => validate(validPlanDocument({ resource_drift: null })), /drift|structure|unsupported/i);
    assert.throws(() => validate(validPlanDocument({ resource_drift: 'none' })), /drift|structure|unsupported/i);
    assert.throws(() => validate(validPlanDocument({ resource_drift: [{ address: 'auth0_client.foreign' }] })), /drift/i);
  });

  it('validates the exact planned API, scopes, SPA configuration, and database connection association', () => {
    const mutations = [
      ['auth0_resource_server.cases', (resource) => { resource.change.after.identifier = 'https://foreign.example/api'; }],
      ['auth0_resource_server.cases', (resource) => { resource.change.after.signing_alg = 'HS256'; }],
      ['auth0_resource_server.cases', (resource) => { resource.change.after.name = 'Foreign API'; }],
      ['auth0_resource_server_scope.read_cases', (resource) => { resource.change.after.scope = 'admin:cases'; }],
      ['auth0_resource_server_scope.write_cases', (resource) => { resource.change.after.scope = 'delete:cases'; }],
      ['auth0_resource_server_scope.read_cases', (resource) => { resource.change.after.resource_server_identifier = 'https://foreign.example/api'; }],
      ['auth0_resource_server_scope.write_cases', (resource) => { resource.change.after.description = 'Unexpected permission'; }],
      ['auth0_client.local_spa', (resource) => { resource.change.after.name = 'Foreign SPA'; }],
      ['auth0_client.local_spa', (resource) => { resource.change.after.app_type = 'native'; }],
      ['auth0_client.local_spa', (resource) => { resource.change.after.grant_types = ['implicit']; }],
      ['auth0_client.local_spa', (resource) => { resource.change.after.callbacks = ['https://remote.example/callback']; }],
      ['auth0_client.local_spa', (resource) => { resource.change.after.allowed_origins = ['https://remote.example']; }],
      ['auth0_client.local_spa', (resource) => { resource.change.after.web_origins = ['https://remote.example']; }],
      ['auth0_client.local_spa', (resource) => { resource.change.after.allowed_logout_urls = ['https://remote.example']; }],
      ['auth0_client.local_spa', (resource) => { resource.change.after.oidc_conformant = false; }],
      ['auth0_connection_client.local_spa_database', (resource) => { resource.change.after.connection_id = 'con_foreign'; }],
    ];
    for (const [address, update] of mutations) {
      assert.throws(() => validate(replaceResource(validPlanDocument(), address, update)), `${address} mutation must fail validation`);
    }
    assert.doesNotThrow(() => validate(), 'the representative pinned-version plan with computed values is valid');
  });

  it('requires computed dependency fields to be marked unknown and rejects malformed change shapes', () => {
    const missingUnknownMarker = replaceResource(validPlanDocument(), 'auth0_connection_client.local_spa_database', (resource) => {
      delete resource.change.after_unknown.client_id;
    });
    assert.throws(() => validate(missingUnknownMarker));

    const falselyKnownClient = replaceResource(validPlanDocument(), 'auth0_connection_client.local_spa_database', (resource) => {
      resource.change.after.client_id = 'client-foreign';
      resource.change.after_unknown.client_id = false;
    });
    assert.throws(() => validate(falselyKnownClient));

    for (const malformed of [
      replaceResource(validPlanDocument(), 'auth0_resource_server.cases', (resource) => { resource.change = null; }),
      replaceResource(validPlanDocument(), 'auth0_resource_server.cases', (resource) => { resource.change.after = null; }),
      replaceResource(validPlanDocument(), 'auth0_resource_server.cases', (resource) => { resource.change.after = []; }),
      replaceResource(validPlanDocument(), 'auth0_resource_server.cases', (resource) => { resource.change.after_unknown = []; }),
      replaceResource(validPlanDocument(), 'auth0_resource_server.cases', (resource) => { resource.change.replace_paths = [['identifier']]; }),
      replaceResource(validPlanDocument(), 'auth0_resource_server.cases', (resource) => { resource.change.importing = { id: 'foreign' }; }),
    ]) assert.throws(() => validate(malformed));
  });

  it('verifies that the configured connection association references only the intended SPA and database input', () => {
    const noConfiguration = validPlanDocument();
    delete noConfiguration.configuration;
    assert.throws(() => validate(noConfiguration), /configuration|root resources/i);

    const wrongConnectionInput = validPlanDocument();
    wrongConnectionInput.configuration.root_module.resources.at(-1).expressions.connection_id.references = ['var.foreign_connection_id'];
    assert.throws(() => validate(wrongConnectionInput), /associate|connection/i);

    const wrongClientReference = validPlanDocument();
    wrongClientReference.configuration.root_module.resources.at(-1).expressions.client_id.references = ['auth0_client.foreign_spa.id', 'auth0_client.foreign_spa'];
    assert.throws(() => validate(wrongClientReference), /associate|connection/i);

    const extraConfiguredResource = validPlanDocument();
    extraConfiguredResource.configuration.root_module.resources.push({
      address: 'auth0_action.unrelated', mode: 'managed', type: 'auth0_action', name: 'unrelated', expressions: {},
    });
    assert.throws(() => validate(extraConfiguredResource), /root resources/i);

    const provisioner = validPlanDocument();
    provisioner.configuration.root_module.resources.find((resource) => resource.address === 'auth0_client.local_spa')
      .provisioners = [{ type: 'local-exec', expressions: { command: {} } }];
    assert.throws(() => validate(provisioner), /provisioner|configuration/i);

    const extraExpression = validPlanDocument();
    extraExpression.configuration.root_module.resources.find((resource) => resource.address === 'auth0_resource_server.cases')
      .expressions.unrelated = {};
    assert.throws(() => validate(extraExpression), /arguments|configuration/i);

    const aliasedProvider = validPlanDocument();
    aliasedProvider.configuration.provider_config.auth0.alias = 'unapproved';
    assert.throws(() => validate(aliasedProvider), /provider|configuration/i);

    const extraProvider = validPlanDocument();
    extraProvider.configuration.provider_config.foreign = {
      name: 'auth0', full_name: 'registry.terraform.io/auth0/auth0', alias: 'foreign',
      expressions: { domain: { references: ['var.auth0_domain'] } },
    };
    assert.throws(() => validate(extraProvider), /provider|configuration/i);

    const wrongProviderName = validPlanDocument();
    wrongProviderName.configuration.provider_config.auth0.name = 'aws';
    assert.throws(() => validate(wrongProviderName), /provider|configuration/i);

    const wrongProviderType = validPlanDocument();
    wrongProviderType.configuration.provider_config.auth0.full_name = 'registry.terraform.io/hashicorp/aws';
    assert.throws(() => validate(wrongProviderType), /provider|configuration/i);

    const wrongDomainReference = validPlanDocument();
    wrongDomainReference.configuration.provider_config.auth0.expressions.domain.references = ['var.foreign_domain'];
    assert.throws(() => validate(wrongDomainReference), /provider|domain|configuration/i);

    const mixedProviderKeys = validPlanDocument();
    mixedProviderKeys.configuration.root_module.resources[0].provider_config_key = 'auth0.foreign';
    assert.throws(() => validate(mixedProviderKeys), /provider|configuration/i);
  });

  it('rejects unexpected resources, duplicate addresses, update/delete/replace/import actions, and drift', () => {
    const base = validPlanDocument();
    assert.throws(() => validate(validPlanDocument({
      resource_changes: [...base.resource_changes, { ...base.resource_changes[0], address: 'auth0_action.unrelated', type: 'auth0_action', name: 'unrelated' }],
    })), /exactly the five/);
    assert.throws(() => validate(validPlanDocument({
      resource_changes: [...base.resource_changes.slice(0, 4), base.resource_changes[0]],
    })), /resource addresses/);
    for (const actions of [['update'], ['delete'], ['delete', 'create'], ['create', 'delete']]) {
      const resources = base.resource_changes.map((resource, index) => index === 0
        ? { ...resource, change: { ...resource.change, actions } } : resource);
      assert.throws(() => validate(validPlanDocument({ resource_changes: resources })), /unexpected resource action/);
    }
    const imported = base.resource_changes.map((resource, index) => index === 0
      ? { ...resource, change: { ...resource.change, importing: { id: 'foreign-id' } } } : resource);
    assert.throws(() => validate(validPlanDocument({ resource_changes: imported })), /unexpected resource action/);
    const withNewMinorMetadata = replaceResource(validPlanDocument(), 'auth0_resource_server.cases', (resource) => {
      resource.change.future_optional_metadata = { observed: true };
    });
    assert.doesNotThrow(() => validate(withNewMinorMetadata));
    assert.throws(() => validate(validPlanDocument({ resource_drift: [{ address: 'auth0_client.foreign' }] })), /contains drift/);
    assert.throws(() => validate(validPlanDocument({ format_version: '2.0' })), /unsupported/);
  });

  it('rejects stale, incomplete, unknown-provider, nested-module, and output-mutation plans', () => {
    const base = validPlanDocument();
    assert.throws(() => validate(validPlanDocument({ complete: false })), /incomplete/);
    assert.throws(() => validate(validPlanDocument({ applyable: false })), /incomplete/);
    const badProvider = base.resource_changes.map((resource, index) => index === 1
      ? { ...resource, provider_name: 'registry.terraform.io/hashicorp/aws' } : resource);
    assert.throws(() => validate(validPlanDocument({ resource_changes: badProvider })), /unexpected resource action/);
    const nested = base.resource_changes.map((resource, index) => index === 1
      ? { ...resource, module_address: 'module.foreign' } : resource);
    assert.throws(() => validate(validPlanDocument({ resource_changes: nested })), /unexpected resource action/);
    const unexpectedOutput = validPlanDocument();
    unexpectedOutput.output_changes = { other_output: { actions: ['create'] } };
    assert.throws(() => validate(unexpectedOutput), /unexpected output/);
    const wrongAudience = validPlanDocument();
    wrongAudience.output_changes.audience.after = 'https://foreign.example/api';
    assert.throws(() => validate(wrongAudience), /output|value/i);

    const malformedOutputUnknown = validPlanDocument();
    malformedOutputUnknown.output_changes.audience.after_unknown = { identifier: false };
    assert.throws(() => validate(malformedOutputUnknown), /output|value/i);
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
