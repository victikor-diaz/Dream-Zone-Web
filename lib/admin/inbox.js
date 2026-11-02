import { readJson, HttpError, queryString } from '../http.js';
import { oneOf } from '../validate.js';
import { COLLECTIONS } from '../catalog.js';
import { idParam } from './common.js';
import { purgeStaleSpecialOrders } from '../privacy.js';

/*
 * Buzón: fichas de encargo y suscriptores del correo.
 * GET    /api/admin/inbox[?summary=1]                 → listas (o solo los conteos)
 * PUT    /api/admin/inbox?kind=order&id= { status }   → nuevo · cotizado · cerrado
 * DELETE /api/admin/inbox?kind=order|subscriber&id=
 */

const ORDER_STATUSES = ['nuevo', 'cotizado', 'cerrado'];
const KINDS = { order: COLLECTIONS.specialOrders, subscriber: COLLECTIONS.subscribers };

function kindParam(req) {
  const kind = queryString(req, 'kind');
  if (!kind || !Object.hasOwn(KINDS, kind)) throw new HttpError(400, 'Tipo de registro desconocido.');
  return kind;
}

const toOrder = (o) => ({
  _id: o._id.toHexString(), code: o.code, piece: o.piece, whatsapp: o.whatsapp ?? null, email: o.email ?? null, // las fichas viejas traían correo
  status: ORDER_STATUSES.includes(o.status) ? o.status : 'nuevo', createdAt: o.createdAt.toISOString(),
});
const toSubscriber = (s) => ({ _id: s._id.toHexString(), email: s.email, source: s.source ?? null, createdAt: s.createdAt.toISOString() });

export default {
  async GET({ req, res, db }) {
    await purgeStaleSpecialOrders(db); // las fichas sin novedad en 6 meses (política de datos, cláusula 4)
    const orders = db.collection(COLLECTIONS.specialOrders);
    const subscribers = db.collection(COLLECTIONS.subscribers);
    const [ordersTotal, ordersNew, subscribersTotal] = await Promise.all([
      orders.countDocuments(),
      orders.countDocuments({ status: 'nuevo' }),
      subscribers.countDocuments(),
    ]);
    const counts = { orders: ordersTotal, ordersNew, subscribers: subscribersTotal };
    if (queryString(req, 'summary')) return res.status(200).json({ counts });

    const [orderList, subscriberList] = await Promise.all([
      orders.find({}).sort({ createdAt: -1 }).limit(500).toArray(),
      subscribers.find({}).sort({ createdAt: -1 }).limit(5000).toArray(),
    ]);
    res.status(200).json({ counts, orders: orderList.map(toOrder), subscribers: subscriberList.map(toSubscriber) });
  },

  async PUT({ req, res, db }) {
    if (kindParam(req) !== 'order') throw new HttpError(400, 'Solo las fichas de encargo tienen estado.');
    const _id = idParam(req, 'ficha');
    const status = oneOf(readJson(req).status, ORDER_STATUSES, 'estado');
    const order = await db.collection(COLLECTIONS.specialOrders).findOneAndUpdate(
      { _id },
      { $set: { status, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!order) throw new HttpError(404, 'Esa ficha ya no existe.');
    res.status(200).json({ order: toOrder(order) });
  },

  async DELETE({ req, res, db }) {
    const kind = kindParam(req);
    const _id = idParam(req, kind === 'order' ? 'ficha' : 'suscriptor');
    await db.collection(KINDS[kind]).deleteOne({ _id });
    res.status(200).json({ ok: true });
  },
};