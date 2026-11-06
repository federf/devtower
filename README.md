# devtower

Tu torre de control como dev: tareas de Jira, PRs y su CI, estado de `master`, pendientes de
Slack e hilos de Claude Code en **una sola pantalla local**, sin abrir diez pestañas.

Corre en tu máquina (`http://localhost:4317`), lee las APIs con tus propios tokens y no manda
datos a ningún servidor propio. La IA (Claude Code) se usa **solo cuando la pedís**.

## Qué hace

| Sección | Qué ves | Qué podés hacer |
|---|---|---|
| **Hoy** | Lo urgente primero: CI rojo, cambios pedidos, conflictos, reviews pendientes, master roto, mensajes sin responder | Abrir un hilo de Claude con el contexto listo |
| **Tareas** | Tu sprint activo como el tablero de Jira (swimlanes y columnas), próximo sprint bajo demanda | Comentar, mover estado, verificar si ya está en prod, cerrar la tarea con comentario y notificación |
| **PRs** | Tus PRs, los que tenés que revisar y sus validaciones (GitHub Actions, Jenkins, etc.) con links | Arreglar CI, comentarios o conflictos con Claude |
| **Master y métricas** | Último commit de `master`/`main` de tus repos y sus checks; métricas de tus PRs de 30 días | Investigar una rama rota |
| **Slack** | DMs, menciones e hilos donde te deben respuesta | Responder (o redactar con Claude) sin salir |
| **Hilos** | Tus conversaciones de Claude Code por proyecto | Continuar, archivar, vincular a un trabajo |
| **⌘K** | Accesos rápidos: vistas, tus links (CI, logs, APM…), tickets | — |
| **🔔** | Lo que espera tu respuesta: Slack, comentarios de Jira, cambios pedidos o CI rojo en tus PRs, reviews pedidas, master roto, hilos de Claude que terminaron. También como notificación de macOS | Ir directo al mensaje, PR o hilo |
| **Clockify** | Timer siempre visible, ▶ por tarea, tus bloques de tiempo frecuentes | Iniciar, pausar, reanudar |

Todo es opcional: si no usás Slack o Jira, esas partes quedan vacías y el resto funciona.

## Requisitos

- Node.js 20 o más (sin dependencias de npm)
- [GitHub CLI](https://cli.github.com) con sesión (`gh auth login`) para PRs y master
- [Claude Code](https://claude.com/claude-code) para las acciones con IA (opcional)
- macOS para el autoarranque (en Linux funciona con `npm start`)

## Instalación

```sh
git clone https://github.com/federf/devtower.git
cd devtower
npm run setup            # pregunta, valida tokens y escribe ~/.config/devtower/config.json
npm run up               # o dejalo con autoarranque desde el setup
open http://localhost:4317
```

Con un preset de tu equipo (links, repos, verificación de deploy):

```sh
npm run setup -- --preset ruta/al/preset-del-equipo.json
```

Un preset es un `config.json` parcial sin datos personales ni tokens; ver `config/example.json`.

## Configuración

`~/.config/devtower/config.json` (o la ruta en `DEVTOWER_CONFIG`). Se puede editar a mano;
reiniciá con `npm run down && npm run up`.

| Clave | Para qué |
|---|---|
| `user.name` | Saludo |
| `reposDir` | Dónde están tus clones (para abrir hilos en el repo correcto) |
| `github.org`, `github.coreRepos` | Búsqueda de PRs por ticket y repos cuyo master se vigila |
| `jira.site`, `jira.email` | Jira Cloud |
| `jira.ticketPattern` | Regex de claves de ticket (detecta tickets en hilos, ramas y PRs) |
| `jira.supportLabels` | Etiquetas de tareas reportadas por clientes: al cerrarlas se pide confirmar validación por impersonate |
| `deployCheck` | Comando que verifica si un PR está en prod (ver abajo) |
| `links` | Accesos de ⌘K: `[{ "name", "url", "icon", "group" }]` |
| `logs.hint` | Cómo debe buscar Claude en tus logs de producción (qué skills o MCP usar) |

### Tokens

Nunca van al repo ni a `config.json`. El setup los guarda en el Llavero de macOS
(`devtower-jira`, `devtower-slack`), en Secret Service en Linux (`secret-tool`) o, si no hay
ninguno, en `~/.config/devtower/secrets.json` con permisos `600`. También se pueden pasar por
entorno: `DEVTOWER_JIRA_TOKEN`, `DEVTOWER_SLACK_TOKEN`.

- **Jira**: API token de https://id.atlassian.com/manage-profile/security/api-tokens
- **Slack**: creá una app desde [`docs/slack-manifest.json`](docs/slack-manifest.json)
  (*Create New App → From an app manifest → JSON*), instalala y usá el *User OAuth Token*.
  Los mensajes se envían como vos y solo cuando tocás **Enviar**.

### Verificación de deploy

`deployCheck.command` es cualquier script tuyo; `{url}` se reemplaza por la URL del PR.
devtower interpreta el código de salida:

| Salida | Significado |
|---|---|
| `0` | El PR está en producción |
| `2` | No está mergeado |
| `3` | Mergeado pero sin tag de release |
| `4` | Tiene tag pero prod tiene una versión anterior |

Si imprime `Primer tag que incluye el PR: X` y `Tag actual en producción: Y`, se muestran.
`deployCheck.repos` limita a qué repos se aplica.

## Uso de IA

Leer, refrescar y navegar nunca llama a Claude. Las acciones con IA (redactar una respuesta,
revisar un PR, investigar el CI) están marcadas y abren un hilo de Claude Code que podés ver y
cortar. Si no tenés token de Jira/Slack, esas fuentes pueden leerse vía los conectores de Claude
(consume cuota).

## Desarrollo

```sh
npm test          # sin red ni Claude: todo se simula
npm start         # en primer plano, con live reload del frontend
```

Más detalle en [`docs/`](docs). Issues y PRs bienvenidos.

## Licencia

[MIT](LICENSE)
