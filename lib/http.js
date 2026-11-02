/* Utilidades HTTP compartidas por las funciones de /api (firma req/res de Vercel). */

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const CACHE = {
  /** Datos públicos: la CDN de Vercel los sirve 60 s y revalida en segundo plano. */
  public: 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
  /** Datos que cambian con cada compra (los apartados de los drops). */
  live: 'public, max-age=0, s-maxage=10, stale-while-revalidate=30',
  /** Respuestas por usuario o mutaciones: nunca en caché. */
  none: 'private, no-store',
};

/**
 * Envuelve un handler por método HTTP: responde 405 a métodos no soportados y
 * convierte errores en JSON sin filtrar detalles internos.
 */
export function route(handlers) {
  const allowed = Object.keys(handlers).join(', ');
  return async function handler(req, res) {
    const fn = handlers[req.method];
    if (!fn) {
      res.setHeader('Allow', allowed);
      res.setHeader('Cache-Control', CACHE.none);
      return res.status(405).json({ error: 'Método no permitido.' });
    }
    try {
      await fn(req, res);
    } catch (err) {
      res.setHeader('Cache-Control', CACHE.none);
      if (err instanceof HttpError) {
        return res.status(err.status).json({ error: err.message });
      }
      if (err?.code === 'DZ_CONFIG') {
        console.error('[api] configuración:', err.message);
        return res.status(503).json({ error: 'La base de datos no está configurada.' });
      }
      console.error(`[api] ${req.method} ${req.url}`, err);
      return res.status(500).json({ error: 'Error interno. Intenta de nuevo en un momento.' });
    }
  };
}

/** Devuelve el cuerpo JSON como objeto plano o lanza 400. */
export function readJson(req) {
  let body;
  try {
    body = req.body; // en Vercel el getter lanza si el JSON es inválido
  } catch {
    throw new HttpError(400, 'El cuerpo de la petición no es JSON válido.');
  }
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      throw new HttpError(400, 'El cuerpo de la petición no es JSON válido.');
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Se esperaba un objeto JSON.');
  }
  return body;
}

/** Lee un parámetro de query como string único (ignora arrays). */
export function queryString(req, name) {
  const value = req.query?.[name];
  return typeof value === 'string' ? value : undefined;
}

/** HTTPS detrás del proxy de Vercel (o en local con un túnel). Decide el atributo Secure de las cookies. */
export function isHttps(req) {
  return req.headers['x-forwarded-proto'] === 'https' || Boolean(process.env.VERCEL);
}

/** Añade una cookie sin pisar otras que la respuesta ya lleve. */
export function appendCookie(res, cookie) {
  const prev = res.getHeader('Set-Cookie');
  const list = prev ? (Array.isArray(prev) ? prev : [String(prev)]) : [];
  res.setHeader('Set-Cookie', [...list, cookie]);
}

/**
 * Defensa extra contra CSRF en mutaciones: si el navegador manda Origin, debe ser este mismo sitio.
 * (Las cookies ya son SameSite=Lax; esto cubre navegadores antiguos y subdominios hermanos.)
 */
export function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  let originHost = null;
  try {
    originHost = new URL(origin).host;
  } catch {
    /* Origin malformado */
  }
  if (!host || originHost !== host) throw new HttpError(403, 'Origen no permitido.');
}

/** IP del visitante. En Vercel x-real-ip / x-forwarded-for los fija el proxy y no se pueden falsear. */
export function clientIp(req) {
  const forwarded = req.headers['x-real-ip'] ?? String(req.headers['x-forwarded-for'] ?? '').split(',')[0];
  return forwarded.trim() || req.socket?.remoteAddress || 'desconocida';
}
