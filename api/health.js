import { route, CACHE } from '../lib/http.js';
import { getDb } from '../lib/mongodb.js';

/** GET /api/health — comprueba que la función llega a MongoDB. */
export default route({
  async GET(req, res) {
    const db = await getDb();
    await db.command({ ping: 1 });
    res.setHeader('Cache-Control', CACHE.none);
    res.status(200).json({ ok: true, db: db.databaseName });
  },
});
