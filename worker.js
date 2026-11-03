/* =====================================================================
   LISTA DE RESERVAS — servidor en Cloudflare Workers + Durable Objects
   - Un único Durable Object ("Sala") guarda los datos en SQLite,
     valida los cupos de forma atómica y reparte los cambios por WebSocket.
   - El Worker sirve la página (index.html) y reenvía /api y /ws a la Sala.
   ===================================================================== */
import { DurableObject } from "cloudflare:workers";
import PAGINA from "./index.html";   // la app completa, incrustada en el Worker al publicar (regla "Text" en wrangler.toml)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") || url.pathname === "/ws") {
      const sala = env.SALA.get(env.SALA.idFromName("principal"));
      return sala.fetch(request);
    }
    if (url.pathname === "/" || url.pathname === "/index.html")
      return new Response(PAGINA, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    return new Response("No encontrado", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  },
};

/* ---------------------------------------------------------------------
   Utilidades
   --------------------------------------------------------------------- */
class ApiError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const ahora = () => new Date().toISOString();
const texto = (v, max = 200) => { if (v === undefined || v === null) return null; const s = String(v).trim().slice(0, max); return s.length ? s : null; };
const esFecha = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const etiquetaDesdeHora = hora => { const [H, M] = hora.split(":").map(Number); return `${H % 12 || 12}${M ? ":" + String(M).padStart(2, "0") : ""}${H >= 12 ? "PM" : "AM"}`; };
const esHora = v => typeof v === "string" && /^\d{2}:\d{2}(:\d{2})?$/.test(v);
const esColor = v => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);

// Columnas editables por tabla (todo lo demás se ignora)
const COLUMNAS = {
  profesores: ["nombre", "color", "orden", "activo"],
  horarios:   ["etiqueta", "hora", "cupos", "orden", "activo"],
  usuarios:   ["nombre", "programa", "notas", "activo"],
};
const ORDEN = {
  profesores: "ORDER BY orden, created_at",
  horarios:   "ORDER BY orden, hora",
  usuarios:   "ORDER BY nombre COLLATE NOCASE",
  reservas:   "ORDER BY fecha, created_at",
};

/* ---------------------------------------------------------------------
   Durable Object: la "sala" compartida por todos los profesores
   --------------------------------------------------------------------- */
export class Sala extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => this.migrar());
    // Los "ping" de los clientes se responden sin despertar al objeto
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  migrar() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS profesores (
        id TEXT PRIMARY KEY, nombre TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#2563eb',
        orden INTEGER NOT NULL DEFAULT 0, activo INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS horarios (
        id TEXT PRIMARY KEY, etiqueta TEXT NOT NULL, hora TEXT NOT NULL, cupos INTEGER NOT NULL DEFAULT 3,
        orden INTEGER NOT NULL DEFAULT 0, activo INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usuarios (
        id TEXT PRIMARY KEY, nombre TEXT NOT NULL, programa TEXT, notas TEXT,
        activo INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS usuarios_nombre_unico ON usuarios (lower(trim(nombre)));
      CREATE TABLE IF NOT EXISTS reservas (
        id TEXT PRIMARY KEY, fecha TEXT NOT NULL, horario_id TEXT NOT NULL, usuario_id TEXT,
        usuario_nombre TEXT NOT NULL, programa TEXT, guia TEXT, profesor_id TEXT, profesor_nombre TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS reservas_fecha_horario ON reservas (fecha, horario_id);
      CREATE UNIQUE INDEX IF NOT EXISTS reservas_sin_duplicados ON reservas (fecha, horario_id, lower(trim(usuario_nombre)));
    `);
    if (this.contar("profesores") === 0) {
      this.insertar("profesores", { nombre: "Profesor 1", color: "#2563eb", orden: 1 });
      this.insertar("profesores", { nombre: "Profesor 2", color: "#ea580c", orden: 2 });
    }
    if (this.contar("horarios") === 0) {
      this.insertar("horarios", { etiqueta: "1PM", hora: "13:00", cupos: 3, orden: 1 });
      this.insertar("horarios", { etiqueta: "3PM", hora: "15:00", cupos: 3, orden: 2 });
      this.insertar("horarios", { etiqueta: "4PM", hora: "16:00", cupos: 3, orden: 3 });
    }
  }

  /* ---------- helpers SQL ---------- */
  fila(r) { if (!r) return r; const o = { ...r }; if ("activo" in o) o.activo = !!o.activo; return o; }
  contar(tabla, where = "", ...args) { return this.sql.exec(`SELECT count(*) AS n FROM ${tabla} ${where}`, ...args).one().n; }
  listar(tabla, where = "", ...args) { return this.sql.exec(`SELECT * FROM ${tabla} ${where} ${ORDEN[tabla] || ""}`, ...args).toArray().map(r => this.fila(r)); }
  uno(tabla, id) { const r = this.sql.exec(`SELECT * FROM ${tabla} WHERE id = ?`, id).toArray()[0]; return this.fila(r); }
  insertar(tabla, datos) {
    const fila = { id: crypto.randomUUID(), created_at: ahora(), ...datos };
    if (tabla === "reservas") fila.updated_at = fila.created_at;
    if ("activo" in fila) fila.activo = fila.activo ? 1 : 0;
    const cols = Object.keys(fila);
    this.sql.exec(`INSERT INTO ${tabla} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, ...cols.map(c => fila[c]));
    return this.uno(tabla, fila.id);
  }
  modificar(tabla, id, cambios) {
    const c = { ...cambios }; if ("activo" in c) c.activo = c.activo ? 1 : 0;
    if (tabla === "reservas") c.updated_at = ahora();
    const cols = Object.keys(c); if (!cols.length) return this.uno(tabla, id);
    this.sql.exec(`UPDATE ${tabla} SET ${cols.map(k => `${k} = ?`).join(", ")} WHERE id = ?`, ...cols.map(k => c[k]), id);
    return this.uno(tabla, id);
  }

  /* ---------- HTTP ---------- */
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") return this.conectarWS(request);
    try {
      const body = ["POST", "PATCH"].includes(request.method) ? await request.json().catch(() => ({})) : null;
      return json(this.api(request.method, url, body || {}));
    } catch (e) {
      if (e instanceof ApiError) return json({ error: { code: e.code, message: e.message, ...e.extra } }, e.status);
      console.error(e);
      return json({ error: { code: "INTERNO", message: String(e && e.message || e) } }, 500);
    }
  }

  // Toda la lógica es síncrona: el Durable Object atiende una petición a la vez,
  // por eso "contar cupos + insertar" es atómico aunque dos profesores reserven a la vez.
  api(metodo, url, body) {
    const ruta = url.pathname.replace(/^\/api(?=\/|$)/, "");   // "/api/reservas/123" -> "/reservas/123"
    const [, tabla, resto] = ruta.split("/");
    const q = url.searchParams;

    if (tabla === "estado" && metodo === "GET")
      return { profesores: this.listar("profesores"), horarios: this.listar("horarios"), usuarios: this.listar("usuarios") };
    if (tabla === "respaldo" && metodo === "GET")
      return { exportado: ahora(), profesores: this.listar("profesores"), horarios: this.listar("horarios"), usuarios: this.listar("usuarios"), reservas: this.listar("reservas") };

    if (tabla === "reservas") {
      if (metodo === "GET" && !resto) {
        const w = [], a = [];
        if (q.get("desde")) { w.push("fecha >= ?"); a.push(q.get("desde")); }
        if (q.get("hasta")) { w.push("fecha <= ?"); a.push(q.get("hasta")); }
        return this.listar("reservas", w.length ? "WHERE " + w.join(" AND ") : "", ...a);
      }
      if (metodo === "GET" && resto === "contar") {
        if (q.get("antes")) return { count: this.contar("reservas", "WHERE fecha < ?", q.get("antes")) };
        if (q.get("horario_id")) return { count: this.contar("reservas", "WHERE horario_id = ?", q.get("horario_id")) };
        return { count: this.contar("reservas") };
      }
      if (metodo === "POST" && !resto) return this.crearReserva(body);
      if (metodo === "PATCH" && resto) return this.actualizarReserva(resto, body);
      if (metodo === "DELETE" && resto) return this.eliminarReserva(resto);
      if (metodo === "DELETE" && !resto && esFecha(q.get("antes"))) {
        const n = this.contar("reservas", "WHERE fecha < ?", q.get("antes"));
        this.sql.exec("DELETE FROM reservas WHERE fecha < ?", q.get("antes"));
        this.difundir({ t: "cambio", tabla: "reservas", evento: "BULK" });
        return { count: n };
      }
    }

    if (COLUMNAS[tabla]) {
      if (metodo === "POST" && resto === "orden" && tabla === "horarios") {
        (body.ids || []).forEach((id, i) => this.sql.exec("UPDATE horarios SET orden = ? WHERE id = ?", i + 1, id));
        this.difundir({ t: "cambio", tabla, evento: "BULK" });
        return { ok: true };
      }
      if (metodo === "POST" && !resto) return this.crearGenerico(tabla, body);
      if (metodo === "PATCH" && resto) return this.actualizarGenerico(tabla, resto, body);
      if (metodo === "DELETE" && resto) return this.eliminarGenerico(tabla, resto);
    }
    throw new ApiError(404, "NO_ENCONTRADO", "Ruta no válida");
  }

  /* ---------- reservas ---------- */
  validarReserva(fecha, horarioId, nombre, excluirId = null) {
    if (!esFecha(fecha)) throw new ApiError(400, "FECHA_INVALIDA", "Fecha inválida");
    if (!nombre) throw new ApiError(400, "NOMBRE_VACIO", "El nombre del usuario no puede estar vacío");
    const h = this.uno("horarios", horarioId);
    if (!h) throw new ApiError(404, "HORARIO_INEXISTENTE", "El horario ya no existe");
    const ocupados = excluirId
      ? this.contar("reservas", "WHERE fecha = ? AND horario_id = ? AND id <> ?", fecha, horarioId, excluirId)
      : this.contar("reservas", "WHERE fecha = ? AND horario_id = ?", fecha, horarioId);
    if (ocupados >= h.cupos)
      throw new ApiError(409, "HORARIO_LLENO", `HORARIO_LLENO|${h.etiqueta}|${ocupados}|${h.cupos}`, { etiqueta: h.etiqueta, ocupados, cupos: h.cupos });
    const dup = excluirId
      ? this.contar("reservas", "WHERE fecha = ? AND horario_id = ? AND lower(trim(usuario_nombre)) = lower(trim(?)) AND id <> ?", fecha, horarioId, nombre, excluirId)
      : this.contar("reservas", "WHERE fecha = ? AND horario_id = ? AND lower(trim(usuario_nombre)) = lower(trim(?))", fecha, horarioId, nombre);
    if (dup) throw new ApiError(409, "DUPLICADO", "Ese usuario ya tiene una reserva en este horario");
    return h;
  }
  crearReserva(b) {
    const nombre = texto(b.usuario_nombre, 120);
    this.validarReserva(b.fecha, b.horario_id, nombre);
    const fila = this.insertar("reservas", {
      fecha: b.fecha, horario_id: b.horario_id, usuario_id: texto(b.usuario_id, 64), usuario_nombre: nombre,
      programa: texto(b.programa), guia: texto(b.guia), profesor_id: texto(b.profesor_id, 64), profesor_nombre: texto(b.profesor_nombre, 80),
    });
    this.difundir({ t: "cambio", tabla: "reservas", evento: "INSERT", new: fila, old: null });
    return fila;
  }
  actualizarReserva(id, b) {
    const actual = this.uno("reservas", id);
    if (!actual) throw new ApiError(404, "NO_ENCONTRADO", "La reserva ya no existe");
    const fecha = b.fecha ?? actual.fecha, horarioId = b.horario_id ?? actual.horario_id;
    const nombre = b.usuario_nombre !== undefined ? texto(b.usuario_nombre, 120) : actual.usuario_nombre;
    this.validarReserva(fecha, horarioId, nombre, id);
    const cambios = { fecha, horario_id: horarioId, usuario_nombre: nombre };
    if (b.usuario_id !== undefined) cambios.usuario_id = texto(b.usuario_id, 64);
    if (b.programa !== undefined) cambios.programa = texto(b.programa);
    if (b.guia !== undefined) cambios.guia = texto(b.guia);
    const fila = this.modificar("reservas", id, cambios);
    this.difundir({ t: "cambio", tabla: "reservas", evento: "UPDATE", new: fila, old: actual });
    return fila;
  }
  eliminarReserva(id) {
    const actual = this.uno("reservas", id);
    if (!actual) return { ok: true };
    this.sql.exec("DELETE FROM reservas WHERE id = ?", id);
    this.difundir({ t: "cambio", tabla: "reservas", evento: "DELETE", new: null, old: actual });
    return { ok: true };
  }

  /* ---------- horarios / profesores / usuarios ---------- */
  limpiarCampos(tabla, b, esNuevo) {
    const out = {};
    for (const k of COLUMNAS[tabla]) {
      if (b[k] === undefined) continue;
      let v = b[k];
      if (k === "activo") v = !!v;
      else if (k === "cupos") { v = Math.max(1, Math.min(50, parseInt(v, 10) || 1)); }
      else if (k === "orden") { v = parseInt(v, 10) || 0; }
      else if (k === "hora") { if (!esHora(v)) throw new ApiError(400, "HORA_INVALIDA", "Hora inválida"); v = v.slice(0, 5); }
      else if (k === "color") { if (!esColor(v)) throw new ApiError(400, "COLOR_INVALIDO", "Color inválido"); }
      else v = texto(v, k === "notas" ? 500 : 120);
      if ((k === "nombre" || k === "etiqueta") && !v) throw new ApiError(400, "NOMBRE_VACIO", "El nombre no puede estar vacío");
      out[k] = v;
    }
    if (esNuevo) {
      if ((tabla === "profesores" || tabla === "usuarios") && !out.nombre) throw new ApiError(400, "NOMBRE_VACIO", "Falta el nombre");
      if (tabla === "horarios") {
        if (!out.hora || !/^\d{2}:\d{2}$/.test(out.hora)) throw new ApiError(400, "HORA_INVALIDA", "Falta la hora (formato HH:MM)");
        if (!out.etiqueta) out.etiqueta = etiquetaDesdeHora(out.hora);
        if (out.cupos === undefined) out.cupos = 3;
      }
      if (out.activo === undefined) out.activo = true;
      if (out.orden === undefined && tabla !== "usuarios") out.orden = this.contar(tabla) + 1;
    }
    if (tabla === "usuarios" && out.nombre !== undefined) {
      const dup = this.sql.exec("SELECT id FROM usuarios WHERE lower(trim(nombre)) = lower(trim(?))", out.nombre).toArray()[0];
      if (dup && dup.id !== b.__id) throw new ApiError(409, "DUPLICADO", "Ya existe un usuario con ese nombre");
    }
    return out;
  }
  crearGenerico(tabla, b) {
    const fila = this.insertar(tabla, this.limpiarCampos(tabla, b, true));
    this.difundir({ t: "cambio", tabla, evento: "INSERT", new: fila, old: null });
    return fila;
  }
  actualizarGenerico(tabla, id, b) {
    const actual = this.uno(tabla, id);
    if (!actual) throw new ApiError(404, "NO_ENCONTRADO", "El registro ya no existe");
    const cambios = this.limpiarCampos(tabla, { ...b, __id: id }, false);
    if (tabla === "profesores" && cambios.activo === false && actual.activo && this.contar("profesores", "WHERE activo = 1") <= 1)
      throw new ApiError(409, "ULTIMO_PROFESOR", "Debe quedar al menos un profesor activo");
    const fila = this.modificar(tabla, id, cambios);
    if (tabla === "usuarios" && cambios.nombre && cambios.nombre !== actual.nombre) {
      // mantener el nombre actualizado en las reservas futuras
      const hoy = new Date().toISOString().slice(0, 10);
      this.sql.exec("UPDATE reservas SET usuario_nombre = ? WHERE usuario_id = ? AND fecha >= ?", cambios.nombre, id, hoy);
      this.difundir({ t: "cambio", tabla: "reservas", evento: "BULK" });
    }
    if (tabla === "profesores" && cambios.nombre && cambios.nombre !== actual.nombre)
      this.sql.exec("UPDATE reservas SET profesor_nombre = ? WHERE profesor_id = ?", cambios.nombre, id);
    this.difundir({ t: "cambio", tabla, evento: "UPDATE", new: fila, old: actual });
    return fila;
  }
  eliminarGenerico(tabla, id) {
    const actual = this.uno(tabla, id);
    if (!actual) return { ok: true };
    if (tabla === "profesores" && actual.activo && this.contar("profesores", "WHERE activo = 1") <= 1)
      throw new ApiError(409, "ULTIMO_PROFESOR", "Debe quedar al menos un profesor activo");
    if (tabla === "horarios") this.sql.exec("DELETE FROM reservas WHERE horario_id = ?", id);
    if (tabla === "usuarios") this.sql.exec("UPDATE reservas SET usuario_id = NULL WHERE usuario_id = ?", id);
    if (tabla === "profesores") this.sql.exec("UPDATE reservas SET profesor_id = NULL WHERE profesor_id = ?", id);
    this.sql.exec(`DELETE FROM ${tabla} WHERE id = ?`, id);
    this.difundir({ t: "cambio", tabla, evento: "DELETE", new: null, old: actual });
    if (tabla === "horarios") this.difundir({ t: "cambio", tabla: "reservas", evento: "BULK" });
    return { ok: true };
  }

  /* ---------- WebSocket: tiempo real + "quién está reservando" ---------- */
  conectarWS(request) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Se esperaba una conexión WebSocket", { status: 426 });
    const par = new WebSocketPair();
    const [cliente, servidor] = [par[0], par[1]];
    this.ctx.acceptWebSocket(servidor);                  // API de hibernación: no consume mientras nadie habla
    servidor.serializeAttachment({ clientId: null, presencia: null });
    servidor.send(JSON.stringify({ t: "bienvenida", presencias: this.presencias() }));
    return new Response(null, { status: 101, webSocket: cliente });
  }
  webSocketMessage(ws, mensaje) {
    if (typeof mensaje !== "string") return;
    let m; try { m = JSON.parse(mensaje); } catch { return; }
    if (m.t === "presencia" && m.clientId) {
      const p = { clientId: String(m.clientId).slice(0, 40), profesor_id: texto(m.profesor_id, 64), profesor_nombre: texto(m.profesor_nombre, 80),
                  color: esColor(m.color) ? m.color : "#64748b", editando: m.editando && typeof m.editando === "object" ? {
                    fecha: texto(m.editando.fecha, 10), horario_id: texto(m.editando.horario_id, 64), nombre: texto(m.editando.nombre, 80), reserva_id: texto(m.editando.reserva_id, 64),
                  } : null, ts: Date.now() };
      ws.serializeAttachment({ clientId: p.clientId, presencia: p });
      this.difundir({ ...p, t: "presencia" }, ws);
    } else if (m.t === "adios") {
      this.despedir(ws);
    }
  }
  webSocketClose(ws) { this.despedir(ws); }
  webSocketError(ws) { this.despedir(ws); }
  despedir(ws) {
    let a = null; try { a = ws.deserializeAttachment(); } catch {}
    try { ws.serializeAttachment({ clientId: null, presencia: null }); } catch {}
    try { ws.close(1000, "adios"); } catch {}
    if (a && a.clientId) this.difundir({ t: "adios", clientId: a.clientId }, ws);
  }
  presencias() {
    const out = [];
    for (const w of this.ctx.getWebSockets()) { try { const a = w.deserializeAttachment(); if (a && a.presencia) out.push(a.presencia); } catch {} }
    return out;
  }
  difundir(obj, excepto = null) {
    const s = JSON.stringify(obj);
    for (const w of this.ctx.getWebSockets()) { if (w === excepto) continue; try { w.send(s); } catch {} }
  }
}
