/** Letras que también valen con tilde (o macrón, como en «Kōga»). */
const ACCENTS = { a: 'aáàäâãā', e: 'eéèëêē', i: 'iíìïîī', o: 'oóòöôõō', u: 'uúùüûū', n: 'nñ', c: 'cç' };

/** Sin tildes y en minúsculas: «Kōga» → «koga». */
export const fold = (text) => String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Búsqueda que no distingue mayúsculas ni tildes: «koga» encuentra «Kōga» y «cafe», «Café». */
export function searchRegex(text) {
  const pattern = [...fold(text)].map((ch) => (ACCENTS[ch] ? `[${ACCENTS[ch]}]` : escapeRe(ch))).join('');
  return new RegExp(pattern, 'i');
}

/* ---------- Relevancia: el buscador de la barra ordena las piezas por lo bien que calzan ---------- */

const clean = (text) => fold(text).replace(/\s+/g, ' ').trim();

/** Las palabras de una búsqueda (hasta 6), sin tildes ni mayúsculas. */
export const searchWords = (text) => clean(text).split(' ').filter(Boolean).slice(0, 6);

/** `t` empieza una palabra de `v` (lo de antes no es letra ni número: «1001» en «dz-1001»). */
const startsWord = (v, t) => new RegExp(`(?:^|[^a-z0-9])${escapeRe(t)}`).test(v);
/** `t` aparece en `v`; las de 1 o 2 letras solo al comienzo de una palabra («xl» sí, la «el» de «felix» no). */
const has = (v, t) => (t.length < 3 ? startsWord(v, t) : v.includes(t));

/**
 * Qué tan bien calza la búsqueda en un texto, de 0 a 100: igual 100 · empieza así 90 · una de sus palabras
 * empieza así 80 · lo contiene 65 · cada palabra buscada empieza una de las suyas 60 · están todas 45.
 */
export function matchScore(value, words) {
  const v = clean(value);
  const q = words.join(' ');
  if (!v || !q) return 0;
  if (v === q) return 100;
  if (v.startsWith(q)) return 90;
  if (startsWord(v, q)) return 80;
  if (q.length >= 3 && v.includes(q)) return 65;
  if (words.every((t) => startsWord(v, t))) return 60;
  if (words.every((t) => has(v, t))) return 45;
  return 0;
}

/** Peso de cada campo: el nombre y el SKU mandan; el nombre de la zona y el formato ayudan. */
const FIELDS = [['name', 1], ['sku', 1], ['zone', 0.75], ['subtitle', 0.7]];

/**
 * Relevancia de una pieza (0: no calza). `zone` es el nombre de su zona. Las palabras pueden repartirse entre
 * campos («figura goku»: la zona y el nombre) y el nº de entrada del índice vale solo («2» o «0002» → DZ-0002).
 * A igual calce, lo que se puede comprar va antes; una pieza agotada baja un escalón.
 */
export function productScore(p, words, zone = '') {
  const text = { name: p.name, sku: p.sku, zone, subtitle: p.subtitle };
  let best = Math.max(...FIELDS.map(([key, weight]) => matchScore(text[key], words) * weight));
  const q = words.join('');
  const entry = String(p.sku ?? '').replace(/\D/g, '');
  if (/^\d+$/.test(q) && entry && Number(entry) === Number(q)) best = 100;
  if (!best) {
    const all = FIELDS.map(([key]) => clean(text[key])).join(' · ');
    if (words.every((t) => startsWord(all, t))) best = 40;
    else if (words.every((t) => has(all, t))) best = 30;
  }
  if (!best) return 0;
  return Math.round(best) + (p.stock > 0 ? 2 : -10);
}

/**
 * Filtro de Mongo para un texto: cada palabra tiene que estar en el nombre, el SKU, el formato o el nombre de la
 * zona de la pieza. Lo usan el índice y el buscador de la barra (que además ordena con productScore).
 * `zones`: las de la curaduría, [{ key, label }].
 */
export function textFilter(text, zones = []) {
  const words = searchWords(text);
  if (!words.length) return {};
  return {
    $and: words.map((w) => {
      const re = searchRegex(w);
      const keys = zones.filter((z) => fold(z.label).includes(w)).map((z) => z.key);
      return { $or: [{ name: re }, { sku: re }, { subtitle: re }, ...(keys.length ? [{ category: { $in: keys } }] : [])] };
    }),
  };
}

/* ---------- Corrección: «camsia» → «camisa» ---------- */

/** Cuántas letras hay que cambiar, quitar o poner para pasar de `a` a `b` (Levenshtein). */
export function distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

/** Las palabras (de 3 letras o más) de unos textos, sin repetir: el vocabulario para corregir. */
export function vocabularyOf(texts) {
  return [...new Set(texts.flatMap((t) => clean(t).split(/[^a-z0-9]+/)).filter((w) => w.length >= 3))];
}

/**
 * Cambia cada palabra que no está en el vocabulario por la más parecida (1 letra de tolerancia hasta 5 letras,
 * 2 desde 6). Devuelve las palabras corregidas, o null si no había nada que corregir o alguna no tiene arreglo.
 */
export function correctWords(words, vocabulary) {
  let changed = false;
  const fixed = words.map((w) => {
    if (w.length < 3 || vocabulary.some((v) => v.includes(w))) return w;
    const tolerance = w.length <= 5 ? 1 : 2;
    let best = null;
    let bestD = tolerance + 1;
    for (const v of vocabulary) {
      if (Math.abs(v.length - w.length) > tolerance) continue;
      const d = distance(w, v);
      if (d < bestD) {
        best = v;
        bestD = d;
      }
    }
    if (best) changed = true;
    return best;
  });
  return changed && fixed.every(Boolean) ? fixed : null;
}