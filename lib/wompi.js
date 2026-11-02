import { createHash, timingSafeEqual } from 'node:crypto';

/*
 * Wompi (Bancolombia): cobros con la página de pago de Wompi (Web Checkout). Los datos de la tarjeta
 * nunca pasan por este servidor. Llaves en variables de entorno (ver README):
 *   WOMPI_PUBLIC_KEY        pub_test_… (sandbox) o pub_prod_… (cobra de verdad)
 *   WOMPI_PRIVATE_KEY       prv_…  · consultar transacciones por referencia
 *   WOMPI_INTEGRITY_SECRET  …_integrity_… · firma cada cobro (nadie puede cambiar el monto)
 *   WOMPI_EVENTS_SECRET     …_events_…    · comprueba que los avisos vienen de Wompi
 */

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const TIMEOUT_MS = 8000;

/** La configuración de Wompi, o null si faltan la llave pública o el secreto de integridad. */
export function wompiConfig() {
  const publicKey = process.env.WOMPI_PUBLIC_KEY ?? '';
  const integrity = process.env.WOMPI_INTEGRITY_SECRET ?? '';
  if (!/^pub_(test|prod)_\w+$/.test(publicKey) || !integrity) return null;
  const sandbox = publicKey.startsWith('pub_test_');
  return {
    publicKey,
    integrity,
    privateKey: process.env.WOMPI_PRIVATE_KEY || null,
    events: process.env.WOMPI_EVENTS_SECRET || null,
    sandbox,
    api: sandbox ? 'https://sandbox.wompi.co/v1' : 'https://production.wompi.co/v1',
  };
}

/** Firma de integridad: SHA-256 de referencia + monto en centavos + moneda + secreto. */
export const integritySignature = (cfg, reference, amountInCents, currency = 'COP') => (
  sha256(`${reference}${amountInCents}${currency}${cfg.integrity}`)
);

/** Enlace a la página de pago de Wompi con el pedido firmado y los datos del comprador ya llenos. */
export function checkoutUrl(cfg, { reference, amountInCents, redirectUrl, customer, delivery }) {
  const params = new URLSearchParams({
    'public-key': cfg.publicKey,
    currency: 'COP',
    'amount-in-cents': String(amountInCents),
    reference,
    'signature:integrity': integritySignature(cfg, reference, amountInCents),
    'customer-data:email': customer.email,
    'customer-data:full-name': customer.name,
    'customer-data:phone-number': customer.phone,
    'customer-data:phone-number-prefix': '+57',
    'customer-data:legal-id': customer.idNumber,
    'customer-data:legal-id-type': customer.idType,
  });
  // Wompi rechaza volver a una dirección sin HTTPS (p. ej. http://localhost): en local el comprador
  // se queda en la página de resultado de Wompi; en Vercel siempre vuelve a pago.html.
  if (/^https:\/\//.test(redirectUrl)) params.set('redirect-url', redirectUrl);
  if (delivery.method === 'envio') {
    params.set('shipping-address:address-line-1', delivery.address);
    if (delivery.details) params.set('shipping-address:address-line-2', delivery.details);
    params.set('shipping-address:country', 'CO');
    params.set('shipping-address:region', delivery.region);
    params.set('shipping-address:city', delivery.city);
    params.set('shipping-address:phone-number', customer.phone);
  }
  return `https://checkout.wompi.co/p/?${params}`;
}

async function call(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Wompi respondió ${res.status}`);
  return (await res.json()).data ?? null;
}

/** Una transacción por su id (el que Wompi agrega al volver de la página de pago). No necesita llave. */
export const getTransaction = (cfg, id) => call(`${cfg.api}/transactions/${encodeURIComponent(id)}`);

/** Las transacciones de una referencia (con la llave privada), la más reciente primero. */
export async function transactionsFor(cfg, reference) {
  if (!cfg.privateKey) return [];
  const list = await call(`${cfg.api}/transactions?reference=${encodeURIComponent(reference)}`, { Authorization: `Bearer ${cfg.privateKey}` });
  return (Array.isArray(list) ? list : []).sort((a, b) => Date.parse(b.created_at ?? 0) - Date.parse(a.created_at ?? 0));
}

/**
 * Una transacción por su id y, si Wompi responde 404 por id (pasa en producción con transacciones ya
 * aprobadas), la misma buscada entre las de su referencia. null si de verdad no aparece.
 */
export async function findTransaction(cfg, id, reference) {
  const tx = await getTransaction(cfg, id);
  if (tx || !reference) return tx;
  return (await transactionsFor(cfg, reference)).find((t) => t.id === id) ?? null;
}

/**
 * Aviso de Wompi (evento transaction.updated): la firma es el SHA-256 de los valores que indica
 * signature.properties (leídos dentro de `data`), el timestamp y el secreto de eventos.
 */
export function verifyEvent(cfg, event) {
  const props = event?.signature?.properties;
  const checksum = event?.signature?.checksum;
  if (!cfg?.events || !Array.isArray(props) || typeof checksum !== 'string' || event.timestamp == null) return false;
  const values = props.map((path) => String(path).split('.').reduce((obj, key) => obj?.[key], event.data));
  if (values.some((v) => v === undefined || v === null)) return false;
  const expected = Buffer.from(sha256(`${values.join('')}${event.timestamp}${cfg.events}`));
  const got = Buffer.from(checksum.toLowerCase());
  return got.length === expected.length && timingSafeEqual(got, expected);
}