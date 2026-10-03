/**
 * GADUAI · Planificaciones (perfil UTP)
 * -------------------------------------
 * Cada mes la UTP recibe una planificación por cada asignatura y curso que hace cada docente.
 * Las docentes no tienen cuenta en GADUAI: reciben por correo un link personal (token) y suben
 * ahí sus archivos. Las asignaturas y cursos salen del horario docente (Configuración →
 * Horarios docentes) y el correo, del directorio de colaboradores.
 *
 * Calendario: el día `dia_envio` del mes salen solos los links del mes; el plazo es el día
 * `dia_limite`; el día anterior al plazo sale un recordatorio amable solo a quien no ha entregado.
 * Ambos los dispara la tarea diaria (/tasks/vencimientos) y son idempotentes.
 *
 * Etapa 1: envío, entrega, recordatorios, bandeja, avisos e historial. La revisión con IA, el
 * V°B° y el traspaso a Google Drive vienen en etapas siguientes.
 */
const crypto = require("crypto");

const PERFILES_PLANIFICACION = ["UTP"];
const PERSONA_AVISOS = "Planificaciones (automático)";
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
  "septiembre", "octubre", "noviembre", "diciembre"];
const ARCHIVO_MAX_BYTES = 10 * 1024 * 1024;
// Las planificaciones se entregan en Word o PDF.
const TIPOS_ARCHIVO = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
// Bytes 0x80-0x9F de Windows-1252 que no coinciden con Latin-1 (comillas tipográficas, guiones, etc.).
const CP1252 = { "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89,
  "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96,
  "—": 0x97, "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f };
// Repara un texto UTF-8 que quedó guardado como si fuera Windows-1252 ("3Â° bÃ¡sico" → "3° básico",
// "MuÃ±oz" → "Muñoz"). Pasaba con planillas .csv subidas antes de la corrección de lectura. Si el
// texto no tiene ese patrón, o no se puede reparar limpiamente, se devuelve tal cual.
function arreglarTildes(texto) {
  const s = String(texto ?? "");
  if (!/[ÃÂ]/.test(s)) return texto;
  const bytes = [];
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c <= 0xff) bytes.push(c);
    else if (CP1252[ch] !== undefined) bytes.push(CP1252[ch]);
    else return texto;
  }
  const r = Buffer.from(bytes).toString("utf8");
  return r.includes("\uFFFD") ? texto : r;
}

// Corrige en la base los textos que ya quedaron mal codificados (horarios y directorio). Idempotente:
// solo toca filas con el patrón y se puede correr en cada arranque.
async function repararTextosMalCodificados(pool) {
  const tablas = [["docentes_horario", ["curso", "asignatura"]], ["directorio_personas", ["nombre", "detalle"]]];
  let corregidas = 0;
  for (const [tabla, cols] of tablas) {
    const filtro = cols.map((c) => `${c} ~ '[ÃÂ]'`).join(" or ");
    const filas = (await pool.query(`select id, ${cols.join(", ")} from ${tabla} where ${filtro}`)).rows;
    for (const f of filas) {
      const nuevos = cols.map((c) => arreglarTildes(f[c]));
      if (nuevos.some((v, i) => v !== f[cols[i]])) {
        await pool.query(`update ${tabla} set ${cols.map((c, i) => `${c}=$${i + 2}`).join(", ")} where id=$1`, [f.id, ...nuevos]);
        corregidas++;
      }
    }
  }
  if (corregidas) console.log(`Textos con tildes mal codificadas reparados: ${corregidas} fila(s).`);
}

const DATA_URI_RE = /^data:([\w.+-]+\/[\w.+-]+)?(;[\w.+=-]+)*;base64,([A-Za-z0-9+/=\s]+)$/;

function registrarPlanificaciones(app, d) {
  const { pool, asyncRoute, verificarActor, actorDeHeaders, crearAlerta, enviarCorreo, correoConfigurado, ahoraChile, sumarDias } = d;

  // ---------- utilidades ----------
  const nombreMes = (mes) => MESES[mes - 1];
  const tituloPeriodo = (p) => `${nombreMes(p.mes)} ${p.anio}`;
  // La base entrega las columnas date como objeto Date (medianoche UTC en Render): siempre se
  // pasan a "YYYY-MM-DD" antes de mostrarlas o compararlas.
  function fechaLarga(fecha) {
    const [y, m, dd] = isoFecha(fecha).split("-").map(Number);
    const dia = new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString("es-CL", { weekday: "long", timeZone: "UTC" });
    return `${dia} ${dd} de ${MESES[m - 1]}`;
  }
  const isoFecha = (f) => (f instanceof Date ? f.toISOString() : String(f)).slice(0, 10);
  // Día límite dentro del mes (si el mes no tiene ese día, el último día del mes).
  function fechaLimiteDe(anio, mes, dia) {
    const ultimo = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
    return `${anio}-${String(mes).padStart(2, "0")}-${String(Math.min(dia, ultimo)).padStart(2, "0")}`;
  }
  const normalizar = (s) => String(s || "").trim().replace(/\s+/g, " ");
  const claveAsignatura = (s) => normalizar(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  function baseUrl(req) {
    const env = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
    if (env) return env.replace(/\/$/, "");
    return req ? `${req.protocol}://${req.get("host")}` : "";
  }
  async function historial(colegioId, periodoId, accion, detalle, autor) {
    await pool.query(
      "insert into planificacion_historial (colegio_id, periodo_id, accion, detalle, autor) values ($1,$2,$3,$4,$5)",
      [colegioId, periodoId, accion, detalle || null, autor]
    );
  }
  async function actorUtp(req, colegioId) {
    const { correo, clave } = req.method === "GET" ? actorDeHeaders(req)
      : { correo: (req.body || {}).actorCorreo, clave: (req.body || {}).actorClave };
    const actor = await verificarActor(colegioId, correo, clave);
    if (!actor || !PERFILES_PLANIFICACION.includes(actor.perfil)) return null;
    return actor;
  }
  async function configDe(colegioId) {
    await pool.query("insert into planificacion_config (colegio_id) values ($1) on conflict do nothing", [colegioId]);
    return (await pool.query("select * from planificacion_config where colegio_id=$1", [colegioId])).rows[0];
  }
  const nombresUtp = async (colegioId) =>
    (await pool.query("select nombre from usuarios where colegio_id=$1 and perfil = any($2)", [colegioId, PERFILES_PLANIFICACION]))
      .rows.map((r) => r.nombre);

  // Docentes que planifican: funcionarios activos con asignatura y curso en su horario.
  async function docentesConHorario(colegioId) {
    const r = await pool.query(
      `select p.id as persona_id, p.nombre, p.correo, h.asignatura, h.curso
         from docentes_horario h join directorio_personas p on p.id = h.persona_id
        where h.colegio_id=$1 and p.activo and coalesce(trim(h.asignatura),'') <> '' and coalesce(trim(h.curso),'') <> ''`,
      [colegioId]
    );
    const porPersona = new Map();
    for (const f of r.rows) {
      if (!porPersona.has(f.persona_id)) porPersona.set(f.persona_id, { persona_id: f.persona_id, nombre: f.nombre, correo: f.correo, items: new Map() });
      const asignatura = normalizar(arreglarTildes(f.asignatura)), curso = normalizar(arreglarTildes(f.curso));
      porPersona.get(f.persona_id).items.set(`${claveAsignatura(asignatura)}|${curso.toLowerCase()}`, { asignatura, curso });
    }
    return [...porPersona.values()].map((p) => ({ ...p, items: [...p.items.values()] }));
  }

  // Crea el período del mes (si no existe) con su hito en el Timeline de la UTP, y suma las
  // docentes y asignaturas que aún no estén. Nunca borra: lo ya entregado se conserva.
  async function asegurarPeriodo(colegioId, anio, mes, fechaLimite, autor) {
    let periodo = (await pool.query("select * from planificacion_periodos where colegio_id=$1 and anio=$2 and mes=$3", [colegioId, anio, mes])).rows[0];
    if (!periodo) {
      const item = (await pool.query(
        `insert into items (colegio_id, tipo, triage, titulo, descripcion, fecha, persona, perfil, creado)
         values ($1,'hito','Azul',$2,$3,$4,$5,'UTP',$6) returning id`,
        [colegioId, `📁 Planificaciones de ${nombreMes(mes)} ${anio}`,
          `Plazo de entrega: ${fechaLarga(fechaLimite)}. Los avisos de cada planificación recibida llegan aquí.`,
          fechaLimite, PERSONA_AVISOS, new Date().toLocaleDateString("es-CL")]
      )).rows[0];
      periodo = (await pool.query(
        `insert into planificacion_periodos (colegio_id, anio, mes, fecha_limite, item_id) values ($1,$2,$3,$4,$5)
         on conflict (colegio_id, anio, mes) do nothing returning *`,
        [colegioId, anio, mes, fechaLimite, item.id]
      )).rows[0] || (await pool.query("select * from planificacion_periodos where colegio_id=$1 and anio=$2 and mes=$3", [colegioId, anio, mes])).rows[0];
      await historial(colegioId, periodo.id, "Período creado", `Planificaciones de ${nombreMes(mes)} ${anio}, plazo ${fechaLarga(fechaLimite)}.`, autor);
    }
    await sincronizarDocentes(colegioId, periodo);
    return periodo;
  }

  // Lleva el mes al horario vigente: suma docentes y asignaturas nuevas, y quita las entradas
  // pendientes (sin archivo) que ya no están en el horario — ej. si se corrigió la planilla.
  // Lo ya entregado nunca se borra.
  async function sincronizarDocentes(colegioId, periodo) {
    const conHorario = await docentesConHorario(colegioId);
    const vigentes = new Set(conHorario.map((d) => String(d.persona_id)));
    for (const doc of conHorario) {
      let pd = (await pool.query("select * from planificacion_docentes where periodo_id=$1 and persona_id=$2", [periodo.id, doc.persona_id])).rows[0];
      if (!pd) {
        pd = (await pool.query(
          `insert into planificacion_docentes (periodo_id, colegio_id, persona_id, nombre, correo, token)
           values ($1,$2,$3,$4,$5,$6) returning *`,
          [periodo.id, colegioId, doc.persona_id, doc.nombre, doc.correo || null, crypto.randomBytes(24).toString("base64url")]
        )).rows[0];
      } else if (doc.correo && doc.correo !== pd.correo) {
        await pool.query("update planificacion_docentes set correo=$1 where id=$2", [doc.correo, pd.id]);
      }
      for (const it of doc.items) {
        await pool.query(
          `insert into planificaciones (periodo_docente_id, periodo_id, colegio_id, asignatura, curso)
           values ($1,$2,$3,$4,$5) on conflict do nothing`,
          [pd.id, periodo.id, colegioId, it.asignatura, it.curso]
        );
      }
      const claves = doc.items.map((it) => `${claveAsignatura(it.asignatura)}|${it.curso.toLowerCase()}`);
      const actuales = (await pool.query(
        "select id, asignatura, curso from planificaciones where periodo_docente_id=$1 and estado='pendiente' and archivo_data is null", [pd.id]
      )).rows;
      for (const p of actuales) {
        if (!claves.includes(`${claveAsignatura(p.asignatura)}|${normalizar(p.curso).toLowerCase()}`)) {
          await pool.query("delete from planificaciones where id=$1", [p.id]);
        }
      }
    }
    // Docentes que ya no tienen horario: se quitan solo si no entregaron nada.
    const enMes = (await pool.query("select id, persona_id from planificacion_docentes where periodo_id=$1", [periodo.id])).rows;
    for (const pd of enMes) {
      if (vigentes.has(String(pd.persona_id))) continue;
      const entrego = (await pool.query("select 1 from planificaciones where periodo_docente_id=$1 and estado <> 'pendiente' limit 1", [pd.id])).rows.length;
      if (!entrego) await pool.query("delete from planificacion_docentes where id=$1", [pd.id]);
    }
  }

  async function itemsDe(pdId) {
    return (await pool.query(
      "select asignatura, curso, estado from planificaciones where periodo_docente_id=$1 order by asignatura, curso", [pdId]
    )).rows;
  }
  const listaItems = (items) => items.map((i) => `  • ${i.asignatura} · ${i.curso}`).join("\n");

  async function enviarLink(periodo, pd, colegioNombre, base, autor) {
    if (!pd.correo) return false;
    const items = await itemsDe(pd.id);
    const link = `${base}/planificacion/${pd.token}`;
    const ok = await enviarCorreo({
      to: pd.correo,
      asunto: `Planificación de ${tituloPeriodo(periodo)} · ${colegioNombre}`,
      texto: `Hola, ${pd.nombre}:\n\nYa puedes entregar tu planificación de ${tituloPeriodo(periodo)} para:\n${listaItems(items)}\n\n` +
        `El plazo es hasta el ${fechaLarga(periodo.fecha_limite)}.\n\nSúbela aquí (es tu link personal):\n${link}\n\n` +
        `Cordialmente,\nUnidad Técnico-Pedagógica\n${colegioNombre}`,
    });
    if (ok) {
      await pool.query("update planificacion_docentes set link_enviado_en=now() where id=$1", [pd.id]);
      await historial(periodo.colegio_id, periodo.id, "Link enviado", `${pd.nombre} (${pd.correo})`, autor);
    }
    return ok;
  }

  async function enviarRecordatorio(periodo, pd, colegioNombre, base) {
    if (!pd.correo) return false;
    const pendientes = (await itemsDe(pd.id)).filter((i) => i.estado === "pendiente");
    if (!pendientes.length) return false;
    const ok = await enviarCorreo({
      to: pd.correo,
      asunto: `Recordatorio: mañana vence el plazo de tu planificación · ${colegioNombre}`,
      texto: `Hola, ${pd.nombre}:\n\nTe recuerdo que mañana se vence el plazo para entregar la planificación de ${tituloPeriodo(periodo)}:\n` +
        `${listaItems(pendientes)}\n\nPuedes subirla aquí:\n${base}/planificacion/${pd.token}\n\nCordialmente,\nUnidad Técnica`,
    });
    if (ok) {
      await pool.query("update planificacion_docentes set recordatorio_enviado_en=now() where id=$1", [pd.id]);
      await historial(periodo.colegio_id, periodo.id, "Recordatorio enviado", `${pd.nombre} (${pd.correo})`, "Sistema");
    }
    return ok;
  }

  // ---------- tarea diaria (la llama /tasks/vencimientos) ----------
  async function tareaDiaria() {
    const hoy = ahoraChile().fecha;
    const [anio, mes, dia] = hoy.split("-").map(Number);
    const base = baseUrl(null);
    const resumen = { links: 0, recordatorios: 0 };
    const configs = (await pool.query(
      `select c.*, co.nombre as colegio_nombre from planificacion_config c join colegios co on co.id=c.colegio_id
        where c.activo and c.envio_automatico`
    )).rows;
    for (const c of configs) {
      try {
        let periodo = (await pool.query("select * from planificacion_periodos where colegio_id=$1 and anio=$2 and mes=$3", [c.colegio_id, anio, mes])).rows[0];
        if (dia >= c.dia_envio && (!periodo || !periodo.links_enviados_en)) {
          periodo = await asegurarPeriodo(c.colegio_id, anio, mes, fechaLimiteDe(anio, mes, c.dia_limite), "Sistema");
          const docentes = (await pool.query("select * from planificacion_docentes where periodo_id=$1 and link_enviado_en is null", [periodo.id])).rows;
          let enviadosColegio = 0;
          for (const pd of docentes) if (await enviarLink(periodo, pd, c.colegio_nombre, base, "Sistema")) enviadosColegio++;
          resumen.links += enviadosColegio;
          // Si no salió ningún correo (sin correo configurado o falla), se reintenta mañana.
          if (enviadosColegio) await pool.query("update planificacion_periodos set links_enviados_en=now() where id=$1", [periodo.id]);
        }
        // Recordatorios: el día anterior al plazo de cualquier período abierto (incluye uno con fecha propia).
        const porVencer = (await pool.query(
          "select * from planificacion_periodos where colegio_id=$1 and fecha_limite=$2::date and recordatorio_enviado_en is null",
          [c.colegio_id, sumarDias(hoy, 1)]
        )).rows;
        for (const p of porVencer) {
          const docentes = (await pool.query("select * from planificacion_docentes where periodo_id=$1", [p.id])).rows;
          for (const pd of docentes) if (await enviarRecordatorio(p, pd, c.colegio_nombre, base)) resumen.recordatorios++;
          await pool.query("update planificacion_periodos set recordatorio_enviado_en=now() where id=$1", [p.id]);
        }
      } catch (err) {
        console.error("Planificaciones: error en la tarea diaria de", c.colegio_id, "-", err.message);
      }
    }
    return resumen;
  }

  // ---------- rutas de la UTP ----------
  app.get("/api/colegios/:id/planificaciones", asyncRoute(async (req, res) => {
    const colegioId = req.params.id;
    const actor = await actorUtp(req, colegioId);
    if (!actor) return res.status(403).json({ error: "solo_utp" });
    const config = await configDe(colegioId);
    const hoy = ahoraChile().fecha;
    const anio = parseInt(req.query.anio, 10) || Number(hoy.slice(0, 4));
    const mes = parseInt(req.query.mes, 10) || Number(hoy.slice(5, 7));
    const periodo = (await pool.query("select * from planificacion_periodos where colegio_id=$1 and anio=$2 and mes=$3", [colegioId, anio, mes])).rows[0] || null;
    let docentes = [];
    if (periodo) {
      await sincronizarDocentes(colegioId, periodo);
      const pds = (await pool.query(
        "select id, persona_id, nombre, correo, token, link_enviado_en, recordatorio_enviado_en from planificacion_docentes where periodo_id=$1 order by nombre", [periodo.id]
      )).rows;
      const planes = (await pool.query(
        `select id, periodo_docente_id, asignatura, curso, estado, archivo_nombre, archivo_bytes, entregada_en, atrasada
           from planificaciones where periodo_id=$1 order by asignatura, curso`, [periodo.id]
      )).rows;
      const base = baseUrl(req);
      docentes = pds.map(({ token, ...pd }) => ({ ...pd, link: `${base}/planificacion/${token}`,
        items: planes.filter((p) => String(p.periodo_docente_id) === String(pd.id)) }));
    }
    const conHorario = await docentesConHorario(colegioId);
    const sinCorreo = conHorario.filter((d) => !d.correo).map((d) => d.nombre);
    const hist = (await pool.query(
      "select accion, detalle, autor, creado_en from planificacion_historial where colegio_id=$1 order by creado_en desc limit 60", [colegioId]
    )).rows;
    res.json({
      hoy, anio, mes, config, correoActivo: correoConfigurado(), periodo: periodo && { ...periodo, fecha_limite: isoFecha(periodo.fecha_limite) },
      fechaLimiteSugerida: fechaLimiteDe(anio, mes, config.dia_limite), docentes, sinCorreo, historial: hist,
      previstos: { docentes: conHorario.length, planificaciones: conHorario.reduce((n, d) => n + d.items.length, 0),
        nombres: conHorario.map((d) => ({ nombre: d.nombre, conCorreo: !!d.correo })).sort((a, b) => a.nombre.localeCompare(b.nombre)) },
    });
  }));

  app.post("/api/colegios/:id/planificaciones/config", asyncRoute(async (req, res) => {
    const colegioId = req.params.id;
    const actor = await actorUtp(req, colegioId);
    if (!actor) return res.status(403).json({ error: "solo_utp" });
    const diaEnvio = parseInt(req.body.diaEnvio, 10), diaLimite = parseInt(req.body.diaLimite, 10);
    if (!(diaEnvio >= 1 && diaEnvio <= 28) || !(diaLimite >= 1 && diaLimite <= 31) || diaEnvio > diaLimite) {
      return res.status(400).json({ error: "dias_invalidos" });
    }
    await configDe(colegioId);
    await pool.query(
      `update planificacion_config set dia_envio=$2, dia_limite=$3, envio_automatico=$4, activo=true,
              actualizado_por=$5, actualizado_en=now() where colegio_id=$1`,
      [colegioId, diaEnvio, diaLimite, req.body.envioAutomatico !== false, actor.nombre]
    );
    await historial(colegioId, null, "Configuración actualizada",
      `Links el día ${diaEnvio}, plazo el día ${diaLimite} de cada mes, envío ${req.body.envioAutomatico !== false ? "automático" : "manual"}.`, actor.nombre);
    res.json({ ok: true });
  }));

  // Envía (o reenvía) los links del mes. Sin personaId: a todas las docentes que tengan algo
  // pendiente. Con personaId: solo a esa docente. Crea el período si aún no existe.
  app.post("/api/colegios/:id/planificaciones/enviar", asyncRoute(async (req, res) => {
    const colegioId = req.params.id;
    const actor = await actorUtp(req, colegioId);
    if (!actor) return res.status(403).json({ error: "solo_utp" });
    const anio = parseInt(req.body.anio, 10), mes = parseInt(req.body.mes, 10);
    if (!(anio >= 2024 && mes >= 1 && mes <= 12)) return res.status(400).json({ error: "mes_invalido" });
    const config = await configDe(colegioId);
    let fechaLimite = /^\d{4}-\d{2}-\d{2}$/.test(req.body.fechaLimite || "") ? req.body.fechaLimite : fechaLimiteDe(anio, mes, config.dia_limite);
    const periodo = await asegurarPeriodo(colegioId, anio, mes, fechaLimite, actor.nombre);
    if (req.body.fechaLimite && isoFecha(periodo.fecha_limite) !== fechaLimite) {
      await pool.query("update planificacion_periodos set fecha_limite=$1, recordatorio_enviado_en=null where id=$2", [fechaLimite, periodo.id]);
      periodo.fecha_limite = fechaLimite;
      await historial(colegioId, periodo.id, "Plazo cambiado", `Nuevo plazo: ${fechaLarga(fechaLimite)}.`, actor.nombre);
    }
    await pool.query("update planificacion_config set activo=true where colegio_id=$1", [colegioId]);
    const colegio = (await pool.query("select nombre from colegios where id=$1", [colegioId])).rows[0];
    let docentes = (await pool.query("select * from planificacion_docentes where periodo_id=$1", [periodo.id])).rows;
    if (req.body.personaId) docentes = docentes.filter((pd) => String(pd.persona_id) === String(req.body.personaId));
    // "soloPreparar": crea el mes y los links sin enviar correos (para copiarlos o enviar uno a uno).
    if (req.body.soloPreparar) {
      return res.json({ ok: true, preparado: true, enviados: 0, sinCorreo: 0, fallidos: 0, correoActivo: correoConfigurado(), docentes: docentes.length });
    }
    let enviados = 0, sinCorreo = 0, fallidos = 0;
    const porEnviar = [];
    for (const pd of docentes) {
      const items = await itemsDe(pd.id);
      if (!req.body.personaId && !items.some((i) => i.estado === "pendiente")) continue;
      if (req.body.soloSinLink && pd.link_enviado_en) continue; // "solo a las que aún no lo reciben"
      if (!pd.correo) { sinCorreo++; continue; }
      porEnviar.push(pd);
    }
    // De a 5 correos a la vez: con 20 o más docentes, uno por uno demoraría demasiado.
    for (let i = 0; i < porEnviar.length; i += 5) {
      const lote = await Promise.all(porEnviar.slice(i, i + 5).map((pd) => enviarLink(periodo, pd, colegio.nombre, baseUrl(req), actor.nombre)));
      lote.forEach((ok) => { if (ok) enviados++; else fallidos++; });
    }
    // Solo se da por "enviado el mes" si de verdad salió algún correo: así, si el correo falla,
    // la tarea diaria lo vuelve a intentar al otro día.
    if (enviados) await pool.query("update planificacion_periodos set links_enviados_en=coalesce(links_enviados_en, now()) where id=$1", [periodo.id]);
    if (fallidos) await historial(colegioId, periodo.id, "Envío fallido", `${fallidos} correo(s) no se pudieron enviar${correoConfigurado() ? "" : ": este GADUAI no tiene configurado el envío de correos"}.`, actor.nombre);
    res.json({ ok: true, enviados, sinCorreo, fallidos, correoActivo: correoConfigurado(), docentes: docentes.length });
  }));

  app.get("/api/colegios/:id/planificaciones/:planId/archivo", asyncRoute(async (req, res) => {
    const colegioId = req.params.id;
    const actor = await actorUtp(req, colegioId);
    if (!actor) return res.status(403).json({ error: "solo_utp" });
    const r = await pool.query(
      "select archivo_nombre, archivo_data from planificaciones where id=$1 and colegio_id=$2 and archivo_data is not null",
      [req.params.planId, colegioId]
    );
    if (!r.rows.length) return res.status(404).json({ error: "no_encontrado" });
    res.json({ nombre: r.rows[0].archivo_nombre, data: r.rows[0].archivo_data });
  }));

  // ---------- rutas públicas de la docente (link personal, sin cuenta) ----------
  const intentosToken = new Map(); // token -> [cantidad, desde]: frena subidas en ráfaga
  async function docentePorToken(token) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token || "")) return null;
    const r = await pool.query(
      `select pd.*, p.anio, p.mes, p.fecha_limite, p.item_id, co.nombre as colegio_nombre
         from planificacion_docentes pd join planificacion_periodos p on p.id=pd.periodo_id
         join colegios co on co.id=pd.colegio_id where pd.token=$1`, [token]
    );
    return r.rows[0] || null;
  }

  app.get("/api/plan-docente/:token", asyncRoute(async (req, res) => {
    let pd = await docentePorToken(req.params.token);
    if (!pd) return res.status(404).json({ error: "link_invalido" });
    const periodoActual = (await pool.query("select * from planificacion_periodos where id=$1", [pd.periodo_id])).rows[0];
    await sincronizarDocentes(pd.colegio_id, periodoActual);
    pd = await docentePorToken(req.params.token);
    if (!pd) return res.status(404).json({ error: "link_invalido" });
    const items = (await pool.query(
      `select id, asignatura, curso, estado, archivo_nombre, entregada_en, atrasada
         from planificaciones where periodo_docente_id=$1 order by asignatura, curso`, [pd.id]
    )).rows;
    // Historial de todas sus entregas en GADUAI (este mes y anteriores), del más reciente al más antiguo.
    const historialEntregas = (await pool.query(
      `select e.archivo_nombre, e.archivo_bytes, e.atrasada, e.comprobante_enviado, e.entregada_en,
              p.asignatura, p.curso, per.anio, per.mes
         from planificacion_entregas e join planificaciones p on p.id=e.planificacion_id
         join planificacion_periodos per on per.id=p.periodo_id
        where p.colegio_id=$1 and e.periodo_docente_id in (select id from planificacion_docentes where persona_id=$2)
        order by e.entregada_en desc limit 100`, [pd.colegio_id, pd.persona_id]
    )).rows;
    res.json({
      correo: pd.correo ? pd.correo.replace(/^(.).*(@.*)$/, "$1•••$2") : null, historial: historialEntregas,
      colegio: pd.colegio_nombre, docente: pd.nombre, anio: pd.anio, mes: pd.mes, mesNombre: nombreMes(pd.mes),
      fechaLimite: isoFecha(pd.fecha_limite), hoy: ahoraChile().fecha, items,
    });
  }));

  app.post("/api/plan-docente/:token/items/:planId", asyncRoute(async (req, res) => {
    const token = req.params.token;
    const ahora = Date.now();
    const [n, desde] = intentosToken.get(token) || [0, ahora];
    const ventana = ahora - desde > 15 * 60 * 1000 ? [0, ahora] : [n, desde];
    if (ventana[0] >= 30) return res.status(429).json({ error: "demasiados_intentos" });
    intentosToken.set(token, [ventana[0] + 1, ventana[1]]);

    const pd = await docentePorToken(token);
    if (!pd) return res.status(404).json({ error: "link_invalido" });
    const plan = (await pool.query("select * from planificaciones where id=$1 and periodo_docente_id=$2", [req.params.planId, pd.id])).rows[0];
    if (!plan) return res.status(404).json({ error: "no_encontrado" });
    if (plan.estado === "revisada") return res.status(409).json({ error: "ya_revisada" });

    const nombre = String((req.body || {}).nombre || "").trim().slice(0, 180);
    const data = String((req.body || {}).data || "");
    const ext = (nombre.match(/\.([a-z0-9]+)$/i) || [])[1];
    const m = data.match(DATA_URI_RE);
    if (!nombre || !ext || !TIPOS_ARCHIVO[ext.toLowerCase()] || !m) return res.status(400).json({ error: "formato_invalido" });
    const bytes = Math.floor(m[3].replace(/\s/g, "").length * 3 / 4);
    if (bytes > ARCHIVO_MAX_BYTES) return res.status(413).json({ error: "archivo_grande" });
    const dataLimpia = `data:${TIPOS_ARCHIVO[ext.toLowerCase()]};base64,${m[3].replace(/\s/g, "")}`;

    const hoy = ahoraChile().fecha;
    const atrasada = hoy > isoFecha(pd.fecha_limite);
    const reemplazo = plan.estado === "entregada";
    await pool.query(
      `update planificaciones set archivo_nombre=$2, archivo_bytes=$3, archivo_data=$4, estado='entregada',
              entregada_en=now(), atrasada=$5 where id=$1`,
      [plan.id, nombre, bytes, dataLimpia, atrasada]
    );
    const que = `${plan.asignatura} · ${plan.curso}`;
    const accion = reemplazo ? "Planificación reemplazada" : "Planificación recibida";
    const entrega = (await pool.query(
      `insert into planificacion_entregas (planificacion_id, periodo_docente_id, archivo_nombre, archivo_bytes, atrasada)
       values ($1,$2,$3,$4,$5) returning id, entregada_en`, [plan.id, pd.id, nombre, bytes, atrasada]
    )).rows[0];
    // Comprobante a la docente: qué entregó, cuándo y que el archivo llegó bien.
    let comprobante = false;
    if (pd.correo) {
      const cuando = new Date(entrega.entregada_en);
      const dia = cuando.toLocaleDateString("es-CL", { timeZone: "America/Santiago", weekday: "long", day: "numeric", month: "long", year: "numeric" });
      const hora = cuando.toLocaleTimeString("es-CL", { timeZone: "America/Santiago", hour: "2-digit", minute: "2-digit", hour12: false });
      const tam = bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
      comprobante = await enviarCorreo({
        to: pd.correo,
        asunto: `Comprobante: recibimos tu planificación de ${plan.asignatura} · ${plan.curso}`,
        texto: `Hola, ${pd.nombre}:\n\nRecibimos correctamente tu planificación${reemplazo ? " (reemplaza la anterior)" : ""}.\n\n` +
          `  Asignatura: ${plan.asignatura}\n  Curso: ${plan.curso}\n  Mes: ${nombreMes(pd.mes)} ${pd.anio}\n` +
          `  Fecha: ${dia}\n  Hora: ${hora} hrs\n  Archivo adjunto: ${nombre} (${tam}) ✓ recibido\n` +
          `  Plazo: ${fechaLarga(pd.fecha_limite)} · ${atrasada ? "entregada después del plazo" : "entregada a tiempo"}\n\n` +
          `Si necesitas cambiarla, puedes reemplazarla desde tu link mientras la Unidad Técnica no la haya revisado.\n\n` +
          `Cordialmente,\nUnidad Técnico-Pedagógica\n${pd.colegio_nombre}`,
      });
      if (comprobante) await pool.query("update planificacion_entregas set comprobante_enviado=true where id=$1", [entrega.id]);
    }
    await historial(pd.colegio_id, pd.periodo_id, accion, `${pd.nombre} — ${que}${atrasada ? " (atrasada)" : ""}`, pd.nombre);
    if (pd.item_id) {
      for (const utp of await nombresUtp(pd.colegio_id)) {
        crearAlerta(pd.colegio_id, pd.item_id, utp, `${accion}: ${pd.nombre} — ${que}${atrasada ? " (atrasada)" : ""}`,
          { autor: "Planificaciones" }).catch(() => {});
      }
    }
    res.json({ ok: true, atrasada, comprobante, entregadaEn: entrega.entregada_en });
  }));

  return { tareaDiaria, PERSONA_AVISOS };
}

module.exports = { registrarPlanificaciones, PERFILES_PLANIFICACION, repararTextosMalCodificados, arreglarTildes };
