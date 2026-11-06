# Gestión de hilos

En **Hilos** hay dos vistas: **Activos** y **Archivados**. Los filtros por fecha,
proyecto y búsqueda se aplican a la vista seleccionada.

Cada proyecto tiene una pestaña con contador de hilos. Se abre inicialmente el
proyecto con actividad más reciente, y se recuerda la pestaña elegida por separado
para Activos y Archivados. **Todos** permite verlos juntos. Proyectos con el mismo
nombre pero distinto directorio no se mezclan: la ruta identifica cada proyecto.
Las flechas izquierda/derecha y Home/End permiten recorrer las pestañas enfocadas.

- **Archivar** conserva el historial original. Oculta el hilo de Hoy, Tareas,
  los resultados activos y el buscador rápido. Permite leerlo desde Archivados.
- **Restaurar** lo devuelve a Activos. Para continuar un hilo archivado primero
  hay que restaurarlo.
- **Borrar** pide confirmación y elimina permanentemente el archivo principal
  `~/.claude/projects/<proyecto>/<id>.jsonl`, además de quitar su entrada del
  índice y la caché de devtower. Cierra sus pestañas en este navegador.
  No borra código, ramas, commits, PRs ni otros artefactos independientes de Claude
  (por ejemplo, historiales de subagentes o copias de seguridad externas).
- Las sesiones ejecutadas por devtower y las que tienen actividad de archivo en los
  últimos 15 segundos no se pueden archivar ni borrar. La actividad de sesiones
  externas se detecta por esa ventana; no equivale a un lock del proceso externo.

El estado persiste en `data/thread-state.json` (ignorado por Git). La escritura es
atómica y las operaciones se serializan. Si el estado está corrupto, la operación
falla sin borrar historiales. El borrado exige `confirm: true` también en el backend.

## API

Todas las mutaciones requieren `x-cockpit: 1` y un Origin local permitido.

- `GET /api/threads?days=14`: `{ threads: [...], archivedThreads: [...] }`.
- `GET /api/search?q=texto&visibility=active|archived`: `{ hits: [...] }`.
- `POST /api/threads/<id>/archive` con `{}`.
- `POST /api/threads/<id>/restore` con `{}`.
- `POST /api/threads/<id>/delete` con `{ "confirm": true }`.

Las mutaciones responden `{ ok: true, id, status: "active|archived|deleted" }`.
Errores: 400 entrada inválida/falta de confirmación, 403 origen/header rechazado,
404 hilo inexistente/eliminado, 409 hilo activo u operación en curso.

## Pruebas

`npm test` ejecuta tests unitarios e integración HTTP con el runner nativo de Node,
sin dependencias. Todos los historiales y el HOME de integración son temporales.
No se invoca Claude, Slack, Jira ni GitHub. Los tests HTTP requieren permiso para
escuchar en localhost. Reiniciar el servidor real después de cambiar el backend.

## Modelo del chat

**Default · Claude Code** no envía `--model`: Claude Code resuelve el modelo según
su configuración, entorno y cuenta. No copia la selección de Claude Desktop ni
promete una versión concreta. La barra de sesión muestra el modelo recibido en
`system/init` de la última ejecución; no se hacen consultas extra para descubrirlo.
Seleccionar Sonnet, Opus u otra opción sí envía explícitamente `--model`.
La versión del CLI instalado también condiciona los modelos disponibles.
