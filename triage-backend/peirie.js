/**
 * GADUAI · PEI/RIE (Proyecto Educativo Institucional + Reglamento Interno)
 * ------------------------------------------------------------------------
 * Acompaña al colegio en la actualización de su PEI y su RIE: el colegio sube ambos documentos,
 * la IA los diagnostica por separado contra la matriz normativa (común a todos los colegios y
 * aprobada por el abogado de GADUAI, en peirie-matriz.json) y luego cruza los dos documentos
 * (motor de coherencia). Cada hallazgo muestra la evidencia y la fuente; el equipo decide y puede
 * convertirlo en una tarea del Timeline con círculo de la promesa.
 *
 * Fase 1: expediente, documentos con versiones, diagnóstico con IA, coherencia, hallazgos →
 * tareas y decisiones. La participación de la comunidad y el expediente final vienen después.
 *
 * Reglas que no se negocian: la IA propone y nunca aprueba ni declara infracciones; el tipo de
 * exigencia de un hallazgo lo pone la matriz (no la IA); sin requisito de la matriz, el hallazgo
 * queda como "Sugerencia de la IA".
 */
const path = require("path");
const fs = require("fs");

const PERFILES_PEIRIE = ["Director ejecutivo/máster", "Director/a de colegio", "UTP", "Encargado de Convivencia Educativa"];
const MODELO = "claude-opus-5-5";
const DOC_MAX_BYTES = 25 * 1024 * 1024;
const TIPOS_DOC = ["pei", "rie", "anexo"];
const TIPOS_HALLAZGO = ["obligacion", "instruccion", "facultativa", "orientacion", "sugerencia_ia"];
const ESTADOS_HALLAZGO = ["abierto", "en_tarea", "resuelto", "descartado"];
const RELACIONES = ["contradiccion", "dependencia", "sin_norma", "coherente"];
const PERSONA_AVISOS = "PEI/RIE (automático)";
// Estamentos que participan en la actualización (art. 16 H LGE: todos los estamentos).
const ESTAMENTOS = {
  directivos: "Equipo directivo", docentes: "Docentes", asistentes: "Asistentes de la educación",
  estudiantes: "Estudiantes", apoderados: "Madres, padres y apoderados", consejo: "Consejo Escolar",
};
const PERTINENCIAS = ["pertinente", "requiere_deliberacion", "no_pertinente"];
const DATA_URI_RE = /^data:([\w.+-]+\/[\w.+-]+)?(;[\w.+=-]+)*;base64,([A-Za-z0-9+/=\s]+)$/;

const MATRIZ = JSON.parse(fs.readFileSync(path.join(__dirname, "peirie-matriz.json"), "utf8"));
const REQUISITOS = new Map(MATRIZ.requisitos.map((r) => [r.id, r]));

// Requisitos que aplican según el tipo de establecimiento declarado en el expediente.
function requisitosAplicables(perfilColegio) {
  const p = perfilColegio || {};
  return MATRIZ.requisitos.filter((r) => {
    switch (r.aplica_cod) {
      case "subv": return p.subvencionado !== false;
      case "parv": return !!p.parvularia;
      case "bm": return p.basica_media !== false;
      case "fc": return !!p.financiamiento_compartido;
      default: return true;
    }
  });
}
function textoMatriz(requisitos, instrumentos) {
  const fuentes = new Map(MATRIZ.fuentes.map((f) => [f.id, f]));
  return requisitos.filter((r) => instrumentos.includes(r.instrumento)).map((r) =>
    `[${r.id}] (${MATRIZ.tipos[r.tipo]}${r.estado !== "Vigente" ? " · confirmar vigencia" : ""}) ${r.requisito}\n` +
    `   Fuente: ${(fuentes.get(r.fuente) || {}).nombre || r.fuente} · ${r.articulo}. Cita: "${r.cita}"` +
    (r.nota ? `\n   Nota: ${r.nota}` : "")
  ).join("\n");
}

const HALLAZGO_SCHEMA = {
  type: "object",
  properties: {
    titulo: { type: "string" },
    seccion: { type: "string" },
    evidencia: { type: "string" },
    requisito_id: { type: "string" },
    propuesta: { type: "string" },
    requiere_confirmacion: { type: "boolean" },
    vinculo: { type: "string" },
  },
  required: ["titulo", "seccion", "evidencia", "requisito_id", "propuesta", "requiere_confirmacion", "vinculo"],
  additionalProperties: false,
};
const ESQUEMA_DIAGNOSTICO = {
  type: "object",
  properties: {
    resumen: { type: "string" },
    fortalezas: { type: "array", items: { type: "string" } },
    alcance_sugerido: { type: "string", enum: ["ajuste", "actualizacion", "reformulacion"] },
    hallazgos: { type: "array", items: HALLAZGO_SCHEMA },
  },
  required: ["resumen", "fortalezas", "alcance_sugerido", "hallazgos"],
  additionalProperties: false,
};
const ESQUEMA_COHERENCIA = {
  type: "object",
  properties: {
    resumen: { type: "string" },
    vinculos: {
      type: "array",
      items: {
        type: "object",
        properties: {
          tema: { type: "string" },
          pei_seccion: { type: "string" },
          pei_cita: { type: "string" },
          rie_seccion: { type: "string" },
          rie_cita: { type: "string" },
          relacion: { type: "string", enum: RELACIONES },
          explicacion: { type: "string" },
          propuesta: { type: "string" },
          requisito_id: { type: "string" },
        },
        required: ["tema", "pei_seccion", "pei_cita", "rie_seccion", "rie_cita", "relacion", "explicacion", "propuesta", "requisito_id"],
        additionalProperties: false,
      },
    },
  },
  required: ["resumen", "vinculos"],
  additionalProperties: false,
};

const ESQUEMA_APORTES = {
  type: "object",
  properties: {
    coincidencias: { type: "array", items: { type: "string" } },
    diferencias: { type: "array", items: { type: "string" } },
    aportes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          resumen: { type: "string" },
          cita: { type: "string" },
          documento: { type: "string", enum: ["PEI", "RIE"] },
          seccion: { type: "string" },
          pertinencia: { type: "string", enum: PERTINENCIAS },
          motivo: { type: "string" },
          redaccion: { type: "string" },
          requisito_id: { type: "string" },
          hallazgo_codigo: { type: "string" },
        },
        required: ["resumen", "cita", "documento", "seccion", "pertinencia", "motivo", "redaccion", "requisito_id", "hallazgo_codigo"],
        additionalProperties: false,
      },
    },
  },
  required: ["coincidencias", "diferencias", "aportes"],
  additionalProperties: false,
};

function registrarPeiRie(app, d) {
  const { pool, asyncRoute, verificarActor, actorDeHeaders, crearAlerta, enviarCorreo, anthropic, ahoraChile } = d;

  // ---------- utilidades ----------
  async function actorPeiRie(req, colegioId) {
    const { correo, clave } = req.method === "GET" ? actorDeHeaders(req)
      : { correo: (req.body || {}).actorCorreo, clave: (req.body || {}).actorClave };
    const actor = await verificarActor(colegioId, correo, clave);
    return actor && PERFILES_PEIRIE.includes(actor.perfil) ? actor : null;
  }
  const expedienteDe = async (colegioId) =>
    (await pool.query("select * from peirie_expedientes where colegio_id=$1 and estado='activo' order by id desc limit 1", [colegioId])).rows[0] || null;
  async function historial(colegioId, expedienteId, accion, detalle, autor) {
    await pool.query("insert into peirie_historial (colegio_id, expediente_id, accion, detalle, autor) values ($1,$2,$3,$4,$5)",
      [colegioId, expedienteId, accion, detalle || null, autor]);
  }
  const isoFecha = (f) => (f instanceof Date ? f.toISOString() : String(f || "")).slice(0, 10);
  function decodificar(data) {
    const m = String(data || "").match(DATA_URI_RE);
    return m ? { tipo: (m[1] || "").toLowerCase(), base64: m[3].replace(/\s/g, "") } : null;
  }
  async function extraerTexto(buffer, ext) {
    if (ext === "pdf") {
      const pdfParse = require("pdf-parse/lib/pdf-parse.js");
      const r = await pdfParse(buffer);
      return String(r.text || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    }
    const mammoth = require("mammoth");
    const r = await mammoth.extractRawText({ buffer });
    return String(r.value || "").replace(/\n{3,}/g, "\n\n").trim();
  }
  // Última versión de cada documento (PEI, RIE y cada anexo por nombre).
  async function documentosVigentes(expedienteId) {
    const filas = (await pool.query(
      `select distinct on (tipo, lower(nombre)) id, tipo, nombre, archivo_nombre, version, caracteres, subido_por, creado_en, texto
         from peirie_documentos where expediente_id=$1 order by tipo, lower(nombre), version desc`, [expedienteId]
    )).rows;
    return filas;
  }

  // ---------- análisis con IA ----------
  async function llamarIA(system, contenido, esquema) {
    const respuesta = await anthropic.beta.messages.create({
      model: MODELO,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: esquema } },
      system,
      messages: [{ role: "user", content: contenido }],
    });
    if (respuesta.stop_reason === "refusal") throw new Error("La IA no pudo revisar estos documentos.");
    if (respuesta.stop_reason === "max_tokens") throw new Error("La respuesta de la IA quedó incompleta. Vuelve a analizar.");
    const texto = respuesta.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    return { json: JSON.parse(texto), modelo: respuesta.model };
  }

  const REGLAS_IA =
    `Reglas: (1) Propones; el equipo directivo decide. Nunca afirmes que el colegio "infringe" la ley: describe la brecha y su fuente. ` +
    `(2) Usa solo lo que dicen los documentos del colegio; si algo no aparece, la evidencia es "No se encontró en el documento" y di dónde se buscó. ` +
    `No inventes citas: la evidencia es texto copiado del documento, breve. ` +
    `(3) requisito_id es el código de la matriz normativa (por ejemplo RIE-06) que sustenta el hallazgo; si no corresponde a ninguno, deja requisito_id vacío y será una sugerencia. ` +
    `(4) Marca requiere_confirmacion=true cuando el hallazgo dependa de una interpretación jurídica o el requisito diga "confirmar vigencia". ` +
    `(5) No incluyas requisitos que el documento ya cumple bien; esos van como fortalezas. Máximo 25 hallazgos, los más relevantes primero. ` +
    `(6) Escribe en español de Chile, claro y breve: título de hasta 12 palabras y propuesta concreta de 1 a 2 oraciones.`;

  function bloqueDocs(docs, titulo) {
    return docs.map((x) => ({ type: "text", text: `${titulo(x)} (archivo ${x.archivo_nombre}, versión ${x.version}):\n\n${x.texto}` }));
  }

  async function diagnosticar(exp, ruta, docs, colegioNombre) {
    const perfil = exp.perfil_colegio || {};
    const aplicables = requisitosAplicables(perfil);
    const instrumentos = ruta === "pei" ? ["PEI", "Ambos"] : ["RIE", "Ambos"];
    const documentos = ruta === "pei" ? docs.filter((x) => x.tipo === "pei") : docs.filter((x) => x.tipo !== "pei");
    if (!documentos.some((x) => x.tipo === ruta)) return { omitido: true };
    const sistema = [
      { type: "text", text:
        `Eres asesor/a experto/a en normativa educacional chilena y gestión escolar. Diagnosticas el ${ruta === "pei" ? "Proyecto Educativo Institucional (PEI)" : "Reglamento Interno (RIE) y sus anexos o protocolos"} ` +
        `de un establecimiento, comparándolo con la matriz normativa de GADUAI.\n\n${REGLAS_IA}\n` +
        (ruta === "pei"
          ? `En "alcance_sugerido" indica si el PEI necesita un ajuste (cambios menores), una actualización (cambios de contenido con consulta amplia) o una reformulación (obsoleto o desajustado).`
          : `En "alcance_sugerido" indica si el RIE necesita un ajuste, una actualización o una reformulación. En "vinculo" anota qué principio o sello del PEI se relaciona con el hallazgo, si lo hay.`) },
      // La matriz es la misma para todos los colegios: va en caché.
      { type: "text", text: `MATRIZ NORMATIVA (aprobada el ${MATRIZ.revision.fecha}):\n${textoMatriz(aplicables, instrumentos)}`, cache_control: { type: "ephemeral" } },
    ];
    const contexto = `Establecimiento: ${colegioNombre}. Tipo declarado: ${[perfil.subvencionado !== false ? "subvencionado o con aportes del Estado" : "particular pagado",
      perfil.basica_media !== false ? "básica y/o media" : null, perfil.parvularia ? "con educación parvularia" : null,
      perfil.especial ? "escuela especial o con Programa de Integración" : null].filter(Boolean).join(", ")}.`;
    const contenido = [...bloqueDocs(documentos, (x) => x.tipo === "anexo" ? `ANEXO DEL RIE: ${x.nombre}` : `DOCUMENTO ${x.tipo.toUpperCase()}`),
      { type: "text", text: `${contexto}\nHaz el diagnóstico.` }];
    return llamarIA(sistema, contenido, ESQUEMA_DIAGNOSTICO);
  }

  async function cruzar(exp, docs, colegioNombre) {
    const pei = docs.find((x) => x.tipo === "pei"), rie = docs.filter((x) => x.tipo !== "pei");
    if (!pei || !rie.some((x) => x.tipo === "rie")) return { omitido: true };
    const coherencia = MATRIZ.requisitos.filter((r) => r.instrumento === "Ambos" || ["CIRC-02", "PEI-11", "PEI-22"].includes(r.id));
    const sistema = [
      { type: "text", text:
        `Eres el motor de coherencia de GADUAI. Revisas si el Reglamento Interno (RIE) de ${colegioNombre} traduce en normas, derechos, deberes y ` +
        `procedimientos los sellos, la misión, la visión, los valores y los perfiles de su Proyecto Educativo Institucional (PEI).\n\n${REGLAS_IA}\n` +
        `Por cada sello, valor o principio relevante del PEI, busca en el RIE dónde se expresa y clasifica la relación: "coherente" (el RIE lo concreta), ` +
        `"dependencia" (un cambio en uno obliga a revisar el otro), "contradiccion" (una norma va en sentido contrario al principio) o "sin_norma" ` +
        `(el principio no tiene ninguna norma o protocolo que lo exprese). Cita textualmente ambos documentos; si no hay texto en el RIE, rie_cita vacío ` +
        `y rie_seccion "No se encontró". Máximo 20 vínculos, primero los que requieren acción.` },
      { type: "text", text: `REFERENCIAS DE COHERENCIA DE LA MATRIZ:\n${textoMatriz(coherencia, ["PEI", "RIE", "Ambos"])}`, cache_control: { type: "ephemeral" } },
    ];
    const contenido = [...bloqueDocs([pei], () => "PEI"), ...bloqueDocs(rie, (x) => x.tipo === "anexo" ? `ANEXO DEL RIE: ${x.nombre}` : "RIE"),
      { type: "text", text: "Cruza el PEI con el RIE." }];
    return llamarIA(sistema, contenido, ESQUEMA_COHERENCIA);
  }

  // Reemplaza los hallazgos abiertos (sin decisión ni tarea) de esa ruta por los nuevos; lo ya
  // decidido o convertido en tarea se conserva.
  async function guardarHallazgos(exp, analisisId, ruta, filas) {
    await pool.query("delete from peirie_hallazgos where expediente_id=$1 and ruta=$2 and estado='abierto' and decision is null", [exp.id, ruta]);
    let n = (await pool.query("select coalesce(max(substring(codigo from 3)::int),0) as n from peirie_hallazgos where expediente_id=$1", [exp.id])).rows[0].n;
    for (const h of filas) {
      const req = REQUISITOS.get(String(h.requisito_id || "").trim().toUpperCase());
      n++;
      await pool.query(
        `insert into peirie_hallazgos (expediente_id, colegio_id, analisis_id, ruta, codigo, titulo, documento, seccion, evidencia,
           requisito_id, tipo, propuesta, requiere_confirmacion, vinculo, relacion, seccion_otro, cita_otro)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [exp.id, exp.colegio_id, analisisId, ruta, `H-${String(n).padStart(2, "0")}`, String(h.titulo || "").slice(0, 300),
          h.documento, String(h.seccion || "").slice(0, 300), String(h.evidencia || "").slice(0, 2000),
          req ? req.id : null, req ? req.tipo : "sugerencia_ia", String(h.propuesta || "").slice(0, 2000),
          !!h.requiere_confirmacion || (req && req.estado !== "Vigente") || false, String(h.vinculo || "").slice(0, 600) || null,
          h.relacion || null, h.seccion_otro || null, h.cita_otro || null]
      );
    }
  }

  const analizando = new Set(); // expedientes con un análisis en curso en este proceso
  async function analizarExpediente(exp, autor) {
    const colegio = (await pool.query("select nombre from colegios where id=$1", [exp.colegio_id])).rows[0];
    const docs = await documentosVigentes(exp.id);
    const analisis = (await pool.query(
      `insert into peirie_analisis (expediente_id, estado, documentos, solicitado_por) values ($1,'analizando',$2,$3) returning id`,
      [exp.id, JSON.stringify(docs.map((x) => ({ id: x.id, tipo: x.tipo, nombre: x.nombre, version: x.version }))), autor]
    )).rows[0];
    const resultado = {};
    try {
      for (const ruta of ["pei", "rie"]) {
        const r = await diagnosticar(exp, ruta, docs, colegio.nombre);
        if (r.omitido) continue;
        resultado[ruta] = { resumen: r.json.resumen, fortalezas: r.json.fortalezas, alcance: r.json.alcance_sugerido };
        await guardarHallazgos(exp, analisis.id, ruta, r.json.hallazgos.map((h) => ({ ...h, documento: ruta === "pei" ? "PEI" : "RIE" })));
        resultado.modelo = r.modelo;
      }
      const c = await cruzar(exp, docs, colegio.nombre);
      if (!c.omitido) {
        const vinculos = c.json.vinculos;
        resultado.coherencia = { resumen: c.json.resumen, vinculos: vinculos.filter((v) => v.relacion === "coherente") };
        await guardarHallazgos(exp, analisis.id, "ambos", vinculos.filter((v) => v.relacion !== "coherente").map((v) => ({
          titulo: v.tema, documento: "PEI ↔ RIE", seccion: v.pei_seccion, evidencia: v.pei_cita, requisito_id: v.requisito_id,
          propuesta: v.propuesta, requiere_confirmacion: false, vinculo: v.explicacion, relacion: v.relacion,
          seccion_otro: v.rie_seccion, cita_otro: v.rie_cita,
        })));
      }
      await pool.query("update peirie_analisis set estado='listo', resultado=$2, terminado_en=now() where id=$1", [analisis.id, JSON.stringify(resultado)]);
      const nuevos = (await pool.query("select count(*)::int as n from peirie_hallazgos where analisis_id=$1", [analisis.id])).rows[0].n;
      await historial(exp.colegio_id, exp.id, "Diagnóstico con IA listo", `${nuevos} hallazgo(s) nuevos.`, "GADUAI");
      for (const u of await responsables(exp)) {
        crearAlerta(exp.colegio_id, exp.item_id, u, `PEI/RIE: el diagnóstico con IA está listo (${nuevos} hallazgos para revisar).`, { autor: "PEI/RIE" }).catch(() => {});
      }
    } catch (err) {
      console.error("PEI/RIE: error en el análisis del expediente", exp.id, "-", err.message);
      await pool.query("update peirie_analisis set estado='error', error=$2, terminado_en=now() where id=$1",
        [analisis.id, err.message.startsWith("La ") ? err.message : "No se pudo completar el análisis con IA. Vuelve a intentarlo en unos minutos."]);
    }
  }
  async function responsables(exp) {
    const nombres = [exp.responsable_pei, exp.responsable_rie, exp.creado_por].filter(Boolean);
    return [...new Set(nombres)];
  }

  // ---------- rutas ----------
  app.get("/api/colegios/:id/peirie", asyncRoute(async (req, res) => {
    const colegioId = req.params.id;
    const actor = await actorPeiRie(req, colegioId);
    if (!actor) return res.status(403).json({ error: "sin_permiso" });
    const exp = await expedienteDe(colegioId);
    const base = { iaActiva: !!anthropic, hoy: ahoraChile().fecha, matriz: { version: MATRIZ.version, revision: MATRIZ.revision, fuentes: MATRIZ.fuentes, tipos: MATRIZ.tipos, fechas: MATRIZ.fechas } };
    if (!exp) return res.json({ ...base, expediente: null });
    const docs = (await pool.query(
      `select id, tipo, nombre, archivo_nombre, version, caracteres, subido_por, creado_en
         from peirie_documentos where expediente_id=$1 order by tipo, lower(nombre), version desc`, [exp.id]
    )).rows;
    const hallazgos = (await pool.query(
      `select h.*, i.circulo_estado as tarea_estado, i.fecha as tarea_fecha
         from peirie_hallazgos h left join items i on i.id=h.item_id
        where h.expediente_id=$1 order by h.id`, [exp.id]
    )).rows.map((h) => ({ ...h, tarea_fecha: h.tarea_fecha ? isoFecha(h.tarea_fecha) : null, requisito: h.requisito_id ? REQUISITOS.get(h.requisito_id) || null : null }));
    let ultimo = (await pool.query("select id, estado, resultado, error, solicitado_por, creado_en, terminado_en from peirie_analisis where expediente_id=$1 order by id desc limit 1", [exp.id])).rows[0] || null;
    // Un análisis que quedó a medias (por ejemplo, el servidor se reinició) se da por fallido a los 20 minutos.
    if (ultimo && ultimo.estado === "analizando" && !analizando.has(exp.id) && Date.now() - new Date(ultimo.creado_en).getTime() > 20 * 60 * 1000) {
      ultimo = { ...ultimo, estado: "error", error: "El análisis se interrumpió. Vuelve a analizar." };
    }
    const hist = (await pool.query("select accion, detalle, autor, creado_en from peirie_historial where expediente_id=$1 order by creado_en desc limit 80", [exp.id])).rows;
    const participacion = (await pool.query(
      `select id, estamento, actividad, fecha, participantes, archivo_nombre, subido_por, creado_en, analisis_estado, analisis, analisis_error, analizado_en
         from peirie_participacion where expediente_id=$1 order by creado_en desc`, [exp.id]
    )).rows.map((p) => ({ ...p, fecha: p.fecha ? isoFecha(p.fecha) : null,
      // Un análisis que quedó a medias se da por fallido a los 15 minutos.
      analisis_estado: p.analisis_estado === "analizando" && Date.now() - new Date(p.analizado_en).getTime() > 15 * 60 * 1000 ? "error" : p.analisis_estado }));
    const aportes = (await pool.query("select * from peirie_aportes where expediente_id=$1 order by id", [exp.id])).rows;
    res.json({
      ...base, expediente: { ...exp, meta_fecha: exp.meta_fecha ? isoFecha(exp.meta_fecha) : null },
      requisitos: requisitosAplicables(exp.perfil_colegio), documentos: docs, hallazgos, analisis: ultimo, historial: hist,
      estamentos: ESTAMENTOS, participacion, aportes,
    });
  }));

  app.post("/api/colegios/:id/peirie/expediente", asyncRoute(async (req, res) => {
    const colegioId = req.params.id;
    const actor = await actorPeiRie(req, colegioId);
    if (!actor) return res.status(403).json({ error: "sin_permiso" });
    const b = req.body || {};
    const nombre = String(b.nombre || "").trim().slice(0, 160) || "Actualización PEI/RIE";
    const p = b.perfilColegio || {};
    const perfil = { subvencionado: p.subvencionado !== false, basica_media: p.basica_media !== false, parvularia: !!p.parvularia,
      especial: !!p.especial, financiamiento_compartido: !!p.financiamiento_compartido };
    const meta = /^\d{4}-\d{2}-\d{2}$/.test(b.metaFecha || "") ? b.metaFecha : null;
    const usuarios = (await pool.query("select nombre from usuarios where colegio_id=$1", [colegioId])).rows.map((u) => u.nombre);
    const respPei = usuarios.includes(b.responsablePei) ? b.responsablePei : null;
    const respRie = usuarios.includes(b.responsableRie) ? b.responsableRie : null;
    let exp = await expedienteDe(colegioId);
    if (exp) {
      await pool.query(
        `update peirie_expedientes set nombre=$2, perfil_colegio=$3, meta_fecha=$4, responsable_pei=$5, responsable_rie=$6 where id=$1`,
        [exp.id, nombre, JSON.stringify(perfil), meta, respPei, respRie]
      );
      await historial(colegioId, exp.id, "Expediente actualizado", nombre, actor.nombre);
      return res.json({ ok: true, id: exp.id });
    }
    // Hito en el Timeline: ahí llegan los avisos del proceso.
    const item = (await pool.query(
      `insert into items (colegio_id, tipo, triage, titulo, descripcion, fecha, persona, perfil, creado)
       values ($1,'hito','Azul',$2,$3,$4,$5,$6,$7) returning id`,
      [colegioId, `🧭 ${nombre}`, "Proceso de actualización del PEI y del Reglamento Interno. Los avisos del diagnóstico llegan aquí.",
        meta || ahoraChile().fecha, PERSONA_AVISOS, actor.perfil, new Date().toLocaleDateString("es-CL")]
    )).rows[0];
    exp = (await pool.query(
      `insert into peirie_expedientes (colegio_id, nombre, perfil_colegio, meta_fecha, responsable_pei, responsable_rie, creado_por, item_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [colegioId, nombre, JSON.stringify(perfil), meta, respPei, respRie, actor.nombre, item.id]
    )).rows[0];
    await historial(colegioId, exp.id, "Expediente creado", nombre, actor.nombre);
    res.json({ ok: true, id: exp.id });
  }));

  app.post("/api/colegios/:id/peirie/documentos", asyncRoute(async (req, res) => {
    const colegioId = req.params.id;
    const actor = await actorPeiRie(req, colegioId);
    if (!actor) return res.status(403).json({ error: "sin_permiso" });
    const exp = await expedienteDe(colegioId);
    if (!exp) return res.status(409).json({ error: "sin_expediente" });
    const b = req.body || {};
    const tipo = TIPOS_DOC.includes(b.tipo) ? b.tipo : null;
    const archivoNombre = String(b.archivoNombre || "").trim().slice(0, 180);
    const ext = (archivoNombre.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
    const archivo = decodificar(b.data);
    if (!tipo || !archivo || !["pdf", "docx"].includes(ext)) return res.status(400).json({ error: "formato_invalido" });
    const nombre = tipo === "anexo" ? (String(b.nombre || "").trim().slice(0, 160) || archivoNombre.replace(/\.[^.]+$/, "")) : (tipo === "pei" ? "PEI" : "Reglamento Interno");
    const buffer = Buffer.from(archivo.base64, "base64");
    if (buffer.length > DOC_MAX_BYTES) return res.status(413).json({ error: "archivo_grande" });
    let texto;
    try { texto = await extraerTexto(buffer, ext); } catch (err) { return res.status(422).json({ error: "no_legible" }); }
    // Un PDF escaneado (solo imágenes) no tiene texto que la IA pueda leer.
    if (!texto || texto.length < 300) return res.status(422).json({ error: "sin_texto" });
    const version = (await pool.query(
      "select coalesce(max(version),0)+1 as v from peirie_documentos where expediente_id=$1 and tipo=$2 and lower(nombre)=lower($3)", [exp.id, tipo, nombre]
    )).rows[0].v;
    const mime = ext === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const r = await pool.query(
      `insert into peirie_documentos (expediente_id, colegio_id, tipo, nombre, archivo_nombre, archivo_data, texto, caracteres, version, subido_por)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [exp.id, colegioId, tipo, nombre, archivoNombre, `data:${mime};base64,${archivo.base64}`, texto, texto.length, version, actor.nombre]
    );
    await historial(colegioId, exp.id, version > 1 ? "Nueva versión de documento" : "Documento cargado", `${nombre} · versión ${version} (${archivoNombre})`, actor.nombre);
    res.json({ ok: true, id: r.rows[0].id, version, caracteres: texto.length });
  }));

  app.get("/api/colegios/:id/peirie/documentos/:docId/archivo", asyncRoute(async (req, res) => {
    const actor = await actorPeiRie(req, req.params.id);
    if (!actor) return res.status(403).json({ error: "sin_permiso" });
    const r = (await pool.query("select archivo_nombre, archivo_data from peirie_documentos where id=$1 and colegio_id=$2", [req.params.docId, req.params.id])).rows[0];
    if (!r) return res.status(404).json({ error: "no_encontrado" });
    res.json({ nombre: r.archivo_nombre, data: r.archivo_data });
  }));

  // Quita un anexo (todas sus versiones). El PEI y el RIE no se borran: se reemplazan con una versión nueva.
  app.post("/api/colegios/:id/peirie/documentos/:docId/quitar", asyncRoute(async (req, res) => {
    const colegioId = req.params.id;
    const actor = await actorPeiRie(req, colegioId);
    if (!actor) return res.status(403).json({ error: "sin_permiso" });
    const doc = (await pool.query("select expediente_id, tipo, nombre from peirie_documentos where id=$1 and colegio_id=$2", [req.params.docId, colegioId])).rows[0];
    if (!doc) return res.status(404).json({ error: "no_encontrado" });
    if (doc.tipo !== "anexo") return res.status(409).json({ error: "solo_anexos" });
    await pool.query("delete from peirie_documentos where expediente_id=$1 and tipo='anexo' and lower(nombre)=lower($2)", [doc.expediente_id, doc.nombre]);
    await historial(colegioId, doc.expediente_id, "Anexo quitado", doc.nombre, actor.nombre);
    res.json({ ok: true });
  }));

  app.post("/api/colegios/:id/peirie/analizar", asyncRoute(async (req, res) => {
    const colegioId = req.params.id;
    const actor = await actorPeiRie(req, colegioId);
    if (!actor) return res.status(403).json({ error: "sin_permiso" });
    if (!anthropic) return res.status(409).json({ error: "sin_ia" });
    const exp = await expedienteDe(colegioId);
    if (!exp) return res.status(409).json({ error: "sin_expediente" });
    const docs = await documentosVigentes(exp.id);
    if (!docs.some((x) => x.tipo === "pei" || x.tipo === "rie")) return res.status(409).json({ error: "sin_documentos" });
    if (analizando.has(exp.id)) return res.status(409).json({ error: "en_curso" });
    analizando.add(exp.id);
    await historial(colegioId, exp.id, "Diagnóstico con IA solicitado", null, actor.nombre);
    analizarExpediente(exp, actor.nombre).finally(() => analizando.delete(exp.id));
    res.json({ ok: true });
  }));

  async function hallazgoDe(req, res) {
    const colegioId = req.params.id;
    const actor = await actorPeiRie(req, colegioId);
    if (!actor) { res.status(403).json({ error: "sin_permiso" }); return {}; }
    const h = (await pool.query("select * from peirie_hallazgos where id=$1 and colegio_id=$2", [req.params.hid, colegioId])).rows[0];
    if (!h) { res.status(404).json({ error: "no_encontrado" }); return {}; }
    return { actor, h };
  }

  // Decisión humana sobre un hallazgo: resuelto o descartado (con justificación), o reabrirlo.
  app.post("/api/colegios/:id/peirie/hallazgos/:hid/decision", asyncRoute(async (req, res) => {
    const { actor, h } = await hallazgoDe(req, res);
    if (!h) return;
    const estado = req.body.estado;
    const texto = String(req.body.decision || "").trim().slice(0, 3000);
    if (!["resuelto", "descartado", "abierto"].includes(estado)) return res.status(400).json({ error: "estado_invalido" });
    if (estado !== "abierto" && !texto) return res.status(400).json({ error: "decision_vacia" });
    const nuevo = estado === "abierto" && h.item_id ? "en_tarea" : estado;
    await pool.query("update peirie_hallazgos set estado=$2, decision=$3, decidido_por=$4, decidido_en=now() where id=$1",
      [h.id, nuevo, estado === "abierto" ? null : texto, estado === "abierto" ? null : actor.nombre]);
    await historial(h.colegio_id, h.expediente_id, estado === "abierto" ? "Hallazgo reabierto" : estado === "resuelto" ? "Hallazgo resuelto" : "Hallazgo descartado",
      `${h.codigo} · ${h.titulo}${texto ? ` — ${texto}` : ""}`, actor.nombre);
    res.json({ ok: true });
  }));

  // Convierte un hallazgo en una tarea del Timeline (círculo de la promesa) con responsable y plazo.
  app.post("/api/colegios/:id/peirie/hallazgos/:hid/tarea", asyncRoute(async (req, res) => {
    const { actor, h } = await hallazgoDe(req, res);
    if (!h) return;
    if (h.item_id) return res.status(409).json({ error: "ya_tiene_tarea" });
    const b = req.body || {};
    const responsable = (await pool.query("select nombre, correo from usuarios where colegio_id=$1 and nombre=$2", [h.colegio_id, b.responsable])).rows[0];
    if (!responsable) return res.status(400).json({ error: "responsable_invalido" });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.fecha || "")) return res.status(400).json({ error: "fecha_invalida" });
    const triage = ["Rojo", "Naranjo", "Azul", "Gris"].includes(b.triage) ? b.triage : "Azul";
    const req0 = h.requisito_id ? REQUISITOS.get(h.requisito_id) : null;
    const titulo = `PEI/RIE ${h.codigo}: ${h.titulo}`.slice(0, 300);
    const desc = [`Hallazgo del diagnóstico PEI/RIE (${h.documento}${h.seccion ? " · " + h.seccion : ""}).`,
      h.evidencia ? `Evidencia: ${h.evidencia}` : null,
      req0 ? `Fuente: ${req0.articulo} (${MATRIZ.tipos[req0.tipo]}).` : "Sugerencia de la IA (sin requisito normativo asociado).",
      `Propuesta: ${h.propuesta}`, b.nota ? `Indicaciones: ${String(b.nota).slice(0, 1000)}` : null].filter(Boolean).join("\n");
    const item = (await pool.query(
      `insert into items (colegio_id, tipo, triage, titulo, descripcion, fecha, responsable, copiados, persona, perfil, creado)
       values ($1,'tarea',$2,$3,$4,$5,$6,'{}',$7,$8,$9) returning id`,
      [h.colegio_id, triage, titulo, desc, b.fecha, responsable.nombre, actor.nombre, actor.perfil, new Date().toLocaleDateString("es-CL")]
    )).rows[0];
    await pool.query("update peirie_hallazgos set estado='en_tarea', item_id=$2, responsable=$3 where id=$1", [h.id, item.id, responsable.nombre]);
    await historial(h.colegio_id, h.expediente_id, "Tarea creada", `${h.codigo} → ${responsable.nombre}, plazo ${b.fecha}`, actor.nombre);
    res.json({ ok: true, itemId: item.id });
    crearAlerta(h.colegio_id, item.id, responsable.nombre, `Nueva tarea asignada: ${titulo}`).catch(() => {});
    if (responsable.nombre !== actor.nombre && responsable.correo) {
      enviarCorreo({ to: responsable.correo, asunto: `Nueva tarea GADUAI: ${titulo}`,
        texto: `${actor.nombre} te asignó una tarea del proceso de actualización del PEI y el Reglamento Interno.\n\n${titulo}\nPlazo: ${b.fecha}\n\n${desc}\n` }).catch(() => {});
    }
  }));

  // ---------- participación por estamento ----------
  // Cada estamento trabaja con su guía y sube un compilado de sus aportes. La IA separa cada aporte,
  // lo cruza con el PEI y el RIE vigentes y con la matriz, y dice si es pertinente y cómo incluirlo.
  // Incluirlo o descartarlo lo decide el equipo (puede incluir de una vez todos los pertinentes).
  async function analizarCompilado(partId) {
    const part = (await pool.query("select * from peirie_participacion where id=$1", [partId])).rows[0];
    if (!part) return;
    const exp = (await pool.query("select * from peirie_expedientes where id=$1", [part.expediente_id])).rows[0];
    const colegio = (await pool.query("select nombre from colegios where id=$1", [part.colegio_id])).rows[0];
    const guardar = (estado, analisis, error) => pool.query(
      "update peirie_participacion set analisis_estado=$2, analisis=$3, analisis_error=$4, analizado_en=now() where id=$1",
      [partId, estado, analisis ? JSON.stringify(analisis) : null, error || null]);
    if (!anthropic) return guardar("sin_ia", null, "La IA no está activa en este GADUAI.");
    try {
      const docs = (await documentosVigentes(exp.id)).filter((x) => x.tipo === "pei" || x.tipo === "rie");
      const abiertos = (await pool.query("select codigo, titulo from peirie_hallazgos where expediente_id=$1 and estado in ('abierto','en_tarea') order by id", [exp.id])).rows;
      const sistema = [
        { type: "text", text:
          `Eres asesor/a de ${colegio.nombre} en el proceso participativo de actualización del PEI y del Reglamento Interno (RIE). ` +
          `Recibes el compilado de aportes de un estamento y lo analizas para el equipo directivo, que decide.\n\n` +
          `Separa cada aporte distinto (no repitas el mismo con otras palabras) y para cada uno indica:\n` +
          `- cita: texto copiado del compilado, breve. No inventes aportes ni acuerdos.\n` +
          `- documento y seccion: dónde se incluiría (PEI o RIE, y la sección del documento vigente).\n` +
          `- pertinencia: "pertinente" si es compatible con la normativa de la matriz, coherente con el ideario del PEI y aporta algo que el ` +
          `documento no tiene o mejora lo que tiene; "no_pertinente" si contradice la normativa (di la fuente), si el documento ya lo contiene ` +
          `(di dónde) o si no corresponde a estos instrumentos; "requiere_deliberacion" si hay posiciones distintas en el compilado o implica ` +
          `una decisión institucional de fondo.\n- motivo: por qué, en 1 o 2 oraciones.\n` +
          `- redaccion: si es pertinente o requiere deliberación, el texto propuesto listo para insertar en el documento; si no, vacío.\n` +
          `- requisito_id: código de la matriz relacionado, o vacío. hallazgo_codigo: código del hallazgo abierto que este aporte ayuda a resolver, o vacío.\n` +
          `En "coincidencias" y "diferencias" resume lo que se repite y las posiciones distintas, sin declarar consensos que el compilado no muestre. ` +
          `Español de Chile, claro y breve. Máximo 30 aportes.` },
        { type: "text", text: `MATRIZ NORMATIVA:\n${textoMatriz(requisitosAplicables(exp.perfil_colegio), ["PEI", "RIE", "Ambos"])}`, cache_control: { type: "ephemeral" } },
      ];
      const contenido = [
        ...bloqueDocs(docs, (x) => x.tipo === "pei" ? "PEI VIGENTE" : "RIE VIGENTE"),
        { type: "text", text: `HALLAZGOS ABIERTOS DEL DIAGNÓSTICO:\n${abiertos.map((h) => `${h.codigo}: ${h.titulo}`).join("\n") || "(ninguno)"}` },
        { type: "text", text: `COMPILADO DEL ESTAMENTO ${ESTAMENTOS[part.estamento].toUpperCase()} (${part.actividad || "actividad"}, ${part.participantes || "?"} participantes, archivo ${part.archivo_nombre}):\n\n${part.texto}` },
        { type: "text", text: "Analiza los aportes de este compilado." },
      ];
      const { json, modelo } = await llamarIA(sistema, contenido, ESQUEMA_APORTES);
      await pool.query("delete from peirie_aportes where participacion_id=$1 and estado='propuesto'", [partId]);
      let n = (await pool.query("select coalesce(max(substring(codigo from 3)::int),0) as n from peirie_aportes where expediente_id=$1", [exp.id])).rows[0].n;
      for (const a of json.aportes) {
        n++;
        const req = REQUISITOS.get(String(a.requisito_id || "").trim().toUpperCase());
        await pool.query(
          `insert into peirie_aportes (expediente_id, colegio_id, participacion_id, estamento, codigo, documento, seccion, resumen, cita,
             pertinencia, motivo, redaccion, requisito_id, hallazgo_codigo)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [exp.id, part.colegio_id, partId, part.estamento, `A-${String(n).padStart(2, "0")}`, a.documento === "PEI" ? "PEI" : "RIE",
            String(a.seccion || "").slice(0, 300), String(a.resumen || "").slice(0, 600), String(a.cita || "").slice(0, 1500),
            PERTINENCIAS.includes(a.pertinencia) ? a.pertinencia : "requiere_deliberacion", String(a.motivo || "").slice(0, 1000),
            String(a.redaccion || "").slice(0, 3000) || null, req ? req.id : null, String(a.hallazgo_codigo || "").trim().slice(0, 10) || null]
        );
      }
      await guardar("listo", { coincidencias: json.coincidencias, diferencias: json.diferencias, modelo, aportes: json.aportes.length });
      await historial(part.colegio_id, exp.id, "Aportes analizados", `${ESTAMENTOS[part.estamento]}: ${json.aportes.length} aporte(s), ${json.aportes.filter((a) => a.pertinencia === "pertinente").length} pertinente(s).`, "GADUAI");
      for (const u of await responsables(exp)) {
        crearAlerta(exp.colegio_id, exp.item_id, u, `PEI/RIE: los aportes de ${ESTAMENTOS[part.estamento]} están analizados.`, { autor: "PEI/RIE" }).catch(() => {});
      }
    } catch (err) {
      console.error("PEI/RIE: error al analizar el compilado", partId, "-", err.message);
      await guardar("error", null, err.message.startsWith("La ") ? err.message : "No se pudo analizar el compilado. Vuelve a intentarlo en unos minutos.");
    }
  }
  function analizarCompiladoEnSegundoPlano(partId) {
    pool.query("update peirie_participacion set analisis_estado='analizando', analisis_error=null, analizado_en=now() where id=$1", [partId])
      .then(() => analizarCompilado(partId))
      .catch((err) => console.error("PEI/RIE: no se pudo iniciar el análisis del compilado", partId, "-", err.message));
  }

  app.post("/api/colegios/:id/peirie/participacion", asyncRoute(async (req, res) => {
    const colegioId = req.params.id;
    const actor = await actorPeiRie(req, colegioId);
    if (!actor) return res.status(403).json({ error: "sin_permiso" });
    const exp = await expedienteDe(colegioId);
    if (!exp) return res.status(409).json({ error: "sin_expediente" });
    const b = req.body || {};
    if (!ESTAMENTOS[b.estamento]) return res.status(400).json({ error: "estamento_invalido" });
    const archivoNombre = String(b.archivoNombre || "").trim().slice(0, 180);
    const ext = (archivoNombre.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
    const archivo = decodificar(b.data);
    if (!archivo || !["pdf", "docx"].includes(ext)) return res.status(400).json({ error: "formato_invalido" });
    const buffer = Buffer.from(archivo.base64, "base64");
    if (buffer.length > DOC_MAX_BYTES) return res.status(413).json({ error: "archivo_grande" });
    let texto;
    try { texto = await extraerTexto(buffer, ext); } catch (err) { return res.status(422).json({ error: "no_legible" }); }
    if (!texto || texto.length < 80) return res.status(422).json({ error: "sin_texto" });
    const participantes = Math.max(0, Math.min(5000, parseInt(b.participantes, 10) || 0)) || null;
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(b.fecha || "") ? b.fecha : null;
    const mime = ext === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const r = await pool.query(
      `insert into peirie_participacion (expediente_id, colegio_id, estamento, actividad, fecha, participantes, archivo_nombre, archivo_data, texto, subido_por)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [exp.id, colegioId, b.estamento, String(b.actividad || "").trim().slice(0, 160) || null, fecha, participantes, archivoNombre,
        `data:${mime};base64,${archivo.base64}`, texto, actor.nombre]
    );
    await historial(colegioId, exp.id, "Compilado de aportes subido", `${ESTAMENTOS[b.estamento]}${participantes ? ` · ${participantes} participantes` : ""} (${archivoNombre})`, actor.nombre);
    analizarCompiladoEnSegundoPlano(r.rows[0].id);
    res.json({ ok: true, id: r.rows[0].id });
  }));

  async function participacionDe(req, res) {
    const actor = await actorPeiRie(req, req.params.id);
    if (!actor) { res.status(403).json({ error: "sin_permiso" }); return {}; }
    const part = (await pool.query("select id, expediente_id, colegio_id, estamento, archivo_nombre from peirie_participacion where id=$1 and colegio_id=$2", [req.params.pid, req.params.id])).rows[0];
    if (!part) { res.status(404).json({ error: "no_encontrado" }); return {}; }
    return { actor, part };
  }
  app.get("/api/colegios/:id/peirie/participacion/:pid/archivo", asyncRoute(async (req, res) => {
    const { part } = await participacionDe(req, res);
    if (!part) return;
    const r = (await pool.query("select archivo_nombre, archivo_data from peirie_participacion where id=$1", [part.id])).rows[0];
    res.json({ nombre: r.archivo_nombre, data: r.archivo_data });
  }));
  app.post("/api/colegios/:id/peirie/participacion/:pid/analizar", asyncRoute(async (req, res) => {
    const { part } = await participacionDe(req, res);
    if (!part) return;
    if (!anthropic) return res.status(409).json({ error: "sin_ia" });
    analizarCompiladoEnSegundoPlano(part.id);
    res.json({ ok: true });
  }));
  // Quita un compilado y sus aportes que no fueron incluidos (lo ya incluido queda en la propuesta de cambios).
  app.post("/api/colegios/:id/peirie/participacion/:pid/quitar", asyncRoute(async (req, res) => {
    const { actor, part } = await participacionDe(req, res);
    if (!part) return;
    await pool.query("delete from peirie_aportes where participacion_id=$1 and estado <> 'incluido'", [part.id]);
    await pool.query("update peirie_aportes set participacion_id=null where participacion_id=$1", [part.id]);
    await pool.query("delete from peirie_participacion where id=$1", [part.id]);
    await historial(part.colegio_id, part.expediente_id, "Compilado quitado", `${ESTAMENTOS[part.estamento]} (${part.archivo_nombre})`, actor.nombre);
    res.json({ ok: true });
  }));

  // Decisión del equipo sobre un aporte: incluirlo, descartarlo (con motivo) o volver a "propuesto".
  app.post("/api/colegios/:id/peirie/aportes/:aid/decision", asyncRoute(async (req, res) => {
    const colegioId = req.params.id;
    const actor = await actorPeiRie(req, colegioId);
    if (!actor) return res.status(403).json({ error: "sin_permiso" });
    const a = (await pool.query("select * from peirie_aportes where id=$1 and colegio_id=$2", [req.params.aid, colegioId])).rows[0];
    if (!a) return res.status(404).json({ error: "no_encontrado" });
    const estado = req.body.estado;
    const texto = String(req.body.decision || "").trim().slice(0, 2000);
    const redaccion = req.body.redaccion !== undefined ? String(req.body.redaccion || "").trim().slice(0, 3000) : a.redaccion;
    if (!["incluido", "descartado", "propuesto"].includes(estado)) return res.status(400).json({ error: "estado_invalido" });
    if (estado === "descartado" && !texto) return res.status(400).json({ error: "decision_vacia" });
    if (estado === "incluido" && !redaccion) return res.status(400).json({ error: "sin_redaccion" });
    await pool.query("update peirie_aportes set estado=$2, decision=$3, redaccion=$4, decidido_por=$5, decidido_en=now() where id=$1",
      [a.id, estado, estado === "propuesto" ? null : texto || null, redaccion || null, estado === "propuesto" ? null : actor.nombre]);
    await historial(colegioId, a.expediente_id, estado === "incluido" ? "Aporte incluido" : estado === "descartado" ? "Aporte descartado" : "Aporte reabierto",
      `${a.codigo} · ${ESTAMENTOS[a.estamento]} · ${a.resumen}${texto ? ` — ${texto}` : ""}`, actor.nombre);
    res.json({ ok: true });
  }));
  // Incluye de una vez todos los aportes que la IA marcó pertinentes (de un estamento o de todos).
  app.post("/api/colegios/:id/peirie/aportes/incluir-pertinentes", asyncRoute(async (req, res) => {
    const colegioId = req.params.id;
    const actor = await actorPeiRie(req, colegioId);
    if (!actor) return res.status(403).json({ error: "sin_permiso" });
    const exp = await expedienteDe(colegioId);
    if (!exp) return res.status(409).json({ error: "sin_expediente" });
    const est = ESTAMENTOS[req.body.estamento] ? req.body.estamento : null;
    const r = await pool.query(
      `update peirie_aportes set estado='incluido', decision='Incluido como pertinente según el análisis de GADUAI.', decidido_por=$3, decidido_en=now()
        where expediente_id=$1 and estado='propuesto' and pertinencia='pertinente' and redaccion is not null and ($2::text is null or estamento=$2)
        returning codigo`, [exp.id, est, actor.nombre]);
    if (r.rowCount) await historial(colegioId, exp.id, "Aportes pertinentes incluidos", `${r.rowCount} aporte(s)${est ? ` de ${ESTAMENTOS[est]}` : ""}: ${r.rows.map((x) => x.codigo).join(", ")}`, actor.nombre);
    res.json({ ok: true, incluidos: r.rowCount });
  }));

  return { PERFILES_PEIRIE };
}

module.exports = { registrarPeiRie, PERFILES_PEIRIE, ESTAMENTOS };
