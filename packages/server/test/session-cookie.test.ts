import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ensureSession } from '../src/persistence.js';

test('HTTPS proxy mode marks the real session response Secure while local HTTP still works', async () => {
  const previous = process.env.SESSION_COOKIE_SECURE;
  const server = createServer((req, res) => ensureSession(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/api/session`;
    delete process.env.SESSION_COOKIE_SECURE;
    const local = (await fetch(url)).headers.get('set-cookie');
    assert.match(local ?? '', /; HttpOnly; SameSite=Lax;/);
    assert.doesNotMatch(local ?? '', /; Secure(?:;|$)/);
    const token = /mmofps-session=([a-f0-9]{64})/.exec(local ?? '')?.[1];
    assert.ok(token);

    process.env.SESSION_COOKIE_SECURE = '1';
    const proxied = (await fetch(url, { headers: { Cookie: `mmofps-session=${token}` } })).headers.get('set-cookie');
    assert.match(proxied ?? '', /; HttpOnly; SameSite=Lax;/);
    assert.match(proxied ?? '', /; Secure(?:;|$)/);
    assert.match(proxied ?? '', new RegExp(`mmofps-session=${token};`), 'existing identity is retained while its cookie is upgraded');
  } finally {
    if (previous === undefined) delete process.env.SESSION_COOKIE_SECURE;
    else process.env.SESSION_COOKIE_SECURE = previous;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
