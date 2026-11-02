import { readJson, HttpError, queryString } from '../http.js';
import { email, optionalText } from '../validate.js';
import { COLLECTIONS } from '../catalog.js';
import { progressOf, purchaseXpFor, PURCHASE_XP, PURCHASE_XP_CENTS } from '../achievements.js';
import { appUrl, mailEnabled, sendMail, storeThanksEmail } from '../mailer.js';
import { idParam } from './common.js';

/*
 * Compras en la sala física: la curaduría busca la credencial de quien compró por su correo, escribe cuánto pagó
 * y le suma el XP de esa compra (5 XP por cada $1.000, como en la tienda en línea: purchaseXp), con un correo de
 * gracias. Cada compra queda registrada para revisarla o deshacerla si hubo un error.
 * GET    /api/admin/sala?email=   → la credencial (nombre, apodo, nivel y XP), para confirmar a quién se le suma
 * GET    /api/admin/sala          → las últimas compras registradas
 * POST   /api/admin/sala { email, amountCents, note?, key } → suma el XP, guarda la compra y manda el gracias;
 *                                  `key` (una por formulario) evita sumarla dos veces si el botón se pulsa de nuevo
 * DELETE /api/admin/sala?id=      → deshace una compra registrada: resta su XP (sin bajar de 0) y la borra
 */

const MAX_CENTS = 2_000_000_000; // $20.000.000 por compra
const RECENT = 20;
const LEVEL_NAMES = ['Novato', 'Adepto', 'Leyenda', 'Mítico'];
const KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;

const shownName = (u) => u.nickname || u.name;

/** La credencial tal como la ve la curaduría al registrar una compra. */
function toCustomer(u) {
  const { xp, level } = progressOf(u);
  return { name: u.name, nickname: u.nickname ?? null, email: u.email, xp, level, levelName: LEVEL_NAMES[level - 1] };
}

const toSale = (s) => ({
  _id: s._id.toHexString(),
  email: s.email,
  name: s.name,
  amountCents: s.amountCents,
  xp: s.xp,
  note: s.note ?? null,
  byName: s.byName ?? null,
  mailed: Boolean(s.mailed),
  createdAt: s.createdAt.toISOString(),
});

async function findCustomer(db, address) {
  const user = await db.collection(COLLECTIONS.users).findOne({ email: address });
  if (!user) throw new HttpError(404, 'No hay ninguna credencial con ese correo. Pídele que la cree en la tienda (o revisa cómo lo escribió).');
  if (!user.passwordHash) throw new HttpError(409, 'Esa credencial es una invitación que aún no se activa.');
  return user;
}

export default {
  async GET({ req, res, db }) {
    const raw = queryString(req, 'email');
    if (raw) {
      const user = await findCustomer(db, email(raw));
      return res.status(200).json({ customer: toCustomer(user) });
    }
    const sales = await db.collection(COLLECTIONS.storeSales).find({}).sort({ createdAt: -1 }).limit(RECENT).toArray();
    res.status(200).json({ sales: sales.map(toSale), rate: { xp: PURCHASE_XP, cents: PURCHASE_XP_CENTS }, mail: mailEnabled() });
  },

  async POST({ req, res, db, auth }) {
    const body = readJson(req);
    const address = email(body.email);
    const amountCents = body.amountCents;
    if (!Number.isInteger(amountCents) || amountCents < 1 || amountCents > MAX_CENTS) {
      throw new HttpError(400, 'Escribe el valor de la compra (ej. 59.900), hasta $20.000.000.');
    }
    const xp = purchaseXpFor(amountCents);
    if (xp <= 0) throw new HttpError(400, 'La compra tiene que ser de al menos $1.000 para sumar XP.');
    const note = optionalText(body.note, { field: 'nota', max: 120 });
    const key = typeof body.key === 'string' && KEY_RE.test(body.key) ? body.key : null;

    const sales = db.collection(COLLECTIONS.storeSales);
    if (key) {
      const already = await sales.findOne({ key });
      if (already) throw new HttpError(409, 'Esa compra ya quedó registrada.');
    }
    const user = await findCustomer(db, address);
    const before = progressOf(user);
    const now = new Date();
    const sale = {
      key, userId: user._id, email: user.email, name: shownName(user), amountCents, xp, note,
      by: auth.user._id, byName: auth.user.nickname || auth.user.name, mailed: false, createdAt: now,
    };
    const { insertedId } = await sales.insertOne(sale);
    sale._id = insertedId;
    const updated = await db.collection(COLLECTIONS.users).findOneAndUpdate(
      { _id: user._id },
      { $inc: { purchaseXp: xp }, $set: { updatedAt: now } },
      { returnDocument: 'after' },
    );
    if (!updated) {
      await sales.deleteOne({ _id: insertedId });
      throw new HttpError(404, 'Esa credencial ya no existe.');
    }
    const after = progressOf(updated);

    // el gracias: un correo con lo que sumó y su nivel (un fallo aquí no deshace el XP)
    let mailed = false;
    if (mailEnabled()) {
      try {
        await sendMail({
          to: updated.email,
          ...storeThanksEmail({
            name: shownName(updated), amountCents, xp, total: after.xp,
            level: LEVEL_NAMES[after.level - 1], levelUp: after.level > before.level, url: `${appUrl(req)}/cuenta`,
          }),
        });
        mailed = true;
        await sales.updateOne({ _id: insertedId }, { $set: { mailed: true } });
      } catch (err) {
        console.error('[sala] no salió el gracias:', err?.message ?? err);
      }
    }
    sale.mailed = mailed;
    res.status(201).json({ sale: toSale(sale), customer: toCustomer(updated), levelUp: after.level > before.level, mailed });
  },

  async DELETE({ req, res, db }) {
    const _id = idParam(req, 'compra');
    const sale = await db.collection(COLLECTIONS.storeSales).findOneAndDelete({ _id });
    if (!sale) throw new HttpError(404, 'Esa compra ya no está registrada.');
    // resta el XP de esa compra sin dejar el de compras en negativo
    const updated = await db.collection(COLLECTIONS.users).findOneAndUpdate(
      { _id: sale.userId },
      [{ $set: { purchaseXp: { $max: [0, { $subtract: [{ $ifNull: ['$purchaseXp', 0] }, sale.xp] }] }, updatedAt: '$$NOW' } }],
      { returnDocument: 'after' },
    );
    res.status(200).json({ ok: true, customer: updated ? toCustomer(updated) : null });
  },
};
