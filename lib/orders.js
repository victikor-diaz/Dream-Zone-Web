import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { HttpError } from './http.js';
import { text, email, optionalText, oneOf } from './validate.js';
import { COLLECTIONS, coverUrl, hasSizes, sizeStock } from './catalog.js';
import { perksFor, progressOf, purchaseXpFor, arcadeDay } from './achievements.js';
import { readSite } from './site.js';
import { enviaEnabled, findPlace, shippingRates } from './shipping.js';
import { consentOf } from './privacy.js';

/*
 * Pedidos: el total lo calcula siempre el servidor (precios de la base, descuento de nivel y envío);
 * el navegador solo elige la entrega. Un pedido nace «pending» y Wompi lo resuelve:
 * approved (se descuentan existencias, sale del carrito y suma XP) · declined · voided · error.
 */

export const DEPARTMENTS = [
  'Amazonas', 'Antioquia', 'Arauca', 'Atlántico', 'Bogotá D.C.', 'Bolívar', 'Boyacá', 'Caldas', 'Caquetá',
  'Casanare', 'Cauca', 'Cesar', 'Chocó', 'Córdoba', 'Cundinamarca', 'Guainía', 'Guaviare', 'Huila', 'La Guajira',
  'Magdalena', 'Meta', 'Nariño', 'Norte de Santander', 'Putumayo', 'Quindío', 'Risaralda',
  'San Andrés y Providencia', 'Santander', 'Sucre', 'Tolima', 'Valle del Cauca', 'Vaupés', 'Vichada',
];
export const ID_TYPES = ['CC', 'CE', 'NIT', 'PP', 'TI'];
/** La entrega tiene dos pasos: «nuevo» (pagado, por despachar) y «enviado» (o listo para recoger, si se recoge en la tienda). */
export const FULFILLMENT = ['nuevo', 'enviado'];
/** Distribuidoras para la guía de envío; `url` es su página oficial, donde está la casilla de rastreo. */
export const CARRIERS = [
  { id: 'servientrega', name: 'Servientrega', url: 'https://www.servientrega.com' },
  { id: 'interrapidisimo', name: 'Interrapidísimo', url: 'https://interrapidisimo.com' },
  { id: 'coordinadora', name: 'Coordinadora', url: 'https://coordinadora.com' },
  { id: 'envia', name: 'Envía', url: 'https://envia.co' },
  { id: 'tcc', name: 'TCC', url: 'https://tcc.com.co' },
  { id: 'deprisa', name: 'Deprisa', url: 'https://www.deprisa.com' },
  { id: 'mensajerosurbanos', name: 'Mensajeros Urbanos', url: 'https://mensajerosurbanos.com' },
  { id: '472', name: '4-72', url: 'https://www.4-72.com.co' },
  { id: 'otra', name: 'Otra', url: null },
];
const CARRIER_BY_ID = new Map(CARRIERS.map((c) => [c.id, c]));
const TRACKING_RE = /^[A-Za-z0-9][A-Za-z0-9 -]{2,38}[A-Za-z0-9]$/;
/** Los pedidos de antes tenían cuatro pasos: «preparando» sigue por despachar y «entregado» ya salió. */
export const fulfillmentOf = (o) => (o.fulfillment === 'enviado' || o.fulfillment === 'entregado' ? 'enviado' : 'nuevo');
const STATUS_FROM_WOMPI = { APPROVED: 'approved', DECLINED: 'declined', VOIDED: 'voided', ERROR: 'error', PENDING: 'pending' };

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
/** Los pesos no tienen centavos: todo se redondea al peso. */
const pesos = (cents) => Math.round(cents / 100) * 100;
const percent = (cents, pct) => pesos((cents * pct) / 100);

/* ---------- Datos del comprador ---------- */

/** Valida { customer, delivery, notes, consent } tal como los manda la página de pago. */
export function checkoutInput(body) {
  const consent = consentOf(body?.consent); // la casilla de la política de datos, antes que todo lo demás
  const c = body?.customer ?? {};
  const d = body?.delivery ?? {};
  const phone = String(c.phone ?? '').replace(/[\s().-]/g, '').replace(/^\+?57(?=3\d{9}$)/, '');
  if (!/^3\d{9}$/.test(phone)) throw new HttpError(400, 'Escribe un celular colombiano de 10 dígitos (empieza por 3).');
  const idNumber = String(c.idNumber ?? '').replace(/[\s.]/g, '').toUpperCase();
  if (!/^[0-9A-Z-]{5,15}$/.test(idNumber)) throw new HttpError(400, 'El número de documento no es válido.');
  const customer = {
    name: text(c.name, { field: 'nombre completo', min: 3, max: 80 }),
    email: email(c.email),
    phone,
    idType: oneOf(c.idType, ID_TYPES, 'tipo de documento'),
    idNumber,
  };
  const method = oneOf(d.method, ['envio', 'tienda'], 'forma de entrega');
  const delivery = method === 'tienda' ? { method } : {
    method,
    region: oneOf(d.region, DEPARTMENTS, 'departamento'),
    city: text(d.city, { field: 'ciudad', min: 2, max: 60 }),
    address: text(d.address, { field: 'dirección', min: 5, max: 120 }),
    details: optionalText(d.details, { field: 'detalles de la dirección', max: 120 }),
    option: shippingOptionId(d.option), // la transportadora elegida (el precio lo vuelve a cotizar el servidor)
  };
  return { customer, delivery, notes: optionalText(body?.notes, { field: 'nota', max: 280 }), consent };
}

/** «coordinadora:ecommerce»: la opción de envío que eligió quien compra (o null). */
export function shippingOptionId(value) {
  if (value === undefined || value === null || value === '') return null;
  const id = String(value).trim();
  if (!/^[a-z]{3,30}:[a-z0-9_-]{1,40}$/i.test(id)) throw new HttpError(400, 'La opción de envío no es válida.');
  return id;
}

/* ---------- Cotización ---------- */

/**
 * Envío: gratis en la tienda. A domicilio, el municipio tiene que estar en la lista oficial (lib/shipping.js findPlace):
 * si no, el pago no sigue (`blocker`, con sugerencias). Con ENVIA_API_KEY se cotiza en vivo con Interrapidísimo y se
 * cobra esa tarifa (o la opción elegida, si se cotizan varias) más el recargo de la tienda; si Envia no responde o no
 * llega a ese municipio, tampoco sigue. Sin la llave (pruebas locales), la tarifa fija de Bogotá o la nacional.
 * El envío gratis (Mítico o promoción) gana siempre: la tienda paga la más barata.
 */
async function shippingFor(db, pago, delivery, merchandiseCents, perks, grams) {
  if (delivery?.method === 'tienda') return { method: 'tienda', cents: 0, free: null, missingCents: null };
  const rules = [
    perks.freeShippingFrom ? { from: perks.freeShippingFrom, reason: 'mitico' } : null,
    pago.envioGratisDesde > 0 ? { from: pago.envioGratisDesde * 100, reason: 'promo' } : null,
  ].filter(Boolean).sort((a, b) => a.from - b.from);
  const free = rules.find((r) => merchandiseCents >= r.from);
  const next = rules.find((r) => merchandiseCents < r.from);
  const base = {
    method: 'envio',
    known: Boolean(delivery?.region),
    cents: null, // null: aún no hay precio (falta el municipio o no se pudo cotizar)
    free: free?.reason ?? null,
    missingCents: free ? null : next ? next.from - merchandiseCents : null, // lo que falta para el envío gratis
    missingReason: free ? null : next?.reason ?? null,
    source: null,
    options: [],
    option: null,
    place: null,
    placeCode: null,
    need: null, // 'region' | 'city': lo que falta escribir para cotizar
    blocker: null, // por qué no se puede pagar con este destino (se muestra tal cual)
    suggestions: [], // municipios parecidos a lo escrito
  };
  if (!delivery?.region) return { ...base, need: 'region' };
  if (!delivery.city) return { ...base, need: 'city' };

  const { place, suggestions } = findPlace(delivery.region, delivery.city);
  if (!place) {
    return {
      ...base,
      blocker: `No encontramos «${delivery.city}» en ${delivery.region}. ${suggestions.length ? 'Elige tu municipio:' : 'Elige tu municipio de la lista.'}`,
      suggestions,
    };
  }
  const where = { ...base, place: place.name, placeCode: place.dane };
  if (!enviaEnabled()) {
    return { ...where, cents: free ? 0 : (delivery.region === 'Bogotá D.C.' ? pago.envioBogota : pago.envioNacional) * 100, source: 'tarifa' };
  }
  const rates = await shippingRates(db, { place, grams, declaredCents: merchandiseCents });
  if (!rates) {
    // con envío gratis la tienda paga igual: el pedido sigue y el despacho se cotiza después
    return free
      ? { ...where, cents: 0, source: 'tarifa' }
      : { ...where, blocker: `No pudimos cotizar el envío a ${place.name} en este momento. Intenta de nuevo en unos minutos o escríbenos por Instagram o TikTok y cuadramos tu pedido.` };
  }
  if (!rates.length) {
    return { ...where, blocker: `Interrapidísimo no llega a ${place.name}. Escríbenos por Instagram o TikTok y cuadramos tu pedido.` };
  }
  const options = rates.map((o) => ({ ...o, cents: o.cents + pago.envioRecargo * 100 }));
  const chosen = free ? options[0] : options.find((o) => o.id === delivery.option) ?? options[0];
  return {
    ...where,
    cents: free ? 0 : chosen.cents,
    source: 'envia',
    options: free ? [] : options, // con envío gratis no se elige: la tienda manda la más barata
    option: chosen,
  };
}

/** Lo que pesan las piezas del pedido (gramos; el empaque pesa poco y no se cuenta): cada una con su peso o el de la curaduría. */
function weightOf(lines, bySlug, pesoPieza) {
  const grams = (slug) => bySlug.get(slug)?.weightGrams ?? pesoPieza;
  return lines.reduce((sum, l) => sum + l.qty * (l.kind === 'product'
    ? grams(l.id)
    : (l.includes ?? []).reduce((n, x) => n + grams(x.id), 0)), 0);
}

/**
 * Cotiza el carrito con los precios de la base: líneas con su descuento de nivel, existencias, envío y total.
 * `problems` lista lo que impide pagar (piezas agotadas, drops cerrados…).
 */
export async function quoteCart(db, { items, user, delivery }) {
  const level = user ? progressOf(user).level : 1;
  const perks = perksFor(level);
  const now = Date.now();
  const codes = items.filter((i) => i.drop).map((i) => i.drop);
  const drops = codes.length ? await db.collection(COLLECTIONS.drops).find({ code: { $in: codes } }).toArray() : [];
  const dropBy = new Map(drops.map((d) => [d.code, d]));
  const slugs = new Set(items.filter((i) => i.slug).map((i) => i.slug));
  drops.forEach((d) => (Array.isArray(d.items) ? d.items : []).forEach((s) => slugs.add(s)));
  const products = slugs.size ? await db.collection(COLLECTIONS.products).find({ slug: { $in: [...slugs] } }).toArray() : [];
  const bySlug = new Map(products.map((p) => [p.slug, p]));
  // unidades de cada pieza (y talla): sueltas y dentro de los bundles; clave «slug» o «slug|talla»
  const need = new Map();
  const add = (slug, qty, size = null) => {
    const key = size ? `${slug}|${size}` : slug;
    need.set(key, (need.get(key) ?? 0) + qty);
  };

  const lines = [];
  for (const it of items) {
    if (it.slug) {
      const p = bySlug.get(it.slug);
      const gross = (p?.priceCents ?? 0) * it.qty;
      const discountCents = percent(gross, perks.productPct);
      const size = it.size ?? null;
      const line = {
        kind: 'product', id: it.slug, ...(size ? { size } : {}),
        name: `${p?.name ?? 'Pieza retirada'}${size ? ` · Talla ${size}` : ''}`, category: p?.category ?? null, icon: p?.icon ?? null, image: coverUrl(p),
        qty: it.qty, unitCents: p?.priceCents ?? 0, discountPct: perks.productPct, discountCents, totalCents: gross - discountCents,
      };
      if (!p || p.status !== 'active') line.problem = 'Ya no está disponible. Quítala del carrito para seguir.';
      else if (hasSizes(p) && !size) line.problem = 'Ahora va por tallas: quítala y vuelve a añadirla con tu talla.';
      else if (size && !p.sizes?.some((s) => s.size === size)) line.problem = `Ya no viene en talla ${size}. Quítala del carrito para seguir.`;
      else add(p.slug, it.qty, size);
      lines.push(line);
      continue;
    }
    const d = dropBy.get(it.drop);
    const pieces = Array.isArray(d?.items) ? d.items : [];
    const gross = (d?.priceCents ?? 0) * it.qty;
    const discountCents = percent(gross, perks.dropPct);
    const line = {
      kind: 'drop', id: it.drop, name: d ? `Drop #${String(d.number).padStart(3, '0')} · ${d.title}` : 'Drop retirado',
      qty: it.qty, unitCents: d?.priceCents ?? 0, discountPct: perks.dropPct, discountCents, totalCents: gross - discountCents,
      includes: pieces.map((s) => ({ id: s, name: bySlug.get(s)?.name ?? s, image: coverUrl(bySlug.get(s)) })),
    };
    if (!d || !d.active || d.endsAt.getTime() <= now) line.problem = 'Este drop ya cerró. Quítalo del carrito para seguir.';
    else if (pieces.some((s) => bySlug.get(s)?.status !== 'active')) line.problem = 'Una pieza de este drop ya no está disponible.';
    else pieces.forEach((s) => add(s, it.qty));
    lines.push(line);
  }

  // existencias: una pieza puede ir suelta y dentro de un bundle a la vez
  for (const [key, qty] of need) {
    const [slug, size = null] = key.split('|');
    const p = bySlug.get(slug);
    const stock = size ? sizeStock(p, size) : p.stock;
    if (stock >= qty) continue;
    const what = size ? `«${p.name}» en talla ${size}` : `«${p.name}»`;
    const note = stock > 0 ? `Solo quedan ${stock} de ${what}.` : `${what[0].toUpperCase()}${what.slice(1)} se agotó.`;
    lines.forEach((l) => {
      if (l.problem) return;
      if ((l.id === slug && (l.size ?? null) === size) || (!size && l.includes?.some((x) => x.id === slug))) l.problem = note;
    });
  }

  const subtotalCents = lines.reduce((sum, l) => sum + l.unitCents * l.qty, 0);
  const discountCents = lines.reduce((sum, l) => sum + l.discountCents, 0);
  const merchandiseCents = subtotalCents - discountCents;
  const { site } = await readSite(db);
  const grams = weightOf(lines, bySlug, site.pago.pesoPieza);
  const shipping = await shippingFor(db, site.pago, delivery, merchandiseCents, perks, grams);
  return {
    level,
    perks,
    lines,
    subtotalCents,
    discountCents,
    merchandiseCents,
    shipping,
    grams,
    totalCents: merchandiseCents + (shipping.cents ?? 0),
    problems: lines.filter((l) => l.problem).map((l) => `${l.name}: ${l.problem}`),
    pickup: { address: `${site.visita.address}, ${site.visita.city}`, note: site.pago.tienda },
    times: site.pago.tiempos,
    contact: site.contacto, // si el envío no se puede cotizar, el pago ofrece escribir por estas redes
  };
}

/* ---------- Pedido ---------- */

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O ni 1/I: se dicta sin errores
function newReference(now = new Date()) {
  const day = arcadeDay(now).slice(2).replace(/-/g, ''); // la fecha de Bogotá, como la ve la tienda
  const tail = Array.from({ length: 6 }, () => REF_ALPHABET[randomInt(REF_ALPHABET.length)]).join('');
  return `DZ${day}-${tail}`;
}

/** Crea el pedido (pending) con la cotización del servidor y una llave para consultarlo sin sesión. */
export async function createOrder(db, { cartId, items, user, input }) {
  const quote = await quoteCart(db, { items, user, delivery: input.delivery });
  if (!quote.lines.length) throw new HttpError(409, 'Tu carrito está vacío.');
  if (quote.problems.length) throw new HttpError(409, quote.problems[0]);
  const ship = quote.shipping;
  // el municipio tiene que existir y el envío tener precio: nada de tarifas a ciegas
  if (ship.method === 'envio' && (ship.blocker || ship.cents == null)) {
    throw new HttpError(409, ship.blocker ?? 'Escribe tu municipio para calcular el envío.');
  }
  if (quote.totalCents < 150_000) throw new HttpError(409, 'El pago mínimo es de $1.500.');

  const key = randomBytes(18).toString('base64url');
  const now = new Date();
  const { option: _picked, ...delivery } = input.delivery; // la opción queda en shippingQuote
  if (ship.method === 'envio') Object.assign(delivery, { city: ship.place, cityCode: ship.placeCode }); // el nombre oficial, para la guía
  const order = {
    reference: newReference(now),
    keyHash: sha256(key),
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    cartId,
    userId: user?._id ?? null,
    level: quote.level,
    perks: quote.perks,
    customer: input.customer,
    delivery,
    notes: input.notes,
    consent: input.consent, // prueba de la autorización: versión de la política y fecha
    lines: quote.lines,
    subtotalCents: quote.subtotalCents,
    discountCents: quote.discountCents,
    merchandiseCents: quote.merchandiseCents,
    shippingCents: ship.cents ?? 0,
    freeShipping: ship.free,
    // con qué se cotizó: la transportadora y lo que cobra (aunque el envío salga gratis para quien compra)
    shippingQuote: ship.option
      ? { source: 'envia', carrier: ship.option.carrier, carrierName: ship.option.carrierName, service: ship.option.service, estimate: ship.option.estimate, cents: ship.option.cents, grams: quote.grams, at: now }
      : ship.method === 'envio' ? { source: 'tarifa', grams: quote.grams, at: now } : null,
    totalCents: quote.totalCents,
    fulfillment: 'nuevo',
    tracking: null,
    xp: 0,
    stockIssues: [],
  };
  await db.collection(COLLECTIONS.orders).insertOne(order);
  return { order, key };
}

/** La llave del enlace de vuelta (pago.html?ref=…&k=…) abre ese pedido sin sesión. */
export function keyMatches(order, key) {
  if (typeof key !== 'string' || !key) return false;
  const a = Buffer.from(sha256(key));
  const b = Buffer.from(order.keyHash ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Estados que un pago aprobado aún puede cambiar: Wompi deja reintentar un pago fallido con la misma referencia. */
export const OPEN_STATUSES = ['pending', 'declined', 'error'];

/**
 * Aplica lo que dice Wompi de una transacción. Un pedido «pending» cambia de estado una sola vez (si llegan a
 * la vez el aviso de Wompi y la consulta del navegador, gana el primero); uno rechazado solo cambia si un
 * reintento quedó aprobado, y uno aprobado ya no cambia aunque llegue tarde el aviso del intento fallido.
 */
export async function applyTransaction(db, tx) {
  const orders = db.collection(COLLECTIONS.orders);
  const order = tx?.reference ? await orders.findOne({ reference: tx.reference }) : null;
  if (!order) return null;
  const wompi = {
    transactionId: tx.id,
    status: tx.status,
    method: tx.payment_method_type ?? null,
    message: tx.status_message ?? null,
    at: new Date(),
  };
  let status = STATUS_FROM_WOMPI[tx.status] ?? 'pending';
  if (status === 'approved' && (tx.amount_in_cents !== order.totalCents || tx.currency !== 'COP')) {
    status = 'error'; // el monto no coincide con el pedido: no se entrega nada
    wompi.message = `El monto pagado (${tx.amount_in_cents}) no coincide con el pedido (${order.totalCents}).`;
  }
  const from = status === 'approved' ? OPEN_STATUSES : ['pending'];
  if (!from.includes(order.status)) return order;
  if (status === 'pending') {
    await orders.updateOne({ _id: order._id, status: 'pending' }, { $set: { wompi, updatedAt: new Date() } });
    return { ...order, wompi };
  }
  const now = new Date();
  const updated = await orders.findOneAndUpdate(
    { _id: order._id, status: { $in: from } },
    { $set: { status, wompi, updatedAt: now, ...(status === 'approved' ? { paidAt: now } : {}) } },
    { returnDocument: 'after' },
  );
  if (!updated) return orders.findOne({ _id: order._id }); // otra petición lo resolvió primero
  return status === 'approved' ? fulfil(db, updated) : updated;
}

/** Las unidades que mueve un pedido: «slug» o «slug|talla» → cantidad. */
function unitsOf(order) {
  const need = new Map();
  const add = (key, qty) => need.set(key, (need.get(key) ?? 0) + qty);
  order.lines.forEach((l) => {
    if (l.kind === 'product') add(l.size ? `${l.id}|${l.size}` : l.id, l.qty);
    else l.includes.forEach((x) => add(x.id, l.qty));
  });
  return need;
}

/** Cómo se guarda una pieza sin existencias en `stockIssues`: «slug» o «slug (talla M)». */
const issueLabel = (key) => {
  const [slug, size] = key.split('|');
  return size ? `${slug} (talla ${size})` : slug;
};

/** Descuenta `qty` unidades si las hay (con talla, de esa talla y del total); nunca baja de cero. */
async function takeStock(db, key, qty) {
  const [slug, size] = key.split('|');
  const products = db.collection(COLLECTIONS.products);
  const now = new Date();
  const { modifiedCount } = size
    ? await products.updateOne(
      { slug, sizes: { $elemMatch: { size, stock: { $gte: qty } } } },
      { $inc: { 'sizes.$.stock': -qty, stock: -qty }, $set: { updatedAt: now } },
    )
    : await products.updateOne({ slug, stock: { $gte: qty } }, { $inc: { stock: -qty }, $set: { updatedAt: now } });
  return modifiedCount > 0;
}

/**
 * Las piezas que no tenían existencias al confirmar el pago se vuelven a revisar: si la curaduría ya repuso,
 * se descuentan ahora y salen del aviso. Cada pieza se saca del aviso antes de descontarla (de forma atómica),
 * así dos consultas a la vez no la descuentan dos veces; si sigue sin existencias, vuelve al aviso.
 */
export async function retryStockIssues(db, order) {
  if (order.status !== 'approved' || order.demo || !order.stockIssues?.length) return order;
  const orders = db.collection(COLLECTIONS.orders);
  const issues = new Set(order.stockIssues);
  for (const [key, qty] of unitsOf(order)) {
    const label = issueLabel(key);
    if (!issues.has(label)) continue;
    const { modifiedCount } = await orders.updateOne({ _id: order._id, stockIssues: label }, { $pull: { stockIssues: label } });
    if (!modifiedCount) continue; // otra consulta ya la está resolviendo
    if (await takeStock(db, key, qty)) issues.delete(label);
    else await orders.updateOne({ _id: order._id }, { $addToSet: { stockIssues: label } });
  }
  return { ...order, stockIssues: [...issues] };
}

/** Pago aprobado: descuenta existencias, saca lo comprado del carrito y suma el XP de la compra. */
async function fulfil(db, order) {
  const stockIssues = [];
  for (const [key, qty] of unitsOf(order)) {
    if (!(await takeStock(db, key, qty))) stockIssues.push(issueLabel(key)); // se vendió en otra compra a la vez: se revisa de nuevo en Curaduría › Pedidos
  }

  if (order.cartId) {
    const slugs = order.lines.filter((l) => l.kind === 'product').map((l) => l.id);
    const codes = order.lines.filter((l) => l.kind === 'drop').map((l) => l.id);
    await db.collection(COLLECTIONS.carts).updateOne(
      { _id: order.cartId },
      { $pull: { items: { $or: [{ slug: { $in: slugs } }, { drop: { $in: codes } }] } }, $set: { updatedAt: new Date() } },
    );
  }

  const xp = order.userId ? purchaseXpFor(order.merchandiseCents) : 0;
  if (xp) await db.collection(COLLECTIONS.users).updateOne({ _id: order.userId }, { $inc: { purchaseXp: xp } });

  const set = { xp, stockIssues };
  await db.collection(COLLECTIONS.orders).updateOne({ _id: order._id }, { $set: set });
  return { ...order, ...set };
}

/* ---------- Despacho ---------- */

/**
 * Lo que manda la curaduría al despachar: { fulfillment: 'enviado', carrier, carrierName?, tracking }, o
 * { fulfillment: 'nuevo' } para deshacerlo. Un envío a domicilio no sale sin distribuidora ni número de guía
 * (es lo que ve quien compró); lo que se recoge en la tienda se marca listo para recoger, sin guía.
 * Devuelve el update de Mongo.
 */
export function shipmentInput(order, body) {
  const fulfillment = oneOf(body?.fulfillment, FULFILLMENT, 'estado de la entrega');
  if (fulfillment === 'nuevo') return { $set: { fulfillment }, $unset: { carrier: '', carrierName: '', tracking: '', shippedAt: '' } };
  const shippedAt = fulfillmentOf(order) === 'enviado' && order.shippedAt ? order.shippedAt : new Date(); // corregir la guía no cambia la fecha
  if (order.delivery?.method === 'tienda') return { $set: { fulfillment, shippedAt }, $unset: { carrier: '', carrierName: '', tracking: '' } };
  const carrier = CARRIER_BY_ID.get(body.carrier);
  if (!carrier) throw new HttpError(400, 'Elige la distribuidora que lleva el pedido.');
  const tracking = String(body.tracking ?? '').trim().replace(/\s+/g, ' ');
  if (!TRACKING_RE.test(tracking)) throw new HttpError(400, 'Escribe el número de guía que te dio la distribuidora (de 4 a 40 letras o números).');
  const set = { fulfillment, carrier: carrier.id, tracking, shippedAt };
  if (carrier.id === 'otra') set.carrierName = text(body.carrierName, { field: 'nombre de la distribuidora', min: 2, max: 40 });
  return { $set: set, $unset: carrier.id === 'otra' ? {} : { carrierName: '' } };
}

/** El envío tal como lo ve quien compró: distribuidora, guía y dónde rastrearla (null mientras no sale). */
function shipmentOf(o) {
  if (fulfillmentOf(o) !== 'enviado') return null;
  const c = CARRIER_BY_ID.get(o.carrier);
  return {
    carrier: c?.id ?? null,
    carrierName: c && c.id !== 'otra' ? c.name : o.carrierName ?? null,
    url: c?.url ?? null,
    tracking: o.tracking ?? null,
    at: (o.shippedAt ?? o.updatedAt ?? o.paidAt).toISOString(),
  };
}

/* ---------- Vistas ---------- */

/** Lo que ve quien hizo el pedido (página de pago y su credencial). */
export function toPublicOrder(o) {
  return {
    reference: o.reference,
    status: o.status,
    createdAt: o.createdAt.toISOString(),
    paidAt: o.paidAt?.toISOString() ?? null,
    customer: { name: o.customer.name, email: o.customer.email },
    delivery: o.delivery,
    lines: o.lines.map(({ problem, ...l }) => l),
    level: o.level,
    subtotalCents: o.subtotalCents,
    discountCents: o.discountCents,
    shippingCents: o.shippingCents,
    freeShipping: o.freeShipping ?? null,
    shippingQuote: o.shippingQuote?.source === 'envia'
      ? { carrier: o.shippingQuote.carrier, carrierName: o.shippingQuote.carrierName, service: o.shippingQuote.service, estimate: o.shippingQuote.estimate }
      : null,
    totalCents: o.totalCents,
    xp: o.xp ?? 0,
    method: o.wompi?.method ?? null,
    paymentStarted: Boolean(o.wompi?.transactionId), // sin transacción, quien compra salió de Wompi sin pagar
    message: o.status === 'declined' || o.status === 'error' ? o.wompi?.message ?? null : null,
    fulfillment: fulfillmentOf(o),
    shipment: shipmentOf(o),
  };
}

/** Vista completa para la curaduría (módulo Pedidos). */
export function toAdminOrder(o) {
  return {
    ...toPublicOrder(o),
    _id: o._id.toHexString(),
    customer: o.customer,
    notes: o.notes ?? null,
    perks: o.perks ?? null,
    merchandiseCents: o.merchandiseCents,
    member: Boolean(o.userId),
    simulated: Boolean(o.simulated), // npm run pago:simular: no entró dinero
    shippingCost: o.shippingQuote?.source === 'envia' ? o.shippingQuote.cents : null, // lo que cobra la transportadora
    weightGrams: o.shippingQuote?.grams ?? null,
    demo: Boolean(o.demo), // recibo de demostración: tampoco movió existencias ni XP
    wompi: o.wompi ? { transactionId: o.wompi.transactionId, status: o.wompi.status, method: o.wompi.method, message: o.wompi.message } : null,
    stockIssues: o.stockIssues ?? [],
    updatedAt: o.updatedAt?.toISOString() ?? null,
  };
}