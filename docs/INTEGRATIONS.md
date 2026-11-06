# Integraciones

## APIs directas (por defecto)

Con tokens en el Keychain, Jira y Slack se leen y escriben sin Claude ni cuota
(`integrations.js`):

- `devtower-jira`: cuenta = email, password = API token de Atlassian.
- `devtower-slack`: user token `xoxp-` de la app interna "devtower" (scopes de lectura
  + `chat:write`, `im:write`, `reactions:write`).

Refresco de fondo cada 5 min (Jira, Slack, PRs vía `gh`); nunca invoca Claude.
Los botones de actualizar usan la API si hay token.
Slack pendiente = DM cuyo último mensaje no es tuyo, mención sin respuesta tuya
posterior en el hilo, o hilo donde participaste con respuesta ajena posterior.
Últimos 7 días, sin bots, máx. 25 chequeos por tipo.

Escrituras solo por acción explícita: **Enviar** (`POST /api/slack/send`) publica
como vos en el hilo (o en el DM) y oculta el item; comentar/transicionar Jira.
Claude solo para **Redactar con Claude**. Sin token: cada fuente vuelve al modo
Claude de abajo. `DEVTOWER_KEYCHAIN=0` y `DEVTOWER_BACKGROUND=0` lo desactivan (tests).

## Modo Claude (fallback sin token)

Slack y Jira vuelven a usar los conectores de Claude por decisión del usuario.
No requieren credenciales nuevas. APIs directas quedan postergadas.

- Abrir vistas, recargar página y polling solo leen caché local: no arrancan Claude.
- **Consultar Slack**, actualizar Jira y las acciones de redacción/escritura usan
  Claude y consumen cuota. No se reintentan automáticamente al agotar el límite.
- La lectura de Slack habilita solo las cinco herramientas originales de lectura,
  sin prefijos genéricos ni wildcards. Guardar borrador conserva su acción explícita.
- Jira usa `mcp__claude_ai_Atlassian__`, nunca `Atlassian_MCP`.
- El chat sigue cerrado por defecto. Abrirlo no genera una respuesta hasta enviar.

## Límite de uso y errores

`claude-errors.js` valida `is_error`, `api_error_status`, subtype y código de salida.
Una respuesta `subtype: success` puede igualmente ser un límite de uso.

Al agotar cuota: mensaje descriptivo en español y horario de reinicio si Claude
lo informa. No se inventa un horario ni se expone JSON, session IDs o stderr.
Errores síncronos devuelven HTTP429 y `code: claude_usage_limit`, con `resetAt`
cuando está disponible. Rate limiting temporal, falta de saldo, autenticación y
consultas demasiado lentas tienen mensajes distintos.

Las consultas de fuente son async: GET Slack/Jira expone `error`, `errorCode` y
`resetAt`. Se conservan datos/timestamp de la última consulta exitosa. Un fallo
no equivale a "sin pendientes". Un reintento exitoso limpia el aviso.

## Pruebas

`npm test` usa procesos Claude simulados; no ejecuta Claude real ni consume cuota.
Verifica navegación sin IA, límites en Slack/Jira/redacción/acciones/chat, caché
preservada, recuperación y los flujos de archivar/borrar hilos.
