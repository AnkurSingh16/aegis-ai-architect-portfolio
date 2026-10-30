#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const organizationName = 'aegis-ai-portfolio';
const workspaceName = 'aegis-auth0-dev';
const apiBase = 'https://app.terraform.io/api/v2';
const freePlanIdentifiers = new Set(['free', 'free_standard']);
const paidPlanIdentifiers = new Set(['essentials', 'standard', 'premium']);

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
    typeof organization.id !== 'string' ||
    subscription?.type !== 'subscriptions' ||
    subscription?.relationships?.organization?.data?.id !== organization.id ||
    typeof featureSetRelationship?.id !== 'string' ||
    matchingFeatureSets.length !== 1 ||
    featureSet?.type !== 'feature-sets' ||
    typeof organizationAttributes['plan-is-trial'] !== 'boolean' ||
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
  const free =
    organizationAttributes['plan-is-enterprise'] === false &&
    freePlanIdentifiers.has(organizationPlan) &&
    subscriptionAttributes['is-public-free-tier'] === true &&
    subscriptionAttributes['is-self-serve-trial'] === false &&
    featureSetAttributes['is-current'] === true &&
    featureSetAttributes['is-free-tier'] === true &&
    freePlanIdentifiers.has(featurePlan);
  const paid =
    subscriptionAttributes['is-public-free-tier'] === false &&
    subscriptionAttributes['is-self-serve-trial'] === false &&
    featureSetAttributes['is-current'] === true &&
    featureSetAttributes['is-free-tier'] === false &&
    paidPlanIdentifiers.has(organizationPlan) &&
    paidPlanIdentifiers.has(featurePlan);

  if (free && !paid) return 'free';
  if (paid && !free) return 'paid';
  return 'unknown';
}

/**
 * Read-only guard for the HCP Terraform workspace before configuring remote state.
 * Dependencies are injectable so tests can verify fail-closed behavior offline.
 */
export async function verifyHcpConfiguration({ home = os.homedir(), fetchImpl = fetch } = {}) {
  const tokenPath = path.join(home, '.terraform.d', 'credentials.tfrc.json');
  let token;
  try {
    const fileInfo = await stat(tokenPath);
    if (!fileInfo.isFile() || (fileInfo.mode & 0o077) !== 0) throw new Error('permissions');
    const credentials = JSON.parse(await readFile(tokenPath, 'utf8'));
    token = credentials?.credentials?.['app.terraform.io']?.token;
  } catch {
    throw new Error('Terraform CLI credentials are missing, unreadable, or have unsafe permissions. Run `terraform login` in a normal terminal.');
  }
  if (typeof token !== 'string' || token.length < 1) {
    throw new Error('Terraform CLI credentials do not contain an app.terraform.io token. Run `terraform login` in a normal terminal.');
  }

  const get = async (resource) => {
    let response;
    try {
      response = await fetchImpl(`${apiBase}${resource}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.api+json',
        },
        redirect: 'error',
      });
    } catch {
      throw new Error('HCP Terraform read request failed. Check network access and CLI login.');
    }
    if (!response.ok) throw new Error(`HCP Terraform read request failed (HTTP ${response.status}). Check organization access and workspace configuration.`);
    try {
      return await response.json();
    } catch {
      throw new Error('HCP Terraform returned an invalid response.');
    }
  };

  const organization = await get(`/organizations/${encodeURIComponent(organizationName)}`);
  const org = organization?.data;
  if (org?.type !== 'organizations' || org.attributes?.name !== organizationName) {
    throw new Error('The configured HCP Terraform organization could not be verified.');
  }
  const subscription = await get(`/organizations/${encodeURIComponent(organizationName)}/subscription`);
  const plan = classifyHcpPlan(organization, subscription);
  if (plan !== 'free') {
    throw new Error(`The organization subscription is not verified as Free (classification: ${plan}).`);
  }

  const workspaceResponse = await get(`/organizations/${encodeURIComponent(organizationName)}/workspaces/${encodeURIComponent(workspaceName)}`);
  const workspace = workspaceResponse?.data;
  if (workspace?.type !== 'workspaces' || workspace.attributes?.name !== workspaceName) {
    throw new Error('The expected HCP Terraform workspace could not be verified.');
  }
  if (workspace.relationships?.organization?.data?.id !== org.id) {
    throw new Error('The workspace organization does not match the expected organization.');
  }
  if (workspace.attributes?.['execution-mode'] !== 'local') {
    throw new Error('The workspace execution mode must be Local.');
  }
  if (workspace.attributes?.['auto-apply'] !== false) {
    throw new Error('Workspace auto-apply must be disabled.');
  }
  if (!Object.hasOwn(workspace.relationships ?? {}, 'current-state-version') || workspace.relationships['current-state-version']?.data !== null) {
    throw new Error('The workspace must have no current state before remote initialization.');
  }

  return {
    organization: organizationName,
    plan,
    workspace: workspaceName,
    executionMode: 'local',
    autoApply: false,
    stateEmpty: true,
  };
}

async function main() {
  if (process.argv.length !== 2) {
    console.error('Usage: node infra/terraform/auth0/hcp-preflight.mjs');
    process.exitCode = 2;
    return;
  }
  try {
    const metadata = await verifyHcpConfiguration();
    console.log(JSON.stringify(metadata, null, 2));
    console.log('Preflight passed. Review this metadata before running terraform-local.mjs init.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'HCP Terraform preflight failed.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
