import test from 'node:test';
import assert from 'node:assert/strict';
import { createGmail } from '../gmail.js';

const secrets = new Map();
const deps = (routes) => ({
  readSecret: async (n) => secrets.get(n) || null,
  storeSecret: async (n, password, account) => { secrets.set(n, { account, password }); },
  removeSecret: async (n) => { secrets.delete(n); },
  fetchImpl: async (url, init) => {
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    if (!hit) throw new Error(`unexpected ${url}`);
    return { ok: true, status: 200, json: async () => hit[1](url, init) };
  },
});
const msg = (from, snippet, labels = []) => ({ internalDate: '1763500000000', snippet, labelIds: labels, payload: { headers: [{ name: 'From', value: from }, { name: 'Subject', value: 'Asunto' }] } });

test('gmail: OAuth con PKCE guarda refresh token y lista solo hilos que esperan respuesta', async () => {
  secrets.clear();
  const gmail = createGmail(deps({
    'oauth2.googleapis.com/token': () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
    '/profile': () => ({ emailAddress: 'yo@x.com' }),
    '/threads/t1': () => ({ id: 't1', messages: [msg('Ana <ana@x.com>', 'Podés mirar esto?', ['UNREAD'])] }),
    '/threads/t2': () => ({ id: 't2', messages: [msg('Ana <ana@x.com>', 'hola'), msg('Yo <yo@x.com>', 'listo')] }),
    '/threads?': () => ({ threads: [{ id: 't1' }, { id: 't2' }] }),
  }));
  await assert.rejects(gmail.authUrl('http://127.0.0.1:1/cb'), { code: 'google_not_configured' });
  await assert.rejects(gmail.configure('malo', 'x'), { status: 400 });
  await gmail.configure('abc.apps.googleusercontent.com', 'secretsecret');
  const url = new URL(await gmail.authUrl('http://127.0.0.1:1/cb'));
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  await assert.rejects(gmail.finish('code', 'otro-state'), { code: 'bad_state' });
  assert.deepEqual(await gmail.finish('code', url.searchParams.get('state')), { email: 'yo@x.com' });
  assert.deepEqual(await gmail.status(), { configured: true, linked: true, email: 'yo@x.com' });
  const items = await gmail.pending();
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'gmail:t1');
  assert.equal(items[0].author, 'Ana');
  assert.equal(items[0].unread, true);
  await gmail.unlink();
  assert.equal((await gmail.status()).linked, false);
});
