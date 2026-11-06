// Health: master/main status per core repo, my PR metrics and the alerts Hoy shows.
// Relies on window.cockpit exposed by app.js. Data comes from gh (no Claude).
const C = window.cockpit;
const { state, api, esc, ago } = C;

state.health = null;

const loadHealth = async (force = false) => {
  try {
    const data = await (await api(`/api/health${force ? '?refresh=1' : ''}`)).json();
    if (!data.error) state.health = data;
  } catch { /* keep last data */ }
  C.render();
};
C.loadHealth = loadHealth;

const STATE_TAG = { SUCCESS: ['ok', 'verde'], FAILURE: ['bad', 'rojo'], ERROR: ['bad', 'rojo'], PENDING: ['info', 'corriendo'], EXPECTED: ['info', 'corriendo'] };
const stateTag = (st) => { const [cls, label] = STATE_TAG[st] || ['', 'sin checks']; return `<span class="tag ${cls}">${label}</span>`; };

// one line of validations: counts plus links to the failing / running checks
const checkLine = (summary, checks, max = 4) => {
  if (!checks?.length) return '';
  const notable = checks.filter((c) => c.state === 'fail' || c.state === 'run').slice(0, max);
  return `<div class="checks"><span class="cnt" title="Validaciones: pasaron · fallaron · corriendo">✓ ${summary.ok}${summary.fail ? ` <b class="bad">✗ ${summary.fail}</b>` : ''}${summary.run ? ` <b class="info">⟳ ${summary.run}</b>` : ''}</span>
    ${notable.map((c) => `<a class="chk ${c.state}" target="_blank" href="${esc(c.url)}" title="${esc(c.desc || c.name)}">${c.state === 'fail' ? '✗' : '⟳'} ${esc(c.name)}</a>`).join('')}</div>`;
};
C.checkLine = checkLine;

const hours = (h) => (h == null ? '—' : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} d`);

C.renderHealth = () => {
  const h = state.health;
  if (!h) return '<div class="empty">Cargando estado de master y métricas…</div>';
  const m = h.metrics;
  const max = Math.max(1, ...m.weeks);
  const masters = h.master.map((r) => `<div class="hcard ${r.broken ? 'broken' : ''}">
      <div class="t"><a class="lnk" target="_blank" href="${esc(r.url)}">${esc(r.repo.split('/')[1])}</a><span class="tag">${esc(r.branch)}</span>${stateTag(r.head?.state)}</div>
      ${r.head ? `<div class="m"><a class="lnk" target="_blank" href="${esc(r.head.url)}">${esc(r.head.sha)}</a><span class="clip">${esc(r.head.title)}</span><span>@${esc(r.head.author)}</span><span>${ago(r.head.at)}</span></div>` : '<div class="m">Sin commits con checks</div>'}
      ${r.head ? checkLine(r.head.summary, r.head.checks) : ''}
      ${r.broken ? `<div class="m"><span class="why">Rojo hace ${r.redCommits} commit${r.redCommits === 1 ? '' : 's'}${r.lastGreen ? ` · último verde ${esc(r.lastGreen.sha)} ${ago(r.lastGreen.at)}` : ''}</span>
        <button class="btn sm primary" data-act="master-fix" data-repo="${esc(r.repo)}" title="Abre un hilo para que Claude investigue por qué falla ${esc(r.branch)}">Investigar con Claude</button></div>` : ''}
    </div>`).join('');
  const kpi = (v, label, tip = '') => `<div class="kpi static" title="${esc(tip)}"><b>${v}</b><span>${label}</span></div>`;
  return `
    <h3 class="sect-title">Estado de master / main</h3><div class="hgrid">${masters}</div>
    <h3 class="sect-title">Tus PRs · desde ${esc(m.since)}</h3>
    <div class="kpis">
      ${kpi(m.merged, 'mergeados (30 d)', m.sampled < m.merged ? `Las medianas usan los ${m.sampled} más recientes` : '')}
      ${kpi(hours(m.leadHours), 'mediana abrir → merge')}
      ${kpi(hours(m.firstReviewHours), 'mediana 1ª review humana', 'Excluye bots (github-actions, Claude, Codex)')}
      ${kpi(m.medianSize == null ? '—' : Math.round(m.medianSize), 'líneas por PR (mediana)')}
    </div>
    <div class="kpis">
      ${kpi(m.open, 'abiertos')}
      ${kpi(m.openFailing, 'con CI rojo')}
      ${kpi(m.openWaiting, 'esperando 1ª review')}
      ${kpi(`${m.oldestOpenDays} d`, 'el más viejo abierto')}
    </div>
    <div class="weeks" title="PRs mergeados por semana (últimas 4)">${m.weeks.map((n, i) => `<div><i style="height:${Math.round((n / max) * 100)}%"></i><b>${n}</b><span>${i === 3 ? 'esta sem.' : `-${3 - i} sem.`}</span></div>`).join('')}</div>
    <p class="note">Actualizado ${ago(h.fetchedAt)} · se refresca solo cada 5 min.</p>`;
};

// alerts for Hoy: a red master blocks everyone
C.healthAlerts = () => (state.health?.master || []).filter((r) => r.broken).map((r) => ({
  sev: 1, icon: '⛔', at: r.head.at, attrs: `data-repo="${esc(r.repo)}"`,
  title: `${esc(r.repo.split('/')[1])}/${esc(r.branch)} está en rojo`,
  sub: `<span class="why">${r.redCommits} commit${r.redCommits === 1 ? '' : 's'} en rojo · último: ${esc(r.head.title)}</span>${checkLine(r.head.summary, r.head.checks, 2)}`,
  acts: `<button class="btn sm primary" data-act="master-fix" data-repo="${esc(r.repo)}" title="Claude investiga la falla">Investigar con Claude</button>`,
}));

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act="master-fix"]');
  if (!el) return;
  const r = state.health?.master.find((x) => x.repo === el.dataset.repo);
  if (!r?.head) return;
  const failing = r.head.checks.filter((c) => c.state === 'fail').map((c) => `${c.name} (${c.url})`).join(', ');
  C.addContext({ label: `${r.repo.split('/')[1]}/${r.branch} rojo`, text: `La rama ${r.branch} de ${r.repo} está en rojo desde hace ${r.redCommits} commit(s). Último commit ${r.head.sha} "${r.head.title}" de @${r.head.author} (${r.head.url}). Checks fallando: ${failing || 'ver commit'}.${r.lastGreen ? ` Último verde: ${r.lastGreen.sha} (${r.lastGreen.url}).` : ''}` },
    { cwd: C.knownCwds().find((d) => d.endsWith(`/${r.repo.split('/')[1]}`)), draft: `Investigá por qué ${r.branch} está en rojo: mirá los checks que fallan y los commits desde el último verde, identificá el commit culpable y proponé el fix. No hagas push.` });
});

loadHealth();
setInterval(() => loadHealth(), 120_000);
