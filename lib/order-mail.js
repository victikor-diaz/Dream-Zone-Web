import { COLLECTIONS } from './catalog.js';
import { mailEnabled, sendMail, orderPaidEmail, newOrderEmail } from './mailer.js';

/*
 * Correos de un pago aprobado: la confirmación a quien compró y el aviso a la curaduría (todas las cuentas admin
 * con credencial activa). Cada uno sale una sola vez: `mailedAt` y `staffMailedAt` se marcan de forma atómica antes
 * de enviar, así el aviso de Wompi y la consulta del navegador no lo duplican. Un fallo aquí nunca afecta el pago.
 * Los recibos de demostración no mandan nada.
 * `base` es la URL pública del sitio (appUrl). Devuelve { customer: boolean, staff: número de curadores avisados }.
 */
export async function mailPaidOrder(db, order, base) {
  const sent = { customer: false, staff: 0 };
  if (order?.status !== 'approved' || order.demo || !mailEnabled()) return sent;
  const orders = db.collection(COLLECTIONS.orders);
  const claim = (field) => orders.findOneAndUpdate({ _id: order._id, [field]: { $exists: false } }, { $set: { [field]: new Date() } });

  try {
    if (await claim('mailedAt')) {
      await sendMail({ to: order.customer.email, ...orderPaidEmail({ order, url: `${base}/cuenta#pedidos` }) });
      sent.customer = true;
    }
  } catch (err) {
    console.error('[pedidos] correo de confirmación:', err.message);
  }

  try {
    if (await claim('staffMailedAt')) {
      const staff = await db.collection(COLLECTIONS.users)
        .find({ role: 'admin', passwordHash: { $exists: true } }, { projection: { email: 1 } })
        .toArray();
      if (staff.length) {
        await sendMail({ to: staff.map((u) => u.email).join(', '), ...newOrderEmail({ order, url: `${base}/admin#pedidos` }) });
        sent.staff = staff.length;
      }
    }
  } catch (err) {
    console.error('[pedidos] aviso a la curaduría:', err.message);
  }
  return sent;
}
