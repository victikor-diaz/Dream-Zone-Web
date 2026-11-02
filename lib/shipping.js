import { COLLECTIONS } from './catalog.js';
import { MUNICIPIOS } from './municipios.js';
import { distance } from './search.js';

/*
 * Envíos: el municipio de destino y la cotización con Envia.com (https://docs.envia.com). Solo cotiza: nunca genera
 * guías (eso sí tiene costo).
 * - El municipio sale de la lista oficial del DANE (lib/municipios.js): se acepta el nombre oficial o su forma corta
 *   («Cali», «Cúcuta», «Cartagena»), sin importar tildes ni mayúsculas. Si no está, se sugieren los más parecidos
 *   y el pago no sigue hasta elegir uno.
 * - Una consulta por transportadora, en paralelo, con tope de tiempo. La que no cubre el destino no aparece.
 * - El destino va como código DANE del municipio seguido de «000». El código postal no cambia el precio en Colombia.
 * - El precio depende del peso de las piezas (el empaque pesa poco y no se cuenta) y del tamaño de la caja, porque
 *   cobran por volumen: la caja se elige según el peso.
 * - Las cotizaciones se guardan 6 h en `shipping_cache` (TTL).
 * Sin ENVIA_API_KEY (pruebas locales) se cobran las tarifas fijas de la curaduría.
 */

const API = 'https://api.envia.com';
const TIMEOUT_MS = 7000;
const RATE_TTL_MS = 6 * 3600e3;
const RATE_RETRY_MS = 10 * 60e3; // si alguna transportadora falló de paso, se vuelve a intentar pronto

/**
 * Las que se cotizan: `envia` es su código en la API, `id` el de CARRIERS en lib/orders.js (para la guía).
 * La tienda despacha todo con Interrapidísimo; para comparar con otras basta sumarlas aquí
 * (coordinadora, serviEntrega, mensajerosUrbanos… y el pago las muestra para elegir).
 */
export const SHIPPING_CARRIERS = [
  { envia: 'interRapidisimo', id: 'interrapidisimo', name: 'Interrapidísimo' },
];

/** Departamentos (como en DEPARTMENTS de lib/orders.js) → su código en Envia. */
const STATE_CODES = {
  Amazonas: 'AM', Antioquia: 'AN', Arauca: 'AR', 'Atlántico': 'AT', 'Bogotá D.C.': 'DC', 'Bolívar': 'BL', 'Boyacá': 'BY',
  Caldas: 'CL', 'Caquetá': 'CA', Casanare: 'CS', Cauca: 'CU', Cesar: 'CE', 'Chocó': 'CH', 'Córdoba': 'CO', Cundinamarca: 'CN',
  'Guainía': 'GU', Guaviare: 'GA', Huila: 'HU', 'La Guajira': 'LG', Magdalena: 'MA', Meta: 'ME', 'Nariño': 'NA',
  'Norte de Santander': 'NS', Putumayo: 'PU', 'Quindío': 'QU', Risaralda: 'RI', 'San Andrés y Providencia': 'SA',
  Santander: 'SN', Sucre: 'SU', Tolima: 'TO', 'Valle del Cauca': 'VC', 'Vaupés': 'VA', Vichada: 'VI',
};

/** La tienda (Cra. 7 #23-65, Bogotá). El teléfono y el código postal solo los pide el formulario: no cambian el precio. */
const ORIGIN = { name: 'Dream Zone', phone: '3000000000', street: 'Cra. 7 #23-65', city: '11001000', state: 'DC', country: 'CO', postalCode: '110311' };

/** Cajas según el peso total: las transportadoras cobran por volumen, así que una caja de más encarece el envío. */
const BOXES = [
  { upToKg: 1, dims: { length: 20, width: 15, height: 10 } },
  { upToKg: 3, dims: { length: 30, width: 20, height: 15 } },
  { upToKg: 8, dims: { length: 40, width: 30, height: 20 } },
  { upToKg: Infinity, dims: { length: 50, width: 40, height: 30 } },
];

export const enviaEnabled = () => Boolean(process.env.ENVIA_API_KEY);

const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/\b(d\.?\s?c\.?|municipio de|ciudad de)\b/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/* ---------- Municipios ---------- */

// nombres oficiales largos que la gente escribe cortos: «Santiago de Cali» → «cali», «San José de Cúcuta» → «cucuta»
const LONG_PREFIX = /^(?:santiago|san jose|san andres|santa cruz|guadalajara|san sebastian|villa de san diego|san juan) del? (.+)$/;
const EXTRA_ALIASES = { 13001: ['cartagena'], 13468: ['mompos'], 52001: ['san juan de pasto'], '05042': ['santafe de antioquia'] };

/** Por departamento: nombre (o forma corta) → [código, nombre oficial]; una forma corta que se repite no vale. */
const indexes = new Map();
function indexOf(region) {
  if (indexes.has(region)) return indexes.get(region);
  const exact = new Map();
  const alias = new Map();
  for (const entry of MUNICIPIOS[region] ?? []) {
    const [code, name] = entry;
    const full = fold(name);
    exact.set(full, entry);
    const short = [
      LONG_PREFIX.exec(full)?.[1],
      ...name.split(/\s+-\s+/).map(fold), // «Piendamó - Tunía»
      ...(EXTRA_ALIASES[code] ?? []),
    ].filter((k) => k && k !== full);
    for (const k of short) alias.set(k, alias.has(k) && alias.get(k) !== entry ? null : entry);
  }
  for (const [k, entry] of alias) if (entry && !exact.has(k)) exact.set(k, entry);
  const index = { exact, keys: [...exact] };
  indexes.set(region, index);
  return index;
}


/** Los nombres oficiales más parecidos a lo escrito («medelin» → Medellín; «rionegr» → Rionegro), hasta 3. */
function suggestionsFor(typed, keys) {
  const tolerance = Math.max(1, Math.floor(typed.length / 4));
  const scored = new Map();
  for (const [key, [, name]] of keys) {
    const score = typed.length >= 3 && key.startsWith(typed) ? 0.5 : distance(typed, key);
    if (score <= tolerance && score < (scored.get(name) ?? Infinity)) scored.set(name, score);
  }
  return [...scored].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0], 'es')).slice(0, 3).map(([name]) => name);
}

/**
 * El municipio de destino: { place: { dane, name, state } } o, si no está en ese departamento, { place: null,
 * suggestions }. Bogotá D.C. es un solo municipio: vale cualquier cosa que se escriba (una localidad, un barrio).
 */
export function findPlace(region, city) {
  const state = STATE_CODES[region];
  if (!state) return { place: null, suggestions: [] };
  if (state === 'DC') return { place: { dane: '11001000', name: 'Bogotá', state }, suggestions: [] };
  const typed = fold(city ?? '');
  if (typed.length < 2) return { place: null, suggestions: [] };
  const { exact, keys } = indexOf(region);
  const hit = exact.get(typed);
  if (hit) return { place: { dane: `${hit[0]}000`, name: hit[1], state }, suggestions: [] };
  return { place: null, suggestions: suggestionsFor(typed, keys) };
}

/** Los nombres oficiales de cada departamento, para la lista del campo «ciudad» del pago. */
export const CITY_NAMES = Object.fromEntries(Object.entries(MUNICIPIOS).map(([region, list]) => [region, list.map(([, name]) => name)]));

/** Peso (kg, de a 100 g) y caja para un pedido que pesa `grams`. */
export function packageFor(grams) {
  const kg = Math.max(0.1, Math.ceil(grams / 100) / 10);
  return { kg, dims: BOXES.find((b) => kg <= b.upToKg).dims };
}

const cacheOf = (db) => db.collection(COLLECTIONS.shippingCache);
async function remember(db, key, value, ttlMs) {
  await cacheOf(db).updateOne({ _id: key }, { $set: { value, expiresAt: new Date(Date.now() + ttlMs) } }, { upsert: true });
}

/** La tarifa más barata de una transportadora (null: no cubre ese destino). Lanza si el fallo es de paso. */
async function rateOne(carrier, place, pkg, declaredPesos) {
  const res = await fetch(`${API}/ship/rate/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.ENVIA_API_KEY}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      origin: ORIGIN,
      destination: { name: 'Cliente', phone: '3000000000', street: 'Dirección del cliente', city: place.dane, state: place.state, country: 'CO', postalCode: `${place.dane.slice(0, 2)}0001` },
      packages: [{
        type: 'box', content: 'Coleccionables', amount: 1, declaredValue: declaredPesos,
        lengthUnit: 'CM', weightUnit: 'KG', weight: pkg.kg, dimensions: pkg.dims,
      }],
      shipment: { type: 1, carrier: carrier.envia },
      settings: { currency: 'COP' },
    }),
  });
  const data = await res.json().catch(() => null);
  const message = String(data?.error?.message ?? '');
  if (res.status >= 500 || res.status === 401 || res.status === 429 || /too many/i.test(message)) {
    throw new Error(`${carrier.envia}: ${res.status} ${message}`.trim());
  }
  const rates = (Array.isArray(data?.data) ? data.data : []).filter((r) => Number(r.totalPrice) > 0 && r.currency === 'COP');
  if (!rates.length) return null;
  const best = rates.reduce((a, b) => (Number(b.totalPrice) < Number(a.totalPrice) ? b : a));
  return {
    id: `${carrier.id}:${best.service}`,
    carrier: carrier.id,
    carrierName: carrier.name,
    service: best.service,
    cents: Math.ceil(Number(best.totalPrice)) * 100,
    estimate: best.deliveryEstimate ?? null,
  };
}

/**
 * Tarifas en vivo para un municipio (de findPlace): las transportadoras que lo cubren, de la más barata a la más
 * cara ([] si ninguna llega). null si no hay llave o la API no respondió.
 */
export async function shippingRates(db, { place, grams, declaredCents }) {
  if (!enviaEnabled() || !place) return null;
  try {
    const pkg = packageFor(grams);
    const declared = Math.max(50_000, Math.ceil(declaredCents / 100 / 50_000) * 50_000); // de a $50.000: aprovecha la caché
    const key = `rate|${place.dane}|${pkg.kg}|${Object.values(pkg.dims).join('x')}|${declared}`;
    const hit = await cacheOf(db).findOne({ _id: key, expiresAt: { $gt: new Date() } });
    if (hit) return hit.value;

    const results = await Promise.allSettled(SHIPPING_CARRIERS.map((c) => rateOne(c, place, pkg, declared)));
    const failed = results.filter((r) => r.status === 'rejected');
    failed.forEach((r) => console.error('[envíos] Envia:', r.reason?.message ?? r.reason));
    if (failed.length === results.length) return null; // ninguna respondió: no se guarda
    const options = results.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : [])).sort((a, b) => a.cents - b.cents);
    await remember(db, key, options, failed.length ? RATE_RETRY_MS : RATE_TTL_MS);
    return options;
  } catch (err) {
    console.error('[envíos] Envia no respondió:', err.message);
    return null;
  }
}
