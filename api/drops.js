import { route, CACHE } from '../lib/http.js';
import { getDb } from '../lib/mongodb.js';
import { COLLECTIONS, toPublicDrop } from '../lib/catalog.js';

/**
 * GET /api/drops — los drops activos (bundles de piezas con precio rebajado), del que cierra antes
 * al que cierra después. Un drop con alguna pieza que ya no está publicada no se muestra.
 * Los bundles se apartan desde POST /api/cart { dropCode }.
 */
export default route({
  async GET(req, res) {
    const db = await getDb();
    const drops = await db
      .collection(COLLECTIONS.drops)
      .find({ active: true, endsAt: { $gt: new Date() }, items: { $type: 'array' } })
      .sort({ endsAt: 1 })
      .limit(24)
      .toArray();

    const slugs = [...new Set(drops.flatMap((d) => d.items))];
    const products = slugs.length
      ? await db.collection(COLLECTIONS.products).find({ slug: { $in: slugs }, status: 'active' }).toArray()
      : [];
    const live = new Set(products.map((p) => p.slug));

    res.setHeader('Cache-Control', CACHE.live);
    res.status(200).json({
      drops: drops.filter((d) => d.items.every((s) => live.has(s))).map((d) => toPublicDrop(d, products)),
    });
  },
});