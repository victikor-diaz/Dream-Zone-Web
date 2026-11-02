/*
 * Simula la respuesta de Wompi a un pedido, SIN cobrar, para probar la lógica de pagos de punta a punta.
 *   npm run pago:simular                                → lista los pedidos que esperan pago
 *   npm run pago:simular -- DZ261016-ABC123             → lo aprueba, como si Wompi dijera APPROVED
 *   npm run pago:simular -- DZ261016-ABC123 rechazado   → también: anulado · error · proceso (Nequi/PSE esperando)
 *   npm run pago:simular -- DZ261016-ABC123 deshacer    → borra un pedido simulado y devuelve existencias y XP
 *   npm run pago:simular -- recibos correo@x.com 15     → 15 recibos pagados de DEMOSTRACIÓN en esa credencial, con
 *                                                         precios reales pero sin mover existencias, carrito ni XP
 *   npm run pago:simular -- recibos correo@x.com borrar → borra los recibos de demostración de esa credencial
 * Pasa por applyTransaction, igual que el aviso real de Wompi: aprobar descuenta existencias (por talla), saca lo
 * comprado del carrito y suma el XP de la compra. El pedido queda marcado «simulado»: en Curaduría › Pedidos se ve
 * que no entró dinero, para no despacharlo.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { getDb, closeDb } from '../lib/mongodb.js';
import { COLLECTIONS, hasSizes } from '../lib/catalog.js';
import { applyTransaction, quoteCart, CARRIERS } from '../lib/orders.js';
import { arcadeDay } from '../lib/achievements.js';
import { email as emailField } from '../lib/validate.js';
import { mailPaidOrder } from '../lib/order-mail.js';
import { mailEnabled } from '../lib/mailer.js';

/** URL de la tienda para los enlaces de los correos (la de producción si está en APP_URL, si no la local). */
const BASE = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');

const OUTCOMES = { aprobado: 'APPROVED', rechazado: 'DECLINED', anulado: 'VOIDED', error: 'ERROR', proceso: 'PENDING' };
const MESSAGES = { DECLINED: 'Pago simulado: rechazado', VOIDED: 'Pago simulado: anulado', ERROR: 'Pago simulado: error' };
const SIM = 'SIMULADO-';
const REF_RE = /^DZ\d{6}-[A-Z2-9]{6}$/;
const USAGE = '> uso: npm run pago:simular -- <referencia> [aprobado|rechazado|anulado|error|proceso|deshacer]';
const [refRaw, actionRaw = 'aprobado'] = process.argv.slice(2);

const money = (cents) => `$${Math.round(cents / 100).toLocaleString('es-CO')}`;
const when = (d) => d.toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'short', timeStyle: 'short' });
const label = (key) => {
  const [slug, size] = key.split('|');
  return size ? `${slug} (talla ${size})` : slug;
};

/** Las unidades que mueve un pedido: «slug» o «slug|talla» → cantidad (igual que fulfil en lib/orders.js). */
function unitsOf(order) {
  const need = new Map();
  const add = (key, qty) => need.set(key, (need.get(key) ?? 0) + qty);
  order.lines.forEach((l) => {
    if (l.kind === 'product') add(l.size ? `${l.id}|${l.size}` : l.id, l.qty);
    else l.includes.forEach((x) => add(x.id, l.qty));
  });
  return need;
}

/** Existencias actuales de esas unidades (la talla si la hay). */
async function stockOf(db, keys) {
  const slugs = [...new Set(keys.map((k) => k.split('|')[0]))];
  const products = await db.collection(COLLECTIONS.products).find({ slug: { $in: slugs } }).toArray();
  const bySlug = new Map(products.map((p) => [p.slug, p]));
  return new Map(keys.map((key) => {
    const [slug, size] = key.split('|');
    const p = bySlug.get(slug);
    return [key, size ? p?.sizes?.find((s) => s.size === size)?.stock : p?.stock];
  }));
}

async function listPending(db) {
  const list = await db.collection(COLLECTIONS.orders).find({ status: 'pending' }).sort({ createdAt: -1 }).limit(15).toArray();
  if (!list.length) {
    console.log('> no hay pedidos esperando pago. Crea uno en /pago (llega hasta Wompi y vuelve sin pagar).');
    return;
  }
  console.log('> pedidos esperando pago (los 15 más nuevos):');
  list.forEach((o) => {
    const tx = o.wompi?.transactionId ? ` · transacción ${o.wompi.transactionId}` : ' · sin transacción';
    console.log(`  ${o.reference} · ${money(o.totalCents)} · ${o.customer.email} · ${when(o.createdAt)}${tx}`);
  });
  console.log(USAGE);
}

async function simulate(db, order, status) {
  if (order.status !== 'pending') throw new Error(`${order.reference} ya está «${order.status}»: solo se simulan pedidos pendientes.`);
  const real = order.wompi?.transactionId && !order.wompi.transactionId.startsWith(SIM);
  if (real) throw new Error(`${order.reference} ya tiene una transacción real de Wompi (${order.wompi.transactionId}): no se simula encima.`);

  const keys = [...unitsOf(order).keys()];
  const before = await stockOf(db, keys);
  const xpBefore = order.userId ? (await db.collection(COLLECTIONS.users).findOne({ _id: order.userId }))?.purchaseXp ?? 0 : null;
  await db.collection(COLLECTIONS.orders).updateOne({ _id: order._id }, { $set: { simulated: true } });
  const after = await applyTransaction(db, {
    id: `${SIM}${Date.now()}`,
    reference: order.reference,
    status,
    amount_in_cents: order.totalCents,
    currency: 'COP',
    payment_method_type: 'SIMULADO',
    status_message: MESSAGES[status] ?? null,
  });

  console.log(`> ${order.reference}: pending → ${after.status}${after.status === 'pending' ? ' (con transacción: «en proceso»)' : ''} · pago SIMULADO, no entró dinero`);
  console.log(`  total ${money(order.totalCents)} · ${order.customer.email} · ${order.userId ? `credencial Lv ${order.level}` : 'sin credencial'}`);
  if (after.status !== 'approved') {
    console.log('  existencias, carrito y XP: sin cambios (solo un pago aprobado los mueve)');
  } else {
    const now = await stockOf(db, keys);
    keys.forEach((k) => console.log(`  existencias ${label(k)}: ${before.get(k)} → ${now.get(k)}`));
    if (after.stockIssues?.length) console.log(`  ¡sin existencias suficientes!: ${after.stockIssues.join(', ')} (la curaduría lo ve en el pedido)`);
    console.log(`  carrito: ${order.cartId ? 'lo comprado salió del carrito' : 'el pedido no tenía carrito'}`);
    console.log(`  XP de la compra: ${order.userId ? `+${after.xp} (purchaseXp ${xpBefore} → ${xpBefore + after.xp})` : 'no suma, se compró sin credencial'}`);
    // como un pago real: confirmación a quien compró y aviso a la curaduría (marcado «simulado»)
    const mail = await mailPaidOrder(db, after, BASE);
    console.log(`  correos: ${!mailEnabled() ? 'el SMTP no está configurado, no sale ninguno'
      : `${mail.customer ? `confirmación a ${order.customer.email}` : 'sin confirmación'} · aviso a ${mail.staff} ${mail.staff === 1 ? 'curador' : 'curadores'}`}`);
  }
  console.log(`  míralo en /pago?ref=${order.reference} (con la sesión del comprador), en Mis pedidos y en Curaduría › Pedidos`);
  console.log(`  para deshacerlo: npm run pago:simular -- ${order.reference} deshacer`);
}

/* ---------- Recibos de demostración ---------- */
const DEMO_PLACES = [
  { region: 'Bogotá D.C.', city: 'Bogotá', address: 'Calle 85 # 11-53' },
  { region: 'Antioquia', city: 'Medellín', address: 'Carrera 43A # 7-50' },
  { region: 'Valle del Cauca', city: 'Cali', address: 'Avenida 6N # 23-45' },
  { region: 'Atlántico', city: 'Barranquilla', address: 'Carrera 53 # 76-120' },
  { region: 'Santander', city: 'Bucaramanga', address: 'Calle 36 # 27-41' },
  { region: 'Risaralda', city: 'Pereira', address: 'Carrera 8 # 21-30' },
];
const DEMO_METHODS = ['CARD', 'NEQUI', 'PSE', 'DAVIPLATA', 'BANCOLOMBIA_TRANSFER'];
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // igual que newReference en lib/orders.js
const pick = (list) => list[randomInt(list.length)];
const DAY = 86_400_000;

/** Recibos pagados repartidos en los últimos meses: los 2 más nuevos por despachar, el resto ya enviados con su guía. */
async function demoReceipts(db, mailRaw, countRaw) {
  let mail;
  try {
    mail = emailField(mailRaw ?? '');
  } catch {
    throw new Error('escribe el correo de la credencial: npm run pago:simular -- recibos correo@ejemplo.com 15');
  }
  const user = await db.collection(COLLECTIONS.users).findOne({ email: mail });
  if (!user) throw new Error(`no hay ninguna cuenta con ${mail}`);
  const orders = db.collection(COLLECTIONS.orders);
  if (countRaw === 'borrar') {
    const { deletedCount } = await orders.deleteMany({ userId: user._id, demo: true });
    console.log(`> ${deletedCount} recibos de demostración borrados de ${user.name} <${mail}>.`);
    return;
  }
  const count = Number(countRaw ?? 15);
  if (!Number.isInteger(count) || count < 1 || count > 40) throw new Error('el número de recibos va de 1 a 40');

  const products = await db.collection(COLLECTIONS.products).find({ status: 'active' }).toArray();
  if (!products.length) throw new Error('no hay piezas activas para armar los recibos');
  const now = Date.now();
  const docs = [];
  for (let i = 0; i < count; i += 1) {
    const createdAt = new Date(now - i * 4 * DAY - randomInt(2, 20) * 3_600_000);
    const paidAt = new Date(createdAt.getTime() + randomInt(60, 600) * 1000);
    const chosen = [...products].sort(() => Math.random() - 0.5).slice(0, randomInt(1, 4));
    const items = chosen.map((p) => {
      const sizes = hasSizes(p) ? p.sizes.filter((s) => s.stock > 0) : [];
      return { slug: p.slug, qty: randomInt(1, 3), ...(hasSizes(p) ? { size: pick(sizes.length ? sizes : p.sizes).size } : {}) };
    });
    const pickup = randomInt(5) === 0;
    const delivery = pickup ? { method: 'tienda' } : { method: 'envio', ...pick(DEMO_PLACES), details: '' };
    const quote = await quoteCart(db, { items, user, delivery }); // precios, beneficio de nivel y envío de verdad
    const shipped = i >= 2;
    const carrier = pick(CARRIERS.filter((c) => c.id !== 'otra'));
    const tail = Array.from({ length: 6 }, () => REF_ALPHABET[randomInt(REF_ALPHABET.length)]).join('');
    docs.push({
      reference: `DZ${arcadeDay(createdAt).slice(2).replace(/-/g, '')}-${tail}`,
      keyHash: createHash('sha256').update(randomBytes(18)).digest('hex'),
      status: 'approved',
      createdAt,
      updatedAt: paidAt,
      paidAt,
      cartId: null,
      userId: user._id,
      level: quote.level,
      perks: quote.perks,
      customer: { name: user.name, email: user.email, phone: '3001234567', idType: 'CC', idNumber: '1020304050' },
      delivery,
      notes: '',
      lines: quote.lines.map(({ problem, ...l }) => l),
      subtotalCents: quote.subtotalCents,
      discountCents: quote.discountCents,
      merchandiseCents: quote.merchandiseCents,
      shippingCents: quote.shipping.cents ?? 0,
      freeShipping: quote.shipping.free,
      totalCents: quote.totalCents,
      fulfillment: shipped ? 'enviado' : 'nuevo',
      ...(shipped ? { shippedAt: new Date(paidAt.getTime() + randomInt(1, 3) * DAY) } : {}),
      ...(shipped && !pickup ? { carrier: carrier.id, tracking: String(randomInt(1_000_000_000, 9_999_999_999)) } : { tracking: null }),
      xp: 0,
      stockIssues: [],
      wompi: { transactionId: `${SIM}DEMO-${Date.now()}-${i}`, status: 'APPROVED', method: pick(DEMO_METHODS), message: null, at: paidAt },
      simulated: true,
      demo: true, // no movió existencias, carrito ni XP: «deshacer» y «borrar» no devuelven nada
    });
  }
  await orders.insertMany(docs);
  const total = docs.reduce((n, o) => n + o.totalCents, 0);
  console.log(`> ${count} recibos de demostración para ${user.name} <${mail}> (Lv ${docs[0].level}) · ${money(total)} en total`);
  console.log(`  ${docs.filter((o) => o.fulfillment === 'nuevo').length} por despachar · ${docs.filter((o) => o.fulfillment === 'enviado').length} enviados o entregados · sin tocar existencias ni XP`);
  console.log(`  míralos en /cuenta#pedidos con esa credencial y en Curaduría › Pedidos («demostración»)`);
  console.log(`  para quitarlos: npm run pago:simular -- recibos ${mail} borrar`);
}

async function undo(db, order) {
  if (!order.simulated) throw new Error(`${order.reference} no es un pedido simulado: este comando solo deshace simulaciones.`);
  if (order.status === 'approved' && !order.demo) {
    const products = db.collection(COLLECTIONS.products);
    const missed = new Set(order.stockIssues ?? []); // lo que no se pudo descontar tampoco se devuelve
    for (const [key, qty] of unitsOf(order)) {
      if (missed.has(label(key))) continue;
      const [slug, size] = key.split('|');
      const now = new Date();
      if (size) await products.updateOne({ slug, 'sizes.size': size }, { $inc: { 'sizes.$.stock': qty, stock: qty }, $set: { updatedAt: now } });
      else await products.updateOne({ slug }, { $inc: { stock: qty }, $set: { updatedAt: now } });
      console.log(`  existencias ${label(key)}: +${qty}`);
    }

    if (order.userId && order.xp) {
      await db.collection(COLLECTIONS.users).updateOne({ _id: order.userId, purchaseXp: { $gte: order.xp } }, { $inc: { purchaseXp: -order.xp } });
      console.log(`  XP de la compra: −${order.xp}`);
    }
  }
  await db.collection(COLLECTIONS.orders).deleteOne({ _id: order._id, simulated: true });
  console.log(`> ${order.reference} (${order.status}) borrado. Lo que salió del carrito no vuelve: añádelo otra vez si quieres repetir la prueba.`);
}

async function main() {
  const db = await getDb();
  if (!refRaw) return listPending(db);
  if (refRaw === 'recibos') return demoReceipts(db, process.argv[3], process.argv[4]);
  const reference = refRaw.trim().toUpperCase();
  const action = actionRaw.trim().toLowerCase();
  if (!REF_RE.test(reference) || !(action in OUTCOMES || action === 'deshacer')) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const order = await db.collection(COLLECTIONS.orders).findOne({ reference });
  if (!order) throw new Error(`no hay ningún pedido ${reference}`);
  if (action === 'deshacer') await undo(db, order);
  else await simulate(db, order, OUTCOMES[action]);
}

main()
  .catch((err) => {
    console.error('> falló:', err.message);
    process.exitCode = 1;
  })
  .finally(closeDb);
