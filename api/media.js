import { Binary, ObjectId } from 'mongodb';
import { route, readJson, HttpError, CACHE, assertSameOrigin, queryString } from '../lib/http.js';
import { getDb } from '../lib/mongodb.js';
import { requireAdmin } from '../lib/auth.js';
import { COLLECTIONS, mediaUrl } from '../lib/catalog.js';

/*
 * Imágenes de producto guardadas en Mongo (sin servicios extra). La curaduría las reduce
 * a ≤1600 px en el navegador antes de subirlas; aquí se sirven con caché inmutable, así
 * que la CDN de Vercel las entrega y Mongo casi no se toca.
 */

const MAX_BYTES = 2.5 * 1024 * 1024; // en base64 ≈ 3.4 MB, por debajo del límite de 4.5 MB de Vercel
const ORPHAN_MS = 24 * 60 * 60 * 1000;
const IMMUTABLE = 'public, max-age=31536000, s-maxage=31536000, immutable';

/** Tipo real según los primeros bytes (no se confía en lo que diga el navegador). */
function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function mediaId(req) {
  const id = queryString(req, 'id');
  if (!id || !/^[0-9a-f]{24}$/.test(id)) throw new HttpError(400, 'Identificador de imagen inválido.');
  return new ObjectId(id);
}

/**
 * GET    /api/media?id=<id>              → la imagen (pública)
 * POST   /api/media { data, cutout }     → sube una imagen en base64 (solo admins)
 * DELETE /api/media?id=<id>              → borra una subida que aún no se guardó en ninguna pieza
 */
export default route({
  async GET(req, res) {
    const _id = mediaId(req);
    const etag = `"${_id.toHexString()}"`;
    if (req.headers['if-none-match'] === etag) {
      res.setHeader('Cache-Control', IMMUTABLE);
      return res.status(304).end();
    }
    const db = await getDb();
    const doc = await db.collection(COLLECTIONS.media).findOne({ _id }, { projection: { data: 1, type: 1 } });
    if (!doc) throw new HttpError(404, 'Imagen no encontrada.');

    const body = Buffer.from(doc.data.buffer);
    res.setHeader('Content-Type', doc.type);
    res.setHeader('Content-Length', String(body.length));
    res.setHeader('Cache-Control', IMMUTABLE);
    res.setHeader('ETag', etag);
    res.status(200).send(body);
  },

  async POST(req, res) {
    res.setHeader('Cache-Control', CACHE.none);
    assertSameOrigin(req);
    const db = await getDb();
    const { user } = await requireAdmin(db, req);
    const body = readJson(req);

    if (typeof body.data !== 'string' || !body.data) throw new HttpError(400, 'Falta la imagen.');
    const buf = Buffer.from(body.data.replace(/^data:[^,]*,/, ''), 'base64');
    if (!buf.length) throw new HttpError(400, 'La imagen está vacía.');
    if (buf.length > MAX_BYTES) throw new HttpError(413, 'La imagen pesa demasiado (máx. 2.5 MB tras optimizarla).');
    const type = sniff(buf);
    if (!type) throw new HttpError(415, 'Formato no admitido: usa JPG, PNG o WebP.');

    const media = db.collection(COLLECTIONS.media);
    const now = new Date();
    // limpieza perezosa: subidas que nunca se guardaron en una pieza
    await media.deleteMany({ attached: false, createdAt: { $lt: new Date(now.getTime() - ORPHAN_MS) } });

    const { insertedId } = await media.insertOne({
      data: new Binary(buf),
      type,
      size: buf.length,
      cutout: body.cutout === true,
      attached: false,
      uploadedBy: user._id,
      createdAt: now,
    });
    const id = insertedId.toHexString();
    res.status(201).json({ id, url: mediaUrl(id), cutout: body.cutout === true, size: buf.length });
  },

  async DELETE(req, res) {
    res.setHeader('Cache-Control', CACHE.none);
    assertSameOrigin(req);
    const db = await getDb();
    await requireAdmin(db, req);
    // solo subidas sin guardar: si ya pertenece a una pieza, se borra al guardar la pieza sin ella
    await db.collection(COLLECTIONS.media).deleteOne({ _id: mediaId(req), attached: false });
    res.status(200).json({ ok: true });
  },
});
