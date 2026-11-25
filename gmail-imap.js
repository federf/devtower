import tls from 'node:tls';
import { buildQuery } from './gmail.js';
import { readSecret as storedSecret, removeSecret as dropStored, storeSecret as store } from './secrets.js';

// Gmail read-only over IMAP with a Google "app password" (no Google Cloud project needed).
// Uses Gmail's IMAP extensions (X-GM-RAW search, X-GM-THRID) and only EXAMINE/PEEK: it never marks
// messages as read and never sends, moves or deletes anything. Same interface as gmail.js.

const HOST = 'imap.gmail.com';
const QUERY = buildQuery();
const MAX_THREADS = 25;
const fail = (message, code, status = 502) => Object.assign(new Error(message), { code, status });

// ------------------------------------------------------------------ text decoding

const charsetDecode = (buf, charset = 'utf-8') => {
  try { return new TextDecoder(String(charset).replace(/["']/g, '').toLowerCase()).decode(buf); } catch { return buf.toString('utf8'); }
};
const qp = (s) => Buffer.from(s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
// RFC 2047 encoded words in headers: =?utf-8?B?...?= / =?iso-8859-1?Q?...?=
export const decodeWords = (value = '') => value.replace(/\r?\n[ \t]+/g, ' ').replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=(\s+(?==\?))?/gi, (_, cs, enc, text) => (
  charsetDecode(enc.toLowerCase() === 'b' ? Buffer.from(text, 'base64') : qp(text.replace(/_/g, ' ')), cs))).trim();
const headerOf = (raw, name) => {
  const m = new RegExp(`^${name}:[ \\t]*((?:.*(?:\\r?\\n[ \\t].*)*))`, 'im').exec(raw);
  return m ? decodeWords(m[1]) : '';
};
const addressOf = (from) => (/<([^>]+)>/.exec(from)?.[1] || from).trim().toLowerCase();
const nameOf = (from) => (from.replace(/<[^>]*>/, '').replace(/^["'\s]+|["'\s]+$/g, '') || addressOf(from));
const htmlToText = (html) => html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();

// body of a (possibly multipart) MIME entity as plain text; raw is a latin1 string
export const mimeText = (raw) => {
  const split = raw.search(/\r?\n\r?\n/);
  const head = split < 0 ? raw : raw.slice(0, split);
  const body = split < 0 ? '' : raw.slice(split).replace(/^\r?\n\r?\n/, '');
  const type = (headerOf(head, 'content-type') || 'text/plain').toLowerCase();
  const boundary = /boundary="?([^";\s]+)"?/i.exec(headerOf(head, 'content-type'))?.[1];
  if (type.startsWith('multipart/') && boundary) {
    const parts = body.split(`--${boundary}`).slice(1).filter((p) => !p.startsWith('--')).map((p) => p.replace(/^\r?\n/, ''));
    const texts = parts.map((p) => ({ p, t: (/^content-type:\s*([^;\r\n]+)/im.exec(p)?.[1] || 'text/plain').toLowerCase() }));
    const pick = texts.find((x) => x.t === 'text/plain') || texts.find((x) => x.t.startsWith('multipart/')) || texts.find((x) => x.t === 'text/html');
    return pick ? mimeText(pick.p) : '';
  }
  if (!type.startsWith('text/')) return '';
  const enc = headerOf(head, 'content-transfer-encoding').toLowerCase();
  const bytes = enc === 'base64' ? Buffer.from(body.replace(/\s/g, ''), 'base64') : enc === 'quoted-printable' ? qp(body) : Buffer.from(body, 'latin1');
  const text = charsetDecode(bytes, /charset="?([^";\s]+)/i.exec(headerOf(head, 'content-type'))?.[1]);
  return type.includes('html') ? htmlToText(text) : text.trim();
};

// ------------------------------------------------------------------ minimal IMAP client

// Index just past the tagged completion line, skipping literals ({n}\r\n + n bytes); -1 while incomplete
const completeAt = (str, tag) => {
  let i = 0;
  while (i < str.length) {
    let eol = str.indexOf('\r\n', i);
    if (eol < 0) return -1;
    const line = str.slice(i, eol);
    const lit = /\{(\d+)\}$/.exec(line);
    if (lit) { i = eol + 2 + Number(lit[1]); if (i > str.length) return -1; continue; }
    if (line.startsWith(`${tag} `)) return eol + 2;
    i = eol + 2;
  }
  return -1;
};

const open = (socket) => {
  let buf = '';
  let waiting = null;
  let n = 0;
  const check = () => {
    if (!waiting) return;
    const end = completeAt(buf, waiting.tag);
    if (end < 0) return;
    const text = buf.slice(0, end);
    buf = buf.slice(end);
    const { tag, resolve, reject } = waiting;
    waiting = null;
    const status = new RegExp(`^${tag} (OK|NO|BAD)(.*)$`, 'm').exec(text.slice(text.lastIndexOf(`${tag} `)));
    if (status?.[1] === 'OK') resolve(text); else reject(Object.assign(fail((status?.[2] || 'error').trim(), 'imap_no'), { raw: text }));
  };
  socket.on('data', (c) => { buf += c.toString('latin1'); check(); });
  socket.on('error', (e) => waiting?.reject(fail(`Conexión con Gmail: ${e.message}`, 'imap_net')));
  socket.on('close', () => waiting?.reject(fail('Gmail cerró la conexión.', 'imap_net')));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(fail('Gmail no respondió.', 'imap_net')), 15_000);
    const poll = () => { if (buf.includes('\r\n')) { clearTimeout(timer); buf = ''; resolve(); } else socket.once('data', () => setImmediate(poll)); };
    poll();
  });
  const cmd = async (text) => {
    await ready;
    const tag = `A${String(++n).padStart(3, '0')}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(fail('Gmail tardó demasiado en responder.', 'imap_net')), 30_000);
      waiting = { tag, resolve: (t) => { clearTimeout(timer); resolve(t); }, reject: (e) => { clearTimeout(timer); reject(e); } };
      socket.write(`${tag} ${text}\r\n`);
    });
  };
  return { cmd, close: () => socket.destroy() };
};

const q = (s) => `"${String(s).replace(/["\\]/g, '')}"`;
const uidsOf = (resp) => (/^\* SEARCH ?(.*)$/m.exec(resp)?.[1] || '').trim().split(/\s+/).filter(Boolean).map(Number);

// each "* n FETCH (...)" block, with its literals extracted
const fetched = (resp) => {
  const out = [];
  const starts = [...resp.matchAll(/^\* \d+ FETCH \(/gm)].map((m) => m.index);
  starts.forEach((s, i) => {
    const block = resp.slice(s, starts[i + 1] ?? resp.length);
    const literals = {};
    let flat = '';
    let pos = 0;
    for (const m of block.matchAll(/(BODY\[[^\]]*\](?:<\d+>)?) \{(\d+)\}\r\n/g)) {
      flat += block.slice(pos, m.index);
      literals[m[1].replace(/<\d+>$/, '')] = block.substr(m.index + m[0].length, Number(m[2]));
      pos = m.index + m[0].length + Number(m[2]);
    }
    flat += block.slice(pos);
    out.push({
      uid: Number(/UID (\d+)/.exec(flat)?.[1]), thrid: /X-GM-THRID (\d+)/.exec(flat)?.[1], flags: /FLAGS \(([^)]*)\)/.exec(flat)?.[1] || '',
      date: Date.parse(/INTERNALDATE "([^"]+)"/.exec(flat)?.[1] || '') || 0, labels: /X-GM-LABELS \((.*?)\)/.exec(flat)?.[1] || '', literals,
    });
  });
  return out;
};

export const createGmailImap = ({ query = () => QUERY, connect = () => tls.connect({ host: HOST, port: 993, servername: HOST }), readSecret = storedSecret, storeSecret = store, removeSecret = dropStored } = {}) => {
  const creds = async () => {
    const s = await readSecret('gmail-imap');
    return s ? { email: s.account, password: s.password } : null;
  };

  // one connection per operation: login → examine All Mail (read-only) → work → close
  const session = async (fn, c) => {
    const imap = open(connect());
    try {
      try { await imap.cmd(`LOGIN ${q(c.email)} ${q(c.password)}`); }
      catch (e) { throw e.code === 'imap_net' ? e : fail('Gmail rechazó el email o la contraseña de aplicación (¿IMAP habilitado y verificación en 2 pasos activa?).', 'imap_auth', 401); }
      const list = await imap.cmd('LIST "" "*"');
      const all = /\(([^)]*\\All[^)]*)\) "[^"]*" "?([^"\r\n]+)"?/.exec(list)?.[2] || '[Gmail]/All Mail';
      await imap.cmd(`EXAMINE ${q(all)}`);
      return await fn(imap);
    } finally { try { await imap.cmd('LOGOUT'); } catch { /* closing */ } imap.close(); }
  };

  const status = async () => {
    const c = await creds();
    return { configured: Boolean(c), linked: Boolean(c), email: c?.email || '', method: 'imap' };
  };

  const configure = async (email, password) => {
    const e = String(email || '').trim();
    const p = String(password || '').replace(/\s+/g, '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw fail('Ingresá tu email de Gmail.', 'bad_email', 400);
    if (p.length < 12) throw fail('La contraseña de aplicación tiene 16 letras (sin espacios).', 'bad_password', 400);
    await session(async () => {}, { email: e, password: p });
    await storeSecret('gmail-imap', p, e);
    return { email: e };
  };

  const pending = async () => {
    const c = await creds();
    if (!c) throw fail('Gmail no está conectado.', 'google_not_linked', 503);
    const me = c.email.toLowerCase();
    return session(async (imap) => {
      const inbox = uidsOf(await imap.cmd(`UID SEARCH X-GM-RAW ${q(query())}`)).slice(-MAX_THREADS * 3);
      if (!inbox.length) return [];
      const metas = fetched(await imap.cmd(`UID FETCH ${inbox.join(',')} (UID X-GM-THRID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])`));
      const sentUids = uidsOf(await imap.cmd(`UID SEARCH X-GM-RAW ${q('from:me newer_than:7d')}`)).slice(-80);
      const sent = sentUids.length ? fetched(await imap.cmd(`UID FETCH ${sentUids.join(',')} (UID X-GM-THRID INTERNALDATE)`)) : [];
      const repliedAt = new Map();
      for (const m of sent) repliedAt.set(m.thrid, Math.max(repliedAt.get(m.thrid) || 0, m.date));

      const threads = new Map();
      for (const m of metas) {
        const t = threads.get(m.thrid) || { thrid: m.thrid, msgs: [] };
        t.msgs.push(m); threads.set(m.thrid, t);
      }
      const waiting = [...threads.values()].map((t) => ({ ...t, last: t.msgs.reduce((a, b) => (b.date > a.date ? b : a)) }))
        .filter((t) => addressOf(headerOf(t.last.literals['BODY[HEADER.FIELDS (FROM SUBJECT DATE)]'] || '', 'from')) !== me && (repliedAt.get(t.thrid) || 0) < t.last.date)
        .sort((a, b) => b.last.date - a.last.date).slice(0, MAX_THREADS);
      if (!waiting.length) return [];

      const snippets = new Map();
      const bodies = fetched(await imap.cmd(`UID FETCH ${waiting.map((t) => t.last.uid).join(',')} (UID BODY.PEEK[1.MIME] BODY.PEEK[1]<0.1500>)`).catch(() => ''));
      for (const b of bodies) {
        const head = b.literals['BODY[1.MIME]'] || '';
        const body = b.literals['BODY[1]'] || '';
        try { snippets.set(b.uid, mimeText(`${head.trimEnd()}\r\n\r\n${body}`).replace(/\s+/g, ' ').slice(0, 400)); } catch { /* no preview */ }
      }
      return waiting.map(({ thrid, msgs, last }) => {
        const h = last.literals['BODY[HEADER.FIELDS (FROM SUBJECT DATE)]'] || '';
        const first = msgs.reduce((a, b) => (b.date < a.date ? b : a));
        const from = headerOf(h, 'from');
        return {
          id: `gmail:${thrid}`, kind: 'email', threadId: thrid, channel: headerOf(first.literals['BODY[HEADER.FIELDS (FROM SUBJECT DATE)]'] || h, 'subject') || '(sin asunto)',
          author: nameOf(from), email: addressOf(from), text: snippets.get(last.uid) || '', ts: new Date(last.date).toISOString(),
          unread: msgs.some((m) => !/\\Seen/.test(m.flags)), starred: msgs.some((m) => /\\Flagged/.test(m.flags)), messages: msgs.length,
          permalink: `https://mail.google.com/mail/u/${encodeURIComponent(c.email)}/#all/${BigInt(thrid).toString(16)}`,
        };
      });
    }, c);
  };

  const threadText = async (threadId, cap = 8000) => {
    const c = await creds();
    if (!c || !/^\d+$/.test(String(threadId))) throw fail('Hilo inválido.', 'bad_thread', 400);
    return session(async (imap) => {
      const uids = uidsOf(await imap.cmd(`UID SEARCH X-GM-THRID ${threadId}`)).slice(-10);
      if (!uids.length) return '';
      const msgs = fetched(await imap.cmd(`UID FETCH ${uids.join(',')} (UID INTERNALDATE BODY.PEEK[]<0.60000>)`));
      return msgs.sort((a, b) => a.date - b.date).map((m) => {
        const raw = m.literals['BODY[]'] || '';
        return `De: ${headerOf(raw, 'from')} · ${headerOf(raw, 'date')}\n${mimeText(raw)}`;
      }).join('\n\n---\n\n').slice(0, cap);
    }, c);
  };

  return { status, configure, pending, threadText, unlink: () => removeSecret('gmail-imap'), forget: () => {} };
};
