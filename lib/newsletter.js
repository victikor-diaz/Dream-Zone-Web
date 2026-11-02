import { randomBytes } from 'node:crypto';
import { COLLECTIONS, regularCents } from './catalog.js';
import { mailEnabled, sendMail, dropEmail } from './mailer.js';

/*
 * Aviso de drops a la lista de correo. Cada drop se avisa una sola vez: `drop.announce` guarda el progreso y
 * cada suscriptor, en `notifiedDrops`, los drops que ya recibió. Si la función se corta (límite de tiempo de
 * Vercel) o falla algún envío, «Reanudar» sigue con quienes faltan sin repetirle a nadie.
 * Cada correo lleva su enlace de baja (/api/subscribe?baja=…) y la cabecera List-Unsubscribe.
 */

const BUDGET_MS = 240_000; // se detiene antes del límite de la función; lo que falte se reanuda
const STALE_MS = 2 * 60_000; // un aviso «enviando» sin latido en 2 min se dio por cortado

export const newSubscriberToken = () => randomBytes(18).toString('base64url');

/**
 * ¿Este drop se avisa solo al guardarlo? Con el aviso encendido (`notify`; los drops de antes, sin el campo,
 * cuentan como encendidos), activo, abierto y nunca avisado. Apagado, solo sale con «Avisar ahora».
 */
export const shouldAnnounce = (drop) => drop?.notify !== false && Boolean(drop?.active) && drop.endsAt > new Date() && !drop.announce;

/**
 * Empieza (o reanuda) el aviso de un drop. Devuelve { drop, run }, con `run` la tarea de envío para waitUntil,
 * o { skipped: 'mail' | 'nobody' | 'running' | 'gone' } si no hay correo, nadie a quien avisar o ya va en curso.
 * `base` es la URL pública del sitio (appUrl) para los enlaces.
 */
export async function startAnnounce(db, dropId, base) {
  if (!mailEnabled()) return { skipped: 'mail' };
  const drops = db.collection(COLLECTIONS.drops);
  const current = await drops.findOne({ _id: dropId });
  if (!current) return { skipped: 'gone' };
  const pending = await db.collection(COLLECTIONS.subscribers).countDocuments({ notifiedDrops: { $ne: current.code } });
  if (!pending) return { skipped: 'nobody' };
  const now = new Date();
  const sent = current.announce?.sent ?? 0;
  const drop = await drops.findOneAndUpdate(
    { _id: dropId, $or: [{ 'announce.running': { $ne: true } }, { 'announce.beat': { $lt: new Date(now.getTime() - STALE_MS) } }] },
    { $set: { announce: { startedAt: current.announce?.startedAt ?? now, finishedAt: null, running: true, beat: now, sent, failed: 0, left: pending } } },
    { returnDocument: 'after' },
  );
  if (!drop) return { skipped: 'running' };
  return { drop, run: () => sendAnnounce(db, drop, base) };
}

async function sendAnnounce(db, drop, base) {
  const drops = db.collection(COLLECTIONS.drops);
  const subs = db.collection(COLLECTIONS.subscribers);
  const started = Date.now();
  try {
    const found = await db.collection(COLLECTIONS.products)
      .find({ slug: { $in: drop.items } }, { projection: { slug: 1, name: 1, priceCents: 1, stock: 1 } })
      .toArray();
    const pieces = drop.items.map((s) => found.find((p) => p.slug === s)).filter(Boolean);
    const url = `${base}/#drops`;
    for await (const s of subs.find({ notifiedDrops: { $ne: drop.code } }).sort({ createdAt: 1 })) {
      if (Date.now() - started > BUDGET_MS) break;
      let { token } = s;
      if (!token) {
        token = newSubscriberToken(); // los suscriptores de antes no tenían enlace de baja
        await subs.updateOne({ _id: s._id }, { $set: { token } });
      }
      const unsubscribe = `${base}/api/subscribe?baja=${token}`;
      let ok = true;
      try {
        await sendMail({
          to: s.email,
          ...dropEmail({ drop, pieces, regularCents: regularCents(pieces), url, unsubscribe }),
          list: { unsubscribe: { url: unsubscribe, comment: 'Darte de baja' } },
          headers: { 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        });
        await subs.updateOne({ _id: s._id }, { $addToSet: { notifiedDrops: drop.code } });
      } catch (err) {
        ok = false;
        console.error(`[drops] aviso del ${drop.code} a ${s.email}:`, err.message);
      }
      await drops.updateOne({ _id: drop._id }, { $inc: { [ok ? 'announce.sent' : 'announce.failed']: 1 }, $set: { 'announce.beat': new Date() } });
    }
  } catch (err) {
    console.error(`[drops] aviso del ${drop.code}:`, err);
  } finally {
    const left = await subs.countDocuments({ notifiedDrops: { $ne: drop.code } });
    await drops.updateOne({ _id: drop._id }, { $set: { 'announce.running': false, 'announce.left': left, 'announce.finishedAt': left ? null : new Date() } });
  }
}
