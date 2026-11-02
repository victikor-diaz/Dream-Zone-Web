import { HttpError } from './http.js';
import { COLLECTIONS } from './catalog.js';
import { createResetToken, INVITE_MS } from './auth.js';

/*
 * Curaduría (admins). Una invitación crea una credencial "pendiente": rol admin, sin
 * contraseña. Solo se activa con el enlace (token de un solo uso, 7 días), así nadie
 * puede adueñarse de ella registrándose con ese correo.
 */

export const inviteLink = (base, token) => `${base}/cuenta?token=${token}#activar`;

/**
 * Da acceso de curaduría a un correo: asciende la cuenta si existe o crea una pendiente.
 * Devuelve { user, created, token }; `token` solo viene si la cuenta aún no tiene contraseña.
 */
export async function grantAdmin(db, { email, name = null, invitedBy = null }) {
  const users = db.collection(COLLECTIONS.users);
  const now = new Date();
  const by = invitedBy ? { invitedBy: invitedBy._id, invitedByName: invitedBy.name } : {};
  let user = await users.findOne({ email });
  let created = false;

  if (!user) {
    user = {
      email,
      name: name ?? email.split('@')[0].slice(0, 60),
      role: 'admin',
      createdAt: now,
      updatedAt: now,
      invitedAt: now,
      ...by,
    };
    try {
      await users.insertOne(user);
      created = true;
    } catch (err) {
      if (err?.code !== 11000) throw err;
      user = await users.findOne({ email }); // la creó otra petición al mismo tiempo
    }
  }

  if (!created) {
    if (user.role === 'admin' && user.passwordHash) throw new HttpError(409, `${email} ya es parte de la curaduría.`);
    const set = { role: 'admin', updatedAt: now, ...by };
    if (!user.passwordHash) {
      set.invitedAt = now;
      if (name) set.name = name;
    }
    user = await users.findOneAndUpdate({ _id: user._id }, { $set: set }, { returnDocument: 'after' });
  }

  const token = user.passwordHash ? null : await createResetToken(db, user._id, { ttlMs: INVITE_MS });
  return { user, created, token };
}

/** Nuevo enlace de activación para una invitación pendiente. */
export async function renewInvite(db, user) {
  if (user.passwordHash) throw new HttpError(409, 'Esta credencial ya está activa: puede entrar con su contraseña.');
  return createResetToken(db, user._id, { ttlMs: INVITE_MS });
}

/** Borra una invitación que nunca se activó (la cuenta no tiene contraseña). */
export async function cancelInvite(db, user) {
  if (user.passwordHash) throw new HttpError(409, 'Esta credencial ya está activa: quítale el acceso en lugar de borrarla.');
  await db.collection(COLLECTIONS.users).deleteOne({ _id: user._id, passwordHash: { $exists: false } });
  await db.collection(COLLECTIONS.passwordResets).deleteMany({ userId: user._id });
  await db.collection(COLLECTIONS.sessions).deleteMany({ userId: user._id });
}