import { route, readJson, HttpError, CACHE } from '../lib/http.js';
import { getDb } from '../lib/mongodb.js';
import { slug, int } from '../lib/validate.js';
import { readCartId, ensureCartId, pruneCart } from '../lib/cart-session.js';
import { COLLECTIONS, DROP_CODE_RE, coverUrl, isPurchasable, hasSizes, sizeStock } from '../lib/catalog.js';

const MAX_QTY_PER_ITEM = 5;
const MAX_LINES = 30;
const EMPTY = { count: 0, items: [], subtotalCents: 0 };
const dropName = (d) => `Drop #${String(d.number).padStart(3, '0')} · ${d.title}`;

/** Drops de las líneas de bundle del carrito, por código. */
async function cartDrops(db, items) {
  const codes = items.filter((i) => i.drop).map((i) => i.drop);
  if (!codes.length) return new Map();
  const drops = await db.collection(COLLECTIONS.drops).find({ code: { $in: codes } }).toArray();
  return new Map(drops.map((d) => [d.code, d]));
}

/** Una línea es una pieza en una talla (sin talla si no va por tallas) o un drop. */
const sameLine = (item, target) => (target.drop
  ? item.drop === target.drop
  : !item.drop && item.slug === target.slug && (item.size ?? null) === (target.size ?? null));
const withSize = (name, size) => (size ? `${name} · Talla ${size}` : name);

/** Unidades de una pieza (en esa talla) que ya hay en el carrito: sueltas y dentro de los bundles. */
function unitsInCart(items, drops, productSlug, size = null) {
  return items.reduce((n, i) => {
    if (i.slug === productSlug && (i.size ?? null) === size) return n + i.qty;
    if (!size && i.drop && drops.get(i.drop)?.items?.includes(productSlug)) return n + i.qty; // los drops no llevan tallas
    return n;
  }, 0);
}

/**
 * Resume el carrito con nombres y precios vigentes. Un bundle cuenta mientras su drop siga abierto;
 * si cerró, se lista como cerrado y queda fuera del total. Una pieza agotada o retirada (archivada o en
 * borrador) se lista con `out` («agotado» · «retirado») y tampoco suma: se ve en rojo para quitarla.
 * Las líneas de piezas o drops borrados salen del carrito (pruneCart) y `removed` dice cuántas.
 */
async function summarize(db, cart) {
  const { items, removed } = await pruneCart(db, cart);
  if (!items.length) return removed ? { ...EMPTY, removed } : EMPTY;

  const drops = await cartDrops(db, items);
  const slugs = new Set(items.filter((i) => i.slug).map((i) => i.slug));
  drops.forEach((d) => (Array.isArray(d.items) ? d.items : []).forEach((s) => slugs.add(s)));
  const products = await db
    .collection(COLLECTIONS.products)
    .find({ slug: { $in: [...slugs] } }, { projection: { _id: 0, slug: 1, name: 1, priceCents: 1, status: 1, stock: 1, sizes: 1, images: 1 } })
    .toArray();
  const bySlug = new Map(products.map((p) => [p.slug, p]));
  const now = Date.now();
  const outOf = (p, size = null) => {
    if (!p || p.status !== 'active') return 'retirado';
    return (size ? sizeStock(p, size) : p.stock) > 0 ? null : 'agotado';
  };

  const lines = items.flatMap((i) => {
    if (i.slug) {
      const p = bySlug.get(i.slug);
      if (!p) return [];
      const out = outOf(p, i.size ?? null);
      return [{ id: p.slug, ...(i.size ? { size: i.size } : {}), name: withSize(p.name, i.size), image: coverUrl(p), qty: i.qty, priceCents: p.priceCents, ...(out ? { out } : {}) }];
    }
    const d = drops.get(i.drop);
    if (!d || !Array.isArray(d.items)) return [];
    const outs = d.items.map((s) => outOf(bySlug.get(s)));
    const out = outs.includes('retirado') ? 'retirado' : outs.includes('agotado') ? 'agotado' : null;
    return [{
      id: `drop:${d.code}`,
      drop: d.code,
      name: dropName(d),
      qty: i.qty,
      priceCents: d.priceCents,
      includes: d.items.filter((s) => bySlug.has(s)).map((s) => ({ id: s, name: bySlug.get(s).name, image: coverUrl(bySlug.get(s)) })),
      closed: !d.active || d.endsAt.getTime() <= now,
      ...(out ? { out } : {}),
    }];
  });
  const open = lines.filter((l) => !l.closed && !l.out);

  return {
    count: open.reduce((n, l) => n + l.qty, 0),
    items: lines,
    subtotalCents: open.reduce((sum, l) => sum + l.qty * l.priceCents, 0),
    ...(removed ? { removed } : {}),
  };
}

/**
 * Suma `qty` a la línea ({ slug, size } o { drop }) o la crea; si la línea ya existe el upsert choca con
 * el _id y se incrementa. `size: null` también encuentra las líneas guardadas sin talla.
 */
async function addLine(carts, cartId, line, qty, now) {
  const match = line.drop ? { drop: line.drop } : { slug: line.slug, size: line.size ?? null };
  const doc = line.drop ? { drop: line.drop } : { slug: line.slug, ...(line.size ? { size: line.size } : {}) };
  try {
    await carts.updateOne(
      { _id: cartId, items: { $not: { $elemMatch: match } } },
      {
        $push: { items: { ...doc, qty, addedAt: now } },
        $set: { updatedAt: now },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
  } catch (err) {
    if (err?.code !== 11000) throw err;
    await carts.updateOne(
      { _id: cartId, items: { $elemMatch: match } },
      { $inc: { 'items.$.qty': qty }, $set: { updatedAt: now } },
    );
  }
}

/** Límites comunes de una línea: unidades por línea y líneas por carrito. */
function checkLine(items, current, qty) {
  if (current + qty > MAX_QTY_PER_ITEM) throw new HttpError(409, `Máximo ${MAX_QTY_PER_ITEM} unidades por producto.`);
  if (!current && items.length >= MAX_LINES) throw new HttpError(409, 'Tu carrito está lleno.');
}

async function addProduct({ req, res, db, body, qty }) {
  const productId = slug(body.productId);
  const product = await db.collection(COLLECTIONS.products).findOne({ slug: productId, status: 'active' });
  if (!product) throw new HttpError(404, 'Ese producto ya no está disponible.');
  let size = null;
  if (hasSizes(product)) {
    size = typeof body.size === 'string' && body.size ? body.size : null;
    if (!size) throw new HttpError(400, `Elige una talla de «${product.name}».`);
    if (!product.sizes.some((s) => s.size === size)) throw new HttpError(400, `«${product.name}» no viene en talla ${size}.`);
  }
  if (!isPurchasable(product, size)) throw new HttpError(409, size ? `La talla ${size} de «${product.name}» está agotada.` : 'Producto agotado.');

  const cartId = ensureCartId(req, res);
  const carts = db.collection(COLLECTIONS.carts);
  const items = (await carts.findOne({ _id: cartId }))?.items ?? [];
  checkLine(items, items.find((i) => sameLine(i, { slug: productId, size }))?.qty ?? 0, qty);
  const available = size ? sizeStock(product, size) : product.stock;
  const inCart = unitsInCart(items, await cartDrops(db, items), productId, size);
  if (inCart + qty > available) {
    throw new HttpError(409, `Solo quedan ${available}${size ? ` en talla ${size}` : ' en stock'}${inCart ? ` y ya tienes ${inCart} en tu carrito` : ''}.`);
  }

  await addLine(carts, cartId, { slug: productId, size }, qty, new Date());
  return { cartId, added: { id: productId, size, name: withSize(product.name, size), qty }, drop: null };
}

async function addDrop({ req, res, db, body, qty }) {
  const code = typeof body.dropCode === 'string' && DROP_CODE_RE.test(body.dropCode) ? body.dropCode : null;
  if (!code) throw new HttpError(400, 'Identificador de drop inválido.');
  const now = new Date();
  const drops = db.collection(COLLECTIONS.drops);
  const drop = await drops.findOne({ code, active: true, endsAt: { $gt: now }, items: { $type: 'array' } });
  if (!drop) throw new HttpError(404, 'Ese drop ya cerró.');
  const products = await db.collection(COLLECTIONS.products).find({ slug: { $in: drop.items }, status: 'active' }).toArray();
  if (products.length !== drop.items.length) throw new HttpError(409, 'Una de las piezas del drop ya no está disponible.');
  if (products.some(hasSizes)) throw new HttpError(409, 'Este drop trae una pieza con tallas: escríbenos para apartarlo.');

  const cartId = ensureCartId(req, res);
  const carts = db.collection(COLLECTIONS.carts);
  const items = (await carts.findOne({ _id: cartId }))?.items ?? [];
  checkLine(items, items.find((i) => i.drop === code)?.qty ?? 0, qty);
  const inCart = await cartDrops(db, items);
  for (const p of products) {
    if (unitsInCart(items, inCart, p.slug) + qty > p.stock) {
      throw new HttpError(409, p.stock > 0 ? `No alcanza «${p.name}» para otro bundle: quedan ${p.stock}.` : `«${p.name}» se agotó.`);
    }
  }

  // no hay cupo aparte: alcanzan los drops que permita la pieza con menos existencias (contando lo que ya está en
  // el carrito, suelto o en otros bundles), y al pagar cada drop descuenta una unidad de cada pieza
  await addLine(carts, cartId, { drop: code }, qty, now);
  return {
    cartId,
    added: { id: `drop:${code}`, name: dropName(drop), qty },
    drop: { code },
  };
}

/** Cambia las unidades de una línea (0 la quita). */
async function setLine({ req, res, db, body }) {
  const qty = body.qty;
  if (!Number.isInteger(qty) || qty < 0 || qty > MAX_QTY_PER_ITEM) throw new HttpError(400, `Las unidades van de 0 a ${MAX_QTY_PER_ITEM}.`);
  const isDrop = body.dropCode !== undefined;
  const value = isDrop ? body.dropCode : slug(body.productId);
  if (isDrop && (typeof value !== 'string' || !DROP_CODE_RE.test(value))) throw new HttpError(400, 'Identificador de drop inválido.');
  const size = !isDrop && typeof body.size === 'string' && body.size ? body.size : null;
  const target = isDrop ? { drop: value } : { slug: value, size };

  const cartId = readCartId(req);
  const carts = db.collection(COLLECTIONS.carts);
  const line = cartId ? (await carts.findOne({ _id: cartId }))?.items?.find((i) => sameLine(i, target)) : null;
  if (!line) throw new HttpError(404, 'Eso ya no está en tu carrito.');
  const diff = qty - line.qty;
  if (diff > 0) {
    const ctx = { req, res, db, body: isDrop ? { dropCode: value } : { productId: value, size }, qty: diff };
    await (isDrop ? addDrop(ctx) : addProduct(ctx));
    return cartId;
  }
  if (diff === 0) return cartId;
  const now = new Date();
  const match = isDrop ? { drop: value } : { slug: value, size }; // size null también encuentra las líneas sin talla
  await carts.updateOne(
    { _id: cartId },
    qty === 0
      ? { $pull: { items: match }, $set: { updatedAt: now } }
      : { $inc: { 'items.$[line].qty': diff }, $set: { updatedAt: now } },
    qty === 0 ? {} : { arrayFilters: [Object.fromEntries(Object.entries(match).map(([k, v]) => [`line.${k}`, v]))] },
  );
  return cartId;
}

/**
 * GET   /api/cart                          → resumen del carrito de esta cookie
 * POST  /api/cart { productId, size?, qty? } → añade una pieza (size obligatorio si va por tallas)
 * POST  /api/cart { dropCode, qty? }       → añade el bundle de un drop activo (si alcanzan las existencias de sus piezas)
 * PATCH /api/cart { productId, size? | dropCode, qty } → fija las unidades de una línea (0 la quita)
 */
export default route({
  async GET(req, res) {
    res.setHeader('Cache-Control', CACHE.none);
    const cartId = readCartId(req);
    if (!cartId) return res.status(200).json(EMPTY);

    const db = await getDb();
    const cart = await db.collection(COLLECTIONS.carts).findOne({ _id: cartId });
    res.status(200).json(await summarize(db, cart));
  },

  async POST(req, res) {
    res.setHeader('Cache-Control', CACHE.none);
    const body = readJson(req);
    const qty = int(body.qty, { min: 1, max: MAX_QTY_PER_ITEM, fallback: 1 });
    const db = await getDb();
    const ctx = { req, res, db, body, qty };
    const { cartId, added, drop } = body.dropCode !== undefined ? await addDrop(ctx) : await addProduct(ctx);

    const updated = await db.collection(COLLECTIONS.carts).findOne({ _id: cartId });
    res.status(200).json({ cart: await summarize(db, updated), added, drop });
  },

  async PATCH(req, res) {
    res.setHeader('Cache-Control', CACHE.none);
    const body = readJson(req);
    const db = await getDb();
    const cartId = await setLine({ req, res, db, body });
    const updated = await db.collection(COLLECTIONS.carts).findOne({ _id: cartId });
    res.status(200).json({ cart: await summarize(db, updated) });
  },
});