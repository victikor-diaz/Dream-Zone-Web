import { waitUntil } from '@vercel/functions';
import { route, readJson, HttpError, CACHE, assertSameOrigin, clientIp, queryString } from '../../lib/http.js';
import { getDb } from '../../lib/mongodb.js';
import { currentUser, requireUser } from '../../lib/auth.js';
import { readCartId, pruneCart } from '../../lib/cart-session.js';
import { COLLECTIONS } from '../../lib/catalog.js';
import { limit } from '../../lib/rate-limit.js';
import { appUrl, mailEnabled } from '../../lib/mailer.js';
import { mailPaidOrder } from '../../lib/order-mail.js';
import { wompiConfig, checkoutUrl, getTransaction, findTransaction, transactionsFor, verifyEvent } from '../../lib/wompi.js';
import { CITY_NAMES } from '../../lib/shipping.js';
import {
  DEPARTMENTS, ID_TYPES, checkoutInput, quoteCart, createOrder, keyMatches, applyTransaction, toPublicOrder, shippingOptionId,
} from '../../lib/orders.js';

/*
 * Pago con Wompi.
 *   GET  /api/checkout/quote?method=envio|tienda&region=&city=&option= → cotización del carrito (precios, nivel,
 *                                                          envío con las opciones de transportadora, total)
 *   GET  /api/checkout/places                             → los municipios de cada departamento (lista oficial del DANE)
 *   POST /api/checkout/create { customer, delivery, notes } → crea el pedido (exige sesión) y devuelve el enlace a Wompi
 *   GET  /api/checkout/status?ref=&k=&id=                 → estado del pedido (consulta a Wompi si sigue pendiente) y `checked`
 *   GET  /api/checkout/mine?page=                         → lo pagado por la credencial con sesión, de 5 en 5, y sus totales
 *   POST /api/checkout/wompi                              → aviso de Wompi (URL de eventos del panel de Wompi)
 */

const MIN = 60 * 1000;

/** Las líneas del carrito de esta cookie, sin las de piezas o drops que ya se borraron (`removed`: cuántas salieron). */
async function cartItems(db, req) {
  const cartId = readCartId(req);
  const cart = cartId ? await db.collection(COLLECTIONS.carts).findOne({ _id: cartId }) : null;
  const { items, removed } = await pruneCart(db, cart);
  return { cartId, items, removed };
}

const MINE_PAGE = 5; // recibos por página en «Mis pedidos»: así nunca empujan hacia abajo el resto de la credencial

/** Correos del pago aprobado (confirmación a quien compró y aviso a la curaduría), después de responder. */
function confirmByMail(req, order) {
  if (order?.status !== 'approved' || !mailEnabled() || (order.mailedAt && order.staffMailedAt)) return;
  waitUntil((async () => {
    try {
      await mailPaidOrder(await getDb(), order, appUrl(req));
    } catch (err) {
      console.error('[checkout] correos del pago:', err.message);
    }
  })());
}

/**
 * Pregunta a Wompi por un pedido pendiente: por el id de la transacción o, sin él, por su referencia.
 * `checked` dice si Wompi respondió de verdad: solo entonces «sin transacción» significa «no ha pagado».
 */
async function refresh(db, cfg, order, txId) {
  if (order.status !== 'pending') return { order, checked: true };
  if (!cfg) return { order, checked: false };
  try {
    let tx = null;
    if (txId) {
      tx = await getTransaction(cfg, txId);
      if (tx && tx.reference !== order.reference) tx = null; // un id de otra compra no cambia este pedido
    }
    if (!tx) [tx] = await transactionsFor(cfg, order.reference);
    const current = tx ? (await applyTransaction(db, tx)) ?? order : order;
    return { order: current, checked: Boolean(tx || cfg.privateKey) }; // sin llave privada no se puede buscar por referencia
  } catch (err) {
    console.error('[checkout] consulta a Wompi:', err.message);
    return { order, checked: false }; // se reintenta en la próxima consulta
  }
}

const ACTIONS = {
  GET: {
    async quote({ req, res, db }) {
      const auth = await currentUser(db, req);
      const { items, removed } = await cartItems(db, req);
      const method = queryString(req, 'method') === 'tienda' ? 'tienda' : 'envio';
      const region = queryString(req, 'region');
      const city = (queryString(req, 'city') ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
      // con la ciudad, el envío se cotiza en vivo con las transportadoras; `option` es la que eligió quien compra
      const delivery = {
        method,
        region: DEPARTMENTS.includes(region) ? region : null,
        city: city.length >= 2 ? city : null,
        option: shippingOptionId(queryString(req, 'option')),
      };
      const quote = await quoteCart(db, { items, user: auth?.user ?? null, delivery });
      res.status(200).json({
        quote,
        removed, // líneas de piezas borradas que se acaban de quitar del carrito
        ready: Boolean(wompiConfig()),
        departments: DEPARTMENTS,
        idTypes: ID_TYPES,
        user: auth ? { name: auth.user.name, email: auth.user.email } : null,
      });
    },

    /** Para la lista del campo «ciudad»: no cambia, así que la CDN la guarda un día. */
    async places({ res }) {
      res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800');
      res.status(200).json({ cities: CITY_NAMES });
    },

    async status({ req, res, db }) {
      const reference = String(queryString(req, 'ref') ?? '');
      const order = /^DZ\d{6}-[A-Z2-9]{6}$/.test(reference)
        ? await db.collection(COLLECTIONS.orders).findOne({ reference })
        : null;
      const auth = order && !keyMatches(order, queryString(req, 'k')) ? await currentUser(db, req) : null;
      const allowed = order && (keyMatches(order, queryString(req, 'k')) || (auth && order.userId?.equals(auth.user._id)));
      if (!allowed) throw new HttpError(404, 'No encontramos ese pedido.');
      const txId = String(queryString(req, 'id') ?? '').slice(0, 64) || null;
      const { order: current, checked } = await refresh(db, wompiConfig(), order, txId);
      confirmByMail(req, current);
      res.status(200).json({ order: toPublicOrder(current), checked });
    },

    async mine({ req, res, db }) {
      const { user } = await requireUser(db, req);
      const orders = db.collection(COLLECTIONS.orders);
      const filter = { userId: user._id, status: 'approved' }; // «Mis pedidos» es lo pagado
      const [totals] = await orders.aggregate([
        { $match: filter },
        { $group: { _id: null, count: { $sum: 1 }, totalCents: { $sum: '$totalCents' }, xp: { $sum: { $ifNull: ['$xp', 0] } } } },
      ]).toArray();
      const count = totals?.count ?? 0;
      const pages = Math.max(1, Math.ceil(count / MINE_PAGE));
      const page = Math.min(pages, Math.max(1, Number.parseInt(queryString(req, 'page') ?? '1', 10) || 1));
      const list = await orders.find(filter).sort({ paidAt: -1, _id: -1 }).skip((page - 1) * MINE_PAGE).limit(MINE_PAGE).toArray();
      res.status(200).json({ orders: list.map(toPublicOrder), page, pages, count, totalCents: totals?.totalCents ?? 0, xp: totals?.xp ?? 0 });
    },
  },

  POST: {
    async create({ req, res, db }) {
      assertSameOrigin(req);
      await limit(db, `checkout:${clientIp(req)}`, { max: 20, windowMs: 15 * MIN });
      const cfg = wompiConfig();
      if (!cfg) throw new HttpError(503, 'Los pagos en línea aún no están configurados. Escríbenos y te ayudamos.');
      const { user } = await requireUser(db, req); // pagar exige credencial con sesión
      const input = checkoutInput(readJson(req));
      const { cartId, items } = await cartItems(db, req);
      const { order, key } = await createOrder(db, { cartId, items, user, input });
      const statusPath = `/pago?ref=${order.reference}&k=${key}`;
      const redirectUrl = `${appUrl(req)}${statusPath}`;
      res.status(201).json({
        reference: order.reference,
        totalCents: order.totalCents,
        statusPath, // para volver al estado del pedido si se cierra la pestaña de Wompi
        url: checkoutUrl(cfg, { reference: order.reference, amountInCents: order.totalCents, redirectUrl, customer: order.customer, delivery: order.delivery }),
      });
    },

    /**
     * Wompi avisa cada cambio de una transacción. El aviso tiene que venir firmado con el secreto de eventos
     * y, aun así, no se cree su contenido: se pide la transacción a la API de Wompi y se aplica esa. Así un
     * aviso falso no aprueba nada aunque alguien conociera el secreto.
     */
    async wompi({ req, res, db }) {
      const cfg = wompiConfig();
      const event = readJson(req);
      if (!verifyEvent(cfg, event)) throw new HttpError(401, 'Firma inválida.');
      const sent = event.event === 'transaction.updated' ? event.data?.transaction : null;
      if (sent?.id) {
        let tx;
        try {
          tx = await findTransaction(cfg, String(sent.id), sent.reference ? String(sent.reference) : null);
        } catch (err) {
          console.error('[checkout] confirmar el aviso con Wompi:', err.message);
          throw new HttpError(503, 'No pudimos confirmar la transacción con Wompi; reintenta.'); // Wompi reenvía el aviso
        }
        if (!tx) {
          // responder 200 aquí perdería el aviso para siempre: con un error, Wompi lo reenvía
          console.error('[checkout] Wompi no devolvió la transacción del aviso:', sent.id, sent.reference);
          throw new HttpError(503, 'No encontramos la transacción en Wompi; reintenta.');
        }
        if (tx.reference === sent.reference) confirmByMail(req, await applyTransaction(db, tx));
      }
      res.status(200).json({ ok: true });
    },
  },
};

async function dispatch(req, res) {
  res.setHeader('Cache-Control', CACHE.none);
  const name = queryString(req, 'action');
  const action = name && Object.hasOwn(ACTIONS[req.method], name) ? ACTIONS[req.method][name] : null;
  if (!action) throw new HttpError(404, 'Acción desconocida.');
  const db = await getDb();
  await action({ req, res, db });
}

export default route({ GET: dispatch, POST: dispatch });