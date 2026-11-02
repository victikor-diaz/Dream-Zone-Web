import { randomBytes } from 'node:crypto';
import { route, readJson, CACHE, HttpError, assertSameOrigin, clientIp } from '../lib/http.js';
import { getDb } from '../lib/mongodb.js';
import { text } from '../lib/validate.js';
import { COLLECTIONS } from '../lib/catalog.js';
import { limit } from '../lib/rate-limit.js';
import { consentOf, purgeStaleSpecialOrders } from '../lib/privacy.js';

const newCode = () => `DZ-${randomBytes(3).toString('hex').toUpperCase()}`;

/** Celular colombiano para WhatsApp: 10 dígitos que empiezan por 3 (acepta espacios, guiones y el +57). */
export function whatsappNumber(value) {
  const digits = String(value ?? '').replace(/[\s().-]/g, '').replace(/^\+?57(?=3\d{9}$)/, '');
  if (!/^3\d{9}$/.test(digits)) throw new HttpError(400, 'Escribe tu WhatsApp: un celular de 10 dígitos que empiece por 3.');
  return digits;
}

/** POST /api/special-orders { piece, whatsapp, consent } — solicitud de "cazadores de reliquias"; respondemos por WhatsApp. */
export default route({
  async POST(req, res) {
    res.setHeader('Cache-Control', CACHE.none);
    assertSameOrigin(req);
    const body = readJson(req);
    const piece = text(body.piece, { field: 'pieza', min: 3, max: 200 });
    const whatsapp = whatsappNumber(body.whatsapp);
    const consent = consentOf(body.consent);

    const db = await getDb();
    await limit(db, `encargo:${clientIp(req)}`, { max: 8, windowMs: 60 * 60 * 1000, message: 'Ya enviaste varias fichas. Espera un rato o escríbenos directo por WhatsApp.' });
    await purgeStaleSpecialOrders(db); // las fichas sin novedad en 6 meses (política de datos, cláusula 4)
    const orders = db.collection(COLLECTIONS.specialOrders);

    // El código es corto y legible; ante una colisión (índice único) se genera otro.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const code = newCode();
      try {
        await orders.insertOne({ code, piece, whatsapp, status: 'nuevo', consent, createdAt: new Date() });
        return res.status(201).json({ code });
      } catch (err) {
        if (err?.code !== 11000) throw err;
      }
    }
    throw new Error('No se pudo generar un código único para la solicitud');
  },
});
