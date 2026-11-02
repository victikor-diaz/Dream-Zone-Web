import { route, readJson, CACHE, queryString } from '../lib/http.js';
import { getDb } from '../lib/mongodb.js';
import { email } from '../lib/validate.js';
import { COLLECTIONS } from '../lib/catalog.js';
import { newSubscriberToken } from '../lib/newsletter.js';
import { consentOf } from '../lib/privacy.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{24}$/; // newSubscriberToken: 18 bytes en base64url

/** Baja de la lista con el token del enlace de cada correo. Idempotente: un enlace viejo tampoco falla. */
async function unsubscribe(token) {
  if (!TOKEN_RE.test(token ?? '')) return false;
  const db = await getDb();
  const { deletedCount } = await db.collection(COLLECTIONS.subscribers).deleteOne({ token });
  return deletedCount > 0;
}

/*
 * POST /api/subscribe { email, website? }  — alta en la lista de drops (idempotente)
 * GET  /api/subscribe?baja=<token>          — el enlace «darte de baja» de los correos: borra y vuelve a la tienda
 * POST /api/subscribe?baja=<token>          — lo mismo con un clic desde el cliente de correo (List-Unsubscribe-Post)
 */
export default route({
  async GET(req, res) {
    res.setHeader('Cache-Control', CACHE.none);
    const done = await unsubscribe(queryString(req, 'baja'));
    res.statusCode = 303;
    res.setHeader('Location', `/?baja=${done ? 'ok' : 'ya'}#correo`);
    res.end();
  },

  async POST(req, res) {
    res.setHeader('Cache-Control', CACHE.none);
    const baja = queryString(req, 'baja');
    if (baja !== undefined && baja !== null) {
      await unsubscribe(baja);
      return res.status(200).json({ ok: true });
    }
    const body = readJson(req);

    // Honeypot: los bots llenan el campo oculto "website"; se responde OK sin guardar nada.
    if (typeof body.website === 'string' && body.website.trim()) {
      return res.status(201).json({ ok: true });
    }

    const address = email(body.email);
    const consent = consentOf(body.consent);
    const db = await getDb();
    try {
      await db.collection(COLLECTIONS.subscribers).insertOne({
        email: address,
        source: 'home',
        token: newSubscriberToken(), // para el enlace de baja de cada correo
        consent, // prueba de la autorización: versión de la política y fecha
        createdAt: new Date(),
      });
    } catch (err) {
      if (err?.code === 11000) return res.status(200).json({ ok: true, already: true });
      throw err;
    }
    res.status(201).json({ ok: true });
  },
});
