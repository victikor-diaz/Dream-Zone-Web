import { waitUntil } from '@vercel/functions';
import { route, readJson, HttpError, CACHE, assertSameOrigin, clientIp, queryString } from '../../lib/http.js';
import { getDb } from '../../lib/mongodb.js';
import { text, email, password, nickname, slug, wholeNumber, oneOf } from '../../lib/validate.js';
import { COLLECTIONS, INDEX_SIZE, toPublicUser } from '../../lib/catalog.js';
import {
  hashPassword, verifyPassword, burnPasswordCheck, startSession, endSession,
  currentUser, requireUser, createResetCode, consumeResetCode, consumeResetToken, unlockAchievements, recordSeen,
  startArcade, finishArcade, assertCanDelete, deleteAccount,
} from '../../lib/auth.js';
import { ACHIEVEMENTS, ACHIEVEMENT_IDS, AVATAR_COLORS, AVATAR_COLOR_LEVEL, AVATAR_COLOR_ACHIEVEMENT, ARCADE_GAMES, progressOf } from '../../lib/achievements.js';
import { limit, reset as forgetAttempts } from '../../lib/rate-limit.js';
import { sendMail, resetCodeEmail, passwordCodeEmail, deleteCodeEmail } from '../../lib/mailer.js';
import { consentOf } from '../../lib/privacy.js';

const MIN = 60 * 1000;
const loginKey = (address) => `login:email:${address}`;

/** Envía el código de recuperación (si la cuenta existe). Corre después de responder. */
async function sendResetCode(db, req, address) {
  try {
    const user = await db.collection(COLLECTIONS.users).findOne({ email: address });
    if (!user) return;
    const code = await createResetCode(db, user._id);
    try {
      await sendMail({ to: user.email, ...resetCodeEmail({ name: user.name, code }) });
    } catch (err) {
      if (err.code === 'DZ_MAIL_OFF' && !process.env.VERCEL) {
        console.log(`\n  [correo sin configurar] código de recuperación para ${user.email}: ${code}\n`);
      } else {
        console.error('[auth] no se pudo enviar el correo de recuperación:', err.message);
      }
    }
  } catch (err) {
    console.error('[auth] recuperación falló:', err);
  }
}

const CODE_ERRORS = {
  expired: 'Ese código venció o ya se usó. Pide uno nuevo.',
  burned: 'Demasiados intentos con ese código. Pide uno nuevo.',
};
const codeError = (check) => CODE_ERRORS[check.reason] ?? `Ese código no es. Te ${check.left === 1 ? 'queda 1 intento' : `quedan ${check.left} intentos`}.`;
const DELETE_PHRASE = 'BORRAR';

const POST_ACTIONS = {
  /** { name, email, password, consent } → crea la cuenta y abre sesión. Sin la casilla de la política, nada. */
  async register({ req, res, body, db }) {
    await limit(db, `register:${clientIp(req)}`, { max: 10, windowMs: 60 * MIN });
    const name = text(body.name, { field: 'nombre', min: 2, max: 60 });
    const address = email(body.email);
    const pass = password(body.password);
    const consent = consentOf(body.consent);

    const users = db.collection(COLLECTIONS.users);
    // también cubre invitaciones pendientes: se activan con su enlace o con "recuperar contraseña"
    const taken = 'Ya existe una credencial con ese correo. Entra o recupera tu contraseña.';
    if (await users.findOne({ email: address }, { projection: { _id: 1 } })) throw new HttpError(409, taken);

    const now = new Date();
    const user = {
      email: address, name, role: 'customer', passwordHash: await hashPassword(pass),
      createdAt: now, updatedAt: now, passwordChangedAt: now, lastLoginAt: now,
      achievements: { credencial: now }, // el primer logro: crear la credencial
      consent, // prueba de la autorización: versión de la política y fecha
    };
    try {
      await users.insertOne(user);
    } catch (err) {
      if (err?.code === 11000) throw new HttpError(409, taken);
      throw err;
    }
    await startSession(db, req, res, user);
    res.status(201).json({ user: toPublicUser(user) });
  },

  /** { email, password } → abre sesión. Mismo mensaje si falla el correo o la contraseña. */
  async login({ req, res, body, db }) {
    const address = email(body.email);
    const pass = typeof body.password === 'string' ? body.password : '';
    if (!pass) throw new HttpError(400, 'Escribe tu contraseña.');
    await limit(db, `login:ip:${clientIp(req)}`, { max: 30, windowMs: 15 * MIN });
    await limit(db, loginKey(address), { max: 8, windowMs: 15 * MIN });

    const users = db.collection(COLLECTIONS.users);
    const user = await users.findOne({ email: address });
    // una invitación sin activar no tiene contraseña: se calcula el hash igual para no revelarlo
    const ok = pass.length <= 128 && user?.passwordHash
      ? await verifyPassword(pass, user.passwordHash)
      : (await burnPasswordCheck(pass), false);
    if (!ok) throw new HttpError(401, 'Correo o contraseña incorrectos.');

    await forgetAttempts(db, loginKey(address));
    await users.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
    await startSession(db, req, res, user);
    res.status(200).json({ user: toPublicUser(user) });
  },

  async logout({ req, res, db }) {
    await endSession(db, req, res);
    res.status(200).json({ ok: true });
  },

  /** { email } → manda un código de 6 dígitos al correo. Siempre la misma respuesta, exista o no la cuenta. */
  async forgot({ req, res, body, db }) {
    const address = email(body.email);
    await limit(db, `forgot:ip:${clientIp(req)}`, { max: 10, windowMs: 60 * MIN });
    await limit(db, `forgot:email:${address}`, {
      max: 3, windowMs: 60 * MIN,
      message: 'Ya pediste varios códigos para ese correo. Revisa tu bandeja (y spam) o espera una hora.',
    });
    // en segundo plano: responder igual de rápido haya cuenta o no
    waitUntil(sendResetCode(db, req, address));
    res.status(200).json({ ok: true });
  },

  /**
   * { email, code, password } → con el código del correo, cambia la contraseña, cierra todas las sesiones y
   * abre una nueva. { token, password, name? } hace lo mismo con el enlace de una invitación de la curaduría
   * (con `name`, quien la recibe elige cómo se llama).
   */
  async reset({ req, res, body, db }) {
    await limit(db, `reset:ip:${clientIp(req)}`, { max: 20, windowMs: 60 * MIN });
    const pass = password(body.password); // antes del código: una contraseña corta no gasta un intento
    const name = typeof body.name === 'string' && body.name.trim() ? text(body.name, { field: 'nombre', min: 2, max: 60 }) : null;
    let userId;
    if (body.code !== undefined) {
      const address = email(body.email);
      await limit(db, `reset:email:${address}`, { max: 15, windowMs: 60 * MIN });
      const code = String(body.code ?? '').replace(/\D/g, '');
      if (code.length !== 6) throw new HttpError(400, 'El código tiene 6 dígitos: revísalo en el correo.');
      const found = await db.collection(COLLECTIONS.users).findOne({ email: address }, { projection: { _id: 1 } });
      const check = found ? await consumeResetCode(db, found._id, code) : { ok: false, reason: 'expired' };
      if (!check.ok) throw new HttpError(400, codeError(check));
      userId = found._id;
    } else {
      userId = await consumeResetToken(db, body.token);
      if (!userId) throw new HttpError(400, 'El enlace venció o ya se usó. Pide uno nuevo.');
    }

    const now = new Date();
    const set = { passwordHash: await hashPassword(pass), passwordChangedAt: now, updatedAt: now, lastLoginAt: now };
    if (name) set.name = name;
    const user = await db.collection(COLLECTIONS.users).findOneAndUpdate(
      { _id: userId },
      { $set: set },
      { returnDocument: 'after' },
    );
    if (!user) throw new HttpError(400, 'El enlace venció o ya se usó. Pide uno nuevo.');

    await db.collection(COLLECTIONS.sessions).deleteMany({ userId });
    await db.collection(COLLECTIONS.passwordResets).deleteMany({ userId });
    await forgetAttempts(db, loginKey(user.email));
    await startSession(db, req, res, user);
    res.status(200).json({ user: toPublicUser(user) });
  },

  /**
   * Cambiar la contraseña con sesión; se cierran las demás sesiones y esta sigue abierta.
   * { current, password } → con la contraseña actual.
   * { step: 'code' } → si no recuerdas la actual: manda un código de 6 dígitos al correo de la cuenta.
   * { code, password } → con ese código en lugar de la actual.
   */
  async password({ req, res, body, db }) {
    const { user, sessionId } = await requireUser(db, req);
    if (body.step === 'code') {
      // el mismo cupo que «¿Olvidaste tu contraseña?» para ese correo: nadie le llena el buzón de códigos
      await limit(db, `forgot:email:${user.email}`, {
        max: 3, windowMs: 60 * MIN,
        message: 'Ya pediste varios códigos. Revisa tu bandeja (y spam) o espera una hora.',
      });
      const code = await createResetCode(db, user._id);
      try {
        await sendMail({ to: user.email, ...passwordCodeEmail({ name: user.name, code }) });
      } catch (err) {
        if (err.code === 'DZ_MAIL_OFF' && !process.env.VERCEL) {
          console.log(`\n  [correo sin configurar] código para cambiar la contraseña de ${user.email}: ${code}\n`);
        } else {
          console.error('[auth] no se pudo enviar el código para cambiar la contraseña:', err.message);
          throw new HttpError(503, 'No pudimos enviarte el código. Intenta de nuevo en unos minutos.');
        }
      }
      res.status(200).json({ ok: true, email: user.email });
      return;
    }

    await limit(db, `password:${user._id}`, { max: 8, windowMs: 15 * MIN });
    const withCode = body.code !== undefined;
    let next;
    if (withCode) {
      next = password(body.password); // antes del código: una contraseña corta no gasta un intento
      const code = String(body.code ?? '').replace(/\D/g, '');
      if (code.length !== 6) throw new HttpError(400, 'El código tiene 6 dígitos: revísalo en tu correo.');
      const check = await consumeResetCode(db, user._id, code);
      if (!check.ok) throw new HttpError(400, codeError(check));
    } else {
      const current = typeof body.current === 'string' ? body.current : '';
      if (!(await verifyPassword(current, user.passwordHash))) {
        throw new HttpError(400, 'Tu contraseña actual no coincide.');
      }
      next = password(body.password);
    }
    const now = new Date();
    await db.collection(COLLECTIONS.users).updateOne(
      { _id: user._id },
      { $set: { passwordHash: await hashPassword(next), passwordChangedAt: now, updatedAt: now } },
    );
    await db.collection(COLLECTIONS.sessions).deleteMany({ userId: user._id, _id: { $ne: sessionId } });
    if (withCode) await forgetAttempts(db, loginKey(user.email)); // si alguien probaba contraseñas, se le acaba
    res.status(200).json({ ok: true });
  },

  /**
   * { ids } con sesión → suma logros a la credencial: los que se desbloquean en el navegador
   * y los que se ganaron sin sesión (pasan a la cuenta al entrar o registrarse).
   * Devuelve la credencial (XP y nivel ya recalculados) y cuáles de esos ids son nuevos.
   */
  async achievements({ req, res, body, db }) {
    const { user } = await requireUser(db, req);
    await limit(db, `achievements:${user._id}`, { max: 60, windowMs: 15 * MIN });
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids)] : [];
    if (!ids.length || ids.length > ACHIEVEMENTS.length || !ids.every((id) => ACHIEVEMENT_IDS.has(id))) {
      throw new HttpError(400, 'Logro desconocido.');
    }
    const result = await unlockAchievements(db, user._id, ids);
    if (!result) throw new HttpError(401, 'Inicia sesión para continuar.');
    res.status(200).json({ user: toPublicUser(result.user), unlocked: result.unlocked });
  },

  /**
   * { ids } con sesión → suma piezas al registro de vistas de la credencial (las que se miran en el visor
   * y las vistas sin sesión en este navegador) y otorga Primer vistazo, Curador y Archivo completo.
   * `ids: []` solo vuelve a revisar esos logros. Devuelve la credencial y los logros nuevos.
   */
  async seen({ req, res, body, db }) {
    const { user } = await requireUser(db, req);
    await limit(db, `seen:${user._id}`, { max: 120, windowMs: 15 * MIN });
    if (!Array.isArray(body.ids) || body.ids.length > INDEX_SIZE) throw new HttpError(400, 'Lista de piezas inválida.');
    const ids = [...new Set(body.ids)].map((id) => slug(id, 'pieza'));
    const result = await recordSeen(db, user._id, ids);
    if (!result) throw new HttpError(401, 'Inicia sesión para continuar.');
    res.status(200).json({ user: toPublicUser(result.user), unlocked: result.unlocked });
  },

  /**
   * Arcade con sesión. { step: 'start', game } gasta la moneda del día (una por día, hora de Bogotá; ilimitadas
   * para la curaduría) y abre una partida de breakout, snake o pacman. { step: 'finish', score } la cierra y suma
   * su XP (según el juego, de 1 a 10; nada si era una partida libre). Devuelve la credencial.
   */
  async arcade({ req, res, body, db }) {
    const { user } = await requireUser(db, req);
    await limit(db, `arcade:${user._id}`, { max: user.role === 'admin' ? 120 : 20, windowMs: 15 * MIN });
    if (body.step === 'start') {
      const game = oneOf(body.game ?? 'breakout', Object.keys(ARCADE_GAMES), 'juego');
      const saved = await startArcade(db, user, game);
      if (!saved) throw new HttpError(409, 'Ya usaste la moneda de hoy. Vuelve mañana por otra.');
      return res.status(200).json({ user: toPublicUser(saved) });
    }
    if (body.step === 'finish') {
      const game = user.arcade?.game ?? 'breakout';
      const score = wholeNumber(body.score, { field: 'puntaje', min: 0, max: ARCADE_GAMES[game].max });
      const result = await finishArcade(db, user._id, { game, score, free: Boolean(user.arcade?.free) });
      if (!result) throw new HttpError(409, 'No hay ninguna partida en curso.');
      return res.status(200).json({ user: toPublicUser(result.user), xp: result.xp });
    }
    throw new HttpError(400, 'Paso del arcade desconocido.');
  },

  /**
   * Borrar la credencial, con tres verificaciones (con sesión):
   * { step: 'start', password } → 1) la contraseña; si es la correcta, manda un código de 6 dígitos al correo.
   * { step: 'confirm', code, phrase, unsubscribe? } → 2) ese código y 3) escribir BORRAR: la borra y cierra la sesión.
   */
  async delete({ req, res, body, db }) {
    const { user } = await requireUser(db, req);
    await limit(db, `delete:${user._id}`, { max: 12, windowMs: 60 * MIN });
    if (body.step === 'start') {
      const pass = typeof body.password === 'string' ? body.password : '';
      if (!pass) throw new HttpError(400, 'Escribe tu contraseña.');
      if (!(await verifyPassword(pass, user.passwordHash))) throw new HttpError(400, 'Esa no es tu contraseña.');
      await assertCanDelete(db, user);
      const code = await createResetCode(db, user._id, 'delete');
      try {
        await sendMail({ to: user.email, ...deleteCodeEmail({ name: user.name, code }) });
      } catch (err) {
        if (err.code === 'DZ_MAIL_OFF' && !process.env.VERCEL) {
          console.log(`\n  [correo sin configurar] código para borrar la credencial de ${user.email}: ${code}\n`);
        } else {
          console.error('[auth] no se pudo enviar el código para borrar la credencial:', err.message);
          throw new HttpError(503, 'No pudimos enviarte el código. Intenta de nuevo en unos minutos.');
        }
      }
      res.status(200).json({ ok: true, email: user.email });
      return;
    }
    if (body.step !== 'confirm') throw new HttpError(400, 'Paso desconocido.');
    // la palabra antes que el código: escribirla mal no gasta un intento del código
    const code = String(body.code ?? '').replace(/\D/g, '');
    if (code.length !== 6) throw new HttpError(400, 'El código tiene 6 dígitos: revísalo en tu correo.');
    if (String(body.phrase ?? '').trim().toUpperCase() !== DELETE_PHRASE) {
      throw new HttpError(400, `Escribe ${DELETE_PHRASE} para confirmar que quieres borrar tu credencial.`);
    }
    const check = await consumeResetCode(db, user._id, code, 'delete');
    if (!check.ok) throw new HttpError(400, codeError(check));
    await deleteAccount(db, user, { unsubscribe: body.unsubscribe === true });
    await endSession(db, req, res);
    res.status(200).json({ ok: true });
  },

  /** { name, nickname?, avatarColor? } con sesión → edita la credencial: nombre, apodo y color del cuadro. */
  async profile({ req, res, body, db }) {
    const { user } = await requireUser(db, req);
    await limit(db, `profile:${user._id}`, { max: 30, windowMs: 15 * MIN });
    const name = text(body.name, { field: 'nombre', min: 2, max: 60 });
    const nick = nickname(body.nickname);
    const color = body.avatarColor ?? 'nivel';
    if (!AVATAR_COLORS.includes(color)) throw new HttpError(400, 'Ese color no está disponible.');
    const needs = AVATAR_COLOR_LEVEL[color] ?? 1;
    if (progressOf(user).level < needs) throw new HttpError(403, 'Ese color se desbloquea en un nivel más alto.');
    const logro = AVATAR_COLOR_ACHIEVEMENT[color];
    if (logro && !user.achievements?.[logro]) throw new HttpError(403, 'Ese cuadro se desbloquea con un logro secreto.');

    // apodo vacío y color del nivel son lo de siempre: no se guardan
    const update = { $set: { name, updatedAt: new Date() }, $unset: {} };
    if (nick) update.$set.nickname = nick; else update.$unset.nickname = '';
    if (color !== 'nivel') update.$set.avatarColor = color; else update.$unset.avatarColor = '';
    if (!Object.keys(update.$unset).length) delete update.$unset;
    const saved = await db.collection(COLLECTIONS.users).findOneAndUpdate({ _id: user._id }, update, { returnDocument: 'after' });
    if (!saved) throw new HttpError(401, 'Inicia sesión para continuar.');
    res.status(200).json({ user: toPublicUser(saved) });
  },
};

/**
 * GET  /api/auth/me        → { user | null }
 * POST /api/auth/register  · login · logout · forgot · reset · password · achievements · seen · profile · arcade · delete
 */
export default route({
  async GET(req, res) {
    res.setHeader('Cache-Control', CACHE.none);
    if (queryString(req, 'action') !== 'me') throw new HttpError(404, 'Acción desconocida.');
    const db = await getDb();
    const auth = await currentUser(db, req);
    res.status(200).json({ user: auth ? toPublicUser(auth.user) : null });
  },

  async POST(req, res) {
    res.setHeader('Cache-Control', CACHE.none);
    const name = queryString(req, 'action');
    if (!name || !Object.hasOwn(POST_ACTIONS, name)) throw new HttpError(404, 'Acción desconocida.');
    const action = POST_ACTIONS[name];
    assertSameOrigin(req);
    const body = readJson(req);
    const db = await getDb();
    await action({ req, res, body, db });
  },
});
