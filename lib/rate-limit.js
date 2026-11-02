import { HttpError } from './http.js';
import { COLLECTIONS } from './catalog.js';

/*
 * Límite de intentos con ventana fija, guardado en Mongo para que funcione entre
 * instancias de la función. El índice TTL sobre expiresAt borra las ventanas viejas;
 * como el TTL corre cada ~60 s, aquí también se descarta una ventana ya vencida.
 */

/** Suma un intento a `key`; lanza 429 si se pasa de `max` dentro de `windowMs`. */
export async function limit(db, key, { max, windowMs, message }) {
  const col = db.collection(COLLECTIONS.rateLimits);
  const now = new Date();
  await col.deleteOne({ _id: key, expiresAt: { $lte: now } });

  let doc;
  try {
    doc = await col.findOneAndUpdate(
      { _id: key },
      { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(now.getTime() + windowMs) } },
      { upsert: true, returnDocument: 'after' },
    );
  } catch (err) {
    if (err?.code !== 11000) throw err;
    // dos peticiones crearon la ventana a la vez: la segunda solo incrementa
    doc = await col.findOneAndUpdate({ _id: key }, { $inc: { count: 1 } }, { returnDocument: 'after' });
  }

  if (doc && doc.count > max) {
    const minutes = Math.max(1, Math.ceil((doc.expiresAt - now) / 60000));
    throw new HttpError(429, message ?? `Demasiados intentos. Espera ${minutes} min y vuelve a probar.`);
  }
}

/** Olvida los intentos de `key` (p. ej. tras un inicio de sesión correcto). */
export function reset(db, key) {
  return db.collection(COLLECTIONS.rateLimits).deleteOne({ _id: key });
}
