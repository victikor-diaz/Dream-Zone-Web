import { route, CACHE } from '../lib/http.js';
import { getDb } from '../lib/mongodb.js';
import { readSite } from '../lib/site.js';

/** GET /api/site — textos, zonas y colores de la página (los edita la curaduría). */
export default route({
  async GET(req, res) {
    const db = await getDb();
    const { site, updatedAt } = await readSite(db);
    res.setHeader('Cache-Control', CACHE.public);
    res.status(200).json({ site, updatedAt });
  },
});