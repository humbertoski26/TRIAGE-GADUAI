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

// Pública a propósito: es la que usa el link con ?colegio=<id> para mostrar el nombre antes
// de loguearse. No expone la lista completa, solo un colegio puntual si se sabe su id.
app.get("/api/colegios/:id", asyncRoute(async (req, res) => {
  const r = await pool.query("select id, nombre, comuna from colegios where id=$1", [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: "no_encontrado" });
  res.json(r.rows[0]);
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
  res.json({ usuario, isMaster: usuario.perfil === PERFIL_MASTER });
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
app.get("/api/colegios/:id/timeline", asyncRoute(async (req, res) => {
  const items = await pool.query(
    "select * from items where colegio_id=$1 order by fecha asc, id asc",
    [req.params.id]
  );
  const ids = items.rows.map(i => i.id);
  let chats = [], alertas = [];
  if (ids.length) {
    chats = (await pool.query("select * from chat_mensajes where item_id = any($1) order by id", [ids])).rows;
    alertas = (await pool.query("select * from alertas where item_id = any($1) order by id", [ids])).rows;
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
    chat: chats.filter(c => c.item_id === it.id).map(c => ({ autor: c.autor, perfil: c.perfil, texto: c.texto, fecha: c.fecha })),
    alertas: alertas.filter(a => a.item_id === it.id).map(a => ({ id: a.id, autor: a.autor, destinatario: a.destinatario, mensaje: a.mensaje, fecha: a.fecha, leida: a.leida }))
  }));
  res.json(out);
}));

app.post("/api/colegios/:id/timeline", asyncRoute(async (req, res) => {
  const b = req.body || {};
  const actor = await verificarActor(req.params.id, b.actorCorreo, b.actorClave);
  if (!actor) return res.status(401).json({ error: "credenciales_invalidas" });
  if (!b.titulo || !b.titulo.trim()) return res.status(400).json({ error: "titulo_requerido" });
  const r = await pool.query(
    `insert into items (colegio_id, tipo, triage, titulo, descripcion, fecha, responsable, copiados, persona, perfil, creado, archivo_nombre, archivo_data)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
    [
      req.params.id, b.tipo || "tarea", b.triage || "Rojo", b.titulo.trim(), b.desc || null,
      b.fecha, b.responsable || null, b.copiados || [], actor.nombre, actor.perfil,
      new Date().toLocaleDateString("es-CL"), b.archivoNombre || null, b.archivoData || null
    ]
  );
  res.json({ id: r.rows[0].id });
}));

app.post("/api/colegios/:id/timeline/:itemId/reaccionar", asyncRoute(async (req, res) => {
  const { tipo, actorCorreo, actorClave } = req.body || {};
  const actor = await verificarActor(req.params.id, actorCorreo, actorClave);
  if (!actor) return res.status(401).json({ error: "credenciales_invalidas" });
  const r = await pool.query("select react from items where id=$1 and colegio_id=$2", [req.params.itemId, req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: "no_encontrado" });
  const react = r.rows[0].react || { like: 0, dislike: 0, ok: 0, heart: 0, done: false };
  if (tipo === "done") react.done = !react.done;
  else react[tipo] = (react[tipo] || 0) + 1;
  await pool.query("update items set react=$1, revisado=true where id=$2", [react, req.params.itemId]);
  res.json({ react });
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
