// Settings view: link integrations (tokens are validated by the server and stored outside the
// repo; they never come back to the page) and edit ~/.config/devtower/config.json.
// Relies on window.cockpit exposed by app.js.
const C = window.cockpit;
const { state, api, esc } = C;

state.settings = { data: null, form: null, repos: [], suggest: null, busy: '', msg: null, dirty: false };
const S = state.settings;

const getJson = async (url, body) => {
  const res = await api(url, body);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
};
const load = async () => {
  try {
    S.data = await getJson('/api/settings');
    if (!S.dirty) S.form = structuredClone(S.data.config);
    if (S.form.github.org && !S.repos.length) loadRepos(S.form.github.org);
  } catch (e) { S.msg = { err: true, text: e.message }; }
  C.render();
};
const loadRepos = async (org) => {
  try { S.repos = (await getJson(`/api/settings/repos?org=${encodeURIComponent(org)}`)).repos; } catch { S.repos = []; }
  C.render();
};

// config changes restart the server (autostart) → wait for it and reload the page
const afterRestart = async (mode) => {
  if (mode === 'manual') { S.msg = { text: 'Guardado. Reiniciá devtower (npm run down && npm run up) para aplicarlo.' }; C.render(); return; }
  if (mode !== 'auto') return;
  S.busy = 'Reiniciando devtower con la configuración nueva…';
  C.render();
  await new Promise((r) => setTimeout(r, 1500));
  for (let i = 0; i < 40; i += 1) {
    try { if ((await fetch('/config.js', { cache: 'no-store' })).ok) { location.reload(); return; } } catch { /* still restarting */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  S.busy = '';
  S.msg = { err: true, text: 'devtower no volvió a responder. Probá npm run up.' };
  C.render();
};

const setPath = (obj, path, value) => {
  const keys = path.split('.');
  let o = obj;
  keys.slice(0, -1).forEach((k) => { o = o[k]; });
  o[keys.at(-1)] = value;
};
const field = (path, label, value, { placeholder = '', type = 'text', hint = '' } = {}) => `<label class="sfield"><span>${label}</span>
  <input type="${type}" data-path="${path}" value="${esc(value ?? '')}" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false">${hint ? `<small>${hint}</small>` : ''}</label>`;
const pill = (ok, text) => `<span class="spill ${ok === true ? 'ok' : ok === false ? 'bad' : ''}">${ok === true ? '●' : ok === false ? '○' : '◌'} ${esc(text)}</span>`;
const tokenRow = (name, label, linked, extra = '') => `<div class="stoken">
  <input type="password" id="tok-${name}" placeholder="${linked ? 'Pegá un token nuevo para reemplazarlo' : label}" autocomplete="off">
  <button class="btn sm primary" data-st="link" data-name="${name}">${linked ? 'Reemplazar' : 'Vincular'}</button>
  ${linked ? `<button class="btn sm ghost" data-st="unlink" data-name="${name}">Desvincular</button>` : ''}${extra}</div>`;
// what each integration enables, what it needs and what it does with your data
const ABOUT = {
  github: {
    what: 'Tus PRs y los que te toca revisar, sus validaciones de CI, el estado de master y tus métricas. También encuentra los PRs de cada tarea de Jira.',
    details: ['Usa la sesión de GitHub CLI (<code>gh auth login</code>): devtower no guarda ningún token de GitHub.',
      'Solo lee. No comenta, aprueba ni mergea: esas acciones las hacés vos en GitHub o con Claude cuando lo pedís.',
      'Se actualiza solo cada 5 minutos.'],
  },
  jira: {
    what: 'La sección Tareas: tu sprint como el tablero de Jira, el próximo sprint, comentar, mover estado (también arrastrando), verificar deploy y cerrar tareas.',
    details: ['Necesita el sitio, el email de tu cuenta y un API token personal. Tiene exactamente tus permisos de Jira.',
      'El token se valida antes de guardarse y queda en el llavero del sistema, no en el archivo de config.',
      'Lee cada 5 minutos. Escribe (comentarios, cambios de estado) solo cuando lo confirmás.'],
  },
  slack: {
    what: 'La sección Slack y Hoy: DMs, menciones e hilos de los últimos 7 días donde te deben respuesta, y responderlos sin salir.',
    details: ['Necesita una app de Slack propia (se crea en un minuto con el manifest) y su User OAuth Token.',
      'Permisos: leer conversaciones donde estás, buscar mensajes, y escribir como vos (<code>chat:write</code>).',
      'Nunca envía nada solo: cada mensaje sale cuando tocás Enviar. Claude redacta únicamente si se lo pedís.'],
  },
  clockify: {
    what: 'Registro de horas: iniciar, pausar y cortar el timer de una tarea y usar tus bloques de tiempo recurrentes.',
    details: ['Necesita tu API key personal de Clockify.', 'El timer por tarea está en desarrollo: por ahora solo se vincula la cuenta.'],
  },
  claude: {
    what: 'Las acciones con IA: redactar respuestas y comentarios, revisar PRs, investigar CI o logs, y los hilos de trabajo.',
    details: ['Usa tu instalación de Claude Code y tu cuota.', 'Nunca corre sola: leer, refrescar y navegar no usa IA. Cada acción con IA está marcada y abre un hilo que podés ver y cortar.'],
  },
  general: { what: 'Datos para que devtower funcione en tu máquina.', details: [] },
  deploy: {
    what: 'El botón «¿En prod?» de cada tarea: corre tu script sobre cada PR de la tarea y sus subtareas y te dice si ya está desplegado.',
    details: ['Cualquier script tuyo sirve: devtower le pasa la URL del PR en <code>{url}</code> y lee el código de salida.',
      'Salidas: <code>0</code> en prod · <code>2</code> sin mergear · <code>3</code> mergeado sin tag de release · <code>4</code> tiene tag pero falta deploy.',
      'Si imprime «Primer tag que incluye el PR: X» y «Tag actual en producción: Y», se muestran.',
      'Los PRs de repos que no están en la lista se marcan como «mergeado» sin verificar.'],
  },
  notify: {
    what: 'Te avisa cuando algo espera tu respuesta: mensajes y menciones en Slack, comentarios en tus tareas de Jira, cambios pedidos o CI rojo en tus PRs, reviews pedidas, master roto y hilos de Claude que terminaron.',
    details: ['Revisa cada minuto con consultas livianas. La primera vez solo registra lo existente: no te avisa de lo viejo.',
      'Siempre aparecen en 🔔 (y el número en el título de la pestaña). La notificación de macOS es opcional.',
      'Para que al hacer clic se abra el link, instalá <code>brew install terminal-notifier</code>; sin eso igual llegan.'],
  },
  links: { what: 'Atajos a tus herramientas (CI, logs, APM, docs…). Se abren con ⌘K desde cualquier sección.', details: [] },
};
const about = (key) => {
  const a = ABOUT[key];
  if (!a) return '';
  return `<p class="sabout">${a.what}</p>${a.details.length ? `<details class="sdetails"><summary>Qué necesita y qué hace con tus datos</summary><ul>${a.details.map((x) => `<li>${x}</li>`).join('')}</ul></details>` : ''}`;
};
const card = (title, status, body, key) => `<section class="scard"><header><h3>${title}</h3>${status}</header>${about(key)}${body}</section>`;

const renderSettings = () => {
  if (!S.data || !S.form) { if (!S.loading) { S.loading = true; load(); } return '<div class="empty">Leyendo la configuración…</div>'; }
  const d = S.data;
  const f = S.form;
  const gh = d.github;
  const ghStatus = !gh.installed ? pill(false, 'gh no instalado') : gh.user ? pill(true, `@${gh.user}`) : pill(false, 'sin sesión');
  const orgs = [...new Set([...gh.orgs, f.github.org].filter(Boolean))];
  const repoChoices = [...new Set([...f.github.coreRepos, ...S.repos.slice(0, S.allRepos ? 60 : 8)])];
  const github = card('GitHub', ghStatus, `
    ${!gh.installed ? '<p class="note">Instalá GitHub CLI: <a class="lnk" target="_blank" href="https://cli.github.com">cli.github.com</a></p>' : ''}
    ${gh.installed && !gh.user ? '<p class="note">Iniciá sesión en una terminal con <code>gh auth login</code> y tocá «Verificar».</p>' : ''}
    <label class="sfield"><span>Org</span><small>Donde buscar los PRs de cada ticket</small><select data-path="github.org"><option value="">—</option>${orgs.map((o) => `<option ${o === f.github.org ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>
    <div class="sfield"><span>Repos a vigilar</span><small>Su rama principal aparece en PRs → Master y métricas, y si se rompe te avisa en Hoy</small><div class="schips">${repoChoices.map((r) => `<label class="chip ${f.github.coreRepos.includes(r) ? 'on' : ''}"><input type="checkbox" data-repo="${esc(r)}" ${f.github.coreRepos.includes(r) ? 'checked' : ''}>${esc(r)}</label>`).join('') || '<span class="note">Elegí una org</span>'}
      ${!S.allRepos && S.repos.length > 8 ? `<button class="btn sm ghost" data-st="all-repos">ver todos (${S.repos.length})</button>` : ''}</div></div>
    <div class="acts"><button class="btn sm ghost" data-st="refresh">Verificar</button></div>`, 'github');

  const jira = card('Jira', d.jira.linked ? pill(true, d.jira.user) : d.jira.error ? pill(false, d.jira.error) : pill(null, 'sin vincular'), `
    ${field('jira.site', 'Sitio', f.jira.site, { placeholder: 'https://tu-empresa.atlassian.net' })}
    ${field('jira.email', 'Email de la cuenta', f.jira.email, { placeholder: 'vos@empresa.com' })}
    <p class="note">API token: <a class="lnk" target="_blank" href="https://id.atlassian.com/manage-profile/security/api-tokens">id.atlassian.com → Create API token</a></p>
    ${tokenRow('jira', 'API token de Atlassian', d.jira.linked)}
    ${field('jira.ticketPattern', 'Patrón de clave de ticket (regex)', f.jira.ticketPattern, { hint: 'Cómo reconocer tus tickets (ej. ABC-123) en hilos, ramas y títulos de PR para vincularlos con la tarea' })}
    ${field('jira.supportLabels', 'Etiquetas de tareas reportadas por clientes', f.jira.supportLabels.join(', '), { hint: 'Tareas que reportó un cliente: al cerrarlas devtower te pide confirmar que lo validaste por impersonate' })}
    ${S.suggest ? `<p class="note">Tus proyectos: <b>${esc(S.suggest.projects.join(', ') || '—')}</b> · etiquetas: ${S.suggest.labels.map((l) => `<button class="chip" data-label="${esc(l)}">${esc(l)}</button>`).join(' ') || '—'}</p>` : ''}
    <div class="acts">${d.jira.linked ? '<button class="btn sm ghost" data-st="suggest" title="Sugiere patrón y etiquetas a partir de tus tareas">Detectar desde mis tareas</button>' : ''}</div>`, 'jira');

  const slack = card('Slack', d.slack.linked ? pill(true, `${d.slack.user} · ${d.slack.team}`) : d.slack.error ? pill(false, d.slack.error) : pill(null, 'sin vincular'), `
    ${d.slack.linked ? '' : `<ol class="ssteps"><li><button class="btn sm" data-st="manifest">Copiar manifest</button> y abrí <a class="lnk" target="_blank" href="https://api.slack.com/apps?new_app=1">api.slack.com/apps</a> → <b>From an app manifest</b> → pestaña JSON → pegalo</li>
      <li><b>Install to Workspace</b> y copiá el <b>User OAuth Token</b> (xoxp-…)</li><li>Pegalo acá abajo</li></ol>`}
    ${tokenRow('slack', 'User OAuth Token xoxp-…', d.slack.linked)}
    `, 'slack');

  const clockify = card('Clockify', d.clockify.linked ? pill(true, d.clockify.user) : d.clockify.error ? pill(false, d.clockify.error) : pill(null, 'sin vincular'), `
    <p class="note">API key: <a class="lnk" target="_blank" href="https://app.clockify.me/user/preferences#advanced">Clockify → Preferences → Advanced → API</a></p>
    ${tokenRow('clockify', 'API key de Clockify', d.clockify.linked)}`, 'clockify');

  const claude = card('Claude Code', d.claude.installed ? pill(true, d.claude.version) : pill(false, 'no instalado'),
    d.claude.installed ? '' : '<p class="note">Instalalo desde <a class="lnk" target="_blank" href="https://claude.com/claude-code">claude.com/claude-code</a>.</p>', 'claude');

  const general = card('General', '', `
    ${field('user.name', 'Tu nombre', f.user.name, { hint: 'Para el saludo de Hoy' })}
    ${field('reposDir', 'Carpeta de tus repos', f.reposDir, { placeholder: '~/Projects', hint: 'Donde tenés los clones: los hilos de Claude de un PR o tarea se abren en el repo correcto' })}
    ${field('logs.hint', 'Cómo buscar en tus logs (para Claude)', f.logs.hint, { placeholder: 'Ej: usá la skill X para nginx y la Y para logs de app', hint: 'Se agrega cuando pedís «Logs» en una tarea o PR' })}`, 'general');

  const deploy = card('Verificación de deploy', f.deployCheck.command ? pill(true, 'configurada') : pill(null, 'desactivada'), `
    ${field('deployCheck.command', 'Comando ({url} = URL del PR)', f.deployCheck.command, { placeholder: '~/scripts/is-pr-in-prod.sh {url}', hint: 'Salida: 0 en prod · 2 sin mergear · 3 sin tag · 4 falta deploy' })}
    ${field('deployCheck.repos', 'Repos que verifica (owner/repo, coma)', f.deployCheck.repos.join(', '), { hint: 'Solo repos con releases que tu script entiende' })}`, 'deploy');

  const links = card('Accesos rápidos (⌘K)', `<span class="spill">${f.links.length}</span>`, `
    <div class="slinks">${f.links.map((l, i) => `<div class="slink">
      <input data-link="${i}" data-k="icon" value="${esc(l.icon)}" maxlength="2" class="icon">
      <input data-link="${i}" data-k="name" value="${esc(l.name)}" placeholder="Nombre">
      <input data-link="${i}" data-k="url" value="${esc(l.url)}" placeholder="https://…">
      <input data-link="${i}" data-k="group" value="${esc(l.group)}" placeholder="Grupo" class="group">
      <button class="btn sm ghost" data-st="link-del" data-i="${i}" title="Quitar">✕</button></div>`).join('')}</div>
    <div class="acts"><button class="btn sm" data-st="link-add">+ Agregar acceso</button></div>`, 'links');

  const NOTIFY = [['slack', 'Slack: DMs, menciones y respuestas'], ['jira', 'Jira: comentarios en tus tareas'], ['github', 'PRs: cambios pedidos, comentarios, CI, reviews'],
    ['master', 'Master/main en rojo'], ['claude', 'Hilos de Claude que terminaron'], ['native', 'Notificación de macOS (además de 🔔)']];
  const notify = card('Notificaciones', `<button class="btn sm ghost" data-st="notify-test">Probar</button>`, `
    <div class="schecks">${NOTIFY.map(([k, l]) => `<label class="cf-check"><input type="checkbox" data-notify-pref="${k}" ${f.notify?.[k] !== false ? 'checked' : ''}> ${l}</label>`).join('')}</div>`, 'notify');

  return `<div class="settings-view">
    <div class="sintro"><p>Todo es opcional: vinculá lo que uses y el resto de devtower sigue funcionando. Los datos se leen desde tu máquina con tus propias credenciales; no pasan por ningún servidor de devtower.</p>
      <p class="note">Preferencias en <code>${esc(d.file)}</code> · tokens en el llavero del sistema, nunca en ese archivo.</p></div>
    ${S.msg ? `<div class="banner ${S.msg.err ? 'err' : ''}" role="status">${esc(S.msg.text)}</div>` : ''}
    ${S.busy ? `<div class="banner">${esc(S.busy)}</div>` : ''}
    <h3 class="sect-title">Integraciones</h3><div class="sgrid">${github}${jira}${slack}${clockify}${claude}</div>
    <h3 class="sect-title">Preferencias</h3><div class="sgrid">${general}${deploy}</div><div class="sgrid">${notify}</div>${links}
    <div class="ssave ${S.dirty ? 'on' : ''}"><span>${S.dirty ? 'Hay cambios sin guardar' : 'Sin cambios'}</span>
      <button class="btn ghost" data-st="discard" ${S.dirty ? '' : 'disabled'}>Descartar</button>
      <button class="btn primary" data-st="save" ${S.dirty && !S.busy ? '' : 'disabled'}>Guardar y aplicar</button></div>
  </div>`;
};
C.renderers.settings = renderSettings;

const markDirty = () => {
  S.dirty = true;
  const bar = document.querySelector('.ssave');
  if (bar) { bar.classList.add('on'); bar.querySelector('span').textContent = 'Hay cambios sin guardar'; bar.querySelectorAll('button').forEach((b) => { b.disabled = false; }); }
};

document.addEventListener('input', (e) => {
  const t = e.target;
  if (!S.form || !t.closest?.('.settings-view')) return;
  if (t.dataset.path) {
    const list = ['jira.supportLabels', 'deployCheck.repos'].includes(t.dataset.path);
    setPath(S.form, t.dataset.path, list ? t.value.split(',').map((x) => x.trim()).filter(Boolean) : t.value);
    markDirty();
  } else if (t.dataset.link) { S.form.links[Number(t.dataset.link)][t.dataset.k] = t.value; markDirty(); }
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (!S.form || !t.closest?.('.settings-view')) return;
  if (t.dataset.repo) {
    const set = new Set(S.form.github.coreRepos);
    if (t.checked) set.add(t.dataset.repo); else set.delete(t.dataset.repo);
    S.form.github.coreRepos = [...set];
    markDirty(); C.render();
  } else if (t.dataset.notifyPref) { S.form.notify = { ...(S.form.notify || {}), [t.dataset.notifyPref]: t.checked }; markDirty();
  } else if (t.dataset.path === 'github.org') { S.repos = []; S.form.github.coreRepos = []; markDirty(); loadRepos(t.value); }
});

document.addEventListener('click', async (e) => {
  const b = e.target.closest('.settings-view [data-st], .settings-view [data-label]');
  if (!b) return;
  if (b.dataset.label) {
    const labels = new Set(S.form.jira.supportLabels);
    labels.add(b.dataset.label);
    S.form.jira.supportLabels = [...labels]; markDirty(); C.render(); return;
  }
  const act = b.dataset.st;
  S.msg = null;
  try {
    if (act === 'refresh') { S.data = null; S.loading = false; C.render(); return; }
    if (act === 'notify-test') {
      if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
      if ('Notification' in window && Notification.permission === 'granted') new Notification('devtower · prueba', { body: 'Así te van a llegar los avisos mientras devtower está abierto.', icon: '/devtower.svg' });
      else await getJson('/api/notifications/test', {});
      C.toast('Notificación de prueba enviada'); return;
    }
    if (act === 'all-repos') { S.allRepos = true; C.render(); return; }
    if (act === 'discard') { S.form = structuredClone(S.data.config); S.dirty = false; C.render(); return; }
    if (act === 'link-add') { S.form.links.push({ name: '', url: '', icon: '↗', group: '' }); markDirty(); C.render(); return; }
    if (act === 'link-del') { S.form.links.splice(Number(b.dataset.i), 1); markDirty(); C.render(); return; }
    if (act === 'manifest') {
      const manifest = await (await fetch('/api/settings/slack-manifest')).text();
      await navigator.clipboard.writeText(manifest);
      C.toast('Manifest copiado'); return;
    }
    if (act === 'suggest') {
      S.suggest = await getJson('/api/settings/jira-suggest');
      if (S.form.jira.ticketPattern !== S.suggest.ticketPattern) { S.form.jira.ticketPattern = S.suggest.ticketPattern; markDirty(); }
      C.render(); return;
    }
    if (act === 'save') {
      S.busy = 'Guardando…'; C.render();
      const r = await getJson('/api/settings', S.form);
      Object.assign(S, { busy: '', dirty: false });
      S.form = structuredClone(r.config);
      return afterRestart(r.restart);
    }
    if (act === 'link' || act === 'unlink') {
      const name = b.dataset.name;
      if (act === 'unlink' && !confirm(`¿Desvincular ${name}? Se borra el token del llavero.`)) return;
      const input = document.getElementById(`tok-${name}`);
      S.busy = act === 'link' ? 'Validando el token…' : 'Desvinculando…'; C.render();
      const r = act === 'link'
        ? await getJson('/api/settings/link', { name, token: input?.value || '', site: S.form.jira.site, email: S.form.jira.email })
        : await getJson('/api/settings/unlink', { name });
      S.busy = '';
      S.msg = { text: act === 'link' ? `${name}: vinculado como ${r.user}${r.team ? ` (${r.team})` : ''} · guardado en ${r.where}` : `${name}: desvinculado` };
      S.data = await getJson('/api/settings');
      C.render();
      if (r.restart) afterRestart(r.restart);
    }
  } catch (err) {
    S.busy = '';
    S.msg = { err: true, text: err.message };
    C.render();
  }
});
