import { readJson, HttpError } from '../http.js';
import { COLLECTIONS } from '../catalog.js';
import { SITE_SCHEMA, SITE_DEFAULTS, readSite, validateSite, writeSite } from '../site.js';

/*
 * Textos, zonas y colores de la página:
 * GET /api/admin/site → { site, updatedAt, schema, defaults } (el esquema arma el formulario)
 * PUT /api/admin/site { site, updatedAt } → guarda todo el contenido validado
 * Una zona con piezas (de cualquier estado) no se puede quitar: primero se pasan a otra.
 */

async function assertZonesKeepPieces(db, zones) {
  const keys = new Set(zones.map((z) => z.key));
  const used = await db.collection(COLLECTIONS.products).aggregate([{ $group: { _id: '$category', count: { $sum: 1 } } }]).toArray();
  const orphan = used.filter((u) => !keys.has(u._id));
  if (!orphan.length) return;
  const { site } = await readSite(db);
  const label = (key) => site.zonas.items.find((z) => z.key === key)?.label ?? key;
  const list = orphan.map((o) => `«${label(o._id)}» (${o.count} ${o.count === 1 ? 'pieza' : 'piezas'})`).join(', ');
  throw new HttpError(409, `No se puede quitar ${list}: primero pasa sus piezas a otra zona en Piezas.`);
}
export default {
  async GET({ res, db }) {
    const { site, updatedAt } = await readSite(db);
    res.status(200).json({ site, updatedAt, schema: SITE_SCHEMA, defaults: SITE_DEFAULTS });
  },

  async PUT({ req, res, db, auth }) {
    const body = readJson(req);
    const content = validateSite(body.site);
    await assertZonesKeepPieces(db, content.zonas.items);
    const updatedAt = await writeSite(db, { content, updatedAt: body.updatedAt ?? null, userId: auth.user._id });
    res.status(200).json({ site: content, updatedAt });
  },
};