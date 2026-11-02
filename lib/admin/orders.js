import { waitUntil } from '@vercel/functions';
import { readJson, HttpError, queryString } from '../http.js';
import { COLLECTIONS } from '../catalog.js';
import { CARRIERS, retryStockIssues, shipmentInput, toAdminOrder, toPublicOrder } from '../orders.js';
import { appUrl, mailEnabled, sendMail, orderShippedEmail } from '../mailer.js';
import { searchRegex } from '../search.js';
import { readSite, hoursSummary } from '../site.js';
import { idParam } from './common.js';

/*
 * Pedidos pagados con Wompi.
 * GET /api/admin/orders?filter=&q=&sort=&page= → una página (24) de la pestaña, con la búsqueda y el orden pedidos;
 *                                     los conteos de cada pestaña (con esa búsqueda), el resumen y las distribuidoras.
 *                                     ?summary=1 → solo cuántos hay por despachar (el contador de la pestaña).
 * PUT /api/admin/orders?id=         → { fulfillment: 'enviado', carrier, carrierName?, tracking }: despachado con
 *                                     su guía (lo que se recoge en la tienda se marca listo para recoger, sin guía) ·
 *                                     { fulfillment: 'nuevo' }: deshace el envío
 * Los pedidos no se crean ni se borran desde aquí: los crea la tienda y los resuelve Wompi.
 */

/**
 * Aviso de envío a quien compró: «Va en camino» con la distribuidora y la guía (o «Listo para recoger», con la
 * dirección y el horario de la tienda, si recoge allá). Sale también en los pedidos simulados, para poder probarlo;
 * no en los recibos de demostración. Devuelve a quién se avisa (o null). Un fallo aquí no deshace el despacho.
 */
function notifyShipped(req, db, order) {
  if (!mailEnabled() || order.demo) return null;
  waitUntil((async () => {
    try {
      const { shipment } = toPublicOrder(order);
      let store = null;
      if (order.delivery.method === 'tienda') {
        const { visita } = (await readSite(db)).site;
        store = { address: `${visita.address}, ${visita.city}`, reference: visita.reference, hours: hoursSummary(visita.hours) };
      }
      await sendMail({ to: order.customer.email, ...orderShippedEmail({ order, shipment, store, url: `${appUrl(req)}/cuenta#pedidos` }) });
    } catch (err) {
      console.error('[pedidos] correo de envío:', err.message);
    }
  })());
  return order.customer.email;
}

const PAGE = 24;
const TABS = {
  despachar: { status: 'approved', fulfillment: { $nin: ['enviado', 'entregado'] } },
  pagados: { status: 'approved' },
  pendientes: { status: 'pending' },
  fallidos: { status: { $in: ['declined', 'voided', 'error'] } },
};
const SORTS = {
  recientes: { createdAt: -1 },
  antiguos: { createdAt: 1 },
  mayor: { totalCents: -1, createdAt: -1 },
  menor: { totalCents: 1, createdAt: -1 },
};
const TEXT_FIELDS = ['reference', 'customer.name', 'customer.email', 'delivery.city', 'delivery.region', 'tracking', 'lines.name', 'lines.includes.name'];

/**
 * Lo que se busca: referencia, cliente (nombre, correo, celular, documento), ciudad, guía o piezas, sin importar
 * tildes ni mayúsculas. Un número con espacios o guiones («300 123 4567») también encuentra el celular y el documento.
 */
function searchFilter(q) {
  if (!q) return {};
  const re = searchRegex(q);
  const or = TEXT_FIELDS.map((field) => ({ [field]: re }));
  const digits = q.replace(/[\s.-]/g, '');
  if (/^\d{3,}$/.test(digits)) {
    or.push({ 'customer.phone': new RegExp(digits) }, { 'customer.idNumber': new RegExp(digits) });
  }
  return { $or: or };
}

export default {
  async GET({ req, res, db }) {
    const orders = db.collection(COLLECTIONS.orders);
    const toShip = await orders.countDocuments(TABS.despachar);
    if (queryString(req, 'summary')) {
      return res.status(200).json({ counts: { toShip, paid: await orders.countDocuments(TABS.pagados) } });
    }

    const tab = Object.hasOwn(TABS, queryString(req, 'filter') ?? '') ? queryString(req, 'filter') : 'despachar';
    const sort = Object.hasOwn(SORTS, queryString(req, 'sort') ?? '') ? queryString(req, 'sort') : 'recientes';
    const q = (queryString(req, 'q') ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const search = searchFilter(q);
    const [counts, [sold]] = await Promise.all([
      Promise.all(Object.entries(TABS).map(async ([key, filter]) => [key, await orders.countDocuments({ ...filter, ...search })]))
        .then(Object.fromEntries),
      orders.aggregate([{ $match: TABS.pagados }, { $group: { _id: null, n: { $sum: 1 }, cents: { $sum: '$totalCents' } } }]).toArray(),
    ]);
    const total = counts[tab];
    const pages = Math.max(1, Math.ceil(total / PAGE));
    const page = Math.min(pages, Math.max(1, Number.parseInt(queryString(req, 'page') ?? '1', 10) || 1));
    const found = await orders.find({ ...TABS[tab], ...search }).sort(SORTS[sort]).skip((page - 1) * PAGE).limit(PAGE).toArray();
    // el aviso «sin existencias» se revisa de nuevo: si ya se repuso la pieza, se descuenta y el aviso desaparece
    const list = await Promise.all(found.map((o) => retryStockIssues(db, o)));
    res.status(200).json({
      orders: list.map(toAdminOrder),
      filter: tab,
      sort,
      q,
      page,
      pages,
      total,
      counts,
      summary: { toShip, paid: sold?.n ?? 0, soldCents: sold?.cents ?? 0 },
      carriers: CARRIERS.map(({ id, name }) => ({ id, name })),
    });
  },

  async PUT({ req, res, db }) {
    const _id = idParam(req, 'pedido');
    const orders = db.collection(COLLECTIONS.orders);
    const prev = await orders.findOne({ _id });
    if (prev?.status !== 'approved') throw new HttpError(404, 'Solo los pedidos pagados se despachan.');
    const update = shipmentInput(prev, readJson(req));
    update.$set.updatedAt = new Date();
    if (!Object.keys(update.$unset ?? {}).length) delete update.$unset;
    const order = await orders.findOneAndUpdate({ _id, status: 'approved' }, update, { returnDocument: 'after' });
    if (!order) throw new HttpError(404, 'Solo los pedidos pagados se despachan.');
    const wasOut = prev.fulfillment === 'enviado' || prev.fulfillment === 'entregado';
    const shippedNow = order.fulfillment === 'enviado' && !wasOut;
    // `mailed`: a quién le llega el aviso; null si no se avisa (corregir la guía, sin correo configurado o demostración)
    const mailed = shippedNow ? notifyShipped(req, db, order) : null;
    res.status(200).json({ order: toAdminOrder(order), mailed, mailOff: shippedNow && !mailEnabled() });
  },
};
