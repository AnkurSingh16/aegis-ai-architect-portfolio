import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import { classifyHcpPlan, verifyHcpConfiguration } from './hcp-preflight.mjs';

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

describe('HCP Terraform read-only preflight', () => {
  it('confirms the intended Free, Local, auto-apply-off empty workspace without returning credentials', async () => {
    const home = await makeHome();
    const result = await verifyHcpConfiguration({ home, fetchImpl: responses() });
    assert.deepEqual(result, {
      organization: 'aegis-ai-portfolio', plan: 'free', workspace: 'aegis-auth0-dev',
      executionMode: 'local', autoApply: false, stateEmpty: true,
    });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(syntheticToken));
  });

  it('fails closed when credentials are missing, malformed, empty or too broadly readable', async () => {
    const missingHome = await mkdtemp(path.join(os.tmpdir(), 'aegis-hcp-missing-'));
    temporaryDirectories.add(missingHome);
    await assert.rejects(verifyHcpConfiguration({ home: missingHome, fetchImpl: responses() }), /credentials are missing/);

    const malformedHome = await makeHome({ content: '{invalid json' });
    await assert.rejects(verifyHcpConfiguration({ home: malformedHome, fetchImpl: responses() }), /credentials are missing/);

    const emptyHome = await makeHome({ content: JSON.stringify({ credentials: { 'app.terraform.io': { token: '' } } }) });
    await assert.rejects(verifyHcpConfiguration({ home: emptyHome, fetchImpl: responses() }), /do not contain.*token/);

    const unsafeHome = await makeHome({ permissions: 0o644 });
    await assert.rejects(verifyHcpConfiguration({ home: unsafeHome, fetchImpl: responses() }), /unsafe permissions/);

    const directoryHome = await mkdtemp(path.join(os.tmpdir(), 'aegis-hcp-directory-'));
    temporaryDirectories.add(directoryHome);
    const directory = path.join(directoryHome, '.terraform.d');
    await mkdir(path.join(directory, 'credentials.tfrc.json'), { recursive: true });
    await assert.rejects(verifyHcpConfiguration({ home: directoryHome, fetchImpl: responses() }), /credentials are missing/);
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

  it('rejects existing or inconclusive state and trusts only an explicitly-null state relationship', async () => {
    const home = await makeHome();
    const populated = { data: { type: 'workspaces', id: 'ws-1', attributes: { name: 'aegis-auth0-dev', 'execution-mode': 'local', 'auto-apply': false }, relationships: { organization: { data: { id: 'org-1' } }, 'current-state-version': { data: { id: 'state-1' } } } } };
    await assert.rejects(verifyHcpConfiguration({ home, fetchImpl: responses({ workspace: populated }) }), /must have no current state/);
    const omitted = { data: { ...populated.data, relationships: { organization: { data: { id: 'org-1' } } } } };
    await assert.rejects(verifyHcpConfiguration({ home, fetchImpl: responses({ workspace: omitted }) }), /must have no current state/);
    const unavailable = { data: { ...populated.data, relationships: { ...populated.data.relationships, 'current-state-version': null } } };
    await assert.rejects(verifyHcpConfiguration({ home, fetchImpl: responses({ workspace: unavailable }) }), /must have no current state/);
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
  writeFileSync(path.join(metadataDirectory, 'terraform.tfstate'), JSON.stringify({ backend: { type: 'cloud' } }), { mode: 0o666 });
}
writeFileSync(${JSON.stringify(captured)}, JSON.stringify({ args, umask: process.umask() & 0o077 }));
`);
    await chmod(terraform, 0o700);

    const credentialDirectory = path.join(temp, '.terraform.d');
    await mkdir(credentialDirectory, { mode: 0o700 });
    await writeFile(path.join(credentialDirectory, 'credentials.tfrc.json'), JSON.stringify({ credentials: { 'app.terraform.io': { token: syntheticToken } } }), { mode: 0o600 });
    const preload = path.join(temp, 'mock-hcp.mjs');
    await writeFile(preload, `
      globalThis.fetch = async (url) => {
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
    const init = spawnSync(process.execPath, ['--import', preload, wrapper, 'init'], { encoding: 'utf8', env });
    assert.equal(init.status, 0, init.stderr);
    const terraformInvocation = JSON.parse(await readFile(captured, 'utf8'));
    assert.deepEqual(terraformInvocation.args, ['init', '-input=false', '-no-color']);
    assert.equal(terraformInvocation.umask, 0o077);
    assert.equal((await stat(projectMetadata)).mode & 0o777, 0o600);
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
});
