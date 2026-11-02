import { route, HttpError, CACHE, queryString } from '../lib/http.js';
import { getDb } from '../lib/mongodb.js';
import { int } from '../lib/validate.js';
import { COLLECTIONS, INDEX_SIZE, toPublicProduct } from '../lib/catalog.js';
import { readSite } from '../lib/site.js';
import { textFilter, searchWords, productScore, vocabularyOf, correctWords } from '../lib/search.js';

const SUGGEST_MAX = 6;

/**
 * El buscador de la barra: las piezas que mejor calzan (hasta SUGGEST_MAX, ordenadas por productScore: nombre y
 * SKU antes que zona y formato, lo que hay antes que lo agotado), cuántas hay en total (las mismas que mostraría
 * el índice con ese texto) y, si ninguna calza, la búsqueda corregida («camsia» → «camisa») con sus piezas.
 */
async function suggest(res, db, text, zones) {
  const products = db.collection(COLLECTIONS.products);
  const zoneName = new Map(zones.map((z) => [z.key, z.label]));
  const rank = async (words) => {
    const docs = await products.find({ status: 'active', ...textFilter(words.join(' '), zones) }).toArray();
    const ranked = docs
      .map((p) => ({ p, score: productScore(p, words, zoneName.get(p.category)) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || b.p.createdAt - a.p.createdAt);
    return { matched: docs.length, ranked: ranked.slice(0, SUGGEST_MAX) };
  };

  const words = searchWords(text);
  let result = words.length ? await rank(words) : { matched: 0, ranked: [] };
  let corrected = null;
  if (words.length && !result.matched) {
    const names = await products.distinct('name', { status: 'active' });
    const fixed = correctWords(words, vocabularyOf([...names, ...zones.map((z) => z.label)]));
    if (fixed) {
      const retry = await rank(fixed);
      if (retry.matched) {
        result = retry;
        corrected = fixed.join(' ');
      }
    }
  }
  res.setHeader('Cache-Control', CACHE.live);
  res.status(200).json({
    matched: result.matched,
    corrected,
    products: result.ranked.map(({ p, score }) => ({ ...toPublicProduct(p), score })),
  });
}

/**
 * GET /api/catalog?category=<zona>&q=<texto>&page=1&limit=10&index=1
 * Una página de piezas activas (las más nuevas primero), filtradas por zona y por texto (cada palabra en el nombre,
 * el SKU, el formato o el nombre de la zona), con el número de páginas, cuántas coinciden y el conteo por zona.
 * `index=1` suma los slugs de las INDEX_SIZE piezas más nuevas: la base de los logros de vistas (igual que
 * recordSeen en lib/auth.js).
 * GET /api/catalog?suggest=<texto> → el buscador de la barra (ver suggest).
 */
export default route({
  async GET(req, res) {
    const db = await getDb();
    const { site } = await readSite(db);
    const zoneItems = site.zonas.items;
    const zones = zoneItems.map((z) => z.key);

    const wanted = queryString(req, 'suggest');
    if (wanted !== undefined) return suggest(res, db, wanted.trim().slice(0, 60), zoneItems);

    const category = queryString(req, 'category');
    const text = String(queryString(req, 'q') ?? '').trim().slice(0, 60);
    const limit = int(queryString(req, 'limit'), { min: 1, max: INDEX_SIZE, fallback: 10 });
    const page = int(queryString(req, 'page'), { min: 1, max: 10_000, fallback: 1 });
    if (category && !zones.includes(category)) {
      throw new HttpError(400, 'Zona desconocida.');
    }

    const products = db.collection(COLLECTIONS.products);
    const filter = { status: 'active', ...textFilter(text, zoneItems) };
    if (category) filter.category = category;

    const [matched, grouped, index] = await Promise.all([
      products.countDocuments(filter),
      products
        .aggregate([
          { $match: { status: 'active' } },
          { $group: { _id: '$category', count: { $sum: 1 } } },
        ])
        .toArray(),
      queryString(req, 'index') === '1'
        ? products.find({ status: 'active' }, { projection: { slug: 1 } }).sort({ createdAt: -1 }).limit(INDEX_SIZE).toArray()
        : null,
    ]);
    // una página que ya no existe (p. ej. se archivaron piezas) muestra la última
    const pages = Math.max(1, Math.ceil(matched / limit));
    const shown = Math.min(page, pages);
    const items = await products.find(filter).sort({ createdAt: -1, _id: -1 }).skip((shown - 1) * limit).limit(limit).toArray();

    const counts = Object.fromEntries(zones.map((c) => [c, 0]));
    for (const { _id, count } of grouped) {
      if (_id in counts) counts[_id] = count;
    }
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

    res.setHeader('Cache-Control', CACHE.live); // las existencias cambian con cada venta: copia de 10 s, no de 1 min
    res.status(200).json({
      products: items.map(toPublicProduct),
      page: shown,
      pages,
      perPage: limit,
      matched,
      total,
      counts,
      ...(index ? { index: index.map((p) => p.slug) } : {}),
    });
  },
});
