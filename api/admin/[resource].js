import { route, HttpError, CACHE, assertSameOrigin, queryString } from '../../lib/http.js';
import { getDb } from '../../lib/mongodb.js';
import { requireAdmin } from '../../lib/auth.js';
import products from '../../lib/admin/products.js';
import site from '../../lib/admin/site.js';
import drops from '../../lib/admin/drops.js';
import inbox from '../../lib/admin/inbox.js';
import team from '../../lib/admin/team.js';
import orders from '../../lib/admin/orders.js';
import sala from '../../lib/admin/sala.js';

/*
 * Curaduría (solo admins): una sola función para todos los módulos del panel.
 *   /api/admin/products · site · drops · orders · sala · inbox · team
 * Cada recurso exporta sus métodos ({ req, res, db, auth }); aquí se comprueba la sesión,
 * el rol y, en las mutaciones, el origen de la petición.
 */
const RESOURCES = { products, site, drops, orders, sala, inbox, team };

async function dispatch(req, res) {
  res.setHeader('Cache-Control', CACHE.none);
  const name = queryString(req, 'resource');
  const resource = name && Object.hasOwn(RESOURCES, name) ? RESOURCES[name] : null;
  if (!resource) throw new HttpError(404, 'Módulo desconocido.');
  const handler = resource[req.method];
  if (!handler) {
    res.setHeader('Allow', Object.keys(resource).join(', '));
    throw new HttpError(405, 'Método no permitido.');
  }
  if (req.method !== 'GET') assertSameOrigin(req);
  const db = await getDb();
  const auth = await requireAdmin(db, req);
  await handler({ req, res, db, auth });
}

export default route({ GET: dispatch, POST: dispatch, PUT: dispatch, DELETE: dispatch });