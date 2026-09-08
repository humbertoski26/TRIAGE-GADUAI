/**
 * TRIAGE GADUAI · backend real
 * ----------------------------
 * API REST + Postgres para que el Timeline, los usuarios y los documentos de TRIAGE GADUAI
 * se sincronicen de verdad entre distintos computadores/celulares de un mismo colegio (y
 * entre colegios distintos, cada uno con su propio espacio).
 *
 * Autenticación: MVP simple por correo+clave verificados en cada escritura (sin sesiones ni
 * hashing todavía — ver README "Seguridad pendiente" antes de vender esto a un colegio real).
 */
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Pool } = require("pg");
const { enviarCorreo } = require("./email");

const PORT = process.env.PORT || 3000;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("Falta la variable de entorno DATABASE_URL");
  process.exit(1);
}
// Clave compartida con el panel de administrador de GADUAI: solo ese backend puede crear
// colegios nuevos o buscar la lista de colegios. Sin esto, cualquiera con el link público
// podía activar colegios "fantasma" con clave maestra fija — ver README.
const ADMIN_SETUP_KEY = process.env.ADMIN_SETUP_KEY;
if (!ADMIN_SETUP_KEY) {
  console.error("Falta la variable de entorno ADMIN_SETUP_KEY");
  process.exit(1);
}
function requireAdminKey(req, res, next) {
  if (req.header("X-Admin-Key") !== ADMIN_SETUP_KEY) {
    return res.status(403).json({ error: "no_autorizado" });
  }
  next();
}
// Para rutas disparadas por un Cron Job (no por una persona) — mismo patrón que
// X-Tasks-Secret en Relacionai. A diferencia de ADMIN_SETUP_KEY, no se exige al arrancar:
// si no está configurada, la ruta protegida simplemente responde 403 siempre (no rompe
// despliegues que todavía no la necesitan).
const TASKS_SECRET = process.env.TASKS_SECRET;
function requireTasksSecret(req, res, next) {
  if (!TASKS_SECRET || req.header("X-Tasks-Secret") !== TASKS_SECRET) {
    return res.status(403).json({ error: "no_autorizado" });
  }
  next();
}
// Nombre de perfil usado por Relacionai al avisar sobre relatos (aviso automático cruzado).
const PERFIL_CONVIVENCIA = "Encargado de Convivencia Educativa";
// En un despliegue dedicado a un solo colegio (ej. gaduai-nuevo-rumbo), esto evita depender
// de que el link exacto con ?colegio=<id> se haya guardado tal cual — un ícono instalado a
// medias, un bookmark viejo, o abrir solo el dominio, igual cae en el colegio correcto.
// Vacío/ausente en el despliegue compartido (varios colegios), donde sí hace falta el parámetro.
const DEFAULT_COLEGIO_ID = process.env.DEFAULT_COLEGIO_ID || null;
function claveAleatoria() {
  return crypto.randomBytes(6).toString("base64url"); // ej. "aB3xQ9-k" — legible y suficiente para un MVP
}
const pool = new Pool({
  connectionString,
  ssl: connectionString.includes("localhost") ? false : { rejectUnauthorized: false }
});

const app = express();
app.use((req, res, next) => {
  // CORS abierto: el frontend se sirve desde este mismo backend, pero se deja abierto
  // por si en el futuro se llama la API desde otro origen (app móvil, etc).
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: "8mb" })); // documentos adjuntos van en base64 dentro del JSON

// ---------- utilidades ----------
function slug(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}
const PERFIL_MASTER = "Director ejecutivo/máster";

// SSO hacia Relacionai: Encargado de Convivencia y Director (de colegio o ejecutivo/máster)
// entran a Relacionai sin clave aparte — Relacionai valida este token con el mismo secreto
// compartido (SSO_SHARED_SECRET) y abre sesión directo. Si no está configurado, simplemente
// no se emite token y el botón de Relacionai pide su login normal, como antes.
const SSO_SHARED_SECRET = process.env.SSO_SHARED_SECRET;
const PERFILES_SSO_RELACIONAI = ["Encargado de Convivencia Educativa", "Director/a de colegio", PERFIL_MASTER];
function generarSsoToken(correo, nombre, perfil) {
  const payload = { correo, nombre, perfil, exp: Date.now() + 2 * 60 * 1000 };
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SSO_SHARED_SECRET).update(b64).digest("hex");
  return `${b64}.${sig}`;
}

async function verificarActor(colegioId, correo, clave) {
  if (!correo || !clave) return null;
  const r = await pool.query(
    "select nombre, correo, perfil from usuarios where colegio_id=$1 and lower(correo)=lower($2) and clave=$3",
    [colegioId, correo, clave]
  );
  return r.rows[0] || null;
}

function asyncRoute(fn) {
  return (req, res) => fn(req, res).catch(err => {
    console.error(err);
    res.status(500).json({ error: "server_error", message: err.message });
  });
}

// ---------- colegios ----------
// Creación y búsqueda quedan solo para el panel de administrador de GADUAI (ver
// requireAdminKey) — un colegio ya no puede autoactivarse desde la pantalla pública.
app.post("/api/colegios", requireAdminKey, asyncRoute(async (req, res) => {
  const { nombre, comuna, correoMaster } = req.body || {};
  if (!nombre || !nombre.trim()) return res.status(400).json({ error: "nombre_requerido" });
  const id = slug(nombre) || ("colegio-" + Date.now());
  const existe = await pool.query("select id from colegios where id=$1", [id]);
  if (existe.rows.length) return res.status(409).json({ error: "colegio_existente", id });

  const correo = (correoMaster && correoMaster.trim()) || `director@${id}.cl`;
  const clave = claveAleatoria();
  await pool.query("insert into colegios (id, nombre, comuna) values ($1,$2,$3)", [id, nombre.trim(), comuna || null]);
  await pool.query(
    "insert into usuarios (colegio_id, nombre, correo, clave, perfil) values ($1,$2,$3,$4,$5)",
    [id, "Director ejecutivo", correo, clave, PERFIL_MASTER]
  );
  res.json({ id, nombre: nombre.trim(), comuna: comuna || null, master: { correo, clave } });
}));

// Solo admin: pega/actualiza el link al despliegue de Relacionai de este colegio, para el
// botón cruzado del header. Se hace aparte de la creación porque Relacionai normalmente se
// despliega después (o en paralelo) y no siempre se sabe su URL todavía al crear el colegio.
app.post("/api/colegios/:id/relacionai-url", requireAdminKey, asyncRoute(async (req, res) => {
  const { url } = req.body || {};
  const r = await pool.query(
    "update colegios set relacionai_url=$2 where id=$1 returning id, nombre, comuna, relacionai_url",
    [req.params.id, (url || "").trim() || null]
  );
  if (!r.rows.length) return res.status(404).json({ error: "no_encontrado" });
  res.json(r.rows[0]);
}));

// Pública a propósito: es la que usa el link con ?colegio=<id> para mostrar el nombre antes
// de loguearse. No expone la lista completa, solo un colegio puntual si se sabe su id.
app.get("/api/colegios/:id", asyncRoute(async (req, res) => {
  const r = await pool.query("select id, nombre, comuna, relacionai_url from colegios where id=$1", [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: "no_encontrado" });
  res.json(r.rows[0]);
}));

// Insignia/logo propio del colegio, usado en documentos formales (ej. Entrevista). Pública
// de lectura (el frontend la necesita antes de saber si el usuario está logueado), protegida
// por X-Admin-Key para cargarla — hoy se sube desde el panel de administrador de GADUAI.
app.get("/api/colegios/:id/insignia", asyncRoute(async (req, res) => {
  const r = await pool.query("select insignia_data from colegios where id=$1", [req.params.id]);
  res.json({ insignia: (r.rows[0] && r.rows[0].insignia_data) || null });
}));

app.post("/api/colegios/:id/insignia", requireAdminKey, asyncRoute(async (req, res) => {
  const { dataUri } = req.body || {};
  const r = await pool.query(
    "update colegios set insignia_data=$2 where id=$1 returning id",
    [req.params.id, (dataUri || "").trim() || null]
  );
  if (!r.rows.length) return res.status(404).json({ error: "no_encontrado" });
  res.json({ ok: true });
}));

app.get("/api/colegios", requireAdminKey, asyncRoute(async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json([]); // no listamos todos los colegios por defecto (privacidad multi-tenant)
  const r = await pool.query(
    "select id, nombre, comuna from colegios where nombre ilike $1 order by nombre limit 10",
    [`%${q}%`]
  );
  res.json(r.rows);
}));

// ---------- login ----------
app.post("/api/colegios/:id/login", asyncRoute(async (req, res) => {
  const { correo, clave } = req.body || {};
  const usuario = await verificarActor(req.params.id, correo, clave);
  if (!usuario) return res.status(401).json({ error: "credenciales_invalidas" });
  const relacionaiSsoToken = (SSO_SHARED_SECRET && PERFILES_SSO_RELACIONAI.includes(usuario.perfil))
    ? generarSsoToken(usuario.correo, usuario.nombre, usuario.perfil)
    : null;
  res.json({ usuario, isMaster: usuario.perfil === PERFIL_MASTER, relacionaiSsoToken });
}));

// ---------- usuarios (solo máster administra) ----------
app.get("/api/colegios/:id/usuarios", asyncRoute(async (req, res) => {
  const r = await pool.query(
    "select id, nombre, correo, perfil from usuarios where colegio_id=$1 order by creado_en",
    [req.params.id]
  );
  res.json(r.rows);
}));

app.post("/api/colegios/:id/usuarios", asyncRoute(async (req, res) => {
  const { nombre, correo, clave, perfil, actorCorreo, actorClave } = req.body || {};
  const actor = await verificarActor(req.params.id, actorCorreo, actorClave);
  if (!actor || actor.perfil !== PERFIL_MASTER) return res.status(403).json({ error: "solo_master" });
  if (!nombre || !correo || !clave || !perfil) return res.status(400).json({ error: "campos_requeridos" });
  try {
    const r = await pool.query(
      "insert into usuarios (colegio_id, nombre, correo, clave, perfil) values ($1,$2,$3,$4,$5) returning id, nombre, correo, perfil",
      [req.params.id, nombre.trim(), correo.trim(), clave, perfil]
    );
    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "correo_existente" });
    throw e;
  }
}));

app.delete("/api/colegios/:id/usuarios/:usuarioId", asyncRoute(async (req, res) => {
  const { actorCorreo, actorClave } = req.body || {};
  const actor = await verificarActor(req.params.id, actorCorreo, actorClave);
  if (!actor || actor.perfil !== PERFIL_MASTER) return res.status(403).json({ error: "solo_master" });
  await pool.query("delete from usuarios where id=$1 and colegio_id=$2 and perfil<>$3", [
    req.params.usuarioId, req.params.id, PERFIL_MASTER
  ]);
  res.json({ ok: true });
}));

// ---------- timeline ----------
// Cada ítem vive en el timeline de quien lo creó y de quien va dirigido (perfil, responsable
// o copiados) — dos perfiles solo comparten un hito si uno es contraparte del otro en ese
// ítem puntual. El Director ejecutivo/máster (sostenedor) es un caso aparte: ve todos los
// Rojo-críticos del colegio en solo lectura (no resuelve ni cierra — eso es del Director/a de
// colegio), más su propio hilo activo (igual que cualquier perfil) con quien le dirija algo a
// él o con quien él mismo cree.
function enHiloPropio(it, perfil, persona) {
  return it.perfil === perfil || it.persona === persona || it.responsable === persona || (it.copiados || []).includes(persona);
}

app.get("/api/colegios/:id/timeline", asyncRoute(async (req, res) => {
  const { perfil, persona } = req.query;
  let sql, params;
  if (perfil === PERFIL_MASTER) {
    sql = "select * from items where colegio_id=$1 and (triage='Rojo' or perfil=$2 or persona=$3 or responsable=$3 or $3 = any(copiados))";
    params = [req.params.id, perfil, persona || ""];
  } else if (perfil) {
    sql = "select * from items where colegio_id=$1 and (perfil=$2 or persona=$3 or responsable=$3 or $3 = any(copiados))";
    params = [req.params.id, perfil, persona || ""];
  } else {
    sql = "select * from items where colegio_id=$1";
    params = [req.params.id];
  }
  sql += " order by fecha asc, id asc";
  const items = await pool.query(sql, params);
  const ids = items.rows.map(i => i.id);
  let chats = [], alertas = [], circulo = [];
  if (ids.length) {
    chats = (await pool.query("select * from chat_mensajes where item_id = any($1) order by id", [ids])).rows;
    alertas = (await pool.query("select * from alertas where item_id = any($1) order by id", [ids])).rows;
    circulo = (await pool.query("select * from circulo_historial where item_id = any($1) order by id", [ids])).rows;
  }
  const out = items.rows.map(it => ({
    id: it.id,
    tipo: it.tipo,
    triage: it.triage,
    titulo: it.titulo,
    desc: it.descripcion,
    fecha: it.fecha,
    responsable: it.responsable,
    copiados: it.copiados,
    persona: it.persona,
    perfil: it.perfil,
    creado: it.creado,
    revisado: it.revisado,
    archivoNombre: it.archivo_nombre,
    archivoData: it.archivo_data,
    react: it.react,
    circuloEstado: it.circulo_estado,
    circuloLike: it.circulo_like,
    soloLectura: perfil === PERFIL_MASTER && !enHiloPropio(it, perfil, persona || ""),
    chat: chats.filter(c => c.item_id === it.id).map(c => ({ autor: c.autor, perfil: c.perfil, texto: c.texto, fecha: c.fecha })),
    alertas: alertas.filter(a => a.item_id === it.id).map(a => ({ id: a.id, autor: a.autor, destinatario: a.destinatario, mensaje: a.mensaje, fecha: a.fecha, leida: a.leida })),
    circuloHistorial: circulo.filter(c => c.item_id === it.id).map(c => ({ paso: c.paso, autor: c.autor, perfil: c.perfil, mensaje: c.mensaje, archivoNombre: c.archivo_nombre, archivoData: c.archivo_data, fecha: c.creado_en }))
  }));
  res.json(out);
}));

app.post("/api/colegios/:id/timeline", asyncRoute(async (req, res) => {
  const b = req.body || {};
  const actor = await verificarActor(req.params.id, b.actorCorreo, b.actorClave);
  if (!actor) return res.status(401).json({ error: "credenciales_invalidas" });
  if (!b.titulo || !b.titulo.trim()) return res.status(400).json({ error: "titulo_requerido" });
  const titulo = b.titulo.trim();
  const r = await pool.query(
    `insert into items (colegio_id, tipo, triage, titulo, descripcion, fecha, responsable, copiados, persona, perfil, creado, archivo_nombre, archivo_data)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
    [
      req.params.id, b.tipo || "tarea", b.triage || "Rojo", titulo, b.desc || null,
      b.fecha, b.responsable || null, b.copiados || [], actor.nombre, actor.perfil,
      new Date().toLocaleDateString("es-CL"), b.archivoNombre || null, b.archivoData || null
    ]
  );
  res.json({ id: r.rows[0].id });

  // Correo a quien entrega (el actor, cuyo correo ya se tiene) y a quien recibe (buscado por
  // nombre, ya que "responsable" es texto libre y no una FK a usuarios) — best-effort, no
  // bloquea la respuesta ni falla la creación del ítem si el correo no se puede enviar.
  const asunto = `Nueva tarea GADUAI: ${titulo}`;
  const texto = `${actor.nombre} te asignó una tarea en GADUAI.\n\nTítulo: ${titulo}\nFecha: ${b.fecha || "—"}\n${b.desc ? `Descripción: ${b.desc}\n` : ""}`;
  enviarCorreo({ to: actor.correo, asunto, texto }).catch(() => {});
  if (b.responsable && b.responsable.trim() && b.responsable.trim() !== actor.nombre) {
    pool.query("select correo from usuarios where colegio_id=$1 and nombre=$2", [req.params.id, b.responsable.trim()])
      .then(ur => { if (ur.rows[0]) enviarCorreo({ to: ur.rows[0].correo, asunto, texto }).catch(() => {}); })
      .catch(() => {});
  }
}));

// ---------- entrevista formal (disponible a todos los perfiles) ----------
app.get("/api/colegios/:id/entrevistas", asyncRoute(async (req, res) => {
  const r = await pool.query(
    "select * from entrevistas where colegio_id=$1 order by creado_en desc",
    [req.params.id]
  );
  res.json(r.rows);
}));

app.post("/api/colegios/:id/entrevistas", asyncRoute(async (req, res) => {
  const b = req.body || {};
  const actor = await verificarActor(req.params.id, b.actorCorreo, b.actorClave);
  if (!actor) return res.status(401).json({ error: "credenciales_invalidas" });
  if (!b.nombreEntrevistado || !b.nombreEntrevistado.trim()) return res.status(400).json({ error: "nombre_requerido" });
  const r = await pool.query(
    `insert into entrevistas (colegio_id, nombre_entrevistado, correo, cargo, fono, fecha, hora, curso, motivo, entrevistador, desarrollo, compromisos, creado_por, perfil_creador)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
    [
      req.params.id, b.nombreEntrevistado.trim(), b.correo || null, b.cargo || null, b.fono || null,
      b.fecha || null, b.hora || null, b.curso || null, b.motivo || null,
      b.entrevistador || actor.nombre, b.desarrollo || null, b.compromisos || null,
      actor.nombre, actor.perfil,
    ]
  );
  res.json(r.rows[0]);
}));

app.post("/api/colegios/:id/timeline/:itemId/reaccionar", asyncRoute(async (req, res) => {
  const { tipo, actorCorreo, actorClave } = req.body || {};
  const actor = await verificarActor(req.params.id, actorCorreo, actorClave);
  if (!actor) return res.status(401).json({ error: "credenciales_invalidas" });
  const r = await pool.query("select * from items where id=$1 and colegio_id=$2", [req.params.itemId, req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: "no_encontrado" });
  // El sostenedor (Director ejecutivo/máster) ve los Rojo-críticos del colegio entero, pero
  // solo puede intervenir en los que pertenecen a su propio hilo — el resto lo resuelve y
  // cierra el Director/a de colegio.
  if (actor.perfil === PERFIL_MASTER && !enHiloPropio(r.rows[0], actor.perfil, actor.nombre)) {
    return res.status(403).json({ error: "solo_lectura" });
  }
  const item = r.rows[0];
  const react = item.react || { like: 0, dislike: 0, ok: 0, heart: 0, done: false };
  const eraCumplida = !!react.done; // se guarda antes de mutar in-place, para distinguir cierre de reapertura
  if (tipo === "done") react.done = !react.done;
  else react[tipo] = (react[tipo] || 0) + 1;
  await pool.query("update items set react=$1, revisado=true where id=$2", [react, req.params.itemId]);
  res.json({ react });

  // Correo de cierre con el historial completo, solo en la transición false→true (no al
  // reabrir). Best-effort: no bloquea la respuesta ni falla si algún correo no se envía.
  if (tipo === "done" && !eraCumplida && react.done) {
    pool.query("select * from chat_mensajes where item_id=$1 order by id", [item.id])
      .then(async (chatR) => {
        const historial = chatR.rows.length
          ? chatR.rows.map(m => `[${m.fecha}] ${m.autor} (${m.perfil}): ${m.texto}`).join("\n")
          : "(sin mensajes en el chat de esta tarea)";
        const adjunto = item.archivo_nombre ? `\nAdjunto: ${item.archivo_nombre}` : "";
        const asunto = `Tarea cerrada en GADUAI: ${item.titulo}`;
        const texto = `${actor.nombre} marcó como cumplida la tarea "${item.titulo}".${adjunto}\n\nHistorial de mensajes:\n${historial}`;
        const destinatarios = new Set();
        const uPersona = await pool.query("select correo from usuarios where colegio_id=$1 and nombre=$2", [req.params.id, item.persona]);
        if (uPersona.rows[0]) destinatarios.add(uPersona.rows[0].correo);
        if (item.responsable) {
          const uResp = await pool.query("select correo from usuarios where colegio_id=$1 and nombre=$2", [req.params.id, item.responsable]);
          if (uResp.rows[0]) destinatarios.add(uResp.rows[0].correo);
        }
        for (const to of destinatarios) await enviarCorreo({ to, asunto, texto });
      })
      .catch(() => {});
  }
}));

// ---------- círculo de la promesa (solo tipo='tarea') ----------
// Máquina de estados que reemplaza las reacciones libres para tareas: nuevo -> (dedo_arriba |
// dedo_abajo) -> manito_ok -> cerrado, más un like opcional del responsable ya cerrado el
// ticket. Cada transición la gatea la persona exacta correspondiente (responsable o remitente,
// igual que ya se gatea el resto del sistema por nombre — no por rol), y queda registrada en
// circulo_historial con su mensaje/adjunto opcional.
app.post("/api/colegios/:id/timeline/:itemId/circulo", asyncRoute(async (req, res) => {
  const { accion, mensaje, archivoNombre, archivoData, actorCorreo, actorClave } = req.body || {};
  const actor = await verificarActor(req.params.id, actorCorreo, actorClave);
  if (!actor) return res.status(401).json({ error: "credenciales_invalidas" });
  const r = await pool.query("select * from items where id=$1 and colegio_id=$2", [req.params.itemId, req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: "no_encontrado" });
  const item = r.rows[0];
  if (actor.perfil === PERFIL_MASTER && !enHiloPropio(item, actor.perfil, actor.nombre)) {
    return res.status(403).json({ error: "solo_lectura" });
  }
  const esResponsable = actor.nombre === item.responsable;
  const esRemitente = actor.nombre === item.persona;
  const estado = item.circulo_estado || "nuevo";

  let nuevoEstado = null, paso;
  if (accion === "aceptar") {
    if (!esResponsable || !(estado === "nuevo" || estado === "dedo_abajo")) return res.status(403).json({ error: "no_autorizado" });
    nuevoEstado = "dedo_arriba"; paso = "👍 Aceptó la acción";
  } else if (accion === "rechazar") {
    if (!esResponsable || estado !== "nuevo") return res.status(403).json({ error: "no_autorizado" });
    nuevoEstado = "dedo_abajo"; paso = "👎 Rechazó la acción";
  } else if (accion === "ok") {
    if (!esResponsable || estado !== "dedo_arriba") return res.status(403).json({ error: "no_autorizado" });
    nuevoEstado = "manito_ok"; paso = "👌 Acción realizada";
  } else if (accion === "cerrar") {
    if (!esRemitente || estado !== "manito_ok") return res.status(403).json({ error: "no_autorizado" });
    nuevoEstado = "cerrado"; paso = "✅ Ticket cerrado";
  } else if (accion === "like") {
    if (!esResponsable || estado !== "cerrado" || item.circulo_like) return res.status(403).json({ error: "no_autorizado" });
    paso = "❤️ Le gustó la retroalimentación";
  } else {
    return res.status(400).json({ error: "accion_invalida" });
  }

  if (nuevoEstado) await pool.query("update items set circulo_estado=$1, revisado=true where id=$2", [nuevoEstado, item.id]);
  if (accion === "like") await pool.query("update items set circulo_like=true where id=$1", [item.id]);
  await pool.query(
    "insert into circulo_historial (item_id, paso, autor, perfil, mensaje, archivo_nombre, archivo_data) values ($1,$2,$3,$4,$5,$6,$7)",
    [item.id, paso, actor.nombre, actor.perfil, mensaje || null, archivoNombre || null, archivoData || null]
  );
  res.json({ ok: true, circuloEstado: nuevoEstado || estado });

  // Correo de cierre con el historial de chat, igual que el de Hitos — best-effort.
  if (accion === "cerrar") {
    pool.query("select * from chat_mensajes where item_id=$1 order by id", [item.id])
      .then(async (chatR) => {
        const historialChat = chatR.rows.length
          ? chatR.rows.map(m => `[${m.fecha}] ${m.autor} (${m.perfil}): ${m.texto}`).join("\n")
          : "(sin mensajes en el chat de esta tarea)";
        const adjunto = item.archivo_nombre ? `\nAdjunto: ${item.archivo_nombre}` : "";
        const asunto = `Tarea cerrada en GADUAI: ${item.titulo}`;
        const texto = `${actor.nombre} cerró el círculo de la promesa de la tarea "${item.titulo}".${mensaje ? `\n\nRetroalimentación: ${mensaje}` : ""}${adjunto}\n\nHistorial de chat:\n${historialChat}`;
        const destinatarios = new Set();
        const uPersona = await pool.query("select correo from usuarios where colegio_id=$1 and nombre=$2", [req.params.id, item.persona]);
        if (uPersona.rows[0]) destinatarios.add(uPersona.rows[0].correo);
        if (item.responsable) {
          const uResp = await pool.query("select correo from usuarios where colegio_id=$1 and nombre=$2", [req.params.id, item.responsable]);
          if (uResp.rows[0]) destinatarios.add(uResp.rows[0].correo);
        }
        for (const to of destinatarios) await enviarCorreo({ to, asunto, texto });
      })
      .catch(() => {});
  }
}));

// ---------- chat por ítem ----------
app.post("/api/colegios/:id/timeline/:itemId/chat", asyncRoute(async (req, res) => {
  const { texto, actorCorreo, actorClave } = req.body || {};
  const actor = await verificarActor(req.params.id, actorCorreo, actorClave);
  if (!actor) return res.status(401).json({ error: "credenciales_invalidas" });
  if (!texto || !texto.trim()) return res.status(400).json({ error: "texto_requerido" });
  await pool.query(
    "insert into chat_mensajes (item_id, autor, perfil, texto, fecha) values ($1,$2,$3,$4,$5)",
    [req.params.itemId, actor.nombre, actor.perfil, texto.trim(), new Date().toLocaleString("es-CL")]
  );
  res.json({ ok: true });
}));

// ---------- alertas ----------
app.post("/api/colegios/:id/timeline/:itemId/alertar", asyncRoute(async (req, res) => {
  const { destinatario, mensaje, actorCorreo, actorClave } = req.body || {};
  const actor = await verificarActor(req.params.id, actorCorreo, actorClave);
  if (!actor) return res.status(401).json({ error: "credenciales_invalidas" });
  await pool.query(
    "insert into alertas (item_id, autor, destinatario, mensaje, fecha) values ($1,$2,$3,$4,$5)",
    [req.params.itemId, actor.nombre, destinatario || "—", mensaje || null, new Date().toLocaleString("es-CL")]
  );
  res.json({ ok: true });
}));

app.post("/api/colegios/:id/alertas/marcar-leidas", asyncRoute(async (req, res) => {
  const { actorCorreo, actorClave } = req.body || {};
  const actor = await verificarActor(req.params.id, actorCorreo, actorClave);
  if (!actor) return res.status(401).json({ error: "credenciales_invalidas" });
  await pool.query(
    `update alertas set leida=true where destinatario=$1 and item_id in (select id from items where colegio_id=$2)`,
    [actor.nombre, req.params.id]
  );
  res.json({ ok: true });
}));

// ---------- tareas programadas (Render Cron Job) ----------
// Aviso + correo cuando a una tarea/hito le queda un día para vencer. Se protege con
// X-Tasks-Secret (no con X-Admin-Key) porque la dispara un Cron Job, no una persona.
app.post("/tasks/vencimientos", requireTasksSecret, asyncRoute(async (req, res) => {
  const r = await pool.query(
    `select * from items
       where fecha = current_date + 1
         and recordatorio_enviado = false
         and coalesce((react->>'done')::boolean, false) = false`
  );
  let avisos = 0, correos = 0;
  for (const it of r.rows) {
    const destinatarioNombre = it.responsable || it.persona;
    await pool.query(
      "insert into alertas (item_id, autor, destinatario, mensaje, fecha) values ($1,'Sistema',$2,$3,$4)",
      [it.id, destinatarioNombre, `Vence mañana: ${it.titulo}`, new Date().toLocaleString("es-CL")]
    );
    avisos++;
    const u = await pool.query("select correo from usuarios where colegio_id=$1 and nombre=$2", [it.colegio_id, destinatarioNombre]);
    if (u.rows[0]) {
      const ok = await enviarCorreo({
        to: u.rows[0].correo,
        asunto: `Vence mañana: ${it.titulo}`,
        texto: `La tarea "${it.titulo}" vence mañana (${it.fecha.toISOString ? it.fecha.toISOString().slice(0, 10) : it.fecha}). Ingresa a GADUAI para revisarla.`,
      });
      if (ok) correos++;
    }
    await pool.query("update items set recordatorio_enviado=true where id=$1", [it.id]);
  }
  res.json({ revisados: r.rows.length, avisos, correos });
}));

// ---------- avisos de sistema (llamados por Relacionai, no por una persona) ----------
// Protegida con X-Admin-Key (mismo secreto que ya usan las rutas de administración de
// colegios) porque quien llama es otro backend de confianza, no un usuario logueado.
app.post("/api/sistema/avisos", requireAdminKey, asyncRoute(async (req, res) => {
  const { tipo, colegioId, caso, cantidad, fechaLimite } = req.body || {};
  const colegio = colegioId || DEFAULT_COLEGIO_ID;
  if (!colegio) return res.status(400).json({ error: "colegio_requerido" });
  let titulo, triage, fecha;
  if (tipo === "relato_enviado") {
    titulo = `Relacionai: se envió la solicitud de relato a ${cantidad || "un"} destinatario(s) — caso ${caso}`;
    triage = "Azul";
    fecha = new Date().toISOString().slice(0, 10);
  } else if (tipo === "relato_por_vencer") {
    titulo = `Relacionai: el relato del caso ${caso} vence mañana (${fechaLimite})`;
    triage = "Rojo";
    fecha = fechaLimite;
  } else {
    return res.status(400).json({ error: "tipo_invalido" });
  }
  await pool.query(
    `insert into items (colegio_id, tipo, triage, titulo, fecha, persona, perfil, creado)
     values ($1,'tarea',$2,$3,$4,'Relacionai (automático)',$5,$6)`,
    [colegio, triage, titulo, fecha, PERFIL_CONVIVENCIA, new Date().toLocaleDateString("es-CL")]
  );
  if (tipo === "relato_por_vencer") {
    const usuarios = await pool.query("select correo from usuarios where colegio_id=$1 and perfil=$2", [colegio, PERFIL_CONVIVENCIA]);
    for (const u of usuarios.rows) {
      await enviarCorreo({
        to: u.correo,
        asunto: `Vence mañana: relato del caso ${caso}`,
        texto: `El relato del caso ${caso} en Relacionai vence mañana (${fechaLimite}). Ingresa a Relacionai para revisarlo.`,
      });
    }
  }
  res.json({ ok: true });
}));

// El frontend la consulta al iniciar si la URL no trae ?colegio= — solo devuelve algo en
// despliegues dedicados a un colegio (DEFAULT_COLEGIO_ID configurado).
app.get("/api/config", (req, res) => {
  res.json({ defaultColegio: DEFAULT_COLEGIO_ID });
});

// ---------- PWA: instalar GADUAI como ícono en el celular/computador ----------
// El manifest se arma por request (no es un archivo estático) para que start_url lleve el
// ?colegio=<id> — así el ícono instalado abre directo el colegio correcto, aunque este mismo
// código sirva a varios colegios (despliegue compartido) o a uno solo (despliegue dedicado).
app.get("/manifest.webmanifest", (req, res) => {
  const colegioId = req.query.colegio || DEFAULT_COLEGIO_ID;
  const colegio = colegioId ? `?colegio=${encodeURIComponent(colegioId)}` : "";
  res.json({
    name: "GADUAI",
    short_name: "GADUAI",
    description: "Sistema de Inteligencia Organizacional para colegios",
    start_url: `/${colegio}`,
    scope: "/",
    display: "standalone",
    background_color: "#020617",
    theme_color: "#020617",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  });
});

// ---------- estáticos (sirve el propio frontend) ----------
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ---------- arranque: aplica el esquema y luego levanta el servidor ----------
async function start() {
  const fs = require("fs");
  const schema = fs.readFileSync(path.join(__dirname, "db", "schema.sql"), "utf8");
  await pool.query(schema);
  app.listen(PORT, () => console.log(`TRIAGE GADUAI backend escuchando en el puerto ${PORT}`));
}
start().catch(err => {
  console.error("No se pudo iniciar el servidor:", err);
  process.exit(1);
});
