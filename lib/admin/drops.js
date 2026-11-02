import { waitUntil } from '@vercel/functions';
import { readJson, HttpError, queryString } from '../http.js';
import { text, slug, wholeNumber, optionalText } from '../validate.js';
import { COLLECTIONS, DROP_ITEMS, regularCents, toAdminDrop } from '../catalog.js';
import { appUrl, mailEnabled } from '../mailer.js';
import { shouldAnnounce, startAnnounce } from '../newsletter.js';
import { idParam, assertFresh, dateField } from './common.js';

/*
 * Drops: bundles de edición limitada. La curaduría junta de 2 a 6 piezas del catálogo y les pone un
 * precio menor que la suma de sus precios. La tienda muestra los drops activos en su sección y en la
 * ficha de cada pieza que traen. No tienen un cupo propio: alcanzan los que permita la pieza con menos
 * existencias, y cada drop pagado descuenta una unidad de cada pieza.
 * Al guardar por primera vez un drop activo y abierto, se avisa por correo a toda la lista (lib/newsletter.js),
 * salvo que la curaduría apague «Avisar por correo» (`notify: false`); entonces solo sale con «Avisar ahora».
 * GET /api/admin/drops · POST · PUT ?id= · DELETE ?id= · POST ?announce=<id> (avisar ahora o reanudar)
 */

const SKIPPED = {
  mail: 'El correo no está configurado (SMTP): el aviso no puede salir todavía.',
  nobody: 'No hay a quién avisar: no hay suscriptores o ya les llegó a todos.',
  running: 'El aviso de este drop ya se está enviando.',
  gone: 'Ese drop ya no existe.',
};

/** Si el drop recién guardado se avisa solo, arranca el envío en segundo plano. Devuelve el drop al día. */
async function maybeAnnounce(db, req, drop) {
  if (!shouldAnnounce(drop)) return drop;
  const started = await startAnnounce(db, drop._id, appUrl(req));
  if (!started.run) return drop;
  waitUntil(started.run());
  return started.drop;
}

const code = (n) => `drop-${String(n).padStart(3, '0')}`;
const MAX_CENTS = 100_000_000; // $1,000,000.00, igual que en product-input.js
const money = (cents) => `$${(cents / 100).toLocaleString('es-CO', { maximumFractionDigits: 2 })}`;

async function dropInput(db, body) {
  const number = wholeNumber(body.number, { field: 'número de drop', min: 1, max: 9999 });
  if (typeof body.active !== 'boolean') throw new HttpError(400, '"activo" debe ser sí o no.');
  if (body.notify !== undefined && typeof body.notify !== 'boolean') throw new HttpError(400, '"avisar por correo" debe ser sí o no.');

  if (!Array.isArray(body.items)) throw new HttpError(400, 'Falta la lista de piezas del drop.');
  const items = [...new Set(body.items.map((s) => slug(s, 'pieza')))];
  if (items.length < DROP_ITEMS.min || items.length > DROP_ITEMS.max) {
    throw new HttpError(400, `Un drop junta de ${DROP_ITEMS.min} a ${DROP_ITEMS.max} piezas distintas.`);
  }
  const products = await db
    .collection(COLLECTIONS.products)
    .find({ slug: { $in: items } }, { projection: { slug: 1, name: 1, priceCents: 1, sizes: 1 } })
    .toArray();
  if (products.length !== items.length) throw new HttpError(400, 'Una de las piezas ya no existe. Quítala del drop.');
  const sized = products.find((p) => Array.isArray(p.sizes) && p.sizes.length);
  if (sized) throw new HttpError(400, `«${sized.name}» va por tallas y aún no puede ir en un drop.`);

  // el bundle siempre sale más barato que comprar sus piezas por separado
  const priceCents = wholeNumber(body.priceCents, { field: 'precio del drop', min: 1, max: MAX_CENTS });
  const regular = regularCents(products);
  if (priceCents >= regular) {
    throw new HttpError(400, `El precio del drop debe ser menor que la suma de sus piezas (${money(regular)}).`);
  }

  return {
    number,
    code: code(number),
    title: text(body.title, { field: 'nombre del drop', min: 2, max: 60 }),
    specs: optionalText(body.specs, { field: 'descripción del drop', max: 120 }),
    items,
    priceCents,
    endsAt: dateField(body.endsAt, 'cierre'),
    active: body.active,
    notify: body.notify !== false, // sin el campo (clientes viejos), como antes: se avisa
  };
}

const duplicate = (err, number) => (err?.code === 11000 ? new HttpError(409, `Ya existe el drop #${String(number).padStart(3, '0')}.`) : err);

export default {
  async GET({ res, db }) {
    const [drops, subscribers] = await Promise.all([
      db.collection(COLLECTIONS.drops).find({}).sort({ endsAt: -1 }).limit(500).toArray(),
      db.collection(COLLECTIONS.subscribers).countDocuments(),
    ]);
    res.status(200).json({ drops: drops.map(toAdminDrop), newsletter: { mail: mailEnabled(), subscribers } });
  },

  async POST({ req, res, db }) {
    const announceId = queryString(req, 'announce');
    if (announceId) {
      const started = await startAnnounce(db, idParam({ query: { id: announceId } }, 'drop'), appUrl(req));
      if (!started.run) throw new HttpError(started.skipped === 'gone' ? 404 : 409, SKIPPED[started.skipped]);
      waitUntil(started.run());
      return res.status(200).json({ drop: toAdminDrop(started.drop) });
    }
    const fields = await dropInput(db, readJson(req));
    const now = new Date();
    const doc = { ...fields, createdAt: now, updatedAt: now };
    try {
      await db.collection(COLLECTIONS.drops).insertOne(doc);
    } catch (err) {
      throw duplicate(err, fields.number);
    }
    res.status(201).json({ drop: toAdminDrop(await maybeAnnounce(db, req, doc)) });
  },

  async PUT({ req, res, db }) {
    const _id = idParam(req, 'drop');
    const body = readJson(req);
    const drops = db.collection(COLLECTIONS.drops);
    const prev = await drops.findOne({ _id });
    if (!prev) throw new HttpError(404, 'Ese drop ya no existe.');
    assertFresh(prev, body, 'Alguien guardó este drop mientras lo editabas. Recarga para ver su versión.');
    const fields = await dropInput(db, body);
    try {
      // productSlug, reserved y blueprint eran del drop de una sola pieza; total y claimed, del cupo propio de antes
      await drops.updateOne({ _id }, { $set: { ...fields, updatedAt: new Date() }, $unset: { productSlug: '', reserved: '', blueprint: '', total: '', claimed: '' } });
    } catch (err) {
      throw duplicate(err, fields.number);
    }
    res.status(200).json({ drop: toAdminDrop(await maybeAnnounce(db, req, await drops.findOne({ _id }))) });
  },

  async DELETE({ req, res, db }) {
    const _id = idParam(req, 'drop');
    const drop = await db.collection(COLLECTIONS.drops).findOneAndDelete({ _id }, { projection: { code: 1 } });
    if (!drop) throw new HttpError(404, 'Ese drop ya no existe.');
    // el bundle sale de los carritos de la gente (como al borrar una pieza)
    const { modifiedCount: carts } = await db.collection(COLLECTIONS.carts).updateMany(
      { 'items.drop': drop.code },
      { $pull: { items: { drop: drop.code } } },
    );
    res.status(200).json({ ok: true, carts });
  },
};