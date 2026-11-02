import { ObjectId } from 'mongodb';
import { readJson, HttpError } from '../http.js';
import { productInput } from '../product-input.js';
import { COLLECTIONS, toAdminProduct } from '../catalog.js';
import { zoneKeys } from '../site.js';
import { idParam, assertFresh } from './common.js';

/*
 * Piezas del catálogo:
 * GET    /api/admin/products          → todas, en cualquier estado
 * POST   /api/admin/products          → alta
 * PUT    /api/admin/products?id=<_id> → edición completa (si cambia el slug, se actualizan carritos y drops)
 * DELETE /api/admin/products?id=<_id> → baja definitiva (y sus imágenes)
 */

const oid = (hex) => new ObjectId(hex);

function duplicate(err) {
  if (err?.code !== 11000) return err;
  if (err.keyPattern?.sku) return new HttpError(409, 'Ese SKU ya lo usa otra pieza.');
  return new HttpError(409, 'Ese identificador (slug) ya lo usa otra pieza.');
}

/** Comprueba que las imágenes existan y devuelve [{ id, cutout }] en el orden pedido. */
async function resolveImages(db, ids) {
  if (!ids.length) return [];
  const found = await db
    .collection(COLLECTIONS.media)
    .find({ _id: { $in: ids.map(oid) } }, { projection: { cutout: 1 } })
    .toArray();
  const byId = new Map(found.map((m) => [m._id.toHexString(), m]));
  if (byId.size !== ids.length) throw new HttpError(400, 'Una de las imágenes ya no existe. Vuelve a subirla.');
  return ids.map((id) => ({ id, cutout: Boolean(byId.get(id).cutout) }));
}

async function attachImages(db, ids) {
  if (ids.length) await db.collection(COLLECTIONS.media).updateMany({ _id: { $in: ids.map(oid) } }, { $set: { attached: true } });
}

async function deleteImages(db, ids) {
  if (ids.length) await db.collection(COLLECTIONS.media).deleteMany({ _id: { $in: ids.map(oid) } });
}

export default {
  async GET({ res, db }) {
    const items = await db.collection(COLLECTIONS.products).find({}).sort({ createdAt: -1 }).limit(2000).toArray();
    res.status(200).json({ products: items.map(toAdminProduct) });
  },

  async POST({ req, res, db }) {
    const { fields, imageIds, createdAt } = productInput(readJson(req), await zoneKeys(db));
    const now = new Date();
    const doc = { ...fields, images: await resolveImages(db, imageIds), createdAt: createdAt ?? now, updatedAt: now };
    try {
      await db.collection(COLLECTIONS.products).insertOne(doc);
    } catch (err) {
      throw duplicate(err);
    }
    await attachImages(db, imageIds);
    res.status(201).json({ product: toAdminProduct(doc) });
  },

  async PUT({ req, res, db }) {
    const _id = idParam(req, 'pieza');
    const body = readJson(req);
    const { fields, imageIds, createdAt } = productInput(body, await zoneKeys(db));

    const products = db.collection(COLLECTIONS.products);
    const prev = await products.findOne({ _id });
    if (!prev) throw new HttpError(404, 'Esa pieza ya no existe.');
    assertFresh(prev, body, 'Alguien guardó esta pieza mientras la editabas. Recarga para ver su versión.');

    const set = { ...fields, images: await resolveImages(db, imageIds), updatedAt: new Date() };
    if (createdAt) set.createdAt = createdAt;
    try {
      await products.updateOne({ _id }, { $set: set, $unset: { preorder: '', availability: '' } }); // campos de la preventa, que ya no existe
    } catch (err) {
      throw duplicate(err);
    }

    if (prev.slug !== fields.slug) {
      await db.collection(COLLECTIONS.drops).updateMany(
        { items: prev.slug },
        { $set: { 'items.$[piece]': fields.slug } },
        { arrayFilters: [{ piece: prev.slug }] },
      );
      await db.collection(COLLECTIONS.carts).updateMany(
        { 'items.slug': prev.slug },
        { $set: { 'items.$[line].slug': fields.slug } },
        { arrayFilters: [{ 'line.slug': prev.slug }] },
      );
    }
    await attachImages(db, imageIds);
    await deleteImages(db, (prev.images ?? []).map((img) => img.id).filter((id) => !imageIds.includes(id)));

    res.status(200).json({ product: toAdminProduct(await products.findOne({ _id })) });
  },

  async DELETE({ req, res, db }) {
    const _id = idParam(req, 'pieza');
    const products = db.collection(COLLECTIONS.products);
    const prev = await products.findOne({ _id });
    if (!prev) throw new HttpError(404, 'Esa pieza ya no existe.');
    const liveDrop = await db
      .collection(COLLECTIONS.drops)
      .findOne({ items: prev.slug, active: true, endsAt: { $gt: new Date() } }, { projection: { number: 1 } });
    if (liveDrop) {
      throw new HttpError(409, `Esta pieza está en el drop #${String(liveDrop.number).padStart(3, '0')}, que sigue activo. Quítala del drop o archívala en lugar de borrarla.`);
    }

    await products.deleteOne({ _id });
    // sale también de los carritos de la gente: si no, queda una línea fantasma que bloquea el pago
    const { modifiedCount: carts } = await db.collection(COLLECTIONS.carts).updateMany(
      { 'items.slug': prev.slug },
      { $pull: { items: { slug: prev.slug } } },
    );
    await deleteImages(db, (prev.images ?? []).map((img) => img.id));
    res.status(200).json({ ok: true, carts });
  },
};