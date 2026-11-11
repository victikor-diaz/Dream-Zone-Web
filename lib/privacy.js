import { HttpError } from './http.js';
import { COLLECTIONS } from './catalog.js';

/*
 * Lo que la política de tratamiento de datos (public/privacidad.html) promete y el servidor tiene que cumplir:
 * - Cláusula 7: cada formulario que recoge datos (credencial, pedido, ficha de encargo, lista de drops) trae la
 *   casilla «Leí y acepto…»; sin ella no se guarda nada, y junto al dato queda la prueba (versión y fecha).
 * - Cláusula 4: las fichas de encargo se borran 6 meses después de su última novedad, y una credencial sin uso
 *   en 2 años se avisa por correo y se borra 30 días después (npm run cuentas:inactivas).
 */

/** Versión vigente de la política. Súbela (y la de privacidad.html) cada vez que cambie el texto. */
export const POLICY_VERSION = '1.1';

export const CONSENT_REQUIRED =
  'Marca la casilla: aceptas la política de tratamiento de datos y declaras que eres mayor de edad o tienes permiso de tu representante legal.';

/** { consent: true } → { policy, at } para guardar con el dato; sin la casilla marcada, 400. */
export function consentOf(value, now = new Date()) {
  if (value !== true) throw new HttpError(400, CONSENT_REQUIRED);
  return { policy: POLICY_VERSION, at: now };
}

export const SPECIAL_ORDER_MONTHS = 6;

/** Borra las fichas de encargo sin novedad (cotización o cambio de estado) en los últimos 6 meses. */
export async function purgeStaleSpecialOrders(db, now = new Date()) {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - SPECIAL_ORDER_MONTHS);
  await db.collection(COLLECTIONS.specialOrders).deleteMany({
    $or: [{ updatedAt: { $lt: cutoff } }, { updatedAt: { $exists: false }, createdAt: { $lt: cutoff } }],
  });
}

export const INACTIVE_YEARS = 2;
export const INACTIVE_NOTICE_DAYS = 30;

/** Desde cuándo una credencial cuenta como inactiva: nadie entra a ella (ni la crea) desde esa fecha. */
export function inactiveSince(now = new Date()) {
  const since = new Date(now);
  since.setFullYear(since.getFullYear() - INACTIVE_YEARS);
  return since;
}