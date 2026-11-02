import { readJson, HttpError, queryString } from '../http.js';
import { email as emailField, text, oneOf } from '../validate.js';
import { COLLECTIONS, toTeamMember } from '../catalog.js';
import { grantAdmin, renewInvite, cancelInvite, inviteLink } from '../team.js';
import { sendMail, appUrl, inviteEmail } from '../mailer.js';
import { limit } from '../rate-limit.js';
import { idParam } from './common.js';

/*
 * Equipo de la curaduría:
 * GET    /api/admin/team                        → admins (activos y pendientes)
 * POST   /api/admin/team { email, name? }       → da acceso: asciende la cuenta o crea una invitación
 * POST   /api/admin/team?id=&action=link        → enlace nuevo para una invitación pendiente
 * PUT    /api/admin/team?id= { role }           → quita (o devuelve) el acceso
 * DELETE /api/admin/team?id=                    → cancela una invitación que nunca se activó
 * El enlace de activación vuelve en la respuesta para copiarlo; si hay SMTP, también se envía por correo.
 */

async function deliver(req, user, token, inviter) {
  const url = inviteLink(appUrl(req), token);
  let emailed = false;
  try {
    await sendMail({ to: user.email, ...inviteEmail({ name: user.name, url, inviter: inviter.name }) });
    emailed = true;
  } catch (err) {
    if (err.code !== 'DZ_MAIL_OFF') console.error('[equipo] no se pudo enviar la invitación:', err.message);
  }
  return { inviteUrl: url, emailed };
}

async function findUser(db, req) {
  const user = await db.collection(COLLECTIONS.users).findOne({ _id: idParam(req, 'cuenta') });
  if (!user) throw new HttpError(404, 'Esa cuenta ya no existe.');
  return user;
}

const SELF = 'No puedes quitarte el acceso a ti mismo: pídeselo a otra persona de la curaduría.';

export default {
  async GET({ res, db, auth }) {
    const users = db.collection(COLLECTIONS.users);
    const [members, customers] = await Promise.all([
      users.find({ role: 'admin' }).sort({ createdAt: 1 }).limit(200).toArray(),
      users.countDocuments({ role: { $ne: 'admin' } }),
    ]);
    res.status(200).json({ members: members.map(toTeamMember), me: auth.user._id.toHexString(), customers });
  },

  async POST({ req, res, db, auth }) {
    await limit(db, `invite:${auth.user._id}`, {
      max: 30, windowMs: 60 * 60 * 1000, message: 'Demasiadas invitaciones seguidas. Espera un poco y vuelve a intentar.',
    });
    if (queryString(req, 'action') === 'link') {
      const user = await findUser(db, req);
      const token = await renewInvite(db, user);
      return res.status(200).json({ member: toTeamMember(user), ...(await deliver(req, user, token, auth.user)) });
    }

    const body = readJson(req);
    const address = emailField(body.email);
    const name = typeof body.name === 'string' && body.name.trim() ? text(body.name, { field: 'nombre', min: 2, max: 60 }) : null;
    const { user, created, token } = await grantAdmin(db, { email: address, name, invitedBy: auth.user });
    const delivery = token ? await deliver(req, user, token, auth.user) : { inviteUrl: null, emailed: false };
    res.status(created ? 201 : 200).json({ member: toTeamMember(user), created, ...delivery });
  },

  async PUT({ req, res, db, auth }) {
    const user = await findUser(db, req);
    const role = oneOf(readJson(req).role, ['admin', 'customer'], 'rol');
    if (role === 'customer' && user._id.equals(auth.user._id)) throw new HttpError(400, SELF);
    if (role === 'customer' && !user.passwordHash) {
      throw new HttpError(400, 'Esta invitación aún no se activa: cancélala en lugar de quitarle el acceso.');
    }
    const updated = await db.collection(COLLECTIONS.users).findOneAndUpdate(
      { _id: user._id },
      { $set: { role, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    res.status(200).json({ member: toTeamMember(updated) });
  },

  async DELETE({ req, res, db, auth }) {
    const user = await findUser(db, req);
    if (user._id.equals(auth.user._id)) throw new HttpError(400, SELF);
    await cancelInvite(db, user);
    res.status(200).json({ ok: true });
  },
};