/*
 * Concilia con Wompi los pedidos que siguen «pending»: por si un aviso de Wompi se perdió y quien compró no
 * volvió a pago.html (p. ej. un pedido creado desde localhost, que no regresa de Wompi).
 *   npm run pago:conciliar                          → muestra qué dice Wompi de cada pedido pendiente (no cambia nada)
 *   npm run pago:conciliar -- --aplicar             → aplica lo que dice Wompi (aprobado, rechazado…) y manda los correos
 *   npm run pago:conciliar -- DZ261019-ABC123 [--aplicar] → solo ese pedido
 * Pasa por applyTransaction, igual que el aviso real: aprobar descuenta existencias, saca lo comprado del
 * carrito y suma el XP de la compra.
 */
import { getDb, closeDb } from '../lib/mongodb.js';
import { COLLECTIONS } from '../lib/catalog.js';
import { applyTransaction } from '../lib/orders.js';
import { wompiConfig, transactionsFor } from '../lib/wompi.js';
import { mailPaidOrder } from '../lib/order-mail.js';
import { mailEnabled } from '../lib/mailer.js';

// pedidos reales: los enlaces de los correos van a la tienda publicada (APP_URL o el dominio de Vercel)
const BASE = (process.env.APP_URL || 'https://dreamzonesh.com').replace(/\/+$/, '');
const REF_RE = /^DZ\d{6}-[A-Z2-9]{6}$/;
const args = process.argv.slice(2);
const apply = args.includes('--aplicar');
const only = args.find((a) => REF_RE.test(a.toUpperCase()))?.toUpperCase() ?? null;

const money = (cents) => `$${Math.round(cents / 100).toLocaleString('es-CO')}`;
const when = (d) => d.toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'short', timeStyle: 'short' });

async function main() {
  const cfg = wompiConfig();
  if (!cfg?.privateKey) throw new Error('faltan WOMPI_PUBLIC_KEY, WOMPI_INTEGRITY_SECRET o WOMPI_PRIVATE_KEY en .env');
  const db = await getDb();
  const filter = only ? { reference: only } : { status: 'pending', simulated: { $ne: true } };
  const list = await db.collection(COLLECTIONS.orders).find(filter).sort({ createdAt: -1 }).limit(50).toArray();
  if (!list.length) {
    console.log(only ? `> no hay ningún pedido ${only}` : '> no hay pedidos pendientes.');
    return;
  }
  console.log(`> Wompi ${cfg.sandbox ? 'sandbox' : 'PRODUCCIÓN'} · ${apply ? 'aplicando cambios' : 'solo consulta (agrega --aplicar para guardar)'}`);
  for (const order of list) {
    const [tx] = await transactionsFor(cfg, order.reference); // la más reciente
    const head = `  ${order.reference} · ${money(order.totalCents)} · ${order.customer.email} · ${when(order.createdAt)}`;
    if (!tx) {
      console.log(`${head} · sin transacción en Wompi (no pagó)`);
      continue;
    }
    const info = `${tx.status} ${tx.payment_method_type ?? ''} ${money(tx.amount_in_cents)} (${tx.id})`;
    if (order.status !== 'pending') {
      console.log(`${head} · ya está «${order.status}» · Wompi: ${info}`);
      continue;
    }
    if (!apply) {
      console.log(`${head} · Wompi: ${info}${tx.status === 'APPROVED' ? '  ← PAGADO, sin registrar' : ''}`);
      continue;
    }
    const after = await applyTransaction(db, tx);
    console.log(`${head} · Wompi: ${info} → pedido «${after.status}»`);
    if (after.stockIssues?.length) console.log(`    ¡sin existencias suficientes!: ${after.stockIssues.join(', ')}`);
    if (after.status === 'approved' && mailEnabled()) {
      const mail = await mailPaidOrder(db, after, BASE);
      console.log(`    correos: ${mail.customer ? `confirmación a ${order.customer.email}` : 'sin confirmación'} · aviso a ${mail.staff} curador(es)`);
    }
  }
}

main()
  .catch((err) => {
    console.error('> falló:', err.message);
    process.exitCode = 1;
  })
  .finally(closeDb);
