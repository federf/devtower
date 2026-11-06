# Iniciar y detener devtower

Desde la carpeta del proyecto:

```sh
cd devtower
npm run up       # Inicia en segundo plano; podés cerrar la terminal
npm run down     # Detiene únicamente este servidor
npm run status   # Indica si está iniciado
```

Abrir http://localhost:4317. No requiere dependencias adicionales.

## Autoarranque

```sh
npm run autostart:on    # Instala LaunchAgent: inicia al entrar a la sesión y reinicia si se cae
npm run autostart:off   # Lo desinstala y detiene devtower
```

Instala `~/Library/LaunchAgents/local.devtower.<PORT>.plist` con el `PATH` actual
(para encontrar `claude`, `gh`, `git`). Con autoarranque activo, `down` detiene
hasta el próximo inicio de sesión y `up` la vuelve a levantar vía launchd.
`status` indica `· autoarranque activo`. Si cambiás de versión de Node o de PATH,
repetir `autostart:on`.
El controlador usa Node y las herramientas de macOS `lsof`, `ps` y `pgrep`.

`up` y `down` se pueden repetir: si ya está iniciado/detenido, solo avisan.
No usa un PID fijo ni depende de un PID guardado: consulta el puerto y verifica
el comando y la ruta del servidor antes de detenerlo. Si el puerto pertenece a
otro programa/proyecto, rechaza la operación sin terminar ese proceso.
Reconoce también una instancia de este proyecto arrancada con `npm start`.

Si hay procesos hijos activos (por ejemplo Claude o una consulta de consumo),
`down` no interrumpe esas tareas: esperar a que terminen o detener la respuesta
desde el chat y volver a ejecutar. No hay terminación forzada automática.

Log del arranque en segundo plano: `data/server-4317.log`, ignorado por Git.
Si no puede arrancar, el comando falla e indica ese archivo; no anuncia éxito
sin verificar que el servidor esté escuchando.

`npm start` sigue disponible en primer plano; se detiene con Ctrl+C.
No mezclar ambos modos para crear varias instancias en el mismo puerto.
Si ya corría con `npm start`, `up` no lo cambia de modo: primero Ctrl+C y luego `up`.

Para otro puerto, usar el mismo `PORT` en todos los comandos:

```sh
PORT=4318 npm run up
PORT=4318 npm run status
PORT=4318 npm run down
```

El log de ese caso es `data/server-4318.log`.
Los comandos funcionan también desde cualquier carpeta usando:

```sh
npm --prefix <carpeta de devtower> run up
npm --prefix <carpeta de devtower> run down
```

Las pruebas de `test/service.test.js` usan servidores ficticios y puertos
aleatorios. No llaman a Claude, Slack, Jira ni detienen el servidor real.
