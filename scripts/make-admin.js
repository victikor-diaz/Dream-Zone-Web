/*
 * Da (o quita) acceso a la curaduría desde la terminal.
 *   npm run admin -- correo@ejemplo.com           → si la cuenta existe la asciende; si no, crea una
 *                                                   invitación y muestra el enlace para activarla (7 días)
 *   npm run admin -- correo@ejemplo.com --quitar  → quita el acceso (o cancela la invitación pendiente)
 * Desde el panel (/admin.html#equipo) se hace lo mismo sin terminal.
 * El enlace usa APP_URL (o http://localhost:3000): cámbiale el dominio si lo abres en producción.
 */
import { getDb, closeDb } from '../lib/mongodb.js';
import { COLLECTIONS } from '../lib/catalog.js';
import { email as emailField } from '../lib/validate.js';
import { grantAdmin, cancelInvite, inviteLink } from '../lib/team.js';
import { appUrl } from '../lib/mailer.js';

const args = process.argv.slice(2);
const raw = args.find((a) => !a.startsWith('--'));
const revoke = args.includes('--quitar');

async function main() {
  if (!raw) {
    console.error('> uso: npm run admin -- correo@ejemplo.com [--quitar]');
    process.exitCode = 1;
    return;
  }
  let email;
  try {
    email = emailField(raw);
  } catch (err) {
    console.error(`> ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const db = await getDb();
  const users = db.collection(COLLECTIONS.users);

  if (revoke) {
    const user = await users.findOne({ email });
    if (!user) {
      console.error(`> no hay ninguna cuenta con ${email}`);
      process.exitCode = 1;
    } else if (!user.passwordHash) {
      await cancelInvite(db, user);
      console.log(`> invitación de ${email} cancelada`);
    } else {
      await users.updateOne({ _id: user._id }, { $set: { role: 'customer', updatedAt: new Date() } });
      console.log(`> ${email} ya no tiene acceso a la curaduría`);
    }
    return;
  }

  let result;
  try {
    result = await grantAdmin(db, { email });
  } catch (err) {
    if (err.status !== 409) throw err;
    console.log(`> ${email} ya es admin → /admin`);
    return;
  }
  const { created, token } = result;
  if (!token) {
    console.log(`> ${email} ahora es admin: entra con su contraseña y abre /admin`);
    return;
  }
  console.log(created
    ? `> invitación creada: ${email} es admin y falta que active su credencial`
    : `> ${email} seguía sin activar: este es un enlace nuevo (el anterior ya no sirve)`);
  console.log(`> enlace de activación · un solo uso · vence en 7 días:\n\n  ${inviteLink(appUrl(null), token)}\n`);
}

main()
  .catch((err) => {
    console.error('> falló:', err.message);
    process.exitCode = 1;
  })
  .finally(closeDb);