/*
 * Correo transaccional por SMTP (Gmail con contraseña de aplicación, Brevo, Resend, Zoho…).
 * Sin SMTP configurado no sale nada; en local, el código de recuperación se imprime en la consola del servidor.
 */
import { dropAvailable } from './catalog.js';

let transporter = null;

export const mailEnabled = () => Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

/** `list` y `headers` son para la lista de correo (List-Unsubscribe: el botón «darse de baja» del cliente de correo). */
export async function sendMail({ to, subject, text, html, list, headers }) {
  if (!mailEnabled()) {
    const err = new Error('SMTP no configurado');
    err.code = 'DZ_MAIL_OFF';
    throw err;
  }
  if (!transporter) {
    const { default: nodemailer } = await import('nodemailer'); // solo lo carga la función que envía correo
    const port = Number(process.env.SMTP_PORT) || 465;
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  await transporter.sendMail({
    from: process.env.MAIL_FROM || `Dream Zone <${process.env.SMTP_USER}>`,
    to,
    subject,
    text,
    html,
    ...(list ? { list } : {}),
    ...(headers ? { headers } : {}),
  });
}

/**
 * URL pública del sitio para los enlaces de los correos. En producción nunca se toma del
 * header Host: alguien podría pedir un enlace para otra persona con un Host falso.
 */
export function appUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  // en local: la dirección por la que entró (localhost, la IP de la red o un túnel https)
  const proto = req?.headers?.['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  return `${proto}://${req?.headers?.host ?? 'localhost:3000'}`;
}

const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => HTML_ENTITIES[c]);

/**
 * Plantilla común: tarjeta negra con la franja del logo, un botón y el enlace en texto plano. `code` muestra un
 * código grande (recuperación) y `unsubscribe`, el enlace de baja de la lista de correo. Sin `cta` no hay botón.
 */
function card({ kicker, heading, body, code, cta, url, foot, unsubscribe }) {
  const serif = 'font-family:Georgia,serif';
  const mono = 'font-family:Menlo,Consolas,monospace';
  return `<!doctype html><html lang="es"><body style="margin:0;background:#000;padding:32px 16px;${mono};color:#EDEDEB">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;border:1px solid #EDEDEB">
<tr><td style="height:6px;background-color:#2B6CB4;background-image:linear-gradient(100deg,#2E9BDA,#2B6CB4,#4A47A3)"></td></tr>
<tr><td style="padding:28px 28px 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#5BB4E6">${escHtml(kicker)}</td></tr>
<tr><td style="padding:0 28px;${serif};font-size:36px;line-height:1.05;color:#EDEDEB">${escHtml(heading)}</td></tr>
<tr><td style="padding:16px 28px 0;font-size:14px;line-height:1.6;color:#A8A8A4">${escHtml(body)}</td></tr>
${code ? `<tr><td style="padding:20px 28px 0"><span style="display:inline-block;padding:14px 22px;border:1px dashed #5BB4E6;${mono};font-size:32px;font-weight:600;letter-spacing:.3em;color:#EDEDEB">${escHtml(code)}</span></td></tr>` : ''}
${cta ? `<tr><td style="padding:24px 28px"><a href="${escHtml(url)}" style="display:inline-block;padding:14px 22px;background:#EDEDEB;color:#000;text-decoration:none;font-weight:600;font-size:13px;letter-spacing:.1em;text-transform:uppercase">${escHtml(cta)}</a></td></tr>` : '<tr><td style="height:24px"></td></tr>'}
<tr><td style="padding:0 28px 28px;font-size:12px;line-height:1.6;color:#8C8C88">${escHtml(foot)}${cta ? `<br>¿El botón no funciona? Copia este enlace:<br><span style="color:#5BB4E6;word-break:break-all">${escHtml(url)}</span>` : ''}</td></tr>
${unsubscribe ? `<tr><td style="padding:14px 28px 22px;border-top:1px solid #2A2A2E;font-size:11px;line-height:1.6;color:#6B6B67">Te llega porque te suscribiste a los drops de Dream Zone. <a href="${escHtml(unsubscribe)}" style="color:#A8A8A4">Darte de baja</a></td></tr>` : ''}
</table>
</td></tr></table></body></html>`;
}

/** Código de 6 dígitos para recuperar la contraseña (se escribe en cuenta.html#recuperar). */
export function resetCodeEmail({ name, code }) {
  const pretty = `${code.slice(0, 3)} ${code.slice(3)}`;
  const subject = `${pretty} es tu código de Dream Zone`;
  const text = [
    `Hola, ${name}:`,
    '',
    'Alguien (ojalá tú) pidió recuperar el acceso a tu credencial en Dream Zone. Tu código es:',
    '',
    `    ${pretty}`,
    '',
    'Escríbelo en la página de recuperación junto con tu contraseña nueva. Vence en 15 minutos y sirve una sola vez.',
    '',
    'Si no fuiste tú, ignora este correo: tu contraseña sigue igual.',
    '',
    '— Dream Zone · archivo de reliquias geek',
  ].join('\n');
  const html = card({
    kicker: 'Dream Zone · recuperar acceso',
    heading: `Hola, ${name}.`,
    body: 'Alguien (ojalá tú) pidió recuperar el acceso a tu credencial. Escribe este código en la página de recuperación junto con tu contraseña nueva:',
    code: pretty, // sin botón: el código se escribe en la página que ya está abierta
    foot: 'Vence en 15 minutos y sirve una sola vez. Si no fuiste tú, ignora este correo: tu contraseña sigue igual.',
  });
  return { subject, text, html };
}

/** Código de 6 dígitos para cambiar la contraseña con la sesión abierta, sin la actual (cuenta.html › Cambiar contraseña). */
export function passwordCodeEmail({ name, code }) {
  const pretty = `${code.slice(0, 3)} ${code.slice(3)}`;
  const subject = `${pretty} es tu código de Dream Zone`;
  const text = [
    `Hola, ${name}:`,
    '',
    'Pediste cambiar la contraseña de tu credencial en Dream Zone sin escribir la actual. Tu código es:',
    '',
    `    ${pretty}`,
    '',
    'Escríbelo en «Cambiar contraseña», en tu credencial, junto con tu contraseña nueva. Vence en 15 minutos y sirve una sola vez.',
    '',
    'Si no fuiste tú, ignora este correo: tu contraseña sigue igual.',
    '',
    '— Dream Zone · archivo de reliquias geek',
  ].join('\n');
  const html = card({
    kicker: 'Dream Zone · cambiar contraseña',
    heading: `Hola, ${name}.`,
    body: 'Pediste cambiar la contraseña de tu credencial sin escribir la actual. Escribe este código en «Cambiar contraseña», junto con tu contraseña nueva:',
    code: pretty,
    foot: 'Vence en 15 minutos y sirve una sola vez. Si no fuiste tú, ignora este correo: tu contraseña sigue igual.',
  });
  return { subject, text, html };
}

/** Código de 6 dígitos para confirmar que se borra la credencial (cuenta.html › Borrar credencial). */
export function deleteCodeEmail({ name, code }) {
  const pretty = `${code.slice(0, 3)} ${code.slice(3)}`;
  const subject = `${pretty} es tu código para borrar tu credencial de Dream Zone`;
  const text = [
    `Hola, ${name}:`,
    '',
    'Pediste borrar tu credencial de Dream Zone. Para confirmarlo, escribe este código en la página de tu credencial:',
    '',
    `    ${pretty}`,
    '',
    'Vence en 15 minutos y sirve una sola vez. Al borrarla se pierden tus logros, tu XP y tu nivel, y no se puede deshacer.',
    '',
    'Si no fuiste tú, no escribas el código y cambia tu contraseña: alguien la conoce.',
    '',
    '— Dream Zone · archivo de reliquias geek',
  ].join('\n');
  const html = card({
    kicker: 'Dream Zone · borrar credencial',
    heading: `Hola, ${name}.`,
    body: 'Pediste borrar tu credencial. Para confirmarlo, escribe este código en la página de tu credencial:',
    code: pretty,
    foot: 'Vence en 15 minutos y sirve una sola vez. Al borrarla se pierden tus logros, tu XP y tu nivel. Si no fuiste tú, no escribas el código y cambia tu contraseña: alguien la conoce.',
  });
  return { subject, text, html };
}

/** El gracias de una compra en la sala física: cuánto XP sumó, su total y su nivel (y si subió). */
export function storeThanksEmail({ name, amountCents, xp, total, level, levelUp, url }) {
  const subject = `¡Gracias por tu compra en Dream Zone! +${xp} XP`;
  const now = levelUp ? `¡subiste a ${level}!` : `eres ${level}.`;
  const line = `Gracias por tu compra de ${cop(amountCents)} en la sala. Tu credencial sumó ${xp} XP: ahora tienes ${total.toLocaleString('es-CO')} XP y ${now}`;
  const text = [
    `Hola, ${name}:`,
    '',
    line,
    '',
    `Mira tu credencial: ${url}`,
    '',
    'Cada $1.000 que compras, en la tienda en línea o en la sala, suma 5 XP.',
    '',
    '— Dream Zone · archivo de reliquias geek',
  ].join('\n');
  const html = card({
    kicker: 'Dream Zone · compra en la sala',
    heading: `¡Gracias, ${name}!`,
    body: line,
    cta: 'Ver mi credencial',
    url,
    foot: 'Cada $1.000 que compras, en la tienda en línea o en la sala, suma 5 XP.',
  });
  return { subject, text, html };
}

/** Aviso de inactividad: la credencial lleva 2 años sin usarse y se borrará en `deadline` si nadie entra. */
export function inactiveNoticeEmail({ name, url, deadline }) {
  const day = deadline.toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Bogota' });
  const subject = 'Tu credencial de Dream Zone lleva 2 años sin usarse';
  const text = [
    `Hola, ${name}:`,
    '',
    `Tu credencial de Dream Zone lleva 2 años sin usarse. Como dice nuestra política de tratamiento de datos, si no entras a ella antes del ${day}, la borraremos con tus logros, tu XP y tu nivel.`,
    '',
    `Si quieres conservarla, solo entra: ${url}`,
    '',
    'Tus pedidos no se borran con ella: se conservan aparte por las normas contables.',
    '',
    '— Dream Zone · archivo de reliquias geek',
  ].join('\n');
  const html = card({
    kicker: 'Dream Zone · credencial inactiva',
    heading: `Hola, ${name}.`,
    body: `Tu credencial lleva 2 años sin usarse. Como dice nuestra política de tratamiento de datos, si no entras a ella antes del ${day}, la borraremos con tus logros, tu XP y tu nivel.`,
    cta: 'Entrar y conservarla',
    url,
    foot: 'Tus pedidos no se borran con ella: se conservan aparte por las normas contables.',
  });
  return { subject, text, html };
}

export function inviteEmail({ name, url, inviter }) {
  const subject = 'Te invitaron a la curaduría de Dream Zone';
  const text = [
    `Hola, ${name}:`,
    '',
    `${inviter} te dio acceso a la curaduría de Dream Zone: el panel para editar las piezas, los textos y los drops de la tienda.`,
    'Abre este enlace en los próximos 7 días para elegir tu contraseña:',
    '',
    url,
    '',
    'Si no esperabas esta invitación, ignora este correo.',
    '',
    '— Dream Zone · archivo de reliquias geek',
  ].join('\n');
  const html = card({
    kicker: 'Dream Zone · curaduría',
    heading: `Hola, ${name}.`,
    body: `${inviter} te dio acceso a la curaduría: el panel para editar las piezas, los textos y los drops de la tienda. El enlace sirve una sola vez y vence en 7 días.`,
    cta: 'Activar mi credencial →',
    url,
    foot: 'Si no esperabas esta invitación, ignora este correo.',
  });
  return { subject, text, html };
}
const cop = (cents) => `$${Math.round(cents / 100).toLocaleString('es-CO')}`;

/** Confirmación de un pago aprobado: lo comprado, el total y cómo llega. */
export function orderPaidEmail({ order, url }) {
  const first = order.customer.name.split(' ')[0];
  const lines = order.lines.map((l) => `${l.qty} × ${l.name} · ${cop(l.totalCents)}`);
  const where = order.delivery.method === 'tienda'
    ? 'Recoges en la tienda: te avisamos por correo cuando esté listo para recoger.'
    : `Envío a ${order.delivery.address}, ${order.delivery.city} (${order.delivery.region}).`;
  const subject = `Pago confirmado · pedido ${order.reference}`;
  const text = [
    `Hola, ${first}:`,
    '',
    `Recibimos tu pago de ${cop(order.totalCents)}. Tu pedido ${order.reference} ya está en el archivo:`,
    '',
    ...lines,
    order.shippingCents ? `Envío · ${cop(order.shippingCents)}` : 'Envío · gratis',
    `Total · ${cop(order.totalCents)}`,
    '',
    where,
    order.xp ? `Tu credencial sumó ${order.xp} XP con esta compra.` : '',
    '',
    `Sigue tu pedido: ${url}`,
    '',
    '— Dream Zone · archivo de reliquias geek',
  ].filter((line, i, all) => line !== '' || all[i - 1] !== '').join('\n');
  const html = card({
    kicker: `Dream Zone · pedido ${order.reference}`,
    heading: `¡Es tuyo, ${first}!`,
    body: `Recibimos tu pago de ${cop(order.totalCents)}: ${lines.join(' · ')}. ${where}${order.xp ? ` Tu credencial sumó ${order.xp} XP.` : ''}`,
    cta: 'Ver mi pedido →',
    url,
    foot: 'Guarda este correo: la referencia identifica tu compra si necesitas escribirnos.',
  });
  return { subject, text, html };
}

/** Aviso a la curaduría: entró un pedido pagado (qué, cuánto, para quién y cómo se entrega). */
export function newOrderEmail({ order, url }) {
  const sim = order.simulated ? '[Simulado] ' : '';
  const lines = order.lines.map((l) => `${l.qty} × ${l.name} · ${cop(l.totalCents)}`);
  const where = order.delivery.method === 'tienda'
    ? 'Recoge en la tienda.'
    : `Envío a ${order.delivery.address}${order.delivery.details ? `, ${order.delivery.details}` : ''}, ${order.delivery.city} (${order.delivery.region}).`;
  const who = `${order.customer.name} · ${order.customer.email} · ${order.customer.phone}`;
  const todo = order.simulated
    ? 'Pago SIMULADO (npm run pago:simular): no entró dinero, no lo despaches.'
    : 'Despáchalo desde Curaduría › Pedidos: elige la distribuidora y escribe la guía; al cliente le llega el aviso.';
  const subject = `${sim}Nuevo pedido ${order.reference} · ${cop(order.totalCents)} · ${order.customer.name}`;
  const text = [
    `Entró un pedido pagado: ${order.reference}`,
    '',
    ...lines,
    order.delivery.method === 'tienda' ? 'Entrega · en la tienda' : order.shippingCents ? `Envío · ${cop(order.shippingCents)}` : 'Envío · gratis',
    `Total · ${cop(order.totalCents)}`,
    '',
    `Cliente: ${who}`,
    where,
    order.notes ? `Nota del cliente: «${order.notes}»` : '',
    '',
    todo,
    url,
    '',
    '— Dream Zone · curaduría',
  ].filter((line, i, all) => line !== '' || all[i - 1] !== '').join('\n');
  const html = card({
    kicker: `Dream Zone · curaduría${sim ? ' · simulado' : ''}`,
    heading: `Pedido ${order.reference}`,
    body: `Pagado: ${cop(order.totalCents)}. ${lines.join(' · ')}. ${where} Cliente: ${who}.${order.notes ? ` Nota: «${order.notes}».` : ''}`,
    cta: 'Abrir pedidos →',
    url,
    foot: todo,
  });
  return { subject, text, html };
}

/** Aviso de un drop nuevo a la lista de correo: qué trae, cuánto ahorra, cuántos quedan y cuándo cierra. */
export function dropEmail({ drop, pieces, regularCents, url, unsubscribe }) {
  const n = String(drop.number).padStart(3, '0');
  const save = regularCents > drop.priceCents ? regularCents - drop.priceCents : 0;
  const left = dropAvailable(pieces); // los que permite la pieza con menos existencias
  const ends = drop.endsAt.toLocaleString('es-CO', {
    timeZone: 'America/Bogota', weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit',
  });
  const names = pieces.map((p) => p.name).join(' + ');
  const price = `${cop(drop.priceCents)}${save ? ` (por separado ${cop(regularCents)}: ahorras ${cop(save)})` : ''}`;
  const subject = `Nuevo drop #${n} · ${drop.title}`;
  const text = [
    `Drop #${n} · ${drop.title}`,
    drop.specs || '',
    '',
    `Trae: ${names}.`,
    `Precio: ${price}.`,
    `Quedan ${left} · cierra el ${ends}.`,
    '',
    `Míralo: ${url}`,
    '',
    `¿Ya no quieres estos avisos? ${unsubscribe}`,
    '',
    '— Dream Zone · archivo de reliquias geek',
  ].filter((line, i, all) => line !== '' || all[i - 1] !== '').join('\n');
  const html = card({
    kicker: `Dream Zone · drop #${n}`,
    heading: drop.title,
    body: `${drop.specs ? `${drop.specs}. ` : ''}Trae ${names}. ${price}. Quedan ${left} · cierra el ${ends}.`,
    cta: 'Ver el drop →',
    url,
    foot: 'Cada unidad se aparta al añadirla al carrito: cuando se acaban, se acaban.',
    unsubscribe,
  });
  return { subject, text, html };
}

/**
 * Aviso de despacho: con qué distribuidora va y su número de guía o, si se recoge, que ya está listo en la tienda.
 * `store` (de «Visítanos»): { address, reference, hours } para decir dónde y cuándo recogerlo.
 */
export function orderShippedEmail({ order, shipment, url, store }) {
  const first = order.customer.name.split(' ')[0];
  const pickup = order.delivery.method === 'tienda';
  const subject = pickup ? `Listo para recoger · pedido ${order.reference}` : `Va en camino · pedido ${order.reference}`;
  const where = store?.address ? ` Te esperamos en ${store.address}.${store.reference ? ` ${store.reference}` : ''}` : '';
  const how = pickup
    ? `Tu pedido ya está listo en la tienda.${where} Al llegar, di la referencia ${order.reference}.`
    : `Tu pedido salió con ${shipment.carrierName}. Número de guía: ${shipment.tracking}.${shipment.url ? ` Rastréalo en ${shipment.url}.` : ''}`;
  const hours = pickup && store?.hours ? `Horario: ${store.hours}.` : '';
  const text = [
    `Hola, ${first}:`,
    '',
    how,
    ...(hours ? ['', hours] : []),
    '',
    `Tu pedido: ${url}`,
    '',
    '— Dream Zone · archivo de reliquias geek',
  ].join('\n');
  const html = card({
    kicker: `Dream Zone · pedido ${order.reference}`,
    heading: pickup ? `Listo para recoger, ${first}.` : `Va en camino, ${first}.`,
    body: how,
    cta: 'Ver mi pedido →',
    url,
    foot: pickup ? hours || 'Te esperamos en el archivo.' : 'La distribuidora puede tardar unas horas en mostrar la guía en su página.',
  });
  return { subject, text, html };
}