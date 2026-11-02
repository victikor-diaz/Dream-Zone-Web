import { HttpError } from './http.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Texto obligatorio, recortado y con límites de longitud. */
export function text(value, { field, min = 1, max = 200 }) {
  if (typeof value !== 'string') throw new HttpError(400, `Falta el campo "${field}".`);
  const clean = value.trim().replace(/\s+/g, ' ');
  if (clean.length < min) throw new HttpError(400, `"${field}" es demasiado corto.`);
  if (clean.length > max) throw new HttpError(400, `"${field}" admite máximo ${max} caracteres.`);
  return clean;
}

export function email(value) {
  const clean = text(value, { field: 'correo', min: 6, max: 254 }).toLowerCase();
  if (!EMAIL_RE.test(clean)) throw new HttpError(400, 'El correo no tiene un formato válido.');
  return clean;
}

/** Letras y números de cualquier idioma, con espacios y . _ - ' en medio. Igual que NICK_RE en public/js/cuenta.js. */
const NICK_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u;

/** Apodo de la credencial: opcional (vacío → null), 2–24 caracteres. */
export function nickname(value) {
  if (value == null) return null;
  if (typeof value !== 'string') throw new HttpError(400, 'El apodo no es válido.');
  const clean = value.trim().replace(/\s+/g, ' ');
  if (!clean) return null;
  if (clean.length < 2 || clean.length > 24) throw new HttpError(400, 'El apodo va de 2 a 24 caracteres (o déjalo vacío).');
  if (!NICK_RE.test(clean)) throw new HttpError(400, "El apodo solo admite letras, números, espacios y . _ - '");
  return clean;
}

export function slug(value, field = 'producto') {
  if (typeof value !== 'string' || value.length > 80 || !SLUG_RE.test(value)) {
    throw new HttpError(400, `Identificador de ${field} inválido.`);
  }
  return value;
}

export function int(value, { min, max, fallback }) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const WEAK_PASSWORDS = new Set([
  '12345678', '123456789', '1234567890', '87654321', 'password', 'password1', 'contraseña', 'contrasena',
  'qwertyui', 'qwerty123', 'iloveyou', 'dreamzone', 'abcd1234', 'abc12345',
]);

/** Contraseña nueva: 8–128 caracteres, sin recortar espacios y fuera de la lista de las más usadas. */
export function password(value) {
  if (typeof value !== 'string' || !value) throw new HttpError(400, 'Escribe una contraseña.');
  if (value.length < 8) throw new HttpError(400, 'La contraseña necesita al menos 8 caracteres.');
  if (value.length > 128) throw new HttpError(400, 'La contraseña admite máximo 128 caracteres.');
  if (WEAK_PASSWORDS.has(value.toLowerCase()) || /^(.)\1+$/.test(value)) {
    throw new HttpError(400, 'Esa contraseña es de las primeras que prueba un atacante. Elige otra.');
  }
  return value;
}

/** Entero dentro de un rango; a diferencia de int(), no corrige: rechaza. */
export function wholeNumber(value, { field, min, max }) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, `"${field}" debe ser un número entero entre ${min} y ${max}.`);
  }
  return value;
}

/** Texto opcional: vacío → null. */
export function optionalText(value, { field, max }) {
  if (value == null || (typeof value === 'string' && !value.trim())) return null;
  return text(value, { field, max });
}

export function oneOf(value, list, field) {
  if (!list.includes(value)) throw new HttpError(400, `"${field}" no es una opción válida.`);
  return value;
}

/** Enlaces que la curaduría puede poner en la tienda: nunca javascript:, data: ni similares. */
export const SAFE_URL_RE = /^(?:https?:\/\/[^\s<>"'`]+|mailto:[^\s<>"'`]+|tel:\+?[\d\s()-]+|#[\w-]*|\/[^\s<>"'`]*|[a-z0-9-]+\.html(?:[?#][^\s<>"'`]*)?)$/i;

/** Enlace opcional: vacío → null. */
export function optionalUrl(value, field) {
  if (value == null || (typeof value === 'string' && !value.trim())) return null;
  const clean = typeof value === 'string' ? value.trim() : '';
  if (clean.length > 300 || !SAFE_URL_RE.test(clean)) {
    throw new HttpError(400, `El enlace de "${field}" no es válido: usa https://…, mailto:, tel:, #seccion o /pagina.`);
  }
  return clean;
}
