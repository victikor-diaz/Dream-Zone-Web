import { randomUUID } from 'node:crypto';
import { appendCookie, isHttps } from './http.js';
import { COLLECTIONS } from './catalog.js';

/* Carrito anónimo: el navegador solo guarda un UUID en cookie httpOnly; el contenido vive en Mongo. */

const COOKIE = 'dz_cart';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 días, igual que el TTL de la colección carts
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function readCartId(req) {
  const value = req.cookies?.[COOKIE];
  return typeof value === 'string' && UUID_RE.test(value) ? value : null;
}

/**
 * Quita del carrito las líneas cuya pieza o drop ya no existe (se borró en la curaduría). Sin esto quedaban líneas
 * fantasma: el carrito no las mostraba, pero seguían contando y el pago las rechazaba sin forma de quitarlas.
 * Devuelve las líneas que quedan y cuántas salieron.
 */
export async function pruneCart(db, cart) {
  const items = cart?.items ?? [];
  if (!items.length) return { items, removed: 0 };
  const slugs = [...new Set(items.filter((i) => i.slug).map((i) => i.slug))];
  const codes = [...new Set(items.filter((i) => i.drop).map((i) => i.drop))];
  const [products, drops] = await Promise.all([
    slugs.length ? db.collection(COLLECTIONS.products).find({ slug: { $in: slugs } }, { projection: { slug: 1 } }).toArray() : [],
    codes.length ? db.collection(COLLECTIONS.drops).find({ code: { $in: codes } }, { projection: { code: 1 } }).toArray() : [],
  ]);
  const haveSlug = new Set(products.map((p) => p.slug));
  const haveDrop = new Set(drops.map((d) => d.code));
  const gone = items.filter((i) => (i.drop ? !haveDrop.has(i.drop) : !haveSlug.has(i.slug)));
  if (!gone.length) return { items, removed: 0 };
  await db.collection(COLLECTIONS.carts).updateOne({ _id: cart._id }, {
    $pull: { items: { $or: [{ slug: { $in: gone.filter((i) => !i.drop).map((i) => i.slug) } }, { drop: { $in: gone.filter((i) => i.drop).map((i) => i.drop) } }] } },
  });
  return { items: items.filter((i) => !gone.includes(i)), removed: gone.length };
}

/** Devuelve el id del carrito (creándolo si hace falta) y renueva la cookie. */
export function ensureCartId(req, res) {
  const id = readCartId(req) ?? randomUUID();
  appendCookie(
    res,
    `${COOKIE}=${id}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`,
  );
  return id;
}
