/*
 * Prueba el correo (SMTP) sin tocar la tienda: inicia sesión en el servidor de correo y manda un mensaje de prueba.
 *   npm run correo:probar -- tu@correo.com
 * Si falla, explica qué revisar (lo más común con Gmail: usar la contraseña normal en vez de una de aplicación).
 */
import { mailEnabled, sendMail } from '../lib/mailer.js';

const to = (process.argv[2] ?? '').trim();
const NEEDED = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'];

function explain(err) {
  const text = `${err.code ?? ''} ${err.responseCode ?? ''} ${err.response ?? err.message}`;
  if (err.code === 'EAUTH' || /\b535\b|534|Username and Password not accepted|Application-specific password/i.test(text)) {
    return 'El servidor no aceptó el usuario o la contraseña. Con Gmail, SMTP_USER es el correo completo y SMTP_PASS una «contraseña de aplicación» de 16 letras (sin espacios), no la contraseña normal. La verificación en 2 pasos debe estar activa.';
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(text)) return `No se encontró el servidor «${process.env.SMTP_HOST}». Revisa SMTP_HOST (para Gmail: smtp.gmail.com).`;
  if (/ETIMEDOUT|ECONNREFUSED|ECONNRESET|ESOCKET|ECONNECTION/.test(text)) {
    return `No se pudo conectar a ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 465}. Revisa SMTP_PORT (Gmail: 465) o si un antivirus o la red bloquea ese puerto.`;
  }
  if (/\b55[0-4]\b/.test(text)) return 'El servidor rechazó el destinatario o el remitente. Revisa la dirección de prueba y MAIL_FROM (con Gmail, usa el mismo correo de SMTP_USER).';
  return 'Revisa los datos SMTP en el .env.';
}

async function main() {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) {
    console.error('> uso: npm run correo:probar -- tu@correo.com');
    process.exitCode = 1;
    return;
  }
  if (!mailEnabled()) {
    const missing = NEEDED.filter((k) => !process.env[k]);
    console.error(`> falta configurar el correo en el .env: ${missing.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`> enviando un correo de prueba a ${to} por ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 465} como ${process.env.SMTP_USER}…`);
  try {
    await sendMail({
      to,
      subject: 'Prueba de correo · Dream Zone',
      text: 'Si lees esto, el correo de Dream Zone ya funciona: códigos de recuperación, pagos, envíos y avisos de drops.\n\n— Dream Zone',
      html: '<p style="font-family:Menlo,Consolas,monospace">Si lees esto, el correo de <b>Dream Zone</b> ya funciona: códigos de recuperación, pagos, envíos y avisos de drops.</p>',
    });
    console.log('> ¡enviado! Revisa la bandeja de entrada (y la carpeta de spam la primera vez).');
  } catch (err) {
    console.error(`> no se pudo enviar: ${err.response ?? err.message}`);
    console.error(`  ${explain(err)}`);
    process.exitCode = 1;
  }
}

main();
