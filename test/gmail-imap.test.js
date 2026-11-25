import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createGmailImap, decodeWords, mimeText } from '../gmail-imap.js';

const lit = (s) => `{${Buffer.byteLength(s, 'utf8')}}\r\n${s}`;
const HDR = (from, subject) => `From: ${from}\r\nSubject: ${subject}\r\nDate: Wed, 19 Nov 2026 10:00:00 -0300\r\n\r\n`;
const D = (iso) => `"${new Date(iso).toUTCString().replace(/^\w+, (\d+) (\w+) (\d+) ([\d:]+) GMT/, '$1-$2-$3 $4 +0000')}"`;

const fakeServer = async (handlers) => {
  const log = [];
  const server = net.createServer((s) => {
    s.write('* OK Gimap ready\r\n');
    let buf = '';
    s.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const [tag, ...rest] = line.split(' ');
        const cmd = rest.join(' ');
        log.push(cmd);
        const h = handlers.find(([re]) => re.test(cmd));
        s.write(`${h ? h[1](cmd) : ''}${tag} ${h ? 'OK' : 'BAD'} done\r\n`);
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { log, connect: () => net.connect(server.address().port, '127.0.0.1'), close: () => server.close() };
};
const secrets = new Map();
const deps = (srv) => ({ connect: srv.connect, readSecret: async (n) => secrets.get(n) || null, storeSecret: async (n, password, account) => { secrets.set(n, { account, password }); }, removeSecret: async (n) => { secrets.delete(n); } });

test('imap: decodeWords y mimeText', () => {
  assert.equal(decodeWords('=?UTF-8?B?w4FuZ2Vs?= <a@x.com>'), 'Ángel <a@x.com>');
  assert.equal(decodeWords('=?iso-8859-1?Q?Jos=E9_P=E9rez?='), 'José Pérez');
  const multi = 'Content-Type: multipart/alternative; boundary="b1"\r\n\r\n--b1\r\nContent-Type: text/html\r\n\r\n<p>html</p>\r\n--b1\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nHola =C3=A1\r\n--b1--';
  assert.equal(mimeText(multi), 'Hola á');
  assert.equal(mimeText('Content-Type: text/html\r\n\r\n<div>Hola&nbsp;<b>mundo</b></div>'), 'Hola mundo');
});

test('imap: lista solo hilos que esperan respuesta y nunca escribe', async () => {
  secrets.clear();
  const srv = await fakeServer([
    [/^LOGIN/, () => ''],
    [/^LIST/, () => '* LIST (\\HasNoChildren \\All) "/" "[Gmail]/Todos"\r\n'],
    [/^EXAMINE/, () => '* 3 EXISTS\r\n'],
    [/^LOGOUT/, () => '* BYE\r\n'],
    [/SEARCH X-GM-RAW "in:inbox/, () => '* SEARCH 10 11\r\n'],
    [/SEARCH X-GM-RAW "from:me/, () => '* SEARCH 12\r\n'],
    [/^UID FETCH 10,11 /, () => `* 1 FETCH (UID 10 X-GM-THRID 111 FLAGS () INTERNALDATE ${D('2026-11-19T10:00:00Z')} BODY[HEADER.FIELDS (FROM SUBJECT DATE)] ${lit(HDR('=?UTF-8?B?w4FuZ2Vs?= <angel@x.com>', 'Necesito ayuda'))})\r\n`
      + `* 2 FETCH (UID 11 X-GM-THRID 222 FLAGS (\\Seen) INTERNALDATE ${D('2026-11-19T09:00:00Z')} BODY[HEADER.FIELDS (FROM SUBJECT DATE)] ${lit(HDR('Bo <bo@x.com>', 'Ya respondido'))})\r\n`],
    [/^UID FETCH 12 /, () => `* 3 FETCH (UID 12 X-GM-THRID 222 INTERNALDATE ${D('2026-11-19T09:30:00Z')})\r\n`],
    [/^UID FETCH 10 /, () => `* 1 FETCH (UID 10 BODY[1.MIME] ${lit('Content-Type: text/plain; charset=utf-8\r\n\r\n')} BODY[1]<0> ${lit('Podés mirar el deploy?')})\r\n`],
  ]);
  const imap = createGmailImap(deps(srv));
  await assert.rejects(imap.pending(), { code: 'google_not_linked' });
  await assert.rejects(imap.configure('mal', 'x'), { status: 400 });
  assert.deepEqual(await imap.configure('yo@x.com', 'abcd efgh ijkl mnop'), { email: 'yo@x.com' });
  assert.equal(secrets.get('gmail-imap').password, 'abcdefghijklmnop');
  const items = await imap.pending();
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'gmail:111');
  assert.equal(items[0].author, 'Ángel');
  assert.equal(items[0].channel, 'Necesito ayuda');
  assert.equal(items[0].text, 'Podés mirar el deploy?');
  assert.equal(items[0].unread, true);
  assert.match(items[0].permalink, /#all\/6f$/);
  assert.ok(srv.log.some((c) => /^EXAMINE "\[Gmail\]\/Todos"/.test(c)));
  assert.ok(srv.log.every((c) => !/^(STORE|UID STORE|APPEND|COPY|MOVE|EXPUNGE|SELECT)/.test(c)), 'solo lectura');
  assert.ok(srv.log.filter((c) => /FETCH/.test(c)).every((c) => !/ BODY\[/.test(c.replace(/BODY\[HEADER/g, 'X'))), 'PEEK: no marca como leído');
  srv.close();
});

test('imap: login rechazado da un error claro', async () => {
  const srv = await fakeServer([[/^LOGIN/, () => '']].map(([re]) => [re, () => { throw new Error('x'); }]).slice(0, 0));
  const bad = await fakeServer([]);
  await assert.rejects(createGmailImap(deps(bad)).configure('yo@x.com', 'abcdefghijklmnop'), { code: 'imap_auth' });
  srv.close(); bad.close();
});
