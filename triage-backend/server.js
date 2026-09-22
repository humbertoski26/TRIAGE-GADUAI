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
const bcrypt = require("bcryptjs");
const express = require("express");
const { Pool, types } = require("pg");
// node-postgres devuelve las columnas "date" (ej. entrevistas.fecha, items.fecha) como objetos
// Date de JS por defecto — al pasar por JSON.stringify() quedan como timestamp completo
// ("2026-09-21T00:00:00.000Z") en vez de la fecha simple ("2026-09-21") que espera el
// frontend. OID 1082 = tipo "date" en Postgres; se deja pasar tal cual viene de la base
// ("YYYY-MM-DD"), sin tocar timestamptz (creado_en, etc.), que sí debe seguir siendo parseable.
types.setTypeParser(1082, val => val);
const { enviarCorreo } = require("./email");
const { enviarPush } = require("./push");
const Anthropic = require("@anthropic-ai/sdk");

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
// Compara dos secretos sin filtrar por cuánto tiempo tardó la comparación (timing attack) —
// crypto.timingSafeEqual exige buffers del mismo largo, así que primero se descarta el caso
// de largos distintos (ya es "no coinciden", sin necesidad de comparar byte a byte).
function comparacionSegura(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a), bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
function requireAdminKey(req, res, next) {
  if (!comparacionSegura(req.header("X-Admin-Key") || "", ADMIN_SETUP_KEY)) {
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
  if (!TASKS_SECRET || !comparacionSegura(req.header("X-Tasks-Secret") || "", TASKS_SECRET)) {
    return res.status(403).json({ error: "no_autorizado" });
  }
  next();
}
// Nombre de perfil usado por Relacionai al avisar sobre relatos (aviso automático cruzado).
const PERFIL_CONVIVENCIA = "Encargado de Convivencia Educativa";

// Para cargar/actualizar la normativa nacional que alimenta el cerebro de IA GADUAI, sin
// exponer un canal de escritura directa a la base de datos. Mismo patrón que TASKS_SECRET:
// si no está configurada, la ruta protegida responde 403 siempre.
const NORMATIVA_SEED_KEY = process.env.NORMATIVA_SEED_KEY;
function requireNormativaKey(req, res, next) {
  if (!NORMATIVA_SEED_KEY || !comparacionSegura(req.header("X-Normativa-Key") || "", NORMATIVA_SEED_KEY)) {
    return res.status(403).json({ error: "no_autorizado" });
  }
  next();
}
// Para sembrar/actualizar ítems de ejemplo que alimentan PULSO GADUAI cuando no hay suficiente
// data real todavía (demo para probar/mostrar el producto) — mismo patrón que las claves de
// arriba. Los ítems de ejemplo siempre parten con "[Demo]" en el título para poder limpiarlos
// o volver a sembrarlos sin duplicar (la ruta borra sus propios ejemplos antes de recrearlos).
const SEED_DEMO_KEY = process.env.SEED_DEMO_KEY;
function requireSeedKey(req, res, next) {
  if (!SEED_DEMO_KEY || !comparacionSegura(req.header("X-Seed-Key") || "", SEED_DEMO_KEY)) {
    return res.status(403).json({ error: "no_autorizado" });
  }
  next();
}
// Clave nueva y de un solo propósito (Fase 17: mover un colegio entre despliegues) —
// deliberadamente NO reutiliza ADMIN_SETUP_KEY para no arriesgar nada que ya dependa de esa
// clave (ej. gaduai-portal administrando este mismo colegio).
const MIGRACION_KEY = process.env.MIGRACION_KEY;
function requireMigracionKey(req, res, next) {
  if (!MIGRACION_KEY || !comparacionSegura(req.header("X-Migracion-Key") || "", MIGRACION_KEY)) {
    return res.status(403).json({ error: "no_autorizado" });
  }
  next();
}
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

// IA GADUAI: respaldo conversacional con Claude cuando el contexto propio del colegio no
// alcanza. Sin ANTHROPIC_API_KEY configurada, el botón sigue mostrando el historial pero la
// ruta de chat responde "ia_no_configurada" en vez de romper el resto del backend.
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
if (!anthropic) console.warn("ANTHROPIC_API_KEY no configurada: IA GADUAI queda deshabilitada.");

const app = express();
// Auditoría de seguridad: antes había "Access-Control-Allow-Origin: *" en todas las rutas.
// El frontend se sirve desde este mismo backend (mismo origen) y ningún otro origen legítimo
// llama esta API desde el navegador (Relacionai la llama servidor-a-servidor, no vía fetch()
// del navegador, así que CORS no le aplica) — con el wildcard, cualquier sitio web externo
// podía leer las respuestas de la API desde el navegador de cualquier visitante. Sin cabeceras
// CORS, el navegador aplica su política de mismo-origen por defecto, que es lo que queremos.
app.use(express.json({ limit: "8mb" })); // documentos adjuntos van en base64 dentro del JSON

// Límite simple de intentos de login por IP — corta fuerza bruta contra /login sin depender
// de un paquete nuevo. En memoria del proceso (el servicio corre en una sola instancia, ver
// numInstances=1 en Render); se resetea solo cada 15 min por IP.
const intentosLogin = new Map(); // ip -> {n, desde}
function loginRateLimit(req, res, next) {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "desconocida";
  const ahora = Date.now();
  const ventanaMs = 15 * 60 * 1000;
  const tope = 20;
  let entrada = intentosLogin.get(ip);
  if (!entrada || ahora - entrada.desde > ventanaMs) entrada = { n: 0, desde: ahora };
  entrada.n++;
  intentosLogin.set(ip, entrada);
  if (entrada.n > tope) {
    return res.status(429).json({ error: "demasiados_intentos", reintentaEnSegundos: Math.ceil((ventanaMs - (ahora - entrada.desde)) / 1000) });
  }
  next();
}

// Para rutas de solo-lectura que antes recibían credenciales por query string (quedaban en
// logs/historial del navegador) — ahora viajan como cabeceras, que el navegador no guarda en
// el historial y que normalmente no quedan en logs de acceso.
function actorDeHeaders(req) {
  return { correo: req.header("X-Actor-Correo") || "", clave: req.header("X-Actor-Clave") || "" };
}

// ---------- utilidades ----------
function slug(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}
// Sin depender de rangos Unicode de tildes (ambiguos de escribir/leer en el código fuente) —
// reemplazo directo de las 5 vocales acentuadas, usado por la carga de horario docente para
// que "miércoles"/"Miércoles" calcen con la clave "miercoles" sin tilde (Fase 19).
function sinTildes(s) {
  return String(s || "").replace(/á/g, "a").replace(/é/g, "e").replace(/í/g, "i").replace(/ó/g, "o").replace(/ú/g, "u");
}
// Normaliza "8:00" / "08:00" / " 8:5 " a "08:00" con cero a la izquierda — así la comparación
// de solapamiento de bloques en /ausentismo/bloque/:id/sugerencias (que compara como texto,
// "08:00" < "08:45") funciona sin importar cómo se haya escrito la hora en la planilla.
function normHora(s) {
  const m = String(s || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return String(s || "").trim();
  return String(m[1]).padStart(2, "0") + ":" + m[2];
}
const PERFIL_MASTER = "Director ejecutivo/máster";
// Mismo listado exacto que PERFILES en public/index.html — usado para validar el perfil al
// guardar el rango de Eventos Críticos de PULSO GADUAI (ver /pulso-eventos-rango más abajo).
const PERFILES = [
  PERFIL_MASTER,
  "Director/a de colegio",
  "Inspector General",
  "UTP",
  "Encargado de Convivencia Educativa",
  "Dupla psicosocial",
  "Docente",
];

// SSO hacia Relacionai: Director (de colegio o ejecutivo/máster), Encargado de Convivencia,
// Dupla psicosocial e Inspector General entran a Relacionai sin clave aparte — Relacionai
// valida este token con el mismo secreto compartido (SSO_SHARED_SECRET) y abre sesión
// directo. UTP y Docente quedan explícitamente fuera: ni token SSO ni botón visible (ver
// actualizarLinkRelacionai() en el frontend, que oculta el botón si no hay token).
const SSO_SHARED_SECRET = process.env.SSO_SHARED_SECRET;
const PERFILES_SSO_RELACIONAI = [
  PERFIL_MASTER,
  "Director/a de colegio",
  "Encargado de Convivencia Educativa",
  "Dupla psicosocial",
  "Inspector General"
];
function generarSsoToken(correo, nombre, perfil) {
  const payload = { correo, nombre, perfil, exp: Date.now() + 2 * 60 * 1000 };
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SSO_SHARED_SECRET).update(b64).digest("hex");
  return `${b64}.${sig}`;
}

async function verificarActor(colegioId, correo, clave) {
  if (!correo || !clave) return null;
  const r = await pool.query(
    "select nombre, correo, perfil, tema, clave_hash from usuarios where colegio_id=$1 and lower(correo)=lower($2)",
    [colegioId, correo]
  );
  const fila = r.rows[0];
  if (!fila || !fila.clave_hash) return null; // sin hash todavía = migración no llegó a esta fila, o cuenta inexistente
  const ok = await bcrypt.compare(clave, fila.clave_hash);
  if (!ok) return null;
  delete fila.clave_hash; // nunca debe viajar de vuelta en una respuesta
  return fila;
}

function asyncRoute(fn) {
  return (req, res) => fn(req, res).catch(err => {
    console.error(err);
    res.status(500).json({ error: "server_error", message: err.message });
  });
}

// Centraliza los ~9 lugares que insertaban directo en `alertas` — ahora todos pasan por acá,
// así ninguno se queda sin disparar la notificación push (Fase 5). `vencimiento` arma el
// mensaje del push con el formato exacto pedido ("Te recuerdo que ... vence en ..."); si no
// se pasa, el push reutiliza el mismo texto de la alerta. Best-effort: nunca bloquea ni
// rompe el flujo que la llama.
async function crearAlerta(colegioId, itemId, destinatario, mensaje, { autor = "Sistema", vencimiento } = {}) {
  await pool.query(
    "insert into alertas (item_id, autor, destinatario, mensaje, fecha) values ($1,$2,$3,$4,$5)",
    [itemId, autor, destinatario, mensaje, new Date().toLocaleString("es-CL")]
  );
  const cuerpo = vencimiento
    ? `Te recuerdo que ${vencimiento.evento} vence en ${vencimiento.plazo}. Gracias.`
    : mensaje;
  enviarPush(pool, colegioId, destinatario, { titulo: "Saludos desde GADUAI 👋", cuerpo, url: "/" }).catch(() => {});
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
  const clave = claveAleatoria(); // se muestra una sola vez en esta respuesta; en la base solo queda el hash
  const claveHash = await bcrypt.hash(clave, 10);
  await pool.query("insert into colegios (id, nombre, comuna) values ($1,$2,$3)", [id, nombre.trim(), comuna || null]);
  await pool.query(
    "insert into usuarios (colegio_id, nombre, correo, clave_hash, perfil) values ($1,$2,$3,$4,$5)",
    [id, "Director ejecutivo", correo, claveHash, PERFIL_MASTER]
  );
  res.json({ id, nombre: nombre.trim(), comuna: comuna || null, master: { correo, clave } });
}));

// Solo admin: genera una clave nueva para el usuario máster de un colegio que ya existe —
// para cuando la clave mostrada al crear el colegio (POST /api/colegios, "se muestra una
// sola vez") se perdió antes de guardarla. Si además llega `correoNuevo`, también actualiza
// el correo de acceso (útil si el máster quedó con el correo por defecto director@<id>.cl en
// vez del correo real de la persona). Si por algún motivo el colegio no tenía todavía ningún
// usuario con perfil máster, se crea uno — mismo patrón que POST /api/colegios.
app.post("/api/colegios/:id/reset-master", requireAdminKey, asyncRoute(async (req, res) => {
  const { correoNuevo } = req.body || {};
  const colegio = await pool.query("select id from colegios where id=$1", [req.params.id]);
  if (!colegio.rows.length) return res.status(404).json({ error: "no_encontrado" });

  const clave = claveAleatoria(); // se muestra una sola vez en esta respuesta
  const claveHash = await bcrypt.hash(clave, 10);
  const existente = await pool.query(
    "select correo from usuarios where colegio_id=$1 and perfil=$2 order by id limit 1",
    [req.params.id, PERFIL_MASTER]
  );

  let correo;
  if (existente.rows.length) {
    correo = (correoNuevo && correoNuevo.trim()) || existente.rows[0].correo;
    await pool.query(
      "update usuarios set correo=$3, clave_hash=$4 where colegio_id=$1 and perfil=$2",
      [req.params.id, PERFIL_MASTER, correo, claveHash]
    );
  } else {
    correo = (correoNuevo && correoNuevo.trim()) || `director@${req.params.id}.cl`;
    await pool.query(
      "insert into usuarios (colegio_id, nombre, correo, clave_hash, perfil) values ($1,$2,$3,$4,$5)",
      [req.params.id, "Director ejecutivo", correo, claveHash, PERFIL_MASTER]
    );
  }
  res.json({ id: req.params.id, master: { correo, clave } });
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

// Elimina un colegio completo (cascade se lleva usuarios, items y todo lo asociado) — para
// limpiar colegios de prueba, sobre todo en el despliegue compartido donde varios colegios
// conviven en la misma base de datos.
app.delete("/api/colegios/:id", requireAdminKey, asyncRoute(async (req, res) => {
  const r = await pool.query("delete from colegios where id=$1 returning id, nombre", [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: "no_encontrado" });
  res.json({ ok: true, eliminado: r.rows[0] });
}));

// Limpieza selectiva: borra toda la ACTIVIDAD de un colegio (Timeline, Círculo, chat, alertas,
// Agenda, Entrevistas, historial de IA GADUAI, sugerencias del Pulso viejo) pero mantiene lo
// estructural — cuentas de usuario, directorio de personas, documentos ya cargados (reglamento/
// PEI), insignia y configuración de PULSO GADUAI (rangos) — para que un colegio real pueda
// "resetearse" antes de entrar en producción sin tener que recrear nada de eso. Distinta de
// DELETE /api/colegios/:id, que borra el colegio entero (cuentas incluidas).
app.post("/api/colegios/:id/limpiar-actividad", requireAdminKey, asyncRoute(async (req, res) => {
  const existe = await pool.query("select id from colegios where id=$1", [req.params.id]);
  if (!existe.rows.length) return res.status(404).json({ error: "no_encontrado" });
  const cliente = await pool.connect();
  try {
    await cliente.query("BEGIN");
    // Borrar items primero: cascade se lleva circulo_historial, chat_mensajes, alertas y los
    // bloques de agenda_bloques que nacieron de una tarea (item_id no nulo).
    const items = await cliente.query("delete from items where colegio_id=$1 returning id", [req.params.id]);
    // Bloques de agenda reservados/bloqueados manualmente (sin item_id) no cascadearon arriba.
    const agenda = await cliente.query("delete from agenda_bloques where colegio_id=$1 returning id", [req.params.id]);
    const entrevistas = await cliente.query("delete from entrevistas where colegio_id=$1 returning id", [req.params.id]);
    const chatIa = await cliente.query("delete from chat_ia where colegio_id=$1 returning id", [req.params.id]);
    const monitorTareas = await cliente.query("delete from monitor_tareas where colegio_id=$1 returning id", [req.params.id]);
    // Los valores "de hoy" de Asistencia/Matrícula son datos de prueba manuales — se limpian;
    // los RANGOS (min/max) son configuración, no actividad, y se mantienen tal cual.
    await cliente.query("update colegios set pulso_asistencia_valor=null, pulso_matricula_valor=null where id=$1", [req.params.id]);
    await cliente.query("COMMIT");
    res.json({
      ok: true,
      borrados: {
        items: items.rows.length,
        agendaBloques: agenda.rows.length,
        entrevistas: entrevistas.rows.length,
        chatIa: chatIa.rows.length,
        monitorTareas: monitorTareas.rows.length,
      },
    });
  } catch (e) {
    await cliente.query("ROLLBACK");
    throw e;
  } finally {
    cliente.release();
  }
}));

// Pública a propósito: es la que usa el link con ?colegio=<id> para mostrar el nombre antes
// de loguearse. No expone la lista completa, solo un colegio puntual si se sabe su id.
app.get("/api/colegios/:id", asyncRoute(async (req, res) => {
  const r = await pool.query(
    `select id, nombre, comuna, relacionai_url,
            pulso_asistencia_valor, pulso_asistencia_min, pulso_asistencia_max,
            pulso_matricula_valor, pulso_matricula_min, pulso_matricula_max
     from colegios where id=$1`,
    [req.params.id]
  );
  if (!r.rows.length) return res.status(404).json({ error: "no_encontrado" });
  res.json(r.rows[0]);
}));

// Configuración de PULSO GADUAI — Asistencia y Matrícula: autoservicio para el máster y el
// Director/a de colegio, mismo patrón que insignia-propia. Son valores escritos a mano
// (mientras no exista integración SIGE) y su rango es igual para todo el colegio. Eventos
// críticos NO vive acá — su rango es por perfil, ver /pulso-eventos-rango más abajo.
app.post("/api/colegios/:id/pulso-config", asyncRoute(async (req, res) => {
  const { actorCorreo, actorClave, asistenciaValor, asistenciaMin, asistenciaMax, matriculaValor, matriculaMin, matriculaMax } = req.body || {};
  const actor = await verificarActor(req.params.id, actorCorreo, actorClave);
  if (!actor || ![PERFIL_MASTER, PERFIL_DIRECTOR_COLEGIO].includes(actor.perfil)) {
    return res.status(403).json({ error: "solo_master_o_director" });
  }
  // El % de asistencia se muestra sin decimales (pedido explícito) — se redondea acá, antes
  // de guardar, para que nunca dependa de que el cliente mande un número ya entero.
  const intOrNull = (v) => { if (v === "" || v === null || v === undefined) return null; const n = Number(v); return Number.isNaN(n) ? null : Math.round(n); };
  const intOr = (v, fallback) => { const n = intOrNull(v); return n === null ? fallback : n; };
  const r = await pool.query(
    `update colegios set
       pulso_asistencia_valor=$2, pulso_asistencia_min=$3, pulso_asistencia_max=$4,
       pulso_matricula_valor=$5, pulso_matricula_min=$6, pulso_matricula_max=$7
     where id=$1 returning id`,
    [
      req.params.id,
      intOrNull(asistenciaValor), intOr(asistenciaMin, 85), intOr(asistenciaMax, 100),
      intOrNull(matriculaValor), intOr(matriculaMin, 800), intOr(matriculaMax, 1000),
    ]
  );
  if (!r.rows.length) return res.status(404).json({ error: "no_encontrado" });
  res.json({ ok: true });
}));

// PULSO GADUAI — Eventos críticos: cada perfil ve solo sus propios ítems Rojo abiertos
// (Director/máster ve todo el colegio, el resto solo su propio hilo — misma regla que ya usa
// itemsVisiblesSql para el Timeline), así que lo "normal" para un perfil no es lo mismo que
// para otro. Por eso el rango se guarda por perfil, no por colegio.
async function obtenerRangoEventos(colegioId, perfil) {
  const r = await pool.query(
    "select eventos_min, eventos_max from pulso_eventos_rango where colegio_id=$1 and perfil=$2",
    [colegioId, perfil]
  );
  return r.rows.length ? { min: r.rows[0].eventos_min, max: r.rows[0].eventos_max } : { min: 1, max: 4 };
}
// La usa cualquier perfil logueado para saber SU PROPIO rango al pintar el botón del home.
app.get("/api/colegios/:id/pulso-eventos-rango", asyncRoute(async (req, res) => {
  const { correo, clave } = actorDeHeaders(req);
  const actor = await verificarActor(req.params.id, correo, clave);
  if (!actor) return res.status(401).json({ error: "credenciales_invalidas" });
  res.json(await obtenerRangoEventos(req.params.id, actor.perfil));
}));
// Listado completo (los 7 perfiles) para la pantalla de Configuración — solo máster/director,
// que son quienes definen el rango "normal" de cada perfil en su colegio.
app.get("/api/colegios/:id/pulso-eventos-rangos", asyncRoute(async (req, res) => {
  const { correo, clave } = actorDeHeaders(req);
  const actor = await verificarActor(req.params.id, correo, clave);
  if (!actor || ![PERFIL_MASTER, PERFIL_DIRECTOR_COLEGIO].includes(actor.perfil)) {
    return res.status(403).json({ error: "solo_master_o_director" });
  }
  const r = await pool.query(
    "select perfil, eventos_min, eventos_max from pulso_eventos_rango where colegio_id=$1",
    [req.params.id]
  );
  const guardados = Object.fromEntries(r.rows.map((row) => [row.perfil, { min: row.eventos_min, max: row.eventos_max }]));
  res.json(PERFILES.map((p) => ({ perfil: p, min: (guardados[p] || {}).min ?? 1, max: (guardados[p] || {}).max ?? 4 })));
}));
app.post("/api/colegios/:id/pulso-eventos-rango", asyncRoute(async (req, res) => {
  const { actorCorreo, actorClave, perfil, min, max } = req.body || {};
  const actor = await verificarActor(req.params.id, actorCorreo, actorClave);
  if (!actor || ![PERFIL_MASTER, PERFIL_DIRECTOR_COLEGIO].includes(actor.perfil)) {
    return res.status(403).json({ error: "solo_master_o_director" });
  }
  if (!PERFILES.includes(perfil)) return res.status(400).json({ error: "perfil_invalido" });
  const numOr = (v, fallback) => { const n = Number(v); return Number.isFinite(n) ? n : fallback; };
  await pool.query(
    `insert into pulso_eventos_rango (colegio_id, perfil, eventos_min, eventos_max)
     values ($1,$2,$3,$4)
     on conflict (colegio_id, perfil) do update set eventos_min=excluded.eventos_min, eventos_max=excluded.eventos_max`,
    [req.params.id, perfil, numOr(min, 1), numOr(max, 4)]
  );
  res.json({ ok: true });
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

// Autoservicio: el máster y el Director/a de colegio pueden subir/cambiar la insignia con su
// propia sesión, sin depender de X-Admin-Key (que solo tiene Humberto) — necesario para que
// cada colegio nuevo pueda cargar su propio logo sin intervención manual al vender el producto.
app.post("/api/colegios/:id/insignia-propia", asyncRoute(async (req, res) => {
  const { actorCorreo, actorClave, dataUri } = req.body || {};
  const actor = await verificarActor(req.params.id, actorCorreo, actorClave);
  if (!actor || ![PERFIL_MASTER, PERFIL_DIRECTOR_COLEGIO].includes(actor.perfil)) {
    return res.status(403).json({ error: "solo_master_o_director" });
  }
  const r = await pool.query(
    "update colegios set insignia_data=$2 where id=$1 returning id",
    [req.params.id, (dataUri || "").trim() || null]
  );
  if (!r.rows.length) return res.status(404).json({ error: "no_encontrado" });
  res.json({ ok: true });
}));

// ---------- notificaciones push del navegador (Web Push) ----------
// Pública: el frontend la necesita para armar la suscripción antes de saber si hay sesión.
app.get("/api/push-public-key", (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || null });
});

app.post("/api/colegios/:id/push-subscripcion", asyncRoute(async (req, res) => {
  const { subscription, actorCorreo, actorClave } = req.body || {};
  const actor = await verificarActor(req.params.id, actorCorreo, actorClave);
  if (!actor) return res.status(401).json({ error: "credenciales_invalidas" });
  if (!subscription || !subscription.endpoint || !subscription.keys) return res.status(400).json({ error: "suscripcion_invalida" });
  await pool.query(
    `insert into push_subscripciones (colegio_id, persona, endpoint, p256dh, auth)
     values ($1,$2,$3,$4,$5)
     on conflict (endpoint) do update set persona=excluded.persona, colegio_id=excluded.colegio_id`,
    [req.params.id, actor.nombre, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]
  );
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
app.post("/api/colegios/:id/login", loginRateLimit, asyncRoute(async (req, res) => {
  const { correo, clave } = req.body || {};
  const usuario = await verificarActor(req.params.id, correo, clave);
  if (!usuario) return res.status(401).json({ error: "credenciales_invalidas" });
  const relacionaiSsoToken = (SSO_SHARED_SECRET && PERFILES_SSO_RELACIONAI.includes(usuario.perfil))
    ? generarSsoToken(usuario.correo, usuario.nombre, usuario.perfil)
    : null;
  res.json({ usuario, isMaster: usuario.perfil === PERFIL_MASTER, relacionaiSsoToken });
}));

// ---------- usuarios (solo máster administra) ----------
// Auditoría de seguridad: esta lista (nombres, correos, perfiles de todo el colegio) se podía
// leer sin ninguna credencial. Ahora exige una cuenta válida del mismo colegio — cualquier
// perfil puede seguir viéndola (la necesitan los checklists de responsable/copiados), pero ya
// no es pública para cualquiera en internet.
app.get("/api/colegios/:id/usuarios", asyncRoute(async (req, res) => {
  const { correo, clave } = actorDeHeaders(req);
  const actor = await verificarActor(req.params.id, correo, clave);
  if (!actor) return res.status(401).json({ error: "credenciales_invalidas" });
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
    const claveHash = await bcrypt.hash(clave, 10);
    const r = await pool.query(
      "insert into usuarios (colegio_id, nombre, correo, clave_hash, perfil) values ($1,$2,$3,$4,$5) returning id, nombre, correo, perfil",
      [req.params.id, nombre.trim(), correo.trim(), claveHash, perfil]
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

// Cada quien cambia su propia preferencia de tema — no requiere ser máster, solo credenciales
// válidas de esa misma cuenta. Se guarda por cuenta (no por dispositivo) a propósito.
app.post("/api/colegios/:id/usuarios/tema", asyncRoute(async (req, res) => {
  const { actorCorreo, actorClave, tema } = req.body || {};
  const actor = await verificarActor(req.params.id, actorCorreo, actorClave);
  if (!actor) return res.status(401).json({ error: "credenciales_invalidas" });
  if (tema !== "claro" && tema !== "oscuro") return res.status(400).json({ error: "tema_invalido" });
  await pool.query("update usuarios set tema=$1 where colegio_id=$2 and lower(correo)=lower($3)", [tema, req.params.id, actorCorreo]);
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

// Auditoría de seguridad: este Timeline completo (tareas, hitos, adjuntos, chat, historial del
// círculo de la promesa — incluye casos delicados como denuncias) se podía leer sin ninguna
// credencial, con `perfil`/`persona` de la query string controlando qué se veía. Ahora exige
// login real y el perfil/persona salen de la cuenta ya verificada, no de lo que mande el
// cliente — así nadie puede pedir `perfil=Director ejecutivo/máster` para ver todo sin serlo.
app.get("/api/colegios/:id/timeline", asyncRoute(async (req, res) => {
  const { correo, clave } = actorDeHeaders(req);
  const actor = await verificarActor(req.params.id, correo, clave);
  if (!actor) return res.status(401).json({ error: "credenciales_invalidas" });
  const perfil = actor.perfil, persona = actor.nombre;
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
  sql += " order by creado_en desc, id desc";
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
    fechaFinal: it.fecha_final,
    responsable: it.responsable,
    copiados: it.copiados,
    persona: it.persona,
    perfil: it.perfil,
    creado: it.creado,
    creadoEn: it.creado_en,
    reunionHora: it.reunion_hora,
    reunionLugar: it.reunion_lugar,
    revisado: it.revisado,
    archivoNombre: it.archivo_nombre,
    archivoData: it.archivo_data,
    react: it.react,
    circuloEstado: it.circulo_estado,
    circuloLike: it.circulo_like,
    relacionaiSugerido: it.relacionai_sugerido,
    relacionaiMotivo: it.relacionai_motivo,
    relacionaiSugerencia: it.relacionai_sugerencia,
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
    `insert into items (colegio_id, tipo, triage, titulo, descripcion, fecha, fecha_final, responsable, copiados, persona, perfil, creado, archivo_nombre, archivo_data)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
    [
      req.params.id, b.tipo || "tarea", b.triage || "Rojo", titulo, b.desc || null,
      b.fecha, b.fechaFinal || null, b.responsable || null, b.copiados || [], actor.nombre, actor.perfil,
      new Date().toLocaleDateString("es-CL"), b.archivoNombre || null, b.archivoData || null
    ]
  );
  const itemId = r.rows[0].id;
  res.json({ id: itemId });

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

  // Avisos en la campanita del círculo de la promesa (solo tareas): al responsable que le
  // asignaron algo, y al remitente confirmando que quedó registrado — best-effort.
  if ((b.tipo || "tarea") === "tarea") {
    if (b.responsable && b.responsable.trim()) {
      crearAlerta(req.params.id, itemId, b.responsable.trim(), `Nueva tarea asignada: ${titulo}`).catch(() => {});
    }
    crearAlerta(req.params.id, itemId, actor.nombre, `Registraste la tarea: ${titulo}`).catch(() => {});
    evaluarRelacionaiTarea(req.params.id, itemId, titulo, b.desc || "").catch(err => console.error("evaluarRelacionaiTarea:", err));
  }
  // El agendamiento automático aplica tanto a tareas como a hitos — cuando el cerebro GADUAI
  // detecta "reunión"/"juntar" en la entrada inteligente (ver detectaReunion), el hito llega
  // acá con agendarReunion=true igual que una tarea con el checkbox marcado.
  if (b.agendarReunion) {
    agendaAgendarReunionAutomatica(req.params.id, itemId, actor, b.responsable, b.copiados || [], b.triage || "Rojo", titulo, b.reunionLugar)
      .catch(err => console.error("agendaAgendarReunionAutomatica:", err));
  }
}));

// ---------- entrevista formal (disponible a todos los perfiles) ----------
// Auditoría de seguridad: las fichas de Entrevista (nombre, correo, fono, motivo, desarrollo,
// compromisos) se podían leer sin credenciales. Cualquier perfil logueado las sigue viendo
// (así se diseñó en la Fase 1), pero ahora exige una cuenta real del colegio.
app.get("/api/colegios/:id/entrevistas", asyncRoute(async (req, res) => {
  const { correo, clave } = actorDeHeaders(req);
  const actor = await verificarActor(req.params.id, correo, clave);
  if (!actor) return res.status(401).json({ error: "credenciales_invalidas" });
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
  // personaId (Fase 19): si el nombre se eligió del autocompletar del directorio (Buscador o
  // Ausentismo incluidos), se valida que esa persona exista en este colegio y, al guardar,
  // queda también como una entrada en su historial. Con match, el RUT sale del directorio (no
  // de lo que mande el cliente, para no depender de que el frontend lo haya copiado bien); sin
  // match, se respeta un RUT escrito a mano si lo hay, y si tampoco eso, queda null y el
  // documento deja el espacio en blanco para escribirlo a mano.
  let personaId = null, rut = (b.rut || "").trim() || null;
  if (b.personaId) {
    const persona = await pool.query("select id, rut from directorio_personas where id=$1 and colegio_id=$2", [b.personaId, req.params.id]);
    if (persona.rows.length) { personaId = persona.rows[0].id; rut = persona.rows[0].rut || null; }
  }
  // Carpeta del historial (Fase 19b): elegida explícitamente en el formulario (con sugerencia
  // automática si el nombre vino del directorio) — nunca se adivina en el servidor.
  const TIPOS_ENTREVISTADO_VALIDOS = ["docente", "asistente", "estudiante", "apoderado", "otro"];
  const tipoEntrevistado = TIPOS_ENTREVISTADO_VALIDOS.includes(b.tipoEntrevistado) ? b.tipoEntrevistado : "otro";
  const r = await pool.query(
    `insert into entrevistas (colegio_id, nombre_entrevistado, correo, cargo, fono, fecha, hora, curso, motivo, entrevistador, desarrollo, compromisos, creado_por, perfil_creador, persona_id, rut, tipo_entrevistado)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning *`,
    [
      req.params.id, b.nombreEntrevistado.trim(), b.correo || null, b.cargo || null, b.fono || null,
      b.fecha || null, b.hora || null, b.curso || null, b.motivo || null,
      b.entrevistador || actor.nombre, b.desarrollo || null, b.compromisos || null,
      actor.nombre, actor.perfil, personaId, rut, tipoEntrevistado,
    ]
  );
  if (personaId) {
    await pool.query(
      `insert into historial_persona (persona_id, tipo, titulo, descripcion, autor, perfil)
       values ($1,'entrevista',$2,$3,$4,$5)`,
      [personaId, `Entrevista · ${b.fecha || new Date().toISOString().slice(0, 10)}`, b.motivo || null, actor.nombre, actor.perfil]
    ).catch(err => console.error("historial_persona (entrevista):", err.message));
  }
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

  // Avisos en la campanita del remitente/responsable según el paso — best-effort.
  if (accion === "aceptar") {
    crearAlerta(req.params.id, item.id, item.persona, `${actor.nombre} aceptó la tarea: ${item.titulo}`).catch(() => {});
  } else if (accion === "ok") {
    crearAlerta(req.params.id, item.id, item.persona, `${actor.nombre} marcó como realizada la tarea: ${item.titulo}`).catch(() => {});
  } else if (accion === "cerrar" && item.responsable) {
    crearAlerta(req.params.id, item.id, item.responsable, `Se cerró tu tarea: ${item.titulo}`).catch(() => {});
  }

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

// El responsable decide qué hacer con la oferta de Relacionai que le hizo el cerebro GADUAI al
// aceptar una tarea delicada: derivar, posponer o descartar. Se persiste para no repetirla salvo
// que haya elegido "recuérdamelo más tarde".
app.post("/api/colegios/:id/timeline/:itemId/relacionai-sugerencia", asyncRoute(async (req, res) => {
  const { decision, actorCorreo, actorClave } = req.body || {};
  if (!["recordar_luego", "no_necesario", "derivado"].includes(decision)) {
    return res.status(400).json({ error: "decision_invalida" });
  }
  const actor = await verificarActor(req.params.id, actorCorreo, actorClave);
  if (!actor) return res.status(401).json({ error: "credenciales_invalidas" });
  const r = await pool.query("select * from items where id=$1 and colegio_id=$2", [req.params.itemId, req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: "no_encontrado" });
  if (actor.nombre !== r.rows[0].responsable) return res.status(403).json({ error: "no_autorizado" });
  await pool.query("update items set relacionai_sugerencia=$1 where id=$2", [decision, req.params.itemId]);
  res.json({ ok: true });
}));

// El token SSO normal (generado al hacer login) expira en 2 minutos — insuficiente si la oferta
// de Relacionai aparece minutos u horas después. Esta ruta emite uno fresco en el momento del clic.
app.post("/api/colegios/:id/sso/relacionai-token", asyncRoute(async (req, res) => {
  const { actorCorreo, actorClave } = req.body || {};
  const actor = await verificarActor(req.params.id, actorCorreo, actorClave);
  if (!actor) return res.status(401).json({ error: "credenciales_invalidas" });
  if (!SSO_SHARED_SECRET || !PERFILES_SSO_RELACIONAI.includes(actor.perfil)) {
    return res.status(403).json({ error: "sin_acceso_relacionai" });
  }
  res.json({ token: generarSsoToken(actor.correo, actor.nombre, actor.perfil) });
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
  await crearAlerta(req.params.id, req.params.itemId, destinatario || "—", mensaje || null, { autor: actor.nombre });
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
// Tres etapas de aviso al responsable (no a Hitos, que no usan círculo de la promesa): 2 días
// antes, 1 día antes, y el mismo día — cada una avisa una sola vez (recordatorio_etapa nunca
// retrocede). La hora exacta la da el horario del Cron Job (9am para 2dias/1dia, 8am para
// hoy) — este endpoint revisa las tres condiciones en cada corrida, así que correrlo dos
// veces el mismo día (8am y 9am) es inofensivo.
const ETAPAS_VENCIMIENTO = [
  { dias: 2, etapa: "2dias", texto: "Quedan 2 días para vencer", plazo: "2 días" },
  { dias: 1, etapa: "1dia", texto: "Queda 1 día para vencer", plazo: "1 día" },
  { dias: 0, etapa: "hoy", texto: "Vence hoy", plazo: "hoy" },
];
app.post("/tasks/vencimientos", requireTasksSecret, asyncRoute(async (req, res) => {
  let revisados = 0, avisos = 0, correos = 0;
  for (const { dias, etapa, texto, plazo } of ETAPAS_VENCIMIENTO) {
    const r = await pool.query(
      `select * from items where tipo='tarea' and fecha = current_date + $1::int and circulo_estado <> 'cerrado'`,
      [dias]
    );
    revisados += r.rows.length;
    for (const it of r.rows) {
      if (it.recordatorio_etapa === etapa) continue;
      if (!it.responsable) { await pool.query("update items set recordatorio_etapa=$1 where id=$2", [etapa, it.id]); continue; }
      const mensaje = `${texto}: ${it.titulo}`;
      await crearAlerta(it.colegio_id, it.id, it.responsable, mensaje, { vencimiento: { evento: it.titulo, plazo } });
      avisos++;
      const u = await pool.query("select correo from usuarios where colegio_id=$1 and nombre=$2", [it.colegio_id, it.responsable]);
      if (u.rows[0]) {
        const ok = await enviarCorreo({
          to: u.rows[0].correo,
          asunto: mensaje,
          texto: `La tarea "${it.titulo}" ${texto.toLowerCase()}. Ingresa a GADUAI para revisarla.`,
        });
        if (ok) correos++;
      }
      await pool.query("update items set recordatorio_etapa=$1 where id=$2", [etapa, it.id]);
    }
  }
  res.json({ revisados, avisos, correos });
}));

// ---------- avisos de sistema (llamados por Relacionai, no por una persona) ----------
// Protegida con X-Admin-Key (mismo secreto que ya usan las rutas de administración de
// colegios) porque quien llama es otro backend de confianza, no un usuario logueado.
app.post("/api/sistema/avisos", requireAdminKey, asyncRoute(async (req, res) => {
  const { tipo, colegioId, caso, cantidad, fechaLimite, persona, dias } = req.body || {};
  const colegio = colegioId || DEFAULT_COLEGIO_ID;
  if (!colegio) return res.status(400).json({ error: "colegio_requerido" });
  const textoDias = dias === 2 ? "Quedan 2 días para vencer" : dias === 1 ? "Queda 1 día para vencer" : dias === 0 ? "Vence hoy" : "Vence pronto";
  let titulo, triage, fecha, perfilObjetivo = PERFIL_CONVIVENCIA;
  if (tipo === "relato_enviado") {
    titulo = `Relacionai: se envió la solicitud de relato a ${cantidad || "un"} destinatario(s) — caso ${caso}`;
    triage = "Azul";
    fecha = new Date().toISOString().slice(0, 10);
  } else if (tipo === "relato_por_vencer") {
    titulo = `Relacionai: ${textoDias.toLowerCase()} el relato del caso ${caso} (${fechaLimite})`;
    triage = "Rojo";
    fecha = fechaLimite;
  } else if (tipo === "caso_iniciado") {
    titulo = `Relacionai: se inició un caso nuevo — ${caso}`;
    triage = "Rojo";
    fecha = new Date().toISOString().slice(0, 10);
    perfilObjetivo = "Director/a de colegio";
  } else {
    return res.status(400).json({ error: "tipo_invalido" });
  }
  const r = await pool.query(
    `insert into items (colegio_id, tipo, triage, titulo, fecha, persona, perfil, creado)
     values ($1,'tarea',$2,$3,$4,'Relacionai (automático)',$5,$6) returning id`,
    [colegio, triage, titulo, fecha, perfilObjetivo, new Date().toLocaleDateString("es-CL")]
  );
  const itemId = r.rows[0].id;

  if (tipo === "caso_iniciado") {
    // Solo Director/a de colegio y el sostenedor (Director ejecutivo/máster) — el ítem ya
    // queda 'Rojo' así que el sostenedor lo ve igual aunque el perfil objetivo sea Director/a.
    const usuarios = await pool.query("select nombre from usuarios where colegio_id=$1 and perfil in ($2,$3)", [colegio, "Director/a de colegio", PERFIL_MASTER]);
    for (const u of usuarios.rows) {
      await crearAlerta(colegio, itemId, u.nombre, titulo);
    }
  } else if (tipo === "relato_por_vencer") {
    // Prioriza a la persona exacta que recepcionó el caso en Relacionai (cruce por nombre);
    // si no hay match, cae al perfil completo de Convivencia como respaldo (Fase 2).
    let destinatarios = persona ? (await pool.query("select nombre, correo from usuarios where colegio_id=$1 and nombre=$2", [colegio, persona])).rows : [];
    if (!destinatarios.length) {
      destinatarios = (await pool.query("select nombre, correo from usuarios where colegio_id=$1 and perfil=$2", [colegio, PERFIL_CONVIVENCIA])).rows;
    }
    for (const u of destinatarios) {
      const plazo = dias === 2 ? "2 días" : dias === 1 ? "1 día" : dias === 0 ? "hoy" : "pronto";
      await crearAlerta(colegio, itemId, u.nombre, titulo, { vencimiento: { evento: `el relato del caso ${caso}`, plazo } });
      await enviarCorreo({
        to: u.correo,
        asunto: titulo,
        texto: `El relato del caso ${caso} en Relacionai ${textoDias.toLowerCase()} (${fechaLimite}). Ingresa a Relacionai para revisarlo.`,
      });
    }
  }
  res.json({ ok: true });
}));

// ---------- documentos del colegio (alimentan el cerebro de IA GADUAI) ----------
// Subir/eliminar es solo del máster (mismo criterio que administrar usuarios); cualquier
// perfil puede listarlos para saber qué tiene cargado el colegio.
app.get("/api/colegios/:id/documentos", asyncRoute(async (req, res) => {
  const r = await pool.query(
    "select id, tipo, nombre, archivo_nombre, subido_por, creado_en from documentos where colegio_id=$1 order by creado_en desc",
    [req.params.id]
  );
  res.json(r.rows);
}));

app.post("/api/colegios/:id/documentos", asyncRoute(async (req, res) => {
  const { actorCorreo, actorClave, tipo, nombre, archivoNombre, archivoData } = req.body || {};
  const actor = await verificarActor(req.params.id, actorCorreo, actorClave);
  if (!actor || actor.perfil !== PERFIL_MASTER) return res.status(403).json({ error: "solo_master" });
  if (!tipo || !nombre) return res.status(400).json({ error: "campos_requeridos" });
  const r = await pool.query(
    "insert into documentos (colegio_id, tipo, nombre, archivo_nombre, archivo_data, subido_por) values ($1,$2,$3,$4,$5,$6) returning id, tipo, nombre, archivo_nombre, subido_por, creado_en",
    [req.params.id, tipo, nombre.trim(), archivoNombre || null, archivoData || null, actor.nombre]
  );
  res.json(r.rows[0]);
}));

app.delete("/api/colegios/:id/documentos/:docId", asyncRoute(async (req, res) => {
  const { actorCorreo, actorClave } = req.body || {};
  const actor = await verificarActor(req.params.id, actorCorreo, actorClave);
  if (!actor || actor.perfil !== PERFIL_MASTER) return res.status(403).json({ error: "solo_master" });
  await pool.query("delete from documentos where id=$1 and colegio_id=$2", [req.params.docId, req.params.id]);
  res.json({ ok: true });
}));

// ---------- IA GADUAI: chat con el "cerebro" del colegio ----------
// El contexto (documentos propios + normativa nacional) va como bloque cacheado del sistema:
// no cambia entre preguntas de un mismo colegio, así Anthropic solo cobra precio completo la
// primera vez y el resto son lecturas de caché (~90% más barato) — ver prompt caching.
async function armarContextoIA(colegioId) {
  const docs = await pool.query(
    "select tipo, nombre from documentos where colegio_id=$1 order by creado_en asc",
    [colegioId]
  );
  const normativa = await pool.query(
    "select titulo, texto from normativa order by id asc"
  );
  let contexto = "Eres GADUAI, el asistente de inteligencia organizacional de este colegio. " +
    "Respondes preguntas de cualquier perfil (director, UTP, inspector general, convivencia, dupla psicosocial, docentes) " +
    "usando el reglamento y documentos propios del colegio, y la normativa educacional chilena vigente que se te entrega abajo. " +
    "Sé claro, breve y práctico, en español de Chile. Si la pregunta requiere un criterio legal o profesional que no puedas " +
    "resolver con este contexto, dilo con honestidad en vez de inventar una respuesta.\n\n";
  if (docs.rows.length) {
    contexto += "=== Documentos cargados por este colegio (referencia por nombre; el máster los administra en Configuración) ===\n";
    contexto += docs.rows.map(d => `- [${d.tipo}] ${d.nombre}`).join("\n") + "\n\n";
  }
  if (normativa.rows.length) {
    contexto += "=== Normativa nacional ===\n";
    for (const n of normativa.rows) contexto += `\n[${n.titulo}]\n${n.texto}\n`;
  }
  return contexto;
}

// El cerebro GADUAI ofrece Relacionai cuando una tarea suena a caso delicado que requiere
// investigación (denuncia, agresión, etc.). Primer filtro: palabras clave, gratis y siempre
// disponible. Si no hay coincidencia y hay IA configurada, se le pide un veredicto usando el
// mismo contexto de reglamento/normativa que ya arma armarContextoIA para el chat de IA GADUAI
// (mismo bloque cacheado, así esta llamada extra sale barata). Best-effort: nunca bloquea la
// creación de la tarea, se llama de forma asíncrona después de responder al usuario.
const PALABRAS_CLAVE_RELACIONAI = [
  "denuncia", "agresion", "agresión", "abuso", "maltrato", "acoso", "bullying",
  "violencia", "amenaza", "vulneracion", "vulneración", "autolesion", "autolesión",
  "connotacion sexual", "connotación sexual", "grooming", "discriminacion", "discriminación"
];
async function evaluarRelacionaiTarea(colegioId, itemId, titulo, descripcion) {
  const texto = `${titulo} ${descripcion || ""}`.toLowerCase();
  if (PALABRAS_CLAVE_RELACIONAI.some(p => texto.includes(p))) {
    await pool.query(
      "update items set relacionai_sugerido=true, relacionai_motivo=$1 where id=$2",
      ["Contiene palabras clave que sugieren un caso a investigar.", itemId]
    );
    return;
  }
  if (!anthropic) return;
  try {
    const contexto = await armarContextoIA(colegioId);
    const completion = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 100,
      system: [{ type: "text", text: contexto, cache_control: { type: "ephemeral" } }],
      messages: [{
        role: "user",
        content: `Analiza esta tarea/hito registrado en GADUAI y decide, usando el reglamento y la normativa entregados arriba como criterio, si describe un caso delicado que amerita investigación formal (por ejemplo: una posible denuncia, agresión, maltrato, acoso, vulneración de derechos u otra situación similar que normalmente se deriva a convivencia escolar).\n\nTítulo: ${titulo}\nDescripción: ${descripcion || "(sin descripción)"}\n\nResponde EXACTAMENTE en dos líneas:\nSI o NO\n<motivo breve, máximo 15 palabras>`
      }]
    });
    const texto2 = completion.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    const [primera, ...resto] = texto2.split("\n");
    if (/^si\b/i.test((primera || "").trim())) {
      await pool.query(
        "update items set relacionai_sugerido=true, relacionai_motivo=$1 where id=$2",
        [resto.join(" ").trim() || "El cerebro GADUAI detectó un caso que conviene investigar.", itemId]
      );
    }
  } catch (err) {
    console.error("evaluarRelacionaiTarea (IA):", err.message);
  }
}

// ---------- Fase 12: entrada inteligente única ----------
// "Tú cuentas lo que ocurre; GADUAI organiza lo que sigue" — la persona escribe o dicta en
// lenguaje natural y el cerebro GADUAI propone tipo/triage/responsable/fecha, reutilizando el
// mismo contexto de reglamento+normativa que ya arma armarContextoIA. No crea nada: solo
// propone, para que el usuario dé su V°B° (o lo edite) en el formulario de siempre antes de
// registrar vía POST /timeline, que no cambia.
async function interpretarSituacion(colegioId, actor, texto, personasDisponibles) {
  if (!anthropic) return null;
  const hoy = new Date().toISOString().slice(0, 10);
  const listaPersonas = (personasDisponibles || []).map(p => `- ${p.nombre} (${p.perfil})`).join("\n") || "(sin personas registradas)";
  try {
    const contexto = await armarContextoIA(colegioId);
    const completion = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 400,
      system: [{ type: "text", text: contexto, cache_control: { type: "ephemeral" } }],
      messages: [{
        role: "user",
        content: `Una persona (${actor.nombre}, perfil ${actor.perfil}) escribió esto en GADUAI hoy ${hoy} describiendo una situación:\n\n"${texto}"\n\nClasifícala usando el criterio de triage de GADUAI:\n- Rojo: urgente + importante (actuar ahora)\n- Naranjo: urgente + no importante (delegable, resolver)\n- Azul: no urgente + importante (estratégico, planificar)\n- Gris: no urgente + no importante (diferible, programar)\n\nPersonas reales de este colegio disponibles como responsable (elige SOLO un nombre de esta lista, nunca inventes uno):\n${listaPersonas}\n\nResponde ÚNICAMENTE con un objeto JSON (sin texto antes ni después, sin \`\`\`) con esta forma exacta:\n{"tipo":"tarea"|"hito","triage":"Rojo"|"Naranjo"|"Azul"|"Gris","titulo":"...(breve, menos de 12 palabras)","fechaSugerida":"YYYY-MM-DD","responsableSugerido":"...(nombre exacto de la lista, o null si no aplica)","copiadosSugeridos":[...nombres de la lista...],"motivo":"...(breve, máximo 20 palabras, explica el porqué de la clasificación)"}`
      }]
    });
    const salida = completion.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    const match = salida.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const propuesta = JSON.parse(match[0]);
    if (!["tarea", "hito"].includes(propuesta.tipo)) propuesta.tipo = "tarea";
    if (!["Rojo", "Naranjo", "Azul", "Gris"].includes(propuesta.triage)) propuesta.triage = "Rojo";
    if (!propuesta.titulo) propuesta.titulo = texto.slice(0, 80);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(propuesta.fechaSugerida || "")) propuesta.fechaSugerida = hoy;
    const nombresValidos = new Set((personasDisponibles || []).map(p => p.nombre));
    if (!nombresValidos.has(propuesta.responsableSugerido)) propuesta.responsableSugerido = null;
    propuesta.copiadosSugeridos = (propuesta.copiadosSugeridos || []).filter(n => nombresValidos.has(n));
    return propuesta;
  } catch (err) {
    console.error("interpretarSituacion (IA):", err.message);
    return null;
  }
}

// Regla determinística (no depende de que haya IA configurada, igual que
// PALABRAS_CLAVE_RELACIONAI de la Fase 11): si la persona dice "reunión" o "juntar", GADUAI
// agenda automáticamente con todos los convocados (responsable + copiados + quien escribió) y
// el registro queda como Hito, no como Tarea — pedido explícito de Humberto. Se busca por RAÍZ
// ("reun"/"junt"), no por palabra exacta, para capturar cualquier conjugación: reunirme,
// reunirnos, reunámonos, junta, juntarnos, juntémonos, etc. — no solo el infinitivo.
// Con límite de palabra (\b) — sin esto, "junt" hacía falso positivo con "adjunto" o
// "conjunto" (palabras frecuentes en descripciones de tareas), que no tienen nada que ver con
// coordinar una reunión.
const RAIZ_REUNION_RE = /\b(reun|junt)/i;
function detectaReunion(texto) {
  return RAIZ_REUNION_RE.test(texto);
}

// Fase 19: si alguien con acceso a Ausentismo escribe que una persona faltó, GADUAI no abre
// el formulario normal de tarea/hito — abre directo el panel de Ausentismo con esa persona ya
// agregada. Regla determinística (no depende de IA), mismo patrón que detectaReunion.
const RAIZ_AUSENCIA_RE = /\b(falt|ausent|licencia)/i;
function detectaAusencia(texto) {
  return RAIZ_AUSENCIA_RE.test(texto);
}
// ¿El nombre de esta persona aparece mencionado en el texto? Exige al menos 2 tokens del
// nombre (o el único token, si el nombre es de una sola palabra) para evitar falsos positivos
// con un apellido muy común mencionado por otro motivo.
function nombreMencionadoEnTexto(nombrePersona, textoNorm) {
  const tokens = nombrePersona.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  if (!tokens.length) return false;
  const encontrados = tokens.filter(t => textoNorm.includes(t));
  return encontrados.length >= Math.min(2, tokens.length);
}

app.post("/api/colegios/:id/interpretar", asyncRoute(async (req, res) => {
  const { actorCorreo, actorClave, texto } = req.body || {};
  const actor = await verificarActor(req.params.id, actorCorreo, actorClave);
  if (!actor) return res.status(401).json({ error: "credenciales_invalidas" });
  if (!texto || !texto.trim()) return res.status(400).json({ error: "texto_requerido" });
  const textoLimpio = texto.trim();

  if (detectaAusencia(textoLimpio) && PERFILES_BUSCADOR.includes(actor.perfil)) {
    const funcionarios = (await pool.query(
      "select id, nombre from directorio_personas where colegio_id=$1 and tipo='funcionario' and activo=true",
      [req.params.id]
    )).rows;
    const textoNorm = textoLimpio.toLowerCase();
    const personasDetectadas = funcionarios.filter(f => nombreMencionadoEnTexto(f.nombre, textoNorm));
    return res.json({ ok: true, ausentismo: true, personasDetectadas });
  }

  const personas = (await pool.query(
    "select nombre, perfil from usuarios where colegio_id=$1 order by nombre", [req.params.id]
  )).rows;
  let propuesta = await interpretarSituacion(req.params.id, actor, textoLimpio, personas);
  if (detectaReunion(textoLimpio)) {
    if (!propuesta) {
      propuesta = {
        tipo: "hito", triage: "Naranjo", titulo: textoLimpio.slice(0, 80),
        fechaSugerida: new Date().toISOString().slice(0, 10),
        responsableSugerido: null, copiadosSugeridos: [],
        motivo: "Se detectó una solicitud de reunión."
      };
    }
    propuesta.tipo = "hito";
    propuesta.agendarReunion = true;
    propuesta.motivo = "GADUAI agenda automáticamente con todos los convocados. " + (propuesta.motivo || "");
  }
  if (!propuesta) return res.json({ ok: false });
  res.json({ ok: true, propuesta });
}));

// Auditoría de seguridad: cualquiera podía leer el chat privado de IA de CUALQUIER persona
// pasando `?persona=<nombre>` — sin credenciales. Ahora exige login y solo devuelve el propio
// chat de quien se autentica (persona sale de la cuenta verificada, no del query string).
app.get("/api/colegios/:id/chat-ia", asyncRoute(async (req, res) => {
  const { correo, clave } = actorDeHeaders(req);
  const actor = await verificarActor(req.params.id, correo, clave);
  if (!actor) return res.status(401).json({ error: "credenciales_invalidas" });
  const r = await pool.query(
    "select rol, contenido, fuente, creado_en from chat_ia where colegio_id=$1 and persona=$2 order by creado_en asc",
    [req.params.id, actor.nombre]
  );
  res.json(r.rows);
}));

app.post("/api/colegios/:id/chat-ia", asyncRoute(async (req, res) => {
  const { actorCorreo, actorClave, mensaje } = req.body || {};
  const actor = await verificarActor(req.params.id, actorCorreo, actorClave);
  if (!actor) return res.status(401).json({ error: "credenciales_invalidas" });
  if (!mensaje || !mensaje.trim()) return res.status(400).json({ error: "mensaje_requerido" });

  await pool.query(
    "insert into chat_ia (colegio_id, persona, rol, contenido, fuente) values ($1,$2,'user',$3,'gaduai')",
    [req.params.id, actor.nombre, mensaje.trim()]
  );

  if (!anthropic) return res.status(503).json({ error: "ia_no_configurada" });

  let respuesta;
  try {
    const contexto = await armarContextoIA(req.params.id);
    const historial = await pool.query(
      "select rol, contenido from chat_ia where colegio_id=$1 and persona=$2 order by creado_en asc limit 20",
      [req.params.id, actor.nombre]
    );
    const completion = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system: [{ type: "text", text: contexto, cache_control: { type: "ephemeral" } }],
      messages: historial.rows.map(h => ({ role: h.rol === "user" ? "user" : "assistant", content: h.contenido }))
    });
    respuesta = completion.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim()
      || "No tengo una respuesta clara para eso todavía.";
  } catch (err) {
    console.error("Error llamando a Claude:", err.message);
    respuesta = "No pude conectarme con el respaldo de IA en este momento. Intenta de nuevo en unos minutos.";
  }

  await pool.query(
    "insert into chat_ia (colegio_id, persona, rol, contenido, fuente) values ($1,$2,'assistant',$3,'claude')",
    [req.params.id, actor.nombre, respuesta]
  );
  res.json({ respuesta });
}));

// ---------- PULSO GADUAI (antes "Monitor Vital v2"): sugerencias diaria/semanal/mensual ----------
// El máster y el director de colegio miran el triage completo del colegio (más su propio
// hilo); el resto de los perfiles solo ve lo que ya le aparece en su Timeline.
const PERFIL_DIRECTOR_COLEGIO = "Director/a de colegio";
function itemsVisiblesSql(perfil) {
  if (perfil === PERFIL_MASTER || perfil === PERFIL_DIRECTOR_COLEGIO) {
    return "select * from items where colegio_id=$1 and revisado=false and (triage='Rojo' or perfil=$2 or persona=$3 or responsable=$3 or $3 = any(copiados)) order by fecha asc";
  }
  return "select * from items where colegio_id=$1 and revisado=false and (perfil=$2 or persona=$3 or responsable=$3 or $3 = any(copiados)) order by fecha asc";
}
function diasHasta(fecha) {
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  // `pg` entrega las columnas `date` como objeto Date (no como texto) — su `${...}` da
  // "Tue Sep 08 2026..." (no parseable), así que hay que pasar por toISOString() primero.
  // También acepta ya-string (por si alguna vez cambia el parser), slice(0,10) sirve para ambos.
  const fechaTexto = fecha instanceof Date ? fecha.toISOString() : String(fecha);
  const f = new Date(fechaTexto.slice(0, 10) + "T12:00:00");
  return Math.round((f - hoy) / 86400000);
}
// Fecha en "YYYY-MM-DD" limpio para mostrar en textos — mismo cuidado que diasHasta() con
// el objeto Date que entrega pg (su toString() da "Tue Sep 08 2026...", no sirve para UI).
function fechaSoloDia(fecha) {
  const fechaTexto = fecha instanceof Date ? fecha.toISOString() : String(fecha);
  return fechaTexto.slice(0, 10);
}
function generarSugerenciasMonitor(items) {
  const sugerencias = [];
  for (const it of items) {
    const dias = diasHasta(it.fecha);
    if (it.triage === "Rojo" && dias <= 0) {
      sugerencias.push({ periodo: "diaria", texto: `Atender hoy: "${it.titulo}" (vence ${fechaSoloDia(it.fecha)})` });
    } else if (it.triage === "Naranjo" && dias > 0 && dias <= 7) {
      sugerencias.push({ periodo: "semanal", texto: `Esta semana: "${it.titulo}" vence el ${fechaSoloDia(it.fecha)}` });
    }
  }
  const pendientesMes = items.filter(it => diasHasta(it.fecha) <= 30).length;
  const urgentesMes = items.filter(it => it.triage === "Rojo" && diasHasta(it.fecha) <= 30).length;
  if (pendientesMes > 0) {
    sugerencias.push({
      periodo: "mensual",
      texto: `Este mes hay ${pendientesMes} tarea(s) pendiente(s) en tu Timeline${urgentesMes ? ` (${urgentesMes} urgente(s))` : ""} — revisa el avance general.`
    });
  }
  return sugerencias;
}

// Nivel de un ítem para la tarjeta "Requiere tu atención" de PULSO GADUAI — mismo criterio de
// urgencia que ya usa generarSugerenciasMonitor, solo que acá se etiqueta el ítem real en vez
// de armar una frase.
function nivelAtencion(it) {
  const dias = diasHasta(it.fecha);
  if (it.triage === "Rojo" && dias <= 0) return "critico";
  if (dias === 0) return "hoy";
  if (it.triage === "Naranjo" && dias > 0 && dias <= 7) return "prioritario";
  return "listo";
}

// Auditoría de seguridad: igual que /timeline, se podía pedir `perfil=Director ejecutivo/máster`
// sin credenciales y ver todo PULSO GADUAI del colegio. Ahora perfil/persona salen de la cuenta
// verificada.
app.get("/api/colegios/:id/monitor", asyncRoute(async (req, res) => {
  const { correo, clave } = actorDeHeaders(req);
  const actor = await verificarActor(req.params.id, correo, clave);
  if (!actor) return res.status(401).json({ error: "credenciales_invalidas" });
  const perfil = actor.perfil, persona = actor.nombre;
  const items = (await pool.query(itemsVisiblesSql(perfil), [req.params.id, perfil, persona])).rows;
  const sugerencias = generarSugerenciasMonitor(items);

  const activas = (await pool.query(
    "select id, periodo, texto from monitor_tareas where colegio_id=$1 and persona=$2 and completada=false",
    [req.params.id, persona]
  )).rows;
  const textosActivos = new Set(activas.map(a => `${a.periodo}::${a.texto}`));
  for (const s of sugerencias) {
    const clave = `${s.periodo}::${s.texto}`;
    if (!textosActivos.has(clave)) {
      await pool.query(
        "insert into monitor_tareas (colegio_id, persona, periodo, texto, fecha_generada) values ($1,$2,$3,$4, current_date)",
        [req.params.id, persona, s.periodo, s.texto]
      );
    }
  }
  const textosVigentes = new Set(sugerencias.map(s => `${s.periodo}::${s.texto}`));
  const vencidas = activas.filter(a => !textosVigentes.has(`${a.periodo}::${a.texto}`)).map(a => a.id);
  if (vencidas.length) {
    await pool.query("delete from monitor_tareas where id = any($1)", [vencidas]);
  }

  const r = await pool.query(
    "select id, periodo, texto from monitor_tareas where colegio_id=$1 and persona=$2 and completada=false order by periodo, id",
    [req.params.id, persona]
  );

  // ---------- PULSO GADUAI: datos reales para el electro, el hero y las tarjetas ----------
  const criticos = items.filter(it => it.triage === "Rojo" && diasHasta(it.fecha) <= 0);
  const prioritarios = items.filter(it => it.triage === "Naranjo" && diasHasta(it.fecha) > 0 && diasHasta(it.fecha) <= 7);
  const hoyItems = items.filter(it => diasHasta(it.fecha) === 0);
  // "Decisión pendiente": tarea Rojo/Naranjo sin cerrar en el círculo de la promesa, abierta
  // hace más de 3 días — un atasco real, reutiliza columnas ya existentes desde la Fase 3.
  const decisionesPendientes = items.filter(it =>
    it.tipo === "tarea" && (it.triage === "Rojo" || it.triage === "Naranjo") &&
    it.circulo_estado !== "cerrado" && diasHasta(it.creado_en || it.fecha) <= -3
  );
  const alertasNoLeidas = (await pool.query(
    "select count(*)::int as n from alertas where destinatario=$1 and leida=false",
    [persona]
  )).rows[0].n;

  const estado = criticos.length > 0 ? "atencion" : "estable";
  // "Saturación" (no "gestión bajo control"): describe cuánto hay encima, no evalúa a la
  // persona — 0 = tranquilo, 100 = muy cargado. Sube con cada crítico/prioritario/vence-hoy.
  const saturacion = Math.min(100, criticos.length * 20 + prioritarios.length * 8 + hoyItems.length * 5);

  res.json({
    tareas: r.rows,
    hayCritico: criticos.length > 0,
    estado,
    saturacion,
    metricas: {
      hoy: hoyItems.length,
      prioritarias: prioritarios.length,
      decisiones: decisionesPendientes.length,
      alertas: alertasNoLeidas
    },
    atencion: items
      .filter(it => diasHasta(it.fecha) <= 30)
      .sort((a, b) => diasHasta(a.fecha) - diasHasta(b.fecha))
      .slice(0, 20)
      .map(it => ({ id: it.id, titulo: it.titulo, fecha: it.fecha, triage: it.triage, tipo: it.tipo, nivel: nivelAtencion(it) })),
    decisionesPendientes: decisionesPendientes.map(it => ({
      id: it.id,
      titulo: it.titulo,
      detalle: `${it.triage === "Rojo" ? "Crítico" : "Prioritario"} · sin cerrar hace más de 3 días`
    }))
  });
}));

app.post("/api/colegios/:id/monitor/:tareaId/completar", asyncRoute(async (req, res) => {
  const { actorCorreo, actorClave } = req.body || {};
  const actor = await verificarActor(req.params.id, actorCorreo, actorClave);
  if (!actor) return res.status(401).json({ error: "credenciales_invalidas" });
  const r = await pool.query(
    "update monitor_tareas set completada=true, fecha_completada=now() where id=$1 and colegio_id=$2 and persona=$3 returning id",
    [req.params.tareaId, req.params.id, actor.nombre]
  );
  if (!r.rows.length) return res.status(404).json({ error: "no_encontrada" });
  res.json({ ok: true });
}));

app.get("/api/colegios/:id/monitor/historial", asyncRoute(async (req, res) => {
  const { correo, clave } = actorDeHeaders(req);
  const actor = await verificarActor(req.params.id, correo, clave);
  if (!actor) return res.status(401).json({ error: "credenciales_invalidas" });
  const r = await pool.query(
    "select id, periodo, texto, fecha_completada from monitor_tareas where colegio_id=$1 and persona=$2 and completada=true order by fecha_completada desc limit 200",
    [req.params.id, actor.nombre]
  );
  res.json(r.rows);
}));

// Siembra/renueva un puñado de ítems de ejemplo (marcados "[Demo]") para que PULSO GADUAI
// tenga algo real que mostrar mientras el colegio todavía no tiene suficiente actividad
// propia — cubre los 4 niveles que ya distingue el electro/las tarjetas (crítico, vence hoy,
// prioritario, decisión pendiente) más un par de alertas no leídas. Idempotente: primero
// borra sus propios ejemplos anteriores, así se puede volver a llamar para refrescar fechas
// sin ir acumulando duplicados. Usa colegios/usuarios reales de este despliegue (un solo
// colegio por base de datos) en vez de datos inventados sueltos.
app.post("/api/sistema/seed-demo-pulso", requireSeedKey, asyncRoute(async (req, res) => {
  const colegioRow = await pool.query("select id from colegios limit 1");
  if (!colegioRow.rows.length) return res.status(404).json({ error: "sin_colegio" });
  const colegioId = colegioRow.rows[0].id;

  async function actorPorPerfil(perfil, fallback) {
    const r = await pool.query("select nombre from usuarios where colegio_id=$1 and perfil=$2 order by creado_en limit 1", [colegioId, perfil]);
    return r.rows[0] ? r.rows[0].nombre : fallback;
  }
  const director = await actorPorPerfil(PERFIL_DIRECTOR_COLEGIO, "Directora del colegio");
  const convivencia = await actorPorPerfil(PERFIL_CONVIVENCIA, "Encargada de Convivencia");
  const utp = await actorPorPerfil("UTP", "Jefe/a UTP");

  await pool.query("delete from items where colegio_id=$1 and titulo like '[Demo]%'", [colegioId]);

  function fechaOffset(dias) {
    const d = new Date(); d.setDate(d.getDate() + dias);
    return d.toISOString().slice(0, 10);
  }
  const hoyTexto = new Date().toLocaleDateString("es-CL");
  const demo = [
    { triage: "Rojo", titulo: "[Demo] Revisar situación de asistencia de un curso",
      descripcion: "Ejemplo de tarea crítica ya vencida — bórrala apenas tengas un caso real así.",
      fecha: fechaOffset(-1), persona: director, perfil: PERFIL_DIRECTOR_COLEGIO, responsable: convivencia },
    { triage: "Azul", titulo: "[Demo] Responder solicitud de un apoderado",
      descripcion: "Ejemplo de tarea que vence hoy mismo (nivel \"Hoy\", no crítico).",
      fecha: fechaOffset(0), persona: director, perfil: PERFIL_DIRECTOR_COLEGIO, responsable: convivencia },
    { triage: "Naranjo", titulo: "[Demo] Validar planificación de la próxima semana",
      descripcion: "Ejemplo de tarea prioritaria dentro de esta semana.",
      fecha: fechaOffset(4), persona: utp, perfil: "UTP", responsable: convivencia },
    { triage: "Naranjo", titulo: "[Demo] Aprobar cambio de horario de un curso",
      descripcion: "Ejemplo de decisión que lleva varios días sin resolverse.",
      fecha: fechaOffset(2), persona: director, perfil: PERFIL_DIRECTOR_COLEGIO, responsable: director, backdate: -5 },
    { triage: "Azul", titulo: "[Demo] Enviar informe de gestión mensual",
      descripcion: "Ejemplo de tarea de gestión general, sin urgencia.",
      fecha: fechaOffset(10), persona: director, perfil: PERFIL_DIRECTOR_COLEGIO, responsable: director }
  ];

  const ids = [];
  for (const d of demo) {
    const r = await pool.query(
      `insert into items (colegio_id, tipo, triage, titulo, descripcion, fecha, responsable, persona, perfil, creado)
       values ($1,'tarea',$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [colegioId, d.triage, d.titulo, d.descripcion, d.fecha, d.responsable, d.persona, d.perfil, hoyTexto]
    );
    ids.push(r.rows[0].id);
    if (d.backdate) {
      await pool.query("update items set creado_en = now() + make_interval(days => $2::int) where id=$1", [r.rows[0].id, d.backdate]);
    }
  }

  await pool.query("delete from alertas where destinatario=$1 and mensaje like '[Demo]%'", [director]);
  await pool.query(
    "insert into alertas (item_id, autor, destinatario, mensaje, fecha) values ($1,'Sistema',$2,$3,$4)",
    [ids[0], director, "[Demo] Vence hoy: revisar situación de asistencia", new Date().toLocaleString("es-CL")]
  );

  res.json({ ok: true, colegioId, itemsCreados: ids.length, actores: { director, convivencia, utp } });
}));

// ---------- Fase 17: mover un colegio entre despliegues (despliegue dedicado → compartido) ----------
// Exporta todo lo de un colegio como JSON (colegio, usuarios con su clave_hash tal cual, y cada
// tabla filtrada por colegio_id o vía join a items/directorio_personas). Se conservan los ids
// originales — el importador los reutiliza tal cual para que las referencias (item_id, etc.) no
// se rompan; por eso el importador después tiene que reajustar las secuencias de cada tabla.
app.get("/api/sistema/exportar/:id", requireMigracionKey, asyncRoute(async (req, res) => {
  const c = req.params.id;
  const colegio = (await pool.query("select * from colegios where id=$1", [c])).rows[0];
  if (!colegio) return res.status(404).json({ error: "no_encontrado" });
  const [usuarios, items, circuloHistorial, chatMensajes, alertas, pushSubs, entrevistas, documentos, chatIa, monitorTareas, directorioPersonas, historialPersona, agendaBloques] = await Promise.all([
    pool.query("select * from usuarios where colegio_id=$1", [c]),
    pool.query("select * from items where colegio_id=$1", [c]),
    pool.query("select ch.* from circulo_historial ch join items i on i.id=ch.item_id where i.colegio_id=$1", [c]),
    pool.query("select cm.* from chat_mensajes cm join items i on i.id=cm.item_id where i.colegio_id=$1", [c]),
    pool.query("select a.* from alertas a join items i on i.id=a.item_id where i.colegio_id=$1", [c]),
    pool.query("select * from push_subscripciones where colegio_id=$1", [c]),
    pool.query("select * from entrevistas where colegio_id=$1", [c]),
    pool.query("select * from documentos where colegio_id=$1", [c]),
    pool.query("select * from chat_ia where colegio_id=$1", [c]),
    pool.query("select * from monitor_tareas where colegio_id=$1", [c]),
    pool.query("select * from directorio_personas where colegio_id=$1", [c]),
    pool.query("select hp.* from historial_persona hp join directorio_personas dp on dp.id=hp.persona_id where dp.colegio_id=$1", [c]),
    pool.query("select * from agenda_bloques where colegio_id=$1", [c]),
  ]);
  res.json({
    colegio,
    usuarios: usuarios.rows, items: items.rows, circuloHistorial: circuloHistorial.rows,
    chatMensajes: chatMensajes.rows, alertas: alertas.rows, pushSubs: pushSubs.rows,
    entrevistas: entrevistas.rows, documentos: documentos.rows, chatIa: chatIa.rows,
    monitorTareas: monitorTareas.rows, directorioPersonas: directorioPersonas.rows,
    historialPersona: historialPersona.rows, agendaBloques: agendaBloques.rows,
  });
}));

// Importa el JSON de /exportar en este despliegue. Idempotente y seguro de reintentar: primero
// borra cualquier fila previa con el mismo colegio_id (cascade se lleva todo lo asociado), así
// que correrlo dos veces no duplica nada. Todo va en una sola transacción — si algo falla, no
// queda un import a medias.
//
// NO reutiliza los ids originales de las filas con bigserial: el despliegue destino ya puede
// tener OTROS colegios (con sus propios usuarios/items ocupando esos mismos números de id), así
// que forzar el id original chocaría con datos ajenos. En cambio, cada fila se inserta sin id
// (Postgres asigna uno nuevo) y se arma un mapa id-viejo→id-nuevo para `items` y
// `directorio_personas` — las únicas dos tablas que otras filas referencian por id
// (circulo_historial/chat_mensajes/alertas/agenda_bloques.item_id, historial_persona.persona_id)
// — así las relaciones quedan intactas aunque los números cambien. `colegios.id` sí se conserva
// tal cual porque es una clave natural (el slug del colegio), no un número autogenerado.
app.post("/api/sistema/importar", requireMigracionKey, asyncRoute(async (req, res) => {
  const d = req.body || {};
  if (!d.colegio || !d.colegio.id) return res.status(400).json({ error: "colegio_requerido" });
  const cliente = await pool.connect();
  try {
    await cliente.query("BEGIN");
    await cliente.query("delete from colegios where id=$1", [d.colegio.id]);
    const co = d.colegio;
    await cliente.query(
      "insert into colegios (id,nombre,comuna,relacionai_url,insignia_data,creado_en) values ($1,$2,$3,$4,$5,$6)",
      [co.id, co.nombre, co.comuna, co.relacionai_url, co.insignia_data, co.creado_en]
    );
    for (const u of d.usuarios || []) {
      await cliente.query(
        `insert into usuarios (colegio_id,nombre,correo,clave,perfil,creado_en,tema,clave_hash)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [u.colegio_id, u.nombre, u.correo, u.clave, u.perfil, u.creado_en, u.tema, u.clave_hash]
      );
    }
    const mapaItems = {};
    for (const it of d.items || []) {
      const r = await cliente.query(
        `insert into items (colegio_id,tipo,triage,titulo,descripcion,fecha,responsable,copiados,persona,perfil,creado,revisado,archivo_nombre,archivo_data,react,creado_en,recordatorio_enviado,recordatorio_etapa,circulo_estado,circulo_like,fecha_final,relacionai_sugerido,relacionai_motivo,relacionai_sugerencia,reunion_hora,reunion_lugar)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26) returning id`,
        [it.colegio_id, it.tipo, it.triage, it.titulo, it.descripcion, it.fecha, it.responsable, it.copiados, it.persona, it.perfil, it.creado, it.revisado, it.archivo_nombre, it.archivo_data, it.react, it.creado_en, it.recordatorio_enviado, it.recordatorio_etapa, it.circulo_estado, it.circulo_like, it.fecha_final, it.relacionai_sugerido, it.relacionai_motivo, it.relacionai_sugerencia, it.reunion_hora, it.reunion_lugar]
      );
      mapaItems[it.id] = r.rows[0].id;
    }
    for (const ch of d.circuloHistorial || []) {
      await cliente.query(
        `insert into circulo_historial (item_id,paso,autor,perfil,mensaje,archivo_nombre,archivo_data,creado_en) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [mapaItems[ch.item_id], ch.paso, ch.autor, ch.perfil, ch.mensaje, ch.archivo_nombre, ch.archivo_data, ch.creado_en]
      );
    }
    for (const cm of d.chatMensajes || []) {
      await cliente.query(
        `insert into chat_mensajes (item_id,autor,perfil,texto,fecha,creado_en) values ($1,$2,$3,$4,$5,$6)`,
        [mapaItems[cm.item_id], cm.autor, cm.perfil, cm.texto, cm.fecha, cm.creado_en]
      );
    }
    for (const a of d.alertas || []) {
      await cliente.query(
        `insert into alertas (item_id,autor,destinatario,mensaje,fecha,leida,creado_en) values ($1,$2,$3,$4,$5,$6,$7)`,
        [mapaItems[a.item_id], a.autor, a.destinatario, a.mensaje, a.fecha, a.leida, a.creado_en]
      );
    }
    for (const p of d.pushSubs || []) {
      await cliente.query(
        `insert into push_subscripciones (colegio_id,persona,endpoint,p256dh,auth,creado_en) values ($1,$2,$3,$4,$5,$6)
         on conflict (endpoint) do nothing`,
        [p.colegio_id, p.persona, p.endpoint, p.p256dh, p.auth, p.creado_en]
      );
    }
    for (const e of d.entrevistas || []) {
      await cliente.query(
        `insert into entrevistas (colegio_id,nombre_entrevistado,correo,cargo,fono,fecha,hora,curso,motivo,entrevistador,desarrollo,compromisos,creado_por,perfil_creador,creado_en)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [e.colegio_id, e.nombre_entrevistado, e.correo, e.cargo, e.fono, e.fecha, e.hora, e.curso, e.motivo, e.entrevistador, e.desarrollo, e.compromisos, e.creado_por, e.perfil_creador, e.creado_en]
      );
    }
    for (const doc of d.documentos || []) {
      await cliente.query(
        `insert into documentos (colegio_id,tipo,nombre,archivo_nombre,archivo_data,subido_por,creado_en) values ($1,$2,$3,$4,$5,$6,$7)`,
        [doc.colegio_id, doc.tipo, doc.nombre, doc.archivo_nombre, doc.archivo_data, doc.subido_por, doc.creado_en]
      );
    }
    for (const ci of d.chatIa || []) {
      await cliente.query(
        `insert into chat_ia (colegio_id,persona,rol,contenido,fuente,creado_en) values ($1,$2,$3,$4,$5,$6)`,
        [ci.colegio_id, ci.persona, ci.rol, ci.contenido, ci.fuente, ci.creado_en]
      );
    }
    for (const mt of d.monitorTareas || []) {
      await cliente.query(
        `insert into monitor_tareas (colegio_id,persona,periodo,texto,fecha_generada,completada,fecha_completada,creado_en) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [mt.colegio_id, mt.persona, mt.periodo, mt.texto, mt.fecha_generada, mt.completada, mt.fecha_completada, mt.creado_en]
      );
    }
    const mapaPersonas = {};
    for (const dp of d.directorioPersonas || []) {
      const r = await cliente.query(
        `insert into directorio_personas (colegio_id,tipo,nombre,rut,detalle,creado_por,creado_en) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [dp.colegio_id, dp.tipo, dp.nombre, dp.rut, dp.detalle, dp.creado_por, dp.creado_en]
      );
      mapaPersonas[dp.id] = r.rows[0].id;
    }
    for (const hp of d.historialPersona || []) {
      await cliente.query(
        `insert into historial_persona (persona_id,tipo,titulo,descripcion,autor,perfil,archivo_nombre,archivo_data,creado_en) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [mapaPersonas[hp.persona_id], hp.tipo, hp.titulo, hp.descripcion, hp.autor, hp.perfil, hp.archivo_nombre, hp.archivo_data, hp.creado_en]
      );
    }
    for (const ab of d.agendaBloques || []) {
      await cliente.query(
        `insert into agenda_bloques (colegio_id,persona,fecha,hora,estado,titulo,modalidad,meet_link,reservado_por,item_id,origen,creado_en) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [ab.colegio_id, ab.persona, ab.fecha, ab.hora, ab.estado, ab.titulo, ab.modalidad, ab.meet_link, ab.reservado_por, ab.item_id ? mapaItems[ab.item_id] : null, ab.origen, ab.creado_en]
      );
    }
    await cliente.query("COMMIT");
    res.json({
      ok: true,
      contadores: {
        usuarios: (d.usuarios || []).length, items: (d.items || []).length,
        circuloHistorial: (d.circuloHistorial || []).length, chatMensajes: (d.chatMensajes || []).length,
        alertas: (d.alertas || []).length, pushSubs: (d.pushSubs || []).length,
        entrevistas: (d.entrevistas || []).length, documentos: (d.documentos || []).length,
        chatIa: (d.chatIa || []).length, monitorTareas: (d.monitorTareas || []).length,
        directorioPersonas: (d.directorioPersonas || []).length, historialPersona: (d.historialPersona || []).length,
        agendaBloques: (d.agendaBloques || []).length,
      }
    });
  } catch (err) {
    await cliente.query("ROLLBACK");
    throw err;
  } finally {
    cliente.release();
  }
}));

// ---------- Buscador restringido: directorio de personas ----------
// Permiso especial: solo estos 4 perfiles pueden buscar/ver fichas, chequeado en el servidor
// (no basta con ocultar el botón en el frontend, porque son datos sensibles de menores/RUT).
const PERFILES_BUSCADOR = [PERFIL_MASTER, "Director/a de colegio", "UTP", "Inspector General"];
async function actorConAccesoBuscador(colegioId, correo, clave) {
  const actor = await verificarActor(colegioId, correo, clave);
  if (!actor || !PERFILES_BUSCADOR.includes(actor.perfil)) return null;
  return actor;
}
// Carga masiva y edición/baja del directorio: solo quien administra el colegio completo
// (mismos 2 perfiles que administran Relacionai) — UTP e Inspector General siguen pudiendo
// dar de alta una persona a la vez desde el Buscador (actorConAccesoBuscador), pero no un
// lote completo ni dar de baja a nadie.
const PERFILES_DIRECTORIO_ADMIN = [PERFIL_MASTER, "Director/a de colegio"];
async function actorAdminDirectorio(colegioId, correo, clave) {
  const actor = await verificarActor(colegioId, correo, clave);
  if (!actor || !PERFILES_DIRECTORIO_ADMIN.includes(actor.perfil)) return null;
  return actor;
}

// Búsqueda y ficha van por POST (no GET) aunque sean lecturas: así la clave del actor nunca
// viaja en la URL/query string (no queda en logs ni en el historial del navegador).
app.post("/api/colegios/:id/directorio/buscar", asyncRoute(async (req, res) => {
  const { actorCorreo, actorClave, q, incluirInactivos, tipo } = req.body || {};
  const actor = await actorConAccesoBuscador(req.params.id, actorCorreo, actorClave);
  if (!actor) return res.status(403).json({ error: "sin_permiso" });
  const termino = (q || "").trim();
  if (termino.length < 2) return res.json([]);
  const filtroTipo = ["funcionario", "estudiante"].includes(tipo) ? "and tipo=$3" : "";
  const params = [req.params.id, `%${termino}%`];
  if (filtroTipo) params.push(tipo);
  const r = await pool.query(
    `select id, tipo, nombre, rut, detalle, correo, activo from directorio_personas
     where colegio_id=$1 and (nombre ilike $2 or rut ilike $2) ${incluirInactivos ? "" : "and activo=true"} ${filtroTipo}
     order by nombre asc limit 30`,
    params
  );
  res.json(r.rows);
}));

// Autocompletar del nombre en Entrevista formal — a propósito NO usa actorConAccesoBuscador:
// Entrevista está disponible para todos los perfiles (no solo los 4 del Buscador), así que
// cualquier actor verificado del colegio puede buscar aquí. Devuelve menos que /buscar (sin
// "activo", ya filtrado a activos — no tiene sentido ofrecer para entrevistar a alguien dado
// de baja) y solo para autocompletar un formulario, no para explorar el directorio completo.
app.post("/api/colegios/:id/directorio/buscar-entrevista", asyncRoute(async (req, res) => {
  const { actorCorreo, actorClave, q } = req.body || {};
  const actor = await verificarActor(req.params.id, actorCorreo, actorClave);
  if (!actor) return res.status(401).json({ error: "credenciales_invalidas" });
  const termino = (q || "").trim();
  if (termino.length < 2) return res.json([]);
  const r = await pool.query(
    `select id, tipo, nombre, rut, detalle, correo from directorio_personas
     where colegio_id=$1 and activo=true and (nombre ilike $2 or rut ilike $2)
     order by nombre asc limit 30`,
    [req.params.id, `%${termino}%`]
  );
  res.json(r.rows);
}));

app.post("/api/colegios/:id/directorio", asyncRoute(async (req, res) => {
  const { actorCorreo, actorClave, tipo, nombre, rut, detalle, correo } = req.body || {};
  const actor = await actorConAccesoBuscador(req.params.id, actorCorreo, actorClave);
  if (!actor) return res.status(403).json({ error: "sin_permiso" });
  if (!tipo || !nombre || !nombre.trim()) return res.status(400).json({ error: "campos_requeridos" });
  const r = await pool.query(
    "insert into directorio_personas (colegio_id, tipo, nombre, rut, detalle, correo, creado_por) values ($1,$2,$3,$4,$5,$6,$7) returning id, tipo, nombre, rut, detalle, correo, activo",
    [req.params.id, tipo, nombre.trim(), rut || null, detalle || null, correo || null, actor.nombre]
  );
  res.json(r.rows[0]);
}));

app.post("/api/colegios/:id/directorio/:personaId/ver", asyncRoute(async (req, res) => {
  const { actorCorreo, actorClave } = req.body || {};
  const actor = await actorConAccesoBuscador(req.params.id, actorCorreo, actorClave);
  if (!actor) return res.status(403).json({ error: "sin_permiso" });
  const persona = await pool.query(
    "select id, tipo, nombre, rut, detalle, correo, activo from directorio_personas where id=$1 and colegio_id=$2",
    [req.params.personaId, req.params.id]
  );
  if (!persona.rows.length) return res.status(404).json({ error: "no_encontrada" });
  const historial = await pool.query(
    "select id, tipo, titulo, descripcion, autor, perfil, archivo_nombre, archivo_data, creado_en from historial_persona where persona_id=$1 order by creado_en desc",
    [req.params.personaId]
  );
  res.json({ ...persona.rows[0], historial: historial.rows });
}));

// Editar datos de una persona — mismos 4 perfiles del Buscador (no solo los 2 de carga
// masiva: corregir un RUT mal tipeado a mano es una edición chica, no una operación masiva).
app.post("/api/colegios/:id/directorio/:personaId/editar", asyncRoute(async (req, res) => {
  const { actorCorreo, actorClave, nombre, rut, detalle, correo } = req.body || {};
  const actor = await actorConAccesoBuscador(req.params.id, actorCorreo, actorClave);
  if (!actor) return res.status(403).json({ error: "sin_permiso" });
  if (!nombre || !nombre.trim()) return res.status(400).json({ error: "nombre_requerido" });
  const r = await pool.query(
    `update directorio_personas set nombre=$3, rut=$4, detalle=$5, correo=$6, actualizado_por=$7, actualizado_en=now()
     where id=$1 and colegio_id=$2 returning id, tipo, nombre, rut, detalle, correo, activo`,
    [req.params.personaId, req.params.id, nombre.trim(), rut || null, detalle || null, correo || null, actor.nombre]
  );
  if (!r.rows.length) return res.status(404).json({ error: "no_encontrada" });
  res.json(r.rows[0]);
}));

// Baja/reactivación lógica — solo los 2 perfiles que administran el colegio completo.
// Nunca se borra la fila: el historial (entrevistas, ausencias) sigue apuntando a persona_id.
app.post("/api/colegios/:id/directorio/:personaId/baja", asyncRoute(async (req, res) => {
  const { actorCorreo, actorClave } = req.body || {};
  const actor = await actorAdminDirectorio(req.params.id, actorCorreo, actorClave);
  if (!actor) return res.status(403).json({ error: "sin_permiso" });
  const r = await pool.query(
    `update directorio_personas set activo=false, actualizado_por=$3, actualizado_en=now()
     where id=$1 and colegio_id=$2 returning id`,
    [req.params.personaId, req.params.id, actor.nombre]
  );
  if (!r.rows.length) return res.status(404).json({ error: "no_encontrada" });
  res.json({ ok: true });
}));

app.post("/api/colegios/:id/directorio/:personaId/reactivar", asyncRoute(async (req, res) => {
  const { actorCorreo, actorClave } = req.body || {};
  const actor = await actorAdminDirectorio(req.params.id, actorCorreo, actorClave);
  if (!actor) return res.status(403).json({ error: "sin_permiso" });
  const r = await pool.query(
    `update directorio_personas set activo=true, actualizado_por=$3, actualizado_en=now()
     where id=$1 and colegio_id=$2 returning id`,
    [req.params.personaId, req.params.id, actor.nombre]
  );
  if (!r.rows.length) return res.status(404).json({ error: "no_encontrada" });
  res.json({ ok: true });
}));

// Carga masiva de colaboradores/estudiantes — el frontend ya parseó y validó el archivo
// (SheetJS), acá solo llega la lista de filas limpias. Por RUT: si ya existe activo en este
// colegio, se ACTUALIZA (detalle/correo) en vez de duplicar — así resubir la misma planilla
// a mitad de año, con datos al día, no crea personas repetidas.
app.post("/api/colegios/:id/directorio/carga-masiva", asyncRoute(async (req, res) => {
  const { actorCorreo, actorClave, tipo, filas } = req.body || {};
  const actor = await actorAdminDirectorio(req.params.id, actorCorreo, actorClave);
  if (!actor) return res.status(403).json({ error: "sin_permiso" });
  if (!["funcionario", "estudiante"].includes(tipo)) return res.status(400).json({ error: "tipo_invalido" });
  if (!Array.isArray(filas) || !filas.length) return res.status(400).json({ error: "sin_filas" });

  let creadas = 0, actualizadas = 0;
  const filasConError = [];
  const cliente = await pool.connect();
  try {
    await cliente.query("BEGIN");
    for (let i = 0; i < filas.length; i++) {
      const f = filas[i] || {};
      const nombre = (f.nombre || "").trim();
      if (!nombre) { filasConError.push({ fila: i + 1, motivo: "sin nombre" }); continue; }
      const rut = (f.rut || "").trim() || null;
      const detalle = (f.detalle || "").trim() || null;
      const correo = (f.correo || "").trim() || null;
      if (rut) {
        const r = await cliente.query(
          `update directorio_personas set nombre=$3, detalle=$4, correo=$5, activo=true, actualizado_por=$6, actualizado_en=now()
           where colegio_id=$1 and rut=$2 returning id`,
          [req.params.id, rut, nombre, detalle, correo, actor.nombre]
        );
        if (r.rows.length) { actualizadas++; continue; }
      }
      await cliente.query(
        "insert into directorio_personas (colegio_id, tipo, nombre, rut, detalle, correo, creado_por) values ($1,$2,$3,$4,$5,$6,$7)",
        [req.params.id, tipo, nombre, rut, detalle, correo, actor.nombre]
      );
      creadas++;
    }
    await cliente.query("COMMIT");
  } catch (e) {
    await cliente.query("ROLLBACK");
    throw e;
  } finally {
    cliente.release();
  }
  res.json({ creadas, actualizadas, filasConError });
}));

// Carga masiva de horario docente — reemplaza el horario completo de cada docente
// mencionado en la planilla (borra sus bloques viejos, inserta los nuevos), para que resubir
// el archivo a mitad de semestre no vaya acumulando bloques duplicados. Cada fila debe traer
// el RUT de alguien que YA exista en el directorio como funcionario (se sube primero la Fase
// 18, de ahí el mensaje de error explícito si no calza).
app.post("/api/colegios/:id/docentes-horario/carga-masiva", asyncRoute(async (req, res) => {
  const { actorCorreo, actorClave, filas } = req.body || {};
  const actor = await actorAdminDirectorio(req.params.id, actorCorreo, actorClave);
  if (!actor) return res.status(403).json({ error: "sin_permiso" });
  if (!Array.isArray(filas) || !filas.length) return res.status(400).json({ error: "sin_filas" });

  const DIAS = { lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5 };
  let creados = 0;
  const filasConError = [];
  const rutsTocados = new Set();
  const cliente = await pool.connect();
  try {
    await cliente.query("BEGIN");
    for (let i = 0; i < filas.length; i++) {
      const f = filas[i] || {};
      const rut = (f.rut || f.rutDocente || "").trim();
      const diaSemana = DIAS[sinTildes((f.dia || "").trim().toLowerCase())];
      const horaInicio = normHora(f.horaInicio);
      const horaFin = normHora(f.horaFin);
      if (!rut || !diaSemana || !horaInicio || !horaFin) {
        filasConError.push({ fila: i + 1, motivo: "faltan campos obligatorios (rut, día, hora inicio/fin)" });
        continue;
      }
      const persona = await cliente.query(
        "select id from directorio_personas where colegio_id=$1 and rut=$2 and tipo='funcionario' and activo=true",
        [req.params.id, rut]
      );
      if (!persona.rows.length) {
        filasConError.push({ fila: i + 1, motivo: `RUT ${rut} no está en Directorio: colaboradores — agréguelo primero ahí` });
        continue;
      }
      const personaId = persona.rows[0].id;
      if (!rutsTocados.has(personaId)) {
        await cliente.query("delete from docentes_horario where persona_id=$1", [personaId]);
        rutsTocados.add(personaId);
      }
      await cliente.query(
        `insert into docentes_horario (colegio_id, persona_id, dia_semana, hora_inicio, hora_fin, curso, asignatura, creado_por)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [req.params.id, personaId, diaSemana, horaInicio, horaFin, (f.curso || "").trim() || null, (f.asignatura || "").trim() || null, actor.nombre]
      );
      creados++;
    }
    await cliente.query("COMMIT");
  } catch (e) {
    await cliente.query("ROLLBACK");
    throw e;
  } finally {
    cliente.release();
  }
  res.json({ creados, docentesActualizados: rutsTocados.size, filasConError });
}));

app.post("/api/colegios/:id/directorio/:personaId/historial", asyncRoute(async (req, res) => {
  const { actorCorreo, actorClave, tipo, titulo, descripcion, archivoNombre, archivoData } = req.body || {};
  const actor = await actorConAccesoBuscador(req.params.id, actorCorreo, actorClave);
  if (!actor) return res.status(403).json({ error: "sin_permiso" });
  if (!tipo || !titulo || !titulo.trim()) return res.status(400).json({ error: "campos_requeridos" });
  const persona = await pool.query(
    "select id from directorio_personas where id=$1 and colegio_id=$2",
    [req.params.personaId, req.params.id]
  );
  if (!persona.rows.length) return res.status(404).json({ error: "no_encontrada" });
  const r = await pool.query(
    `insert into historial_persona (persona_id, tipo, titulo, descripcion, autor, perfil, archivo_nombre, archivo_data)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning id, tipo, titulo, descripcion, autor, perfil, archivo_nombre, archivo_data, creado_en`,
    [req.params.personaId, tipo, titulo.trim(), descripcion || null, actor.nombre, actor.perfil, archivoNombre || null, archivoData || null]
  );
  res.json(r.rows[0]);
}));

// ---------- Ausentismo (Fase 19): panorama del día y propuesta de reemplazo ----------
// Mismos 4 perfiles del Buscador pueden VER el panorama; solo 3 de ellos pueden EDITARLO
// (Director ejecutivo/máster queda en solo-lectura, igual que en el prototipo de referencia:
// ve el panorama completo del colegio pero no registra ausencias ni asigna reemplazos).
const PERFILES_AUSENTISMO_EDITA = ["Director/a de colegio", "UTP", "Inspector General"];
function diaSemanaDe(fechaStr) {
  const d = new Date(fechaStr + "T12:00:00"); // mediodía: evita cruzar de día por huso horario
  const dow = d.getDay(); // 0=domingo … 6=sábado
  return dow >= 1 && dow <= 5 ? dow : null;
}

app.get("/api/colegios/:id/ausentismo", asyncRoute(async (req, res) => {
  const { correo, clave } = actorDeHeaders(req);
  const actor = await actorConAccesoBuscador(req.params.id, correo, clave);
  if (!actor) return res.status(403).json({ error: "sin_permiso" });
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || "") ? req.query.fecha : new Date().toISOString().slice(0, 10);
  const ausencias = (await pool.query(
    `select a.id, a.persona_id, dp.nombre, dp.rut, dp.detalle as cargo, a.causa, a.creado_por, a.creado_en
     from ausencias a join directorio_personas dp on dp.id = a.persona_id
     where a.colegio_id=$1 and a.fecha=$2 order by a.creado_en`,
    [req.params.id, fecha]
  )).rows;
  let bloques = [];
  if (ausencias.length) {
    bloques = (await pool.query(
      `select ab.id, ab.ausencia_id, ab.docente_horario_id, ab.reemplazante_persona_id, ab.reemplazante_nombre_libre,
              dh.hora_inicio, dh.hora_fin, dh.curso, dh.asignatura, rp.nombre as reemplazante_nombre
       from ausencias_bloques ab
       join docentes_horario dh on dh.id = ab.docente_horario_id
       left join directorio_personas rp on rp.id = ab.reemplazante_persona_id
       where ab.ausencia_id = any($1) order by dh.hora_inicio`,
      [ausencias.map(a => a.id)]
    )).rows;
  }
  const porAusencia = {};
  for (const b of bloques) (porAusencia[b.ausencia_id] = porAusencia[b.ausencia_id] || []).push(b);
  const resultado = ausencias.map(a => ({ ...a, bloques: porAusencia[a.id] || [] }));
  const conReemplazo = bloques.filter(b => b.reemplazante_persona_id || b.reemplazante_nombre_libre).length;
  res.json({
    fecha,
    ausencias: resultado,
    puedeEditar: PERFILES_AUSENTISMO_EDITA.includes(actor.perfil),
    indicadores: {
      ausentesHoy: ausencias.length,
      bloquesConReemplazo: conReemplazo,
      bloquesSinReemplazo: bloques.length - conReemplazo,
    },
  });
}));

app.post("/api/colegios/:id/ausentismo/agregar", asyncRoute(async (req, res) => {
  const { actorCorreo, actorClave, personaId, causa, fecha } = req.body || {};
  const actor = await actorConAccesoBuscador(req.params.id, actorCorreo, actorClave);
  if (!actor) return res.status(403).json({ error: "sin_permiso" });
  if (!PERFILES_AUSENTISMO_EDITA.includes(actor.perfil)) return res.status(403).json({ error: "solo_lectura" });
  if (!personaId) return res.status(400).json({ error: "persona_requerida" });
  const fechaUsar = /^\d{4}-\d{2}-\d{2}$/.test(fecha || "") ? fecha : new Date().toISOString().slice(0, 10);
  const persona = await pool.query(
    "select id from directorio_personas where id=$1 and colegio_id=$2 and tipo='funcionario' and activo=true",
    [personaId, req.params.id]
  );
  if (!persona.rows.length) return res.status(404).json({ error: "persona_no_encontrada" });
  let ausenciaId;
  try {
    const r = await pool.query(
      "insert into ausencias (colegio_id, persona_id, fecha, causa, creado_por, perfil_creador) values ($1,$2,$3,$4,$5,$6) returning id",
      [req.params.id, personaId, fechaUsar, causa || null, actor.nombre, actor.perfil]
    );
    ausenciaId = r.rows[0].id;
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "ya_marcada_ausente_esa_fecha" });
    throw e;
  }
  const diaSemana = diaSemanaDe(fechaUsar);
  if (diaSemana) {
    const bloquesDia = (await pool.query(
      "select id from docentes_horario where persona_id=$1 and dia_semana=$2", [personaId, diaSemana]
    )).rows;
    for (const b of bloquesDia) {
      await pool.query("insert into ausencias_bloques (ausencia_id, docente_horario_id) values ($1,$2)", [ausenciaId, b.id]);
    }
  }
  // La ficha de una persona en el Buscador debe mostrar TODA su información — historial,
  // entrevistas, y también sus ausencias, no solo lo que se registró desde su propia ficha.
  await pool.query(
    `insert into historial_persona (persona_id, tipo, titulo, descripcion, autor, perfil)
     values ($1,'ausencia',$2,$3,$4,$5)`,
    [personaId, `Ausencia · ${fechaUsar}`, causa || null, actor.nombre, actor.perfil]
  ).catch(err => console.error("historial_persona (ausencia):", err.message));
  res.json({ ok: true, ausenciaId });
}));

app.post("/api/colegios/:id/ausentismo/:ausenciaId/causa", asyncRoute(async (req, res) => {
  const { actorCorreo, actorClave, causa } = req.body || {};
  const actor = await actorConAccesoBuscador(req.params.id, actorCorreo, actorClave);
  if (!actor) return res.status(403).json({ error: "sin_permiso" });
  if (!PERFILES_AUSENTISMO_EDITA.includes(actor.perfil)) return res.status(403).json({ error: "solo_lectura" });
  const r = await pool.query(
    "update ausencias set causa=$3 where id=$1 and colegio_id=$2 returning id",
    [req.params.ausenciaId, req.params.id, causa || null]
  );
  if (!r.rows.length) return res.status(404).json({ error: "no_encontrada" });
  res.json({ ok: true });
}));

app.post("/api/colegios/:id/ausentismo/:ausenciaId/quitar", asyncRoute(async (req, res) => {
  const { actorCorreo, actorClave } = req.body || {};
  const actor = await actorConAccesoBuscador(req.params.id, actorCorreo, actorClave);
  if (!actor) return res.status(403).json({ error: "sin_permiso" });
  if (!PERFILES_AUSENTISMO_EDITA.includes(actor.perfil)) return res.status(403).json({ error: "solo_lectura" });
  const r = await pool.query(
    "delete from ausencias where id=$1 and colegio_id=$2 returning id",
    [req.params.ausenciaId, req.params.id]
  );
  if (!r.rows.length) return res.status(404).json({ error: "no_encontrada" });
  res.json({ ok: true });
}));

// Candidatos a reemplazo: docentes con horario cargado, sin clase propia a esa misma hora ese
// día, y que no estén ellos mismos marcados ausentes esa fecha — hasta 5, ordenados por menor
// carga horaria semanal (para repartir parejo). No cruza con bloqueos de Agenda (Fase 10):
// queda para una iteración futura si las sugerencias resultan poco precisas en la práctica.
app.post("/api/colegios/:id/ausentismo/bloque/:bloqueId/sugerencias", asyncRoute(async (req, res) => {
  const { actorCorreo, actorClave } = req.body || {};
  const actor = await actorConAccesoBuscador(req.params.id, actorCorreo, actorClave);
  if (!actor) return res.status(403).json({ error: "sin_permiso" });
  const bloque = (await pool.query(
    `select ab.id, ab.ausencia_id, dh.dia_semana, dh.hora_inicio, dh.hora_fin, a.fecha, a.persona_id as ausente_persona_id
     from ausencias_bloques ab
     join docentes_horario dh on dh.id = ab.docente_horario_id
     join ausencias a on a.id = ab.ausencia_id
     where ab.id=$1 and a.colegio_id=$2`,
    [req.params.bloqueId, req.params.id]
  )).rows[0];
  if (!bloque) return res.status(404).json({ error: "no_encontrado" });
  const candidatos = (await pool.query(
    `select dp.id, dp.nombre, count(dh_all.id) as horas_semana
     from directorio_personas dp
     join docentes_horario dh_all on dh_all.persona_id = dp.id
     where dp.colegio_id=$1 and dp.tipo='funcionario' and dp.activo=true and dp.id <> $2
       and not exists (
         select 1 from docentes_horario dh2
         where dh2.persona_id = dp.id and dh2.dia_semana=$3 and dh2.hora_inicio < $5 and dh2.hora_fin > $4
       )
       and not exists (
         select 1 from ausencias a2 where a2.persona_id = dp.id and a2.fecha=$6
       )
     group by dp.id, dp.nombre
     order by horas_semana asc, dp.nombre asc
     limit 5`,
    [req.params.id, bloque.ausente_persona_id, bloque.dia_semana, bloque.hora_inicio, bloque.hora_fin, bloque.fecha]
  )).rows;
  res.json(candidatos);
}));

app.post("/api/colegios/:id/ausentismo/bloque/:bloqueId/reemplazo", asyncRoute(async (req, res) => {
  const { actorCorreo, actorClave, reemplazantePersonaId, reemplazanteNombreLibre } = req.body || {};
  const actor = await actorConAccesoBuscador(req.params.id, actorCorreo, actorClave);
  if (!actor) return res.status(403).json({ error: "sin_permiso" });
  if (!PERFILES_AUSENTISMO_EDITA.includes(actor.perfil)) return res.status(403).json({ error: "solo_lectura" });
  const r = await pool.query(
    `update ausencias_bloques set reemplazante_persona_id=$3, reemplazante_nombre_libre=$4
     where id=$1 and ausencia_id in (select id from ausencias where colegio_id=$2) returning id`,
    [req.params.bloqueId, req.params.id, reemplazantePersonaId || null, reemplazanteNombreLibre || null]
  );
  if (!r.rows.length) return res.status(404).json({ error: "no_encontrado" });
  res.json({ ok: true });
}));

app.post("/api/sistema/normativa", requireNormativaKey, asyncRoute(async (req, res) => {
  const items = Array.isArray(req.body) ? req.body : (req.body || {}).items;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "items_requerido" });
  for (const it of items) {
    if (!it.titulo || !it.texto) continue;
    await pool.query(
      `insert into normativa (titulo, tipo, categoria, aplica_publico, aplica_privado, texto)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (titulo) do update set
         tipo=excluded.tipo, categoria=excluded.categoria,
         aplica_publico=excluded.aplica_publico, aplica_privado=excluded.aplica_privado, texto=excluded.texto`,
      [it.titulo, it.tipo || null, it.categoria || null, it.aplicaPublico !== false, it.aplicaPrivado !== false, it.texto]
    );
  }
  res.json({ ok: true, cargados: items.length });
}));

// ---------- Agenda / Calendario (Fase 10) ----------
// Bloques fijos de 45 min, lunes a viernes, 08:00-16:15 — mismo horario que ya define el
// prototipo de referencia. Solo existe una fila en agenda_bloques cuando un bloque deja de
// estar "abierto"; la ausencia de fila para (persona,fecha,hora) es disponibilidad.
const AGENDA_HORAS = ["08:00", "08:45", "09:30", "10:15", "11:00", "11:45", "12:30", "13:15", "14:00", "14:45", "15:30"];
const AGENDA_DIAS_MAX = 30; // tope de reserva: máximo 1 mes hacia adelante

function agendaFechaISO(f) { return f instanceof Date ? f.toISOString().slice(0, 10) : String(f).slice(0, 10); }
function agendaHoraTexto(h) { return String(h).slice(0, 5); } // pg entrega time como "HH:MM:SS"

// Render corre el proceso en UTC (no en hora de Chile) — si "hoy"/"ahora" se calculan con
// new Date() a secas, cerca de la medianoche UTC (≈20-21 hrs en Chile) el servidor ya cree
// que es "mañana" mientras acá todavía es "hoy". Para que el tope de reserva y el motor de
// agendamiento automático usen siempre el calendario real de Chile, se leen explícitamente
// en esa zona horaria en vez de confiar en la hora local del proceso.
const AGENDA_TZ = "America/Santiago";
function agendaAhoraChile() {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: AGENDA_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(new Date());
  const v = {}; partes.forEach(p => { v[p.type] = p.value; });
  return { fecha: `${v.year}-${v.month}-${v.day}`, hora: parseInt(v.hour, 10), minuto: parseInt(v.minute, 10) };
}
// Suma/resta días a una fecha "YYYY-MM-DD" como aritmética de calendario pura (vía Date.UTC,
// sin componente de hora real) — evita cualquier salto de día por conversión de zona horaria.
function agendaSumarDias(fechaIso, dias) {
  const [y, m, d] = fechaIso.split("-").map(Number);
  const f = new Date(Date.UTC(y, m - 1, d));
  f.setUTCDate(f.getUTCDate() + dias);
  return f.toISOString().slice(0, 10);
}
function agendaDiaSemana(fechaIso) {
  const [y, m, d] = fechaIso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=domingo ... 6=sábado
}
function agendaDentroDeTope(fechaIso) {
  const hoy = agendaAhoraChile().fecha;
  const limite = agendaSumarDias(hoy, AGENDA_DIAS_MAX);
  return fechaIso >= hoy && fechaIso <= limite; // comparación de strings "YYYY-MM-DD" es válida
}

// Bloques no-abiertos (bloqueados o reservados) de una persona en un rango — lo que no
// aparece acá está disponible.
async function agendaBloquesDe(colegioId, persona, desde, hasta) {
  const r = await pool.query(
    "select fecha, hora, estado, titulo, modalidad, meet_link, reservado_por, item_id, origen from agenda_bloques where colegio_id=$1 and persona=$2 and fecha>=$3 and fecha<=$4 order by fecha, hora",
    [colegioId, persona, desde, hasta]
  );
  return r.rows.map(b => ({ ...b, fecha: agendaFechaISO(b.fecha), hora: agendaHoraTexto(b.hora) }));
}

// Busca el primer bloque de 45 min, dentro de los próximos `ventanaDias`, en que TODAS las
// `quienes` estén libres a la vez (lun-vie, sin ofrecer horas ya pasadas si es hoy). "hoy" y
// "ahora" se calculan en hora de Chile (ver agendaAhoraChile), no en la del proceso.
async function agendaBuscarBloqueComun(colegioId, quienes, ventanaDias) {
  const ahoraChile = agendaAhoraChile();
  const hoy = ahoraChile.fecha, horaAhora = ahoraChile.hora, minutoAhora = ahoraChile.minuto;
  const fechaLimite = agendaSumarDias(hoy, ventanaDias);
  const ocupados = await pool.query(
    "select persona, fecha, hora from agenda_bloques where colegio_id=$1 and persona = any($2) and fecha>=$3 and fecha<=$4",
    [colegioId, quienes, hoy, fechaLimite]
  );
  const ocupadoSet = new Set(ocupados.rows.map(r => `${r.persona}|${agendaFechaISO(r.fecha)}|${agendaHoraTexto(r.hora)}`));
  for (let d = 0; d <= ventanaDias; d++) {
    const fechaIso = agendaSumarDias(hoy, d);
    const diaSemana = agendaDiaSemana(fechaIso); // 0=domingo, 6=sábado
    if (diaSemana === 0 || diaSemana === 6) continue;
    for (const hora of AGENDA_HORAS) {
      if (d === 0) {
        const [hh, mm] = hora.split(":").map(Number);
        if (hh < horaAhora || (hh === horaAhora && mm <= minutoAhora)) continue;
      }
      if (quienes.every(p => !ocupadoSet.has(`${p}|${fechaIso}|${hora}`))) return { fecha: fechaIso, hora };
    }
  }
  return null;
}

// Se llama best-effort desde POST /timeline cuando se crea una tarea con agendarReunion=true.
// Ventana de búsqueda según urgencia (triage): Rojo = lo antes posible (hoy/mañana), Naranjo
// 2 días, Azul 4 días, Gris 5 días — la escala que pidió Humberto. Si no hay bloque en común:
// el Director (de colegio o ejecutivo/máster) igual agenda según su propia disponibilidad y
// los demás se adaptan; cualquier otro perfil solo recibe el aviso de coordinarlo a mano.
async function agendaAgendarReunionAutomatica(colegioId, itemId, actor, responsable, copiados, triage, titulo, lugar) {
  const personas = Array.from(new Set([actor.nombre, ...(responsable ? [responsable.trim()] : []), ...(copiados || []).filter(Boolean)]));
  if (personas.length < 2) return;
  const ventanaDias = { Rojo: 1, Naranjo: 2, Azul: 4, Gris: 5 }[triage] ?? 3;

  let bloque = await agendaBuscarBloqueComun(colegioId, personas, ventanaDias);
  let forzadoPorDirector = false;
  if (!bloque && (actor.perfil === PERFIL_MASTER || actor.perfil === PERFIL_DIRECTOR_COLEGIO)) {
    bloque = await agendaBuscarBloqueComun(colegioId, [actor.nombre], ventanaDias);
    forzadoPorDirector = !!bloque;
  }
  if (!bloque) {
    for (const p of personas) {
      crearAlerta(colegioId, itemId, p, `No se encontró un bloque en común para agendar la reunión de "${titulo}" — coordínenla manualmente en la Agenda.`).catch(() => {});
    }
    return;
  }
  // La fecha del ítem pasa a ser la fecha real encontrada por la Agenda (no la fecha en la que
  // se escribió la entrada) — así el Timeline muestra cuándo quedó agendada de verdad la
  // reunión, con su hora y lugar, tal como pidió Humberto.
  const lugarTexto = (lugar || "").trim() || null;
  await pool.query("update items set fecha=$1, reunion_hora=$2, reunion_lugar=$3 where id=$4", [bloque.fecha, bloque.hora, lugarTexto, itemId]);
  const lugarMsg = lugarTexto ? ` en ${lugarTexto}` : "";
  for (const p of personas) {
    await pool.query(
      `insert into agenda_bloques (colegio_id, persona, fecha, hora, estado, titulo, modalidad, item_id, origen)
       values ($1,$2,$3,$4,'reservado',$5,'presencial',$6,'automatico')
       on conflict (colegio_id, persona, fecha, hora) do nothing`,
      [colegioId, p, bloque.fecha, bloque.hora, `Reunión: ${titulo}${lugarMsg}`, itemId]
    );
    const mensaje = forzadoPorDirector
      ? `No se encontró un bloque en común — reunión agendada el ${bloque.fecha} a las ${bloque.hora}${lugarMsg} según la disponibilidad de ${actor.nombre}. "${titulo}".`
      : `Reunión agendada el ${bloque.fecha} a las ${bloque.hora}${lugarMsg} (presencial, 45 min) con: ${personas.filter(x => x !== p).join(", ")}. "${titulo}".`;
    crearAlerta(colegioId, itemId, p, mensaje).catch(() => {});
  }
}

// Agenda personal — solo el dueño ve/edita sus propios bloques (verificarActor + nombre exacto).
// Auditoría de seguridad: la agenda privada de cualquier persona (incluye el título de
// reuniones agendadas automáticamente, que puede ser el título de una tarea delicada) se podía
// leer sin credenciales. Ahora exige cualquier cuenta válida del colegio (no necesita ser la
// misma persona — el sentido de esto es coordinar reuniones con otros).
app.get("/api/colegios/:id/agenda", asyncRoute(async (req, res) => {
  const { correo, clave } = actorDeHeaders(req);
  const actor = await verificarActor(req.params.id, correo, clave);
  if (!actor) return res.status(401).json({ error: "credenciales_invalidas" });
  const { persona, desde, hasta } = req.query;
  if (!persona || !desde || !hasta) return res.status(400).json({ error: "persona_desde_hasta_requeridos" });
  res.json(await agendaBloquesDe(req.params.id, persona, desde, hasta));
}));

app.post("/api/colegios/:id/agenda/bloquear", asyncRoute(async (req, res) => {
  const { actorCorreo, actorClave, fecha, hora } = req.body || {};
  const actor = await verificarActor(req.params.id, actorCorreo, actorClave);
  if (!actor) return res.status(401).json({ error: "credenciales_invalidas" });
  if (!AGENDA_HORAS.includes(hora)) return res.status(400).json({ error: "hora_invalida" });
  const existente = await pool.query(
    "select id, estado from agenda_bloques where colegio_id=$1 and persona=$2 and fecha=$3 and hora=$4",
    [req.params.id, actor.nombre, fecha, hora]
  );
  if (existente.rows.length) {
    if (existente.rows[0].estado === "reservado") return res.status(409).json({ error: "bloque_reservado" });
    await pool.query("delete from agenda_bloques where id=$1", [existente.rows[0].id]); // vuelve a "abierto"
  } else {
    await pool.query(
      "insert into agenda_bloques (colegio_id, persona, fecha, hora, estado, origen) values ($1,$2,$3,$4,'bloqueado','manual')",
      [req.params.id, actor.nombre, fecha, hora]
    );
  }
  res.json({ ok: true });
}));

// Rutas públicas del link para compartir (sin login, igual que GET /api/colegios/:id ya es
// público) — quien recibe el link ve la disponibilidad de esa persona y reserva un bloque.
app.get("/api/colegios/:id/agenda-publica/:persona", asyncRoute(async (req, res) => {
  const hoy = agendaAhoraChile().fecha;
  const limite = agendaSumarDias(hoy, AGENDA_DIAS_MAX);
  const bloques = await agendaBloquesDe(req.params.id, req.params.persona, hoy, limite);
  res.json({ horas: AGENDA_HORAS, diasMax: AGENDA_DIAS_MAX, bloques });
}));

app.post("/api/colegios/:id/agenda-publica/:persona/reservar", asyncRoute(async (req, res) => {
  const { nombre, correo, fecha, hora, motivo } = req.body || {};
  if (!nombre || !correo || !fecha || !hora) return res.status(400).json({ error: "campos_requeridos" });
  if (!AGENDA_HORAS.includes(hora)) return res.status(400).json({ error: "hora_invalida" });
  if (!agendaDentroDeTope(fecha)) return res.status(400).json({ error: "fuera_de_rango" });
  const persona = req.params.persona;
  try {
    await pool.query(
      `insert into agenda_bloques (colegio_id, persona, fecha, hora, estado, titulo, reservado_por, origen)
       values ($1,$2,$3,$4,'reservado',$5,$6,'link_publico')`,
      [req.params.id, persona, fecha, hora, motivo || `Reunión con ${nombre}`, nombre]
    );
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "bloque_no_disponible" });
    throw e;
  }
  const asunto = `Reunión agendada: ${fecha} ${hora}`;
  const texto = `${nombre} agendó una reunión de 45 min con ${persona} el ${fecha} a las ${hora} hrs.${motivo ? `\nMotivo: ${motivo}` : ""}`;
  enviarCorreo({ to: correo, asunto, texto }).catch(() => {});
  pool.query("select correo from usuarios where colegio_id=$1 and nombre=$2", [req.params.id, persona])
    .then(ur => { if (ur.rows[0]) enviarCorreo({ to: ur.rows[0].correo, asunto, texto }).catch(() => {}); })
    .catch(() => {});
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
    background_color: "#0C0B70",
    theme_color: "#0C0B70",
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
// Auditoría de seguridad: migra a bcrypt las cuentas que todavía tengan clave en texto plano
// (columna `clave`) y no tengan `clave_hash` — se corre una sola vez por fila (idempotente:
// una fila ya migrada nunca vuelve a tocarse) y de forma automática en cada arranque, así no
// depende de que alguien entre a mano a la base de datos de producción a migrarla.
async function migrarClavesAHash() {
  const r = await pool.query("select id, clave from usuarios where clave_hash is null and clave is not null");
  for (const fila of r.rows) {
    const hash = await bcrypt.hash(fila.clave, 10);
    await pool.query("update usuarios set clave_hash=$1 where id=$2", [hash, fila.id]);
  }
  if (r.rows.length) console.log(`Seguridad: migradas ${r.rows.length} cuenta(s) de clave en texto plano a bcrypt.`);
}

async function start() {
  const fs = require("fs");
  const schema = fs.readFileSync(path.join(__dirname, "db", "schema.sql"), "utf8");
  await pool.query(schema);
  await migrarClavesAHash();
  app.listen(PORT, () => console.log(`TRIAGE GADUAI backend escuchando en el puerto ${PORT}`));
}
start().catch(err => {
  console.error("No se pudo iniciar el servidor:", err);
  process.exit(1);
});
