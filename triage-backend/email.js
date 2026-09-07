/**
 * TRIAGE GADUAI · envío de correos
 * ---------------------------------
 * SMTP puro vía nodemailer, con las mismas variables de entorno que ya usa Relacionai
 * (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM, SMTP_USE_TLS) para poder
 * reutilizar exactamente las mismas credenciales de Resend en ambos backends.
 * Si no están configuradas, no falla: simplemente no envía nada.
 */
const nodemailer = require("nodemailer");

function configurado() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD);
}

let transporter = null;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || "587", 10),
      secure: false,
      requireTLS: process.env.SMTP_USE_TLS !== "0",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    });
  }
  return transporter;
}

async function enviarCorreo({ to, asunto, texto }) {
  if (!configurado() || !to) return false;
  try {
    await getTransporter().sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject: asunto,
      text: texto,
    });
    return true;
  } catch (err) {
    console.error("No se pudo enviar el correo a", to, err.message);
    return false;
  }
}

module.exports = { enviarCorreo };
