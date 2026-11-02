import { ObjectId } from 'mongodb';
import { HttpError, queryString } from '../http.js';

/* Piezas comunes de los recursos de la curaduría (api/admin/[resource].js). */

export function idParam(req, what) {
  const id = queryString(req, 'id');
  if (!id || !/^[0-9a-f]{24}$/.test(id)) throw new HttpError(400, `Identificador de ${what} inválido.`);
  return new ObjectId(id);
}

/** Bloqueo optimista: si otra persona guardó mientras editabas, no se pisa su trabajo. */
export function assertFresh(prev, body, message) {
  if (body.updatedAt && prev.updatedAt && body.updatedAt !== prev.updatedAt.toISOString()) {
    throw new HttpError(409, message);
  }
}

export function dateField(value, field) {
  if (typeof value !== 'string' || !value) throw new HttpError(400, `Falta la fecha de ${field}.`);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `La fecha de ${field} no es válida.`);
  return d;
}

export const slugify = (s, fallback) => String(s)
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  .slice(0, 60).replace(/-+$/, '') || fallback;