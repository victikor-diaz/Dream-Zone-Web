import { HttpError } from './http.js';
import { text, slug, wholeNumber, optionalText, oneOf } from './validate.js';
import { ICONS, BADGES, STATUSES, MAX_IMAGES, SIZES } from './catalog.js';

/* Validación de una pieza completa tal como la manda la curaduría (alta o edición). `zones`: claves de las zonas vigentes. */

const SKU_RE = /^[A-Z0-9][A-Z0-9-]{1,23}$/;
const TONE_RE = /^#[0-9a-f]{6}$/i;
const HEX_ID_RE = /^[0-9a-f]{24}$/;
const MAX_CENTS = 100_000_000; // $1,000,000.00

const cents = (value, field) => wholeNumber(value, { field, min: 0, max: MAX_CENTS });
const empty = (value) => value == null || value === '';

/** Tallas: null (no va por tallas) o [{ size, stock }] en el orden de SIZES; las existencias son por talla. */
function sizesInput(value) {
  if (value == null || (Array.isArray(value) && !value.length)) return null;
  if (!Array.isArray(value)) throw new HttpError(400, 'Las tallas no son válidas.');
  const seen = new Set();
  const sizes = value.map((s) => {
    const size = oneOf(s?.size, SIZES, 'talla');
    if (seen.has(size)) throw new HttpError(400, `La talla ${size} está repetida.`);
    seen.add(size);
    return { size, stock: wholeNumber(s.stock, { field: `existencias de la talla ${size}`, min: 0, max: 100_000 }) };
  });
  return sizes.sort((a, b) => SIZES.indexOf(a.size) - SIZES.indexOf(b.size));
}

export function productInput(body, zones) {
  const sku = typeof body.sku === 'string' ? body.sku.trim().toUpperCase() : '';
  if (!SKU_RE.test(sku)) throw new HttpError(400, 'El SKU solo admite letras, números y guiones (2 a 24).');

  const priceCents = cents(body.priceCents, 'precio');
  const compareAtCents = empty(body.compareAtCents) ? null : cents(body.compareAtCents, 'precio anterior');
  if (compareAtCents != null && compareAtCents <= priceCents) {
    throw new HttpError(400, 'El precio anterior debe ser mayor que el precio actual (o déjalo vacío).');
  }


  let tone = null;
  if (!empty(body.tone)) {
    if (typeof body.tone !== 'string' || !TONE_RE.test(body.tone)) throw new HttpError(400, 'El color debe ser un hex tipo #ff6fae.');
    tone = body.tone.toLowerCase();
  }

  if (!Array.isArray(body.images)) throw new HttpError(400, 'Falta la lista de imágenes.');
  const imageIds = [...new Set(body.images.map((img) => (typeof img === 'string' ? img : img?.id)))];
  if (imageIds.length > MAX_IMAGES) throw new HttpError(400, `Máximo ${MAX_IMAGES} imágenes por pieza.`);
  if (!imageIds.every((id) => typeof id === 'string' && HEX_ID_RE.test(id))) {
    throw new HttpError(400, 'Hay una imagen con un identificador inválido.');
  }

  const sizes = sizesInput(body.sizes);

  let createdAt = null;
  if (!empty(body.createdAt)) {
    createdAt = new Date(body.createdAt);
    if (Number.isNaN(createdAt.getTime())) throw new HttpError(400, 'La fecha de alta no es válida.');
  }

  return {
    fields: {
      name: text(body.name, { field: 'nombre', min: 2, max: 80 }),
      slug: slug(body.slug, 'pieza (slug)'),
      sku,
      category: oneOf(body.category, zones, 'zona'),
      subtitle: text(body.subtitle, { field: 'formato', min: 2, max: 80 }),
      icon: oneOf(body.icon, ICONS, 'ilustración'),
      status: oneOf(body.status, STATUSES, 'estado'),
      priceCents,
      compareAtCents,
      rarity: wholeNumber(body.rarity, { field: 'rareza', min: 1, max: 5 }),
      badge: empty(body.badge) ? null : oneOf(body.badge, BADGES, 'etiqueta'),
      // con tallas, las existencias son la suma de las tallas
      stock: sizes ? sizes.reduce((sum, s) => sum + s.stock, 0) : wholeNumber(body.stock, { field: 'existencias', min: 0, max: 100_000 }),
      sizes,
      lore: optionalText(body.lore, { field: 'lore', max: 280 }),
      tone,
      // peso de la pieza, para cotizar el envío (vacío: el peso por pieza de Curaduría › Página › Pago y envíos)
      weightGrams: empty(body.weightGrams) ? null : wholeNumber(body.weightGrams, { field: 'peso', min: 1, max: 50_000 }),
    },
    imageIds,
    createdAt,
  };
}
