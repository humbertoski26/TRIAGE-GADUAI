/**
 * TRIAGE GADUAI · notificaciones push del navegador (Web Push)
 * --------------------------------------------------------------
 * Usa las llaves VAPID (VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY) para mandar
 * notificaciones reales del sistema operativo a los dispositivos que se
 * suscribieron. Si las llaves no están configuradas, no falla: simplemente
 * no envía nada (mismo criterio que email.js).
 */
const webpush = require("web-push");

function configurado() {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

let configurada = false;
function asegurarConfig() {
  if (!configurada && configurado()) {
    webpush.setVapidDetails(
      "mailto:soporte@gaduai.cl",
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
    configurada = true;
  }
}

// Busca todas las suscripciones de esa persona en ese colegio y les manda la notificación.
// Si una suscripción devuelve 404/410 (venció o el usuario desinstaló/revocó), se borra sola.
async function enviarPush(pool, colegioId, persona, { titulo, cuerpo, url }) {
  if (!configurado() || !persona) return 0;
  asegurarConfig();
  const subs = await pool.query(
    "select id, endpoint, p256dh, auth from push_subscripciones where colegio_id=$1 and persona=$2",
    [colegioId, persona]
  );
  let enviados = 0;
  for (const s of subs.rows) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ titulo: titulo || "GADUAI", cuerpo: cuerpo || "", url: url || "/" })
      );
      enviados++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await pool.query("delete from push_subscripciones where id=$1", [s.id]).catch(() => {});
      } else {
        console.error("No se pudo enviar push a", persona, "-", err.message);
      }
    }
  }
  return enviados;
}

module.exports = { enviarPush, configurado };
