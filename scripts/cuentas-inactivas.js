/*
 * Credenciales inactivas (política de datos, cláusula 4): una cuenta de cliente a la que nadie entra en 2 años se
 * avisa por correo y, si nadie entra en los 30 días siguientes, se borra como si la persona la borrara (sus pedidos
 * se quedan sin el enlace a la cuenta). Las de la curaduría no se tocan.
 *   npm run cuentas:inactivas              → cuántas hay en cada paso (no cambia nada)
 *   npm run cuentas:inactivas -- avisar    → manda el aviso a las que aún no lo tienen
 *   npm run cuentas:inactivas -- borrar    → borra las avisadas hace 30 días o más que siguen sin entrar
 */
import { getDb, closeDb } from '../lib/mongodb.js';
import { COLLECTIONS } from '../lib/catalog.js';
import { deleteAccount } from '../lib/auth.js';
import { mailEnabled, sendMail, appUrl, inactiveNoticeEmail } from '../lib/mailer.js';
import { INACTIVE_NOTICE_DAYS, inactiveSince } from '../lib/privacy.js';

const DAY = 24 * 60 * 60 * 1000;
const step = process.argv[2] ?? '';

async function main() {
  if (!['', 'avisar', 'borrar'].includes(step)) {
    console.error('> uso: npm run cuentas:inactivas [-- avisar | borrar]');
    process.exitCode = 1;
    return;
  }
  const db = await getDb();
  const users = db.collection(COLLECTIONS.users);
  const now = new Date();
  const since = inactiveSince(now);
  // sin entrar desde `since` (la fecha de creación cuenta si nunca volvió a entrar)
  const idle = { role: 'customer', $or: [{ lastLoginAt: { $lt: since } }, { lastLoginAt: null, createdAt: { $lt: since } }] };
  // el aviso vale solo si es posterior a la última entrada: quien entró después de un aviso viejo vuelve a empezar
  const noticed = { $expr: { $gt: ['$inactiveNoticeAt', { $ifNull: ['$lastLoginAt', '$createdAt'] }] } };
  const toWarn = { ...idle, $nor: [noticed] };
  const due = new Date(now.getTime() - INACTIVE_NOTICE_DAYS * DAY);
  // avisada hace 30 días o más y sin entrar desde el aviso
  const toDelete = { ...idle, ...noticed, inactiveNoticeAt: { $lte: due } };

  if (step === 'avisar') {
    if (!mailEnabled()) {
      console.error('> falta configurar el correo (SMTP_*): sin aviso no se puede borrar ninguna credencial');
      process.exitCode = 1;
      return;
    }
    const deadline = new Date(now.getTime() + INACTIVE_NOTICE_DAYS * DAY);
    let sent = 0;
    for (const user of await users.find(toWarn).toArray()) {
      try {
        await sendMail({ to: user.email, ...inactiveNoticeEmail({ name: user.name, url: `${appUrl()}/cuenta#entrar`, deadline }) });
        await users.updateOne({ _id: user._id }, { $set: { inactiveNoticeAt: now } });
        sent += 1;
      } catch (err) {
        console.error(`> no se pudo avisar a ${user.email}: ${err.message}`);
      }
    }
    console.log(`> avisos enviados: ${sent}`);
    return;
  }

  if (step === 'borrar') {
    let gone = 0;
    for (const user of await users.find(toDelete).toArray()) {
      await deleteAccount(db, user);
      gone += 1;
    }
    console.log(`> credenciales borradas: ${gone}`);
    return;
  }

  const [warn, waiting, ready] = await Promise.all([
    users.countDocuments(toWarn),
    users.countDocuments({ ...idle, ...noticed, inactiveNoticeAt: { $gt: due } }),
    users.countDocuments(toDelete),
  ]);
  console.log(`> sin entrar desde ${since.toISOString().slice(0, 10)}: ${warn} por avisar · ${waiting} avisadas (esperando ${INACTIVE_NOTICE_DAYS} días) · ${ready} por borrar`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());