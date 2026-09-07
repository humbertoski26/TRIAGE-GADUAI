/**
 * TRIAGE GADUAI · envío de correos
 * ---------------------------------
 * SMTP puro vía nodemailer, con las mismas variables de entorno que ya usa Relacionai
 * (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM, SMTP_USE_TLS) para poder
 * reutilizar exactamente las mismas credenciales de Resend en ambos backends.
 * Si no están configuradas, no falla: simplemente no envía nada.
 */
const nodemailer = require("nodemailer");

// Saca espacios y el espacio-de-no-separación (\xa0) que a veces queda pegado al copiar
// una clave desde el navegador — mismo problema que ya tuvimos con Relacionai/Gmail.
function limpiar(valor) {
  return valor ? valor.replace(/\s+/g, "") : valor;
}

function configurado() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD);
}

let transporter = null;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: limpiar(process.env.SMTP_HOST),
      port: parseInt(limpiar(process.env.SMTP_PORT) || "587", 10),
      secure: false,
      requireTLS: process.env.SMTP_USE_TLS !== "0",
      auth: { user: limpiar(process.env.SMTP_USER), pass: limpiar(process.env.SMTP_PASSWORD) },
    });
  }
  return transporter;
}

async function enviarCorreo({ to, asunto, texto }) {
  if (!configurado()) {
    console.log("SMTP no configurado; no se envía correo a", to);
    return false;
  }
  if (!to) return false;
  try {
    const info = await getTransporter().sendMail({
      from: limpiar(process.env.SMTP_FROM) || limpiar(process.env.SMTP_USER),
      to,
      subject: asunto,
      text: texto,
    });
    console.log("Correo enviado a", to, "-", info.messageId || info.response || "sin id");
    return true;
  } catch (err) {
    console.error("No se pudo enviar el correo a", to, "-", err.message);
    return false;
  }
}

module.exports = { enviarCorreo };
