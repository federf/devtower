# Trabajos locales

Un trabajo reúne un objetivo, varios proyectos, enlaces y conversaciones sin
crear tickets ni llamar a IA. **Tareas** sigue siendo Jira; **Trabajos** es la
organización personal local.

## Uso

- En Hilos o en la barra de una conversación: **◇ Trabajo**.
- Elegir crear uno nuevo o vincular el hilo a un trabajo existente.
- Editar título, proyectos (una ruta o nombre por línea), próximo paso, dónde
  quedé y enlaces http/https (uno por línea).
- Elegir más hilos en el formulario: al marcarlos se agrega su proyecto.
  Las opciones incluyen los hilos del rango actual y los ya vinculados.
- En **Trabajos** (⌥G): buscar en todos los campos, editar o abrir un hilo.
  El filtro temporal de Hilos no limita los trabajos guardados.
- **Nuevo trabajo** permite empezar sin conversación asociada.

Guardar, buscar y abrir un historial no consume IA. No se envían notas al chat
ni se ejecutan prompts automáticamente. Se sugieren los enlaces de tickets/PRs
ya detectados en el hilo; los enlaces son referencias, no sincronizaciones.

## Persistencia y seguridad

`data/work-items.json` es local al servidor, ignorado por Git. No depende del
localStorage del navegador y sobrevive recargas y reinicios. No sincroniza entre
computadoras. No guardar secretos en notas ni enlaces.

Las escrituras son atómicas y serializadas por el servidor. Cada trabajo tiene
`revision`; editar una versión anterior devuelve 409, conserva el formulario y
no pisa cambios de otra pestaña. Copiar lo propio y reabrir permite reconciliarlo.
Archivo corrupto: falla sin sobrescribir los trabajos existentes.

Se conserva una referencia mínima de cada hilo (id, título, cwd, proyecto), no
una copia del transcript. Archivar/borrar un hilo no elimina notas ni revive su
historial. Los vínculos eliminados se muestran deshabilitados; los archivados se
abren para lectura y requieren restauración antes de continuar. Los hilos quitados
externamente se detectan al intentar abrirlos. Desvincular un hilo no lo borra.

El formulario vive en un dialog fuera del contenido que actualiza el polling;
no pierde campos al actualizar datos. Live reload espera mientras está abierto.
Cancelar con ediciones pide confirmación. Esta primera versión no incluye estados,
archivado/borrado de trabajos, recetas ni resúmenes automáticos.

## API

- `GET /api/work-items` → `{ items: [...] }`, ordenados por última edición.
  Referencias incluyen `status: active|archived|deleted` según estado de hilos.
- `POST /api/work-items` → 201 `{ item: {...} }`.
- `POST /api/work-items/<id>` → 200 `{ item: {...} }`, requiere `revision` actual.

Escritura: `x-cockpit: 1` y Origin local permitido, igual que otras mutaciones.
Campos: `title` (obligatorio, 200), `projects` (20 strings), `links` (30 URLs),
`notes` (20000), `nextStep` (2000), `threadIds` (30 ids de hilos existentes).
Todos los campos se envían; listas y textos pueden estar vacíos salvo el título.
En edición se conservan referencias previas aunque su historial haya sido borrado.
URLs solo http/https sin credenciales; no se descargan ni se ejecutan en servidor.

Errores: 400 validación, 403 origen/header, 404 trabajo/hilo nuevo no encontrado,
409 revisión desactualizada, 500 lectura/escritura fallida. Todas las respuestas
son JSON; nunca se invoca Claude desde estos endpoints.

`npm test`: fixtures temporales; sin Claude ni conectores reales. Además se verificó
visualmente crear desde hilo, reunir proyectos, persistir al recargar, editar,
rechazar enlaces inseguros sin perder texto y vincular a trabajo existente.
