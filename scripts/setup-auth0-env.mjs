#!/usr/bin/env node
import { open, unlink } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const target = new URL('../.env.auth0', import.meta.url);

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

if (!stdin.isTTY || !stdout.isTTY) {
  fail('Interactive terminal required. In a normal VS Code Terminal, run: node scripts/setup-auth0-env.mjs');
} else {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const domain = (await readline.question('Auth0 domain (for example tenant.us.auth0.com): ')).trim();
    const clientId = (await readline.question('Management API client ID: ')).trim();
    readline.close();
    if (!/^[a-zA-Z0-9.-]+$/.test(domain) || domain.includes('..') || domain.startsWith('.') || domain.endsWith('.')
      || /[/:@?#]/.test(domain) || !clientId || hasControlCharacter(clientId)) {
      fail('Invalid Auth0 domain or client ID format. No file was created.');
    } else {
      const secret = await readHidden('Management API client secret: ');
      if (!secret || hasControlCharacter(secret)) {
        fail('Invalid client secret format. No file was created.');
      } else {
        const contents = [
          `AUTH0_DOMAIN=${JSON.stringify(domain)}`,
          `AUTH0_CLIENT_ID=${JSON.stringify(clientId)}`,
          `AUTH0_CLIENT_SECRET=${JSON.stringify(secret)}`,
          '',
        ].join('\n');
        let file;
        try {
          file = await open(target, 'wx', 0o600);
          await file.writeFile(contents, { encoding: 'utf8' });
          await file.chmod(0o600);
          console.info('Created ignored .env.auth0 with mode 0600. Secret value was not displayed.');
        } catch (error) {
          if (error?.code === 'EEXIST') {
            fail('.env.auth0 already exists; it was not changed. Back it up and edit it manually if rotation is needed.');
          } else {
            fail('Unable to create .env.auth0 securely. No credential values were displayed.');
          }
          if (file) {
            await file.close();
            try { await unlink(target); } catch { /* Keep the generic setup error. */ }
          }
        } finally {
          if (file) await file.close();
        }
      }
    }
  } catch {
    fail('Setup cancelled or unable to read input. No credential values were displayed.');
  } finally {
    readline.close();
  }
}

async function readHidden(prompt) {
  stdout.write(prompt);
  const chunks = [];
  stdin.setRawMode(true);
  stdin.resume();
  try {
    await new Promise((resolve, reject) => {
      const onData = (chunk) => {
        const character = chunk.toString('utf8');
        if (character === '\r' || character === '\n') {
          stdout.write('\n');
          stdin.off('data', onData);
          resolve();
        } else if (character === '\u0003') {
          stdin.off('data', onData);
          reject(new Error('cancelled'));
        } else if (character === '\u007f' || character === '\b') {
          if (chunks.length) chunks.pop();
        } else if (!hasControlCharacter(character)) {
          chunks.push(character);
        }
      };
      stdin.on('data', onData);
    });
    return chunks.join('');
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}

function hasControlCharacter(value) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}
