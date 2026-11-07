/* Constantes del dominio y serializadores: lo que sale de Mongo hacia el navegador. */
import { progressOf, avatarColorFor } from './achievements.js';


/** Ilustraciones line-art disponibles en el sprite de public/index.html (y su copia en admin.html). */
export const ICONS = ['mecha', 'd20', 'book', 'pad', 'cards', 'helmet', 'cart', 'shirt', 'meeple', 'cap', 'wallet', 'bag'];
export const BADGES = ['nuevo', 'ultimas', 'oferta'];
/** «Nuevo» dura un mes desde la fecha de alta; después la tienda muestra la pieza sin etiqueta (sin tocar la base). */
export const NEW_BADGE_MONTHS = 1;
export function newBadgeUntil(createdAt) {
  const until = new Date(createdAt);
  until.setMonth(until.getMonth() + NEW_BADGE_MONTHS);
  return until;
}
/** La etiqueta que ve la tienda: la guardada, salvo «Nuevo» vencido. */
export function shownBadge(p, now = new Date()) {
  if (p.badge !== 'nuevo') return p.badge ?? null;
  return p.createdAt && newBadgeUntil(p.createdAt) > now ? 'nuevo' : null;
}
/** active: visible en la tienda · draft: en preparación · archived: retirada sin borrar. */
export const STATUSES = ['active', 'draft', 'archived'];
export const MAX_IMAGES = 8;
/** Piezas que muestra el índice de la tienda (las más nuevas): tope de /api/catalog y base de «Archivo completo». */
export const INDEX_SIZE = 48;
/** Un drop junta de 2 a 6 piezas distintas del catálogo en un bundle. */
export const DROP_ITEMS = { min: 2, max: 6 };
export const DROP_CODE_RE = /^drop-\d{3,4}$/;

export const COLLECTIONS = {
  products: 'products',
  drops: 'drops',
  carts: 'carts',
  subscribers: 'subscribers',
  specialOrders: 'special_orders',
  users: 'users',
  sessions: 'sessions',
  passwordResets: 'password_resets',
  rateLimits: 'rate_limits',
  media: 'media',
  settings: 'settings',
  orders: 'orders',
  shippingCache: 'shipping_cache',
  storeSales: 'store_sales', // compras en la sala física que sumaron XP a una credencial
};

export const mediaUrl = (id) => `/api/media?id=${id}`;
/** La primera foto de una pieza, para las miniaturas del carrito y del pedido (null si no tiene). */
export const coverUrl = (p) => (p?.images?.[0]?.id ? mediaUrl(p.images[0].id) : null);

/** Tallas de ropa, en orden. Una pieza con `sizes` lleva existencias por talla y su `stock` es la suma. */
export const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
export const hasSizes = (product) => Array.isArray(product?.sizes) && product.sizes.length > 0;
/** Existencias de una talla (0 si la pieza no la tiene). */
export const sizeStock = (product, size) => product.sizes?.find((s) => s.size === size)?.stock ?? 0;

/** Un producto se puede añadir si tiene existencias (de la talla elegida, si va por tallas). */
export function isPurchasable(product, size = null) {
  return hasSizes(product) ? sizeStock(product, size) > 0 : product.stock > 0;
}

/** Precio normal de un bundle: lo que cuestan hoy sus piezas por separado. */
export const regularCents = (products) => products.reduce((sum, p) => sum + p.priceCents, 0);

const publicImages = (p) => (p.images ?? []).map((img) => ({ url: mediaUrl(img.id), cutout: Boolean(img.cutout) }));

export function toPublicProduct(p) {
  return {
    id: p.slug,
    sku: p.sku,
    name: p.name,
    category: p.category,
    subtitle: p.subtitle,
    icon: p.icon,
    priceCents: p.priceCents,
    compareAtCents: p.compareAtCents ?? null,
    rarity: p.rarity,
    badge: shownBadge(p),
    stock: p.stock,
    sizes: hasSizes(p) ? p.sizes.map(({ size, stock }) => ({ size, stock })) : null,
    lore: p.lore ?? null,
    tone: p.tone ?? null,
    images: publicImages(p),
  };
}

/** Vista completa para la curaduría: todos los campos editables + metadatos. */
export function toAdminProduct(p) {
  return {
    ...toPublicProduct(p),
    badge: p.badge ?? null, // la guardada: la curaduría ve «Nuevo» aunque ya haya vencido (el editor avisa)
    _id: p._id.toHexString(),
    slug: p.slug,
    status: p.status ?? 'active',
    images: (p.images ?? []).map((img) => ({ id: img.id, url: mediaUrl(img.id), cutout: Boolean(img.cutout) })),
    createdAt: p.createdAt?.toISOString() ?? null,
    updatedAt: p.updatedAt?.toISOString() ?? null,
    weightGrams: p.weightGrams ?? null,
  };
}

/** Credencial de jugador: datos de la cuenta, apodo y color del cuadro + XP, nivel (1–4) y logros con su fecha. */
export function toPublicUser(u) {
  const progress = progressOf(u);
  return {
    name: u.name,
    email: u.email,
    role: u.role === 'admin' ? 'admin' : 'customer',
    createdAt: u.createdAt.toISOString(),
    nickname: u.nickname ?? null,
    seen: Array.isArray(u.seen) ? u.seen : [], // registro de piezas vistas (slugs)
    avatarColor: avatarColorFor(u.avatarColor, progress.level, u.achievements),
    // la moneda del arcade: el día (Bogotá) en que se usó, si la partida sigue en curso y cuánto XP dio
    arcade: u.arcade?.day ? { day: u.arcade.day, game: u.arcade.game ?? 'breakout', state: u.arcade.state, free: Boolean(u.arcade.free), xp: u.arcade.xp ?? 0 } : null,
    ...progress,
  };
}

/**
 * Cuántos drops completos alcanzan: los que permite la pieza con menos existencias (3 piezas con 4, 5 y 6 → 4).
 * Cada drop vendido descuenta una unidad de cada pieza, así que no hay un cupo aparte. Una pieza que falta cuenta 0.
 */
export function dropAvailable(items) {
  if (!items.length) return 0;
  return Math.min(...items.map((p) => (Number.isInteger(p?.stock) && p.stock > 0 ? p.stock : 0)));
}

/** Drop para la tienda: sus piezas en el orden del bundle, el precio normal, el del drop y cuántos quedan. */
export function toPublicDrop(drop, products) {
  const bySlug = new Map(products.map((p) => [p.slug, p]));
  const items = drop.items.map((s) => bySlug.get(s));
  return {
    code: drop.code,
    number: drop.number,
    title: drop.title,
    specs: drop.specs ?? null,
    endsAt: drop.endsAt.toISOString(),
    available: dropAvailable(items),
    priceCents: drop.priceCents,
    regularCents: regularCents(items),
    items: items.map(toPublicProduct),
  };
}

/* ---------- Vistas de la curaduría ---------- */

/** Las piezas (slugs) llegan tal cual: la curaduría ya tiene el catálogo para mostrar nombres y precios. */
export function toAdminDrop(d) {
  return {
    _id: d._id.toHexString(),
    code: d.code,
    number: d.number,
    title: d.title ?? '',
    specs: d.specs ?? '',
    items: Array.isArray(d.items) ? d.items : [],
    priceCents: d.priceCents ?? null,
    active: Boolean(d.active),
    notify: d.notify !== false, // avisar por correo a la lista al publicarlo
    endsAt: d.endsAt.toISOString(),
    createdAt: d.createdAt?.toISOString() ?? null,
    updatedAt: d.updatedAt?.toISOString() ?? null,
    // el aviso por correo a la lista: cuántos van, cuántos faltan y si sigue enviándose
    announce: d.announce ? {
      startedAt: d.announce.startedAt?.toISOString() ?? null,
      finishedAt: d.announce.finishedAt?.toISOString() ?? null,
      running: Boolean(d.announce.running),
      sent: d.announce.sent ?? 0,
      failed: d.announce.failed ?? 0,
      left: d.announce.left ?? 0,
    } : null,
  };
}


/** Integrante de la curaduría (o cuenta encontrada para invitar). `pending`: aún no elige contraseña. */
export function toTeamMember(u) {
  const { level } = progressOf(u);
  return {
    _id: u._id.toHexString(),
    name: u.name,
    nickname: u.nickname ?? null,
    avatarColor: avatarColorFor(u.avatarColor, level, u.achievements), // el cuadro que eligió en su credencial (si ya lo desbloqueó)
    level,
    email: u.email,
    role: u.role === 'admin' ? 'admin' : 'customer',
    pending: !u.passwordHash,
    createdAt: u.createdAt?.toISOString() ?? null,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    invitedBy: u.invitedByName ?? null,
  };
}
