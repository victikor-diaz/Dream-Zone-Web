import { randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError, appendCookie, isHttps } from './http.js';
import { COLLECTIONS, INDEX_SIZE } from './catalog.js';
import { seenAchievements, arcadeDay, arcadeXpFor } from './achievements.js';

/*
 * Cuentas sin dependencias: contraseñas con scrypt (node:crypto) y sesiones opacas.
 * El navegador guarda un token aleatorio en una cookie HttpOnly; Mongo guarda solo su
 * SHA-256, así que una copia de la base de datos no sirve para suplantar a nadie.
 */

const scrypt = promisify(scryptCb);
const KEYLEN = 64;
const COST = { N: 32768, r: 8, p: 1 };
const MAXMEM = 64 * 1024 * 1024; // N=2^15 necesita ~32 MB; el límite por defecto se queda corto

const SESSION_COOKIE = 'dz_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const RESET_MS = 60 * 60 * 1000;
const CODE_MS = 15 * 60 * 1000; // el código de recuperación vence en 15 min
export const CODE_TRIES = 5; // intentos por código: con 6 dígitos, adivinarlo es imposible en la práctica
/** Las invitaciones a la curaduría duran más: quien la recibe quizá no la abre el mismo día. */
export const INVITE_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes en base64url

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

/* ---------- Contraseñas ---------- */

/** Formato autodescriptivo para poder subir el costo más adelante sin romper hashes viejos. */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { ...COST, maxmem: MAXMEM });
  return `scrypt$${COST.N}$${COST.r}$${COST.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt' || typeof password !== 'string') return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: MAXMEM,
  });
  return timingSafeEqual(key, expected);
}

/** Si el correo no existe se calcula un hash igual: el tiempo de respuesta no revela qué cuentas hay. */
let dummyHash = null;
export async function burnPasswordCheck(password) {
  dummyHash ??= await hashPassword(randomBytes(12).toString('hex'));
  await verifyPassword(String(password), dummyHash);
}

/* ---------- Sesiones ---------- */

const cookie = (req, value, maxAge) =>
  `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`;

function readToken(req) {
  const value = req.cookies?.[SESSION_COOKIE];
  return typeof value === 'string' && TOKEN_RE.test(value) ? value : null;
}

export async function startSession(db, req, res, user) {
  const token = newToken();
  const now = new Date();
  await db.collection(COLLECTIONS.sessions).insertOne({
    _id: sha256(token),
    userId: user._id,
    createdAt: now,
    expiresAt: new Date(now.getTime() + SESSION_MS),
    userAgent: String(req.headers['user-agent'] ?? '').slice(0, 200),
  });
  appendCookie(res, cookie(req, token, SESSION_MS / 1000));
}

export async function endSession(db, req, res) {
  const token = readToken(req);
  if (token) await db.collection(COLLECTIONS.sessions).deleteOne({ _id: sha256(token) });
  appendCookie(res, cookie(req, '', 0));
}

/** `{ user, sessionId }` de la cookie actual, o null. */
export async function currentUser(db, req) {
  const token = readToken(req);
  if (!token) return null;
  const session = await db
    .collection(COLLECTIONS.sessions)
    .findOne({ _id: sha256(token), expiresAt: { $gt: new Date() } });
  if (!session) return null;
  const user = await db.collection(COLLECTIONS.users).findOne({ _id: session.userId });
  return user ? { user, sessionId: session._id } : null;
}

export async function requireUser(db, req) {
  const auth = await currentUser(db, req);
  if (!auth) throw new HttpError(401, 'Inicia sesión para continuar.');
  return auth;
}

export async function requireAdmin(db, req) {
  const auth = await requireUser(db, req);
  if (auth.user.role !== 'admin') throw new HttpError(403, 'Solo la curaduría puede hacer esto.');
  return auth;
}

/* ---------- Logros ---------- */

/**
 * Suma logros (ids ya validados) a la credencial. $min conserva la fecha del primer desbloqueo,
 * así repetir uno no cambia nada, y el documento de antes dice cuáles son nuevos de verdad
 * (dos pestañas que reclaman el mismo logro no lo cuentan dos veces).
 * Devuelve { user, unlocked } con la cuenta ya actualizada, o null si la cuenta no existe.
 */
export async function unlockAchievements(db, userId, ids) {
  const now = new Date();
  const before = await db.collection(COLLECTIONS.users).findOneAndUpdate(
    { _id: userId },
    { $min: Object.fromEntries(ids.map((id) => [`achievements.${id}`, now])) },
    { returnDocument: 'before' },
  );
  if (!before) return null;
  const unlocked = ids.filter((id) => !(before.achievements?.[id] instanceof Date));
  const achievements = { ...before.achievements, ...Object.fromEntries(unlocked.map((id) => [id, now])) };
  return { user: { ...before, achievements }, unlocked };
}

/**
 * Suma piezas (slugs ya validados; las que no existen se ignoran) al registro de vistas de la credencial
 * y otorga los logros que dependen de él con las reglas del índice de la tienda: las INDEX_SIZE piezas
 * activas más nuevas, igual que /api/catalog. Con `ids` vacío solo vuelve a revisar los logros.
 * Devuelve { user, unlocked } o null si la cuenta no existe.
 */
export async function recordSeen(db, userId, ids) {
  const products = db.collection(COLLECTIONS.products);
  const users = db.collection(COLLECTIONS.users);
  const real = ids.length
    ? (await products.find({ slug: { $in: ids } }, { projection: { slug: 1 } }).toArray()).map((p) => p.slug)
    : [];
  const user = real.length
    ? await users.findOneAndUpdate({ _id: userId }, { $addToSet: { seen: { $each: real } } }, { returnDocument: 'after' })
    : await users.findOne({ _id: userId });
  if (!user) return null;

  const index = await products
    .find({ status: 'active' }, { projection: { slug: 1 } })
    .sort({ createdAt: -1 })
    .limit(INDEX_SIZE)
    .toArray();
  const seen = new Set(user.seen ?? []);
  const count = index.filter((p) => seen.has(p.slug)).length;
  const earned = seenAchievements(count, index.length).filter((id) => !(user.achievements?.[id] instanceof Date));
  if (!earned.length) return { user, unlocked: [] };
  return unlockAchievements(db, userId, earned);
}

/* ---------- Arcade: una moneda al día ---------- */

/**
 * Gasta la moneda de hoy (hora de Bogotá) y abre una partida del juego elegido. Solo si hoy aún no se usó,
 * así dos pestañas no la gastan dos veces. La curaduría tiene monedas ilimitadas: después de la del día
 * abre partidas libres (`free`, sin XP). Devuelve la cuenta actualizada o null si la moneda ya se usó.
 */
export async function startArcade(db, user, game) {
  const users = db.collection(COLLECTIONS.users);
  const day = arcadeDay();
  const now = new Date();
  const coin = await users.findOneAndUpdate(
    { _id: user._id, 'arcade.day': { $ne: day } },
    { $set: { arcade: { day, game, state: 'playing', free: false, startedAt: now } } },
    { returnDocument: 'after' },
  );
  if (coin || user.role !== 'admin') return coin;
  return users.findOneAndUpdate(
    { _id: user._id },
    { $set: { 'arcade.game': game, 'arcade.state': 'playing', 'arcade.free': true, 'arcade.startedAt': now } },
    { returnDocument: 'after' },
  );
}

/**
 * Cierra la partida en curso y suma su XP una sola vez (una partida libre no suma).
 * Devuelve { user, xp } o null si no había partida de ese juego.
 */
export async function finishArcade(db, userId, { game, score, free }) {
  const xp = free ? 0 : arcadeXpFor(game, score);
  const user = await db.collection(COLLECTIONS.users).findOneAndUpdate(
    { _id: userId, 'arcade.state': 'playing', 'arcade.game': game },
    { $set: { 'arcade.state': 'done', 'arcade.score': score, 'arcade.xp': xp, 'arcade.endedAt': new Date() }, $inc: { arcadeXp: xp } },
    { returnDocument: 'after' },
  );
  return user ? { user, xp } : null;
}

/* ---------- Recuperación de contraseña ---------- */

/** Crea un enlace de un solo uso (1 h por defecto); invalida los anteriores de esa cuenta. */
export async function createResetToken(db, userId, { ttlMs = RESET_MS } = {}) {
  const token = newToken();
  const now = new Date();
  const resets = db.collection(COLLECTIONS.passwordResets);
  await resets.deleteMany({ userId });
  await resets.insertOne({ _id: sha256(token), userId, createdAt: now, expiresAt: new Date(now.getTime() + ttlMs) });
  return token;
}

/**
 * Código de 6 dígitos para recuperar la contraseña (15 min, 5 intentos). Reemplaza al anterior de esa cuenta;
 * en la base solo queda su huella, ligada a la cuenta.
 */
export async function createResetCode(db, userId, kind = 'code') {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const now = new Date();
  const resets = db.collection(COLLECTIONS.passwordResets);
  await resets.deleteMany({ userId, kind });
  await resets.insertOne({
    _id: sha256(newToken()), kind, userId, codeHash: sha256(`${userId}:${code}`), tries: 0,
    createdAt: now, expiresAt: new Date(now.getTime() + CODE_MS),
  });
  return code;
}

/**
 * Comprueba el código y, si es el correcto, lo consume (atómico). Cada error gasta un intento; al quinto el
 * código deja de servir. Devuelve { ok } o { ok: false, reason: 'expired' | 'wrong' | 'burned', left }.
 * `kind`: 'code' recupera la contraseña; 'delete' confirma que se borra la credencial.
 */
export async function consumeResetCode(db, userId, code, kind = 'code') {
  const resets = db.collection(COLLECTIONS.passwordResets);
  const doc = await resets.findOne({ userId, kind, expiresAt: { $gt: new Date() } });
  if (!doc) return { ok: false, reason: 'expired' };
  const given = Buffer.from(sha256(`${userId}:${code}`));
  const want = Buffer.from(doc.codeHash);
  if (given.length === want.length && timingSafeEqual(given, want)) {
    return (await resets.findOneAndDelete({ _id: doc._id })) ? { ok: true } : { ok: false, reason: 'expired' };
  }
  const after = await resets.findOneAndUpdate({ _id: doc._id }, { $inc: { tries: 1 } }, { returnDocument: 'after' });
  const left = CODE_TRIES - (after?.tries ?? CODE_TRIES);
  if (left > 0) return { ok: false, reason: 'wrong', left };
  await resets.deleteOne({ _id: doc._id });
  return { ok: false, reason: 'burned', left: 0 };
}

/** La última cuenta activa de la curaduría no se borra: la tienda se quedaría sin quien la administre. */
export async function assertCanDelete(db, user) {
  if (user.role !== 'admin') return;
  const others = await db.collection(COLLECTIONS.users)
    .countDocuments({ role: 'admin', _id: { $ne: user._id }, passwordHash: { $exists: true } });
  if (!others) {
    throw new HttpError(409, 'Eres la única cuenta activa de la curaduría: invita a otra persona (Curaduría › Equipo) antes de borrar la tuya.');
  }
}

/**
 * Borra una credencial: la cuenta (con sus logros, XP y nivel), sus sesiones y sus códigos. Los pedidos se quedan,
 * porque las normas contables piden guardarlos, pero sin el enlace a la cuenta. Con `unsubscribe` también sale de
 * la lista de avisos de drops.
 */
export async function deleteAccount(db, user, { unsubscribe = false } = {}) {
  await assertCanDelete(db, user);
  await db.collection(COLLECTIONS.orders).updateMany({ userId: user._id }, { $set: { userId: null, accountDeletedAt: new Date() } });
  await db.collection(COLLECTIONS.sessions).deleteMany({ userId: user._id });
  await db.collection(COLLECTIONS.passwordResets).deleteMany({ userId: user._id });
  if (unsubscribe) await db.collection(COLLECTIONS.subscribers).deleteMany({ email: user.email });
  await db.collection(COLLECTIONS.storeSales).deleteMany({ userId: user._id }); // el XP de compras en la sala va con la credencial
  await db.collection(COLLECTIONS.users).deleteOne({ _id: user._id });
}

/** Consume el token (atómico: dos clics en el mismo enlace no sirven dos veces). Devuelve el userId o null. */
export async function consumeResetToken(db, token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const doc = await db
    .collection(COLLECTIONS.passwordResets)
    .findOneAndDelete({ _id: sha256(token), expiresAt: { $gt: new Date() } });
  return doc?.userId ?? null;
}
