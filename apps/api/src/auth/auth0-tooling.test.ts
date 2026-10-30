import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Auth0 local tooling', () => {
  it('refuses setup without a TTY and does not create a credential file', async () => {
    const root = await createTemporaryRoot();
    const helper = path.join(root, 'scripts', 'setup-auth0-env.mjs');
    await mkdir(path.dirname(helper), { recursive: true });
    await copyFile(path.join(repository, 'scripts/setup-auth0-env.mjs'), helper);

    const result = spawnSync(process.execPath, [helper], { encoding: 'utf8', input: '' });

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('Interactive terminal required');
    expect(result.stdout + result.stderr).toContain('node scripts/setup-auth0-env.mjs');
    await expect(readFile(path.join(root, '.env.auth0'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('redacts the synthetic client secret and strips inherited database and Terraform override variables', async () => {
    const root = await createTemporaryRoot();
    const wrapper = await installWrapperFixture(root);
    const secret = 'synthetic-test-secret-42';
    await writeFile(path.join(root, '.env.auth0'), [
      `AUTH0_DOMAIN=${JSON.stringify('example.us.auth0.com')}`,
      `AUTH0_CLIENT_ID=${JSON.stringify('synthetic-client-id')}`,
      `AUTH0_CLIENT_SECRET=${JSON.stringify(secret)}`,
      '',
    ].join('\n'), { mode: 0o600 });
    const result = spawnSync(process.execPath, [wrapper, 'plan'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        TMPDIR: root,
        PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? ''}`,
        DATABASE_URL: 'synthetic-database-url',
        DATABASE_ADMIN_URL: 'synthetic-admin-url',
        TF_CLI_ARGS_plan: '-out=unexpected.tfplan',
        TF_LOG: 'TRACE',
      },
    });

    expect(result.status, [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n')).toBe(0);
    expect(result.stdout.match(/\[REDACTED\]/g)).toHaveLength(2);
    expect(result.stdout + result.stderr).not.toContain(secret);
    expect(result.stdout + result.stderr).not.toContain('synthetic-database-url');
    expect(result.stdout + result.stderr).not.toContain('synthetic-admin-url');
    expect(result.stdout + result.stderr).not.toContain('unexpected.tfplan');
  });

  it.each(['apply', 'destroy', 'state', 'import'])('denies the %s command before invoking Terraform', async (action) => {
    const root = await createTemporaryRoot();
    const wrapper = await installWrapperFixture(root);
    const result = spawnSync(process.execPath, [wrapper, action], { encoding: 'utf8', env: { ...process.env, TMPDIR: root } });

    expect(result.status).toBe(2);
    expect(result.stdout + result.stderr).toContain('intentionally unavailable');
    await expect(readFile(path.join(root, 'terraform-invoked'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not accept caller-supplied Terraform arguments', async () => {
    const root = await createTemporaryRoot();
    const wrapper = await installWrapperFixture(root);
    const result = spawnSync(process.execPath, [wrapper, 'plan', '-out=unexpected.tfplan'], { encoding: 'utf8' });

    expect(result.status).toBe(2);
    expect(result.stdout + result.stderr).toContain('intentionally unavailable');
  });

  it('keeps Auth0 credentials, Terraform variables and state/cache ignored', () => {
    const ignoredPaths = [
      '.env.auth0',
      'infra/terraform/auth0/terraform.tfvars',
      'infra/terraform/auth0/terraform.tfstate',
      'infra/terraform/auth0/terraform.tfstate.backup',
      'infra/terraform/auth0/.terraform/providers/provider',
    ];

    for (const ignoredPath of ignoredPaths) {
      expect(spawnSync('git', ['check-ignore', '-q', ignoredPath], { cwd: repository }).status).toBe(0);
    }
    expect(spawnSync('git', ['check-ignore', '-q', 'infra/terraform/auth0/.terraform.lock.hcl'], { cwd: repository }).status).not.toBe(0);
  });
});

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aegis-auth0-tooling-'));
  temporaryRoots.push(root);
  return root;
}

async function installWrapperFixture(root: string): Promise<string> {
  const wrapper = path.join(root, 'infra', 'terraform', 'auth0', 'terraform-local.mjs');
  const bin = path.join(root, 'bin');
  await mkdir(path.dirname(wrapper), { recursive: true });
  await mkdir(bin, { recursive: true });
  await copyFile(path.join(repository, 'infra/terraform/auth0/terraform-local.mjs'), wrapper);
  await copyFile(path.join(repository, 'infra/terraform/auth0/hcp-preflight.mjs'), path.join(path.dirname(wrapper), 'hcp-preflight.mjs'));
  const fakeTerraform = path.join(bin, 'terraform');
  await writeFile(fakeTerraform, [
    '#!/bin/sh',
    'printf "%s\\n" "$AUTH0_CLIENT_SECRET"',
    'printf "%s\\n" "$AUTH0_CLIENT_SECRET" >&2',
    'printf "%s\\n" "$DATABASE_URL" "$DATABASE_ADMIN_URL" "$TF_CLI_ARGS_plan" "$TF_LOG"',
    'printf "%s\\n" "$1 $2 $3" > "$TMPDIR/terraform-invoked"',
  ].join('\n'));
  await chmod(fakeTerraform, 0o700);
  return wrapper;
}
