# Recarga automática de frontend

Activada por defecto en el servidor local. Guardar archivos de `public/` notifica
al navegador mediante SSE (`/api/dev/events`), sin dependencias ni llamadas a IA.

- CSS: reemplaza la hoja cuando termina de cargar, sin recargar la página ni perder estado.
- JS, HTML e imágenes: recarga la página automáticamente.
- Cambios rápidos se agrupan durante 150 ms.
- Si hay respuestas en curso, borradores, adjuntos/contexto sin enviar, respuestas
  Slack abiertas con texto, operaciones en curso o un modal de confirmación,
  la recarga completa espera. Aparece un aviso con opción manual y confirmación.
- Al quedar sin trabajo pendiente, recarga. Se mantienen pestañas/proyectos ya
  persistidos por la app; el chat vuelve a su estado inicial cerrado.
- SSE reconecta solo. Si cambió la versión durante una desconexión o reinicio del
  servidor, solicita recarga con la misma protección de borradores.

Refrescar manualmente **una vez** tras instalar esta función para cargar su cliente.
Cambios futuros en frontend ya no requieren ese refresco.

`LIVE_RELOAD=0 npm start` desactiva el watcher. Actualmente observa el directorio
plano `public/`; archivos temporales y extensiones ajenas al frontend se ignoran.
No observa historiales ni reinicia backend: cambios de `server.js` todavía requieren
reinicio controlado para no interrumpir ejecuciones Claude.

Pruebas: `npm test` verifica SSE real con archivos temporales y la política de
protección de trabajo pendiente, sin Claude real ni servicios externos.
