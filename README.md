# 📋 Lista de Reservas — versión Cloudflare

Plataforma de reservas en tiempo real para **dos (o más) profesores**, con cupos limitados por horario.
Esta versión **no usa Supabase**: la página, los datos y el tiempo real viven juntos en
**Cloudflare Workers + Durable Objects**, en el plan gratuito y **sin que nadie tenga que mantener un servidor encendido**.

```
https://reservas.<tu-subdominio>.workers.dev   ←  una sola dirección para todo
```

## Qué hace

| Función | Detalle |
|---|---|
| **Tiempo real** | Si un profesor reserva a "pepito", el otro lo ve al instante. Mientras escribe, el otro ve *"Profesor 2 está reservando a «pepito»"*. |
| **Cupos** | 3 por horario por defecto. Al llegar al máximo el horario se marca **🔒 COMPLETO**, desaparece el botón *+ Reservar* y el formulario abierto del otro profesor se bloquea solo. |
| **Sin carreras** | La comprobación de cupos se hace en el servidor de forma atómica: aunque dos profesores pulsen "Reservar" en el mismo milisegundo, nunca entra un 4.º. |
| **Configurable** | Horarios, etiquetas, cupos, orden, profesores y colores se editan dentro de la app (pestaña *Configuración*) y se aplican en vivo. |
| **Identidad** | Cada profesor solo elige su nombre al entrar (sin contraseña). Se recuerda en el navegador. |
| **Vistas** | Reservas del día (con impresión), vista semanal, directorio de usuarios, exportar CSV / copia JSON, limpiar meses antiguos. |
| **Presencia** | Avatares de quién está en línea; reconexión automática si se corta internet. |

## Estructura del proyecto (sin carpetas, para subirlo fácil a GitHub)

```
worker.js            servidor: API REST (/api/...), WebSocket (/ws), base SQLite, reglas de cupos; también sirve la página
index.html           la aplicación completa (HTML + CSS + JS, un solo archivo)
wrangler.toml        configuración de Cloudflare (nombre, Durable Object, incrustar index.html)
package.json         solo necesita "wrangler" como dependencia de desarrollo
package-lock.json    versiones exactas (opcional pero recomendable)
test/e2e.py          prueba automática con 2 navegadores (42 comprobaciones) — opcional, no hace falta subirla
```

## Publicar en Cloudflare (gratis)

Necesitas una cuenta de Cloudflare (gratuita, sin tarjeta): <https://dash.cloudflare.com/sign-up>.

### Opción A — desde tu computadora (recomendada, ~5 minutos)

1. Instala **Node.js** (LTS) desde <https://nodejs.org> si no lo tienes.
2. Descomprime esta carpeta, abre una terminal dentro de ella y ejecuta:
   ```bash
   npm install
   npx wrangler login      # abre el navegador para autorizar tu cuenta de Cloudflare
   npx wrangler deploy     # publica. Al terminar muestra la URL https://reservas.<subdominio>.workers.dev
   ```
3. La primera vez Cloudflare puede pedirte que registres tu subdominio `*.workers.dev` (un nombre cualquiera). Acéptalo y vuelve a ejecutar `npx wrangler deploy`.
4. Comparte la URL con el otro profesor. ¡Listo!

Para actualizar la app más adelante: vuelve a ejecutar `npx wrangler deploy`. Los datos **no se pierden** al redeplegar.

### Opción B — con un token de API (sin instalar nada en tu PC)

Si prefieres que alguien más lo publique por ti (por ejemplo desde este asistente), crea un token:

1. Cloudflare → *My Profile* → *API Tokens* → **Create Token** → plantilla **"Edit Cloudflare Workers"** → *Continue* → *Create Token*.
2. Copia el token (empieza por una cadena larga) y tu **Account ID** (aparece en *Workers & Pages → Overview*, columna derecha).
3. Quien tenga el token ejecuta:
   ```bash
   CLOUDFLARE_API_TOKEN=xxxxx CLOUDFLARE_ACCOUNT_ID=yyyyy npx wrangler deploy
   ```
   Cuando termines puedes **revocar el token** desde la misma pantalla.

### Opción C — desde GitHub (sin instalar nada)

1. GitHub → **New repository** (por ejemplo `reservas`, privado).
2. **Add file → Upload files** → sube los 5 archivos sueltos: `worker.js`, `index.html`, `wrangler.toml`, `package.json`, `package-lock.json` → *Commit changes*.
3. Cloudflare → *Workers & Pages → Create application → Workers → Import a repository* → elige el repo →
   nombre `reservas`, build command vacío, deploy command `npx wrangler deploy` → **Create and deploy**.
4. Cada cambio que subas al repositorio se publica solo.

## Probar en local

```bash
npm install
npm run dev            # http://localhost:8787  (datos locales en .wrangler/, no se suben a la nube)
python3 test/e2e.py    # opcional: prueba con 2 navegadores (requiere: pip install playwright && playwright install chromium)
```

## Cómo funciona por dentro

- **Worker** (`worker.js`): sirve `index.html` (incrustado al publicar) y reenvía `/api/*` y `/ws` a un único
  **Durable Object** llamado `Sala`.
- **Durable Object `Sala`**: tiene su propia base **SQLite** (tablas `profesores`, `horarios`, `usuarios`, `reservas`).
  Atiende las peticiones **una por una**, por eso "contar cupos + insertar" es atómico y el límite nunca se supera.
  Cada cambio se difunde a todos los navegadores conectados por **WebSocket** (con hibernación: no consume mientras nadie escribe).
- **Reglas del servidor**: máximo `cupos` por horario y fecha (`409 HORARIO_LLENO`), un mismo usuario no puede repetir en el
  mismo horario (`409 DUPLICADO`), no se puede desactivar/eliminar al último profesor (`409 ULTIMO_PROFESOR`).

### API (por si quieres integrarla con otra cosa)

| Método y ruta | Descripción |
|---|---|
| `GET /api/estado` | profesores, horarios y usuarios |
| `GET /api/reservas?desde=AAAA-MM-DD&hasta=AAAA-MM-DD` | reservas en un rango |
| `POST /api/reservas` | crear `{fecha, horario_id, usuario_nombre, programa, guia, profesor_id, profesor_nombre}` |
| `PATCH /api/reservas/:id` · `DELETE /api/reservas/:id` | editar / eliminar |
| `DELETE /api/reservas?antes=AAAA-MM-DD` | limpiar reservas antiguas |
| `POST/PATCH/DELETE /api/{horarios|profesores|usuarios}[/:id]` | configuración |
| `GET /api/respaldo` | copia completa en JSON |
| `WS /ws` | mensajes `cambio`, `presencia`, `bienvenida`, `adios` |

## Límites del plan gratuito (más que suficientes)

100 000 peticiones/día, 100 000 escrituras y 5 millones de lecturas de filas/día, 5 GB de almacenamiento.
Un día intenso de dos profesores usa menos del 1 %. **Nunca se pausa por inactividad** (a diferencia de Supabase Free).

## Seguridad

No hay contraseñas: cualquiera que conozca la URL puede ver y modificar reservas (igual que la versión anterior).
Usa una URL que no sea pública y descarga una **copia de seguridad (JSON)** de vez en cuando desde *Configuración → Datos*.
Si más adelante quieres un PIN de acceso, es un añadido pequeño.
