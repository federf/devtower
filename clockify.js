// Clockify: running timer, start/pause per task, and the user's recurring blocks
// (most repeated non-ticket entries of the last weeks). Writes only on explicit actions.

const API = 'https://api.clockify.me/api/v1';
const HISTORY_DAYS = 28;
const BLOCKS = 8;

const fail = (message, status = 502, code = 'clockify_failed') => Object.assign(new Error(message), { status, code });
const iso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
const hours = (e, now) => (Date.parse(e.timeInterval?.end || new Date(now)) - Date.parse(e.timeInterval?.start)) / 3_600_000;

export const createClockify = ({ readSecret, ticketPattern, fetchImpl = fetch, now = () => Date.now() }) => {
  const TICKET = new RegExp(`\\b(?:${ticketPattern})\\b`);
  let me = null;
  let history = { at: 0, entries: [], tags: [] };

  const call = async (path, { method = 'GET', body } = {}) => {
    const secret = await readSecret('clockify');
    if (!secret) throw fail('Vinculá Clockify en Config', 503, 'token_missing');
    const res = await fetchImpl(`${API}${path}`, {
      method, headers: { 'x-api-key': secret.password, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) throw fail('Clockify rechazó la API key: vinculala de nuevo en Config', 502, 'clockify_auth');
    if (!res.ok) throw fail(`Clockify respondió ${res.status}`);
    return res.status === 204 ? null : res.json();
  };
  const user = async () => (me ??= await call('/user').then((u) => ({ id: u.id, ws: u.activeWorkspace || u.defaultWorkspace })));
  const forget = () => { me = null; history = { at: 0, entries: [], tags: [] }; };

  const loadHistory = async (force = false) => {
    if (!force && now() - history.at < 5 * 60_000) return history;
    const u = await user();
    const since = iso(now() - HISTORY_DAYS * 86_400_000);
    const [entries, tags] = await Promise.all([
      call(`/workspaces/${u.ws}/user/${u.id}/time-entries?start=${since}&page-size=500&hydrated=true`),
      call(`/workspaces/${u.ws}/tags?archived=false&page-size=500`),
    ]);
    history = { at: now(), entries, tags };
    return history;
  };

  const shape = (e) => (e ? {
    id: e.id, description: e.description || '', start: e.timeInterval?.start, end: e.timeInterval?.end || null,
    projectId: e.projectId || '', project: e.project?.name || '', tagIds: e.tagIds || [], tags: (e.tags || []).map((t) => t.name),
    billable: Boolean(e.billable), ticket: TICKET.exec(e.description || '')?.[0] || null,
  } : null);

  // most repeated entries that are not about a ticket, with their usual project and tags
  const recurringBlocks = (entries) => {
    const by = new Map();
    for (const e of entries) {
      if (!e.description || TICKET.test(e.description)) continue;
      const key = `${e.description.trim().toLowerCase()}|${e.projectId || ''}`;
      const b = by.get(key) || { description: e.description.trim(), projectId: e.projectId || '', project: e.project?.name || '', tagIds: e.tagIds || [],
        tags: (e.tags || []).map((t) => t.name), billable: Boolean(e.billable), count: 0, hours: 0, last: e.timeInterval?.start };
      b.count += 1;
      b.hours += hours(e, now());
      by.set(key, b);
    }
    return [...by.values()].filter((b) => b.count >= 2).sort((a, b) => b.count - a.count).slice(0, BLOCKS)
      .map((b, i) => ({ ...b, id: `b${i}`, hours: Math.round(b.hours * 10) / 10 }));
  };

  const status = async () => {
    const u = await user();
    const [running, h] = await Promise.all([call(`/workspaces/${u.ws}/user/${u.id}/time-entries?in-progress=true&hydrated=true`), loadHistory()]);
    const startOfDay = new Date(now()); startOfDay.setHours(0, 0, 0, 0);
    const today = h.entries.filter((e) => Date.parse(e.timeInterval?.start) >= startOfDay.getTime() && e.timeInterval?.end)
      .reduce((sum, e) => sum + hours(e, now()), 0);
    const last = h.entries.find((e) => e.timeInterval?.end);
    return { running: shape(running?.[0]), last: shape(last), todayHours: Math.round(today * 100) / 100, blocks: recurringBlocks(h.entries) };
  };

  const stop = async () => {
    const u = await user();
    try { await call(`/workspaces/${u.ws}/user/${u.id}/time-entries`, { method: 'PATCH', body: { end: iso(now()) } }); }
    catch (e) { if (!/404/.test(e.message)) throw e; } // nothing running
    history.at = 0;
  };

  const start = async ({ description, projectId = '', tagIds = [], billable = false }) => {
    const u = await user();
    const running = await call(`/workspaces/${u.ws}/user/${u.id}/time-entries?in-progress=true`);
    if (running?.length) await stop();
    const entry = await call(`/workspaces/${u.ws}/time-entries`, { method: 'POST', body: {
      start: iso(now()), description: String(description).slice(0, 3000), projectId: projectId || undefined,
      tagIds: tagIds.length ? tagIds : undefined, billable,
    } });
    history.at = 0;
    return shape(entry);
  };

  // a task timer follows the user's own convention: "[KEY]: summary", same project/tags as last time
  const taskEntry = async ({ key, summary, type, labels = [] }) => {
    const h = await loadHistory();
    const previous = h.entries.find((e) => (e.description || '').includes(key));
    if (previous) return { description: previous.description, projectId: previous.projectId || '', tagIds: previous.tagIds || [], billable: Boolean(previous.billable) };
    const ticketEntries = h.entries.filter((e) => TICKET.test(e.description || ''));
    const counts = new Map();
    ticketEntries.forEach((e) => e.projectId && counts.set(e.projectId, (counts.get(e.projectId) || 0) + 1));
    const projectId = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    const wanted = new Set([type, ...labels].filter(Boolean).map((x) => x.toLowerCase()));
    const tagIds = h.tags.filter((t) => wanted.has(t.name.toLowerCase())).map((t) => t.id);
    return { description: `[${key}]: ${summary}`, projectId, tagIds, billable: false };
  };

  return { status, start, stop, taskEntry, forget };
};
