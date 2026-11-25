import crypto from 'node:crypto';
import { readSecret as storedSecret, removeSecret as dropStored, storeSecret as store } from './secrets.js';

// Gmail, read-only, via Google OAuth (desktop client + loopback redirect, PKCE).
// The user creates the OAuth client in Google Cloud; its id/secret and the refresh token live in the
// Keychain (see secrets.js). Nothing is ever sent or modified: scope is gmail.readonly.

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
// Gmail search for "waiting on me": narrow on purpose (automatic notifications are the usual noise)
export const buildQuery = ({ days = 3, onlyDirect = true, excludeSenders = [] } = {}) => [
  'in:inbox', `newer_than:${days}d`, '-category:promotions', '-category:social', '-category:forums',
  ...(onlyDirect ? ['-category:updates', 'to:me'] : []),
  ...excludeSenders.map((s) => `-from:${s}`), '(is:unread OR is:starred)',
].join(' ');
const QUERY = buildQuery();
const MAX_THREADS = 25;
const fail = (message, code, status = 502) => Object.assign(new Error(message), { code, status });

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const decode = (data = '') => Buffer.from(data, 'base64url').toString('utf8');
const header = (msg, name) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value || '';
const addressOf = (from) => (/<([^>]+)>/.exec(from)?.[1] || from).trim().toLowerCase();
const nameOf = (from) => (from.replace(/<[^>]*>/, '').replace(/^["'\s]+|["'\s]+$/g, '') || addressOf(from));

const htmlToText = (html) => html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
const bodyOf = (part) => {
  if (!part) return '';
  const parts = part.parts || [];
  const plain = parts.length ? parts.map(bodyOf).filter(Boolean) : [];
  if (part.mimeType === 'text/plain' && part.body?.data) return decode(part.body.data);
  if (part.mimeType === 'text/html' && part.body?.data) return htmlToText(decode(part.body.data));
  if (parts.some((p) => p.mimeType === 'text/plain')) return bodyOf(parts.find((p) => p.mimeType === 'text/plain'));
  return plain.join('\n');
};

export const createGmail = ({ query = () => QUERY, fetchImpl = fetch, readSecret = storedSecret, storeSecret = store, removeSecret = dropStored, now = () => Date.now() } = {}) => {
  let access = null; // { token, until }
  let pending = null; // { state, verifier, redirectUri }

  const client = async () => {
    const c = await readSecret('google-client');
    return c ? { id: c.account, secret: c.password } : null;
  };
  const refreshToken = async () => (await readSecret('google-refresh')) || null;

  const status = async () => {
    const [c, r] = await Promise.all([client(), refreshToken()]);
    return { configured: Boolean(c), linked: Boolean(c && r), email: r?.account || '' };
  };

  const configure = async (id, secret) => {
    const cid = String(id || '').trim();
    const csecret = String(secret || '').trim();
    if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(cid)) throw fail('El Client ID debe terminar en .apps.googleusercontent.com', 'bad_client', 400);
    if (csecret.length < 10) throw fail('Pegá el Client secret', 'bad_client', 400);
    await storeSecret('google-client', csecret, cid);
    access = null;
  };

  const authUrl = async (redirectUri) => {
    const c = await client();
    if (!c) throw fail('Guardá primero el Client ID y el secret de Google.', 'google_not_configured', 409);
    const verifier = b64url(crypto.randomBytes(32));
    pending = { state: b64url(crypto.randomBytes(16)), verifier, redirectUri };
    const q = new URLSearchParams({
      client_id: c.id, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent',
      state: pending.state, code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  };

  const tokenRequest = async (params) => {
    const c = await client();
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, ...params }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw fail(data.error === 'invalid_grant' ? 'Google revocó el acceso: volvé a conectar Gmail.' : `Google rechazó la autorización (${data.error || res.status}).`, 'google_auth', 502);
    return data;
  };

  const finish = async (code, state) => {
    if (!pending || state !== pending.state) throw fail('Respuesta de Google inválida o vencida: reintentá conectar.', 'bad_state', 400);
    const { verifier, redirectUri } = pending;
    pending = null;
    const data = await tokenRequest({ code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code' });
    if (!data.refresh_token) throw fail('Google no devolvió un refresh token: revocá el acceso de devtower en tu cuenta de Google y reintentá.', 'no_refresh', 502);
    access = { token: data.access_token, until: now() + (data.expires_in - 60) * 1000 };
    const me = await api('/profile');
    await storeSecret('google-refresh', data.refresh_token, me.emailAddress);
    return { email: me.emailAddress };
  };

  const accessToken = async () => {
    if (access && access.until > now()) return access.token;
    const r = await refreshToken();
    if (!r || !(await client())) throw fail('Gmail no está conectado.', 'google_not_linked', 503);
    const data = await tokenRequest({ refresh_token: r.password, grant_type: 'refresh_token' });
    access = { token: data.access_token, until: now() + (data.expires_in - 60) * 1000 };
    return access.token;
  };

  const api = async (path, params = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) (Array.isArray(v) ? v : [v]).forEach((x) => q.append(k, x));
    const res = await fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me${path}${q.size ? `?${q}` : ''}`, { headers: { authorization: `Bearer ${await accessToken()}` } });
    if (res.status === 401 || res.status === 403) { access = null; throw fail('Gmail rechazó el acceso: volvé a conectar.', 'google_auth', 502); }
    if (res.status === 429) throw fail('Gmail limitó las consultas. Reintentá en unos minutos.', 'google_rate_limited', 429);
    if (!res.ok) throw fail(`Gmail respondió ${res.status}.`, 'google_failed');
    return res.json();
  };

  // threads whose last message is not mine: they wait for me
  const pendingThreads = async () => {
    const [{ emailAddress: me }, list] = await Promise.all([api('/profile'), api('/threads', { q: query(), maxResults: MAX_THREADS })]);
    const mine = me.toLowerCase();
    const threads = await Promise.all((list.threads || []).map((t) => api(`/threads/${t.id}`, { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] })));
    return threads.map((t) => {
      const last = t.messages[t.messages.length - 1];
      const from = header(last, 'from');
      return { thread: t, last, from, own: addressOf(from) === mine };
    }).filter((x) => !x.own).map(({ thread, last, from }) => ({
      id: `gmail:${thread.id}`, kind: 'email', threadId: thread.id, channel: header(thread.messages[0], 'subject') || '(sin asunto)',
      author: nameOf(from), email: addressOf(from), text: (last.snippet || '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').slice(0, 400),
      ts: new Date(Number(last.internalDate)).toISOString(), unread: thread.messages.some((m) => m.labelIds?.includes('UNREAD')),
      starred: thread.messages.some((m) => m.labelIds?.includes('STARRED')), messages: thread.messages.length,
      permalink: `https://mail.google.com/mail/u/${encodeURIComponent(me)}/#inbox/${thread.id}`,
    })).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  };

  // full text of a thread (for case analysis), capped
  const threadText = async (threadId, cap = 8000) => {
    const t = await api(`/threads/${encodeURIComponent(threadId)}`, { format: 'full' });
    return t.messages.map((m) => `De: ${header(m, 'from')} · ${header(m, 'date')}\n${bodyOf(m.payload).trim()}`).join('\n\n---\n\n').slice(0, cap);
  };

  const unlink = async () => { access = null; await Promise.all([removeSecret('google-refresh'), removeSecret('google-client')]); };

  return { status, configure, authUrl, finish, pending: pendingThreads, threadText, unlink, forget: () => { access = null; } };
};
