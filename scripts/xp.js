/*
 * XP extra de una credencial: compras hechas en la tienda física, premios o pruebas.
 *   npm run xp -- correo@ejemplo.com          → muestra XP, nivel y logros de esa cuenta
 *   npm run xp -- correo@ejemplo.com 5000     → fija su XP extra en 5000 (se suma al de los logros)
 *   npm run xp -- correo@ejemplo.com 0        → le quita el XP extra
 * Nivel = XP de los logros (todos suman 500) + XP extra + arcade + compras · Adepto 500 · Leyenda 2,000 · Mítico 5,000.
 */
import { getDb, closeDb } from '../lib/mongodb.js';
import { COLLECTIONS } from '../lib/catalog.js';
import { email as emailField } from '../lib/validate.js';
import { ACHIEVEMENTS, LEVEL_XP, MAX_EXTRA_XP, progressOf } from '../lib/achievements.js';

const NAMES = ['Novato', 'Adepto', 'Leyenda', 'Mítico'];
const [raw, amountRaw] = process.argv.slice(2);

async function main() {
  let email;
  try {
    email = emailField(raw ?? '');
  } catch {
    console.error('> uso: npm run xp -- correo@ejemplo.com [xp extra]');
    process.exitCode = 1;
    return;
  }
  const amount = amountRaw === undefined ? null : Number(amountRaw);
  if (amount !== null && (!Number.isInteger(amount) || amount < 0 || amount > MAX_EXTRA_XP)) {
    console.error(`> el XP extra debe ser un entero entre 0 y ${MAX_EXTRA_XP.toLocaleString('en-US')}`);
    process.exitCode = 1;
    return;
  }

  const db = await getDb();
  const users = db.collection(COLLECTIONS.users);
  let user = await users.findOne({ email });
  if (!user) {
    console.error(`> no hay ninguna cuenta con ${email}`);
    process.exitCode = 1;
    return;
  }
  if (amount !== null) {
    const update = amount ? { $set: { extraXp: amount } } : { $unset: { extraXp: '' } };
    user = await users.findOneAndUpdate({ _id: user._id }, update, { returnDocument: 'after' });
  }

  const { xp, level, achievements, arcadeXp } = progressOf(user);
  const next = LEVEL_XP[level];
  console.log(`> ${user.name} <${email}>`);
  console.log(`  Lv ${String(level).padStart(2, '0')} · ${NAMES[level - 1]} · ${xp.toLocaleString('en-US')} XP${next ? ` (siguiente nivel a ${next.toLocaleString('en-US')} XP)` : ' · nivel máximo'}`);
  console.log(`  logros ${Object.keys(achievements).length}/${ACHIEVEMENTS.length} · XP extra ${(user.extraXp ?? 0).toLocaleString('en-US')} · arcade ${arcadeXp.toLocaleString('en-US')}`);
}

main()
  .catch((err) => {
    console.error('> falló:', err.message);
    process.exitCode = 1;
  })
  .finally(closeDb);
