import { timingSafeEqual } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { route, readJson, HttpError, CACHE, assertSameOrigin, clientIp, queryString } from '../../lib/http.js';
import { getDb } from '../../lib/mongodb.js';
import { currentUser, requireUser } from '../../lib/auth.js';
import { readCartId, pruneCart } from '../../lib/cart-session.js';
import { COLLECTIONS } from '../../lib/catalog.js';
import { limit } from '../../lib/rate-limit.js';
import { appUrl, mailEnabled } from '../../lib/mailer.js';
import { mailPaidOrder } from '../../lib/order-mail.js';
import { wompiConfig, checkoutUrl, getTransaction, findTransaction, transactionFor, verifyEvent } from '../../lib/wompi.js';
import { CITY_NAMES } from '../../lib/shipping.js';
import {
  DEPARTMENTS, ID_TYPES, OPEN_STATUSES, checkoutInput, quoteCart, createOrder, keyMatches, applyTransaction, toPublicOrder, shippingOptionId,
} from '../../lib/orders.js';

/*
 * Pago con Wompi.
 *   GET  /api/checkout/quote?method=envio|tienda&region=&city=&option= → cotización del carrito (precios, nivel,
 *                                                          envío con las opciones de transportadora, total)
 *   GET  /api/checkout/places                             → los municipios de cada departamento (lista oficial del DANE)
 *   POST /api/checkout/create { customer, delivery, consent } → crea el pedido (exige sesión) y devuelve el enlace a Wompi
 *   GET  /api/checkout/status?ref=&k=&id=                 → estado del pedido (consulta a Wompi si sigue pendiente) y `checked`
 *   GET  /api/checkout/mine?page=                         → lo pagado por la credencial con sesión, de 5 en 5, y sus totales
 *   GET  /api/checkout/conciliar                          → Vercel Cron (vercel.json): pregunta a Wompi por los pedidos abiertos
 *   POST /api/checkout/wompi                              → aviso de Wompi (URL de eventos del panel de Wompi)
 *
 * Un pago aprobado se confirma por cualquiera de estos caminos, sin depender de que quien compra vuelva a la tienda
 * (en el celular Wompi no siempre ofrece volver): el aviso de Wompi, al instante; la conciliación, cada 5 minutos; y
 * la consulta a Wompi al abrir el recibo o «Mis pedidos».
 */

const MIN = 60 * 1000;
const OPEN_DAYS = 7; // hasta cuándo se le sigue preguntando a Wompi por un pedido sin resolver
const SWEEP_MAX = 40; // pedidos por pasada de la conciliación
const SWEEP_MS = 30 * 1000; // lo que queda sin revisar sigue en la siguiente pasada
const MINE_MAX = 3; // pedidos abiertos que se revisan al abrir «Mis pedidos»

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

/** Pedidos reales sin resolver y recientes, el más nuevo primero (los simulados no existen en Wompi). */
const openOrders = (db, match, max) => db.collection(COLLECTIONS.orders)
  .find({
    ...match,
    status: { $in: OPEN_STATUSES },
    simulated: { $ne: true },
    demo: { $ne: true },
    createdAt: { $gte: new Date(Date.now() - OPEN_DAYS * 24 * 60 * MIN) },
  })
  .sort({ createdAt: -1 })
  .limit(max)
  .toArray();

/** Vercel Cron manda `Authorization: Bearer $CRON_SECRET`; sin ese secreto configurado nadie entra. */
function assertCron(req) {
  const secret = process.env.CRON_SECRET;
  const got = Buffer.from(String(req.headers.authorization ?? ''));
  const want = Buffer.from(`Bearer ${secret}`);
  if (!secret || got.length !== want.length || !timingSafeEqual(got, want)) throw new HttpError(401, 'No autorizado.');
}

/**
 * Pregunta a Wompi por un pedido sin resolver: por el id de la transacción y por su referencia, porque un
 * rechazo puede tener un reintento aprobado después.
 * `checked` dice si Wompi respondió de verdad: solo entonces «sin transacción» significa «no ha pagado».
 */
async function refresh(db, cfg, order, txId) {
  if (!OPEN_STATUSES.includes(order.status)) return { order, checked: true };
  if (!cfg) return { order, checked: false };
  try {
    let tx = txId ? await getTransaction(cfg, txId) : null;
    if (tx?.reference !== order.reference) tx = null; // un id de otra compra no cambia este pedido
    if (tx?.status !== 'APPROVED') tx = (await transactionFor(cfg, order.reference)) ?? tx;
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

    /** Por si el aviso de Wompi se perdió y quien pagó no volvió: aquí se aprueba, se avisa y se descuenta igual. */
    async conciliar({ req, res, db }) {
      assertCron(req);
      const cfg = wompiConfig();
      if (!cfg?.privateKey) throw new HttpError(503, 'Faltan las llaves de Wompi.');
      const deadline = Date.now() + SWEEP_MS;
      const list = await openOrders(db, {}, SWEEP_MAX);
      let checked = 0;
      let approved = 0;
      for (const order of list) {
        if (Date.now() > deadline) break;
        const { order: current } = await refresh(db, cfg, order);
        checked += 1;
        if (current.status === 'approved') {
          approved += 1;
          console.log(`[checkout] conciliado con Wompi (el aviso no llegó): ${current.reference}`);
        }
        confirmByMail(req, current);
      }
      res.status(200).json({ open: list.length, checked, approved });
    },

    async mine({ req, res, db }) {
      const { user } = await requireUser(db, req);
      const cfg = wompiConfig();
      // lo que se acaba de pagar aparece aquí aunque ni el aviso ni la conciliación hayan pasado todavía
      const open = cfg ? await openOrders(db, { userId: user._id }, MINE_MAX) : [];
      const fresh = await Promise.all(open.map((order) => refresh(db, cfg, order)));
      fresh.forEach(({ order }) => confirmByMail(req, order));
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