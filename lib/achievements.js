/*
 * Logros y niveles de la credencial de jugador (y lo que se desbloquea con ellos).
 * Cada logro da XP y entre todos suman exactamente el XP de Adepto: quien los completa todos
 * pasa de Novato a Adepto. Leyenda y Mítico piden más XP, que llegará con las compras en línea
 * (mientras tanto la curaduría lo puede regalar con `npm run xp`).
 * Mismos ids, XP y rarezas que en public/js/progress.js; ahí vive lo que desbloquea cada uno.
 * Los nombres y descripciones los edita la curaduría (bloque «Logros» de la página).
 * Este archivo no importa nada del proyecto: lo usan catalog.js y site.js sin ciclos.
 */

/**
 * rarity 1–5: color de botín del logro (común → legendaria). `secret`: nombre y descripción no se ven
 * hasta desbloquearlo; mientras tanto se muestra su `hint` (una pista de cómo conseguirlo).
 */
export const ACHIEVEMENTS = [
  { id: 'credencial', name: 'Credencial en mano', desc: 'Crea tu credencial de jugador.', xp: 20, rarity: 1 },
  { id: 'primer-vistazo', name: 'Primer vistazo', desc: 'Registra tu primera pieza en el visor.', xp: 20, rarity: 1 },
  { id: 'primera-moneda', name: 'Primera moneda', desc: 'Juega tu primera partida en el arcade.', xp: 40, rarity: 2 },
  { id: 'archivo-completo', name: 'Archivo completo', desc: 'Registra todas las piezas del índice.', xp: 80, rarity: 4 },
  { id: 'primer-botin', name: 'Primer botín', desc: 'Añade una pieza a tu carrito.', xp: 40, rarity: 2 },
  { id: 'sin-raton', name: 'Sin ratón', desc: 'Recorre el índice solo con el teclado.', xp: 30, rarity: 2 },
  { id: 'hola-terminal', name: 'Hola, terminal', desc: 'Ejecuta un comando en la terminal.', xp: 30, rarity: 2 },
  { id: 'cazador', name: 'Cazador de reliquias', desc: 'Envía una ficha de encargo.', xp: 60, rarity: 3 },
  { id: 'en-la-lista', name: 'En la lista', desc: 'Suscríbete y recibe cada drop al instante.', xp: 30, rarity: 2 },
  { id: 'cartografo', name: 'Cartógrafo', desc: 'Traza la ruta hasta la sala física.', xp: 30, rarity: 2 },
  { id: 'buho', name: 'Búho nocturno', desc: 'Visita el archivo entre las 00:00 y las 05:00.', xp: 50, rarity: 4, secret: true, hint: 'Vuelve cuando la ciudad duerma.' },
  { id: 'viejo-truco', name: 'Viejo truco', desc: '↑ ↑ ↓ ↓ ← → ← → B A', xp: 70, rarity: 5, secret: true, hint: 'Arriba, arriba… el truco de siempre también funciona aquí.' },
];

export const ACHIEVEMENT_IDS = new Set(ACHIEVEMENTS.map((a) => a.id));
const XP_BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a.xp]));

/** XP de todos los logros juntos (500): justo lo que pide Adepto. */
export const ACHIEVEMENTS_XP = ACHIEVEMENTS.reduce((sum, a) => sum + a.xp, 0);

/** XP mínimo de cada nivel: Lv 01 Novato · Lv 02 Adepto · Lv 03 Leyenda · Lv 04 Mítico. */
export const LEVEL_XP = [0, ACHIEVEMENTS_XP, 2000, 5000];

/** Tope del XP extra (regalo de la curaduría), del que da el arcade y del de las compras. */
export const MAX_EXTRA_XP = 1_000_000;

/**
 * Beneficios de cada nivel al pagar (se acumulan). Mismos números que LEVEL_PERKS en public/js/progress.js.
 * Adepto: 5% en las piezas · Leyenda: además 10% en los drops · Mítico: además envío gratis desde $50.000.
 */
export const LEVEL_PERKS = [
  { productPct: 0, dropPct: 0, freeShippingFrom: null },
  { productPct: 5, dropPct: 0, freeShippingFrom: null },
  { productPct: 5, dropPct: 10, freeShippingFrom: null },
  { productPct: 5, dropPct: 10, freeShippingFrom: 5_000_000 }, // centavos: $50.000
];
export const perksFor = (level) => LEVEL_PERKS[Math.min(Math.max(level, 1), LEVEL_PERKS.length) - 1];

/** Compras: 5 XP por cada $1.000 completos pagados en piezas y drops (el envío no cuenta). */
export const PURCHASE_XP_CENTS = 100_000; // $1.000
export const PURCHASE_XP = 5;
export const purchaseXpFor = (cents) => Math.floor(cents / PURCHASE_XP_CENTS) * PURCHASE_XP;

/**
 * Arcade: una moneda al día (hora de Bogotá) para jugar uno de tres juegos. La partida da XP según el puntaje:
 * 5 por cada `per` puntos, mínimo 1 por jugar y máximo 50 (se llega limpiando Breakout, con 30 manzanas en Snake
 * o con el laberinto de Pac-Man completo). `max` es el puntaje más alto posible.
 * Mismos números que GAMES y ARCADE_XP en public/js/main.js.
 * La curaduría tiene monedas ilimitadas: la primera partida del día suma XP y las demás son libres.
 */
export const ARCADE_GAMES = {
  breakout: { max: 40, per: 4 }, // ladrillos: 5 XP cada 4
  snake: { max: 400, per: 3 }, // manzanas: 5 XP cada 3
  pacman: { max: 251, per: 25 }, // puntos del laberinto: 5 XP cada 25
};
export const ARCADE_XP_STEP = 5;
export const ARCADE_MAX_XP = 50;
export const arcadeXpFor = (game, score) => Math.min(
  ARCADE_MAX_XP,
  Math.max(1, Math.ceil((score * ARCADE_XP_STEP) / (ARCADE_GAMES[game] ?? ARCADE_GAMES.breakout).per)),
);
/** Hoy en Bogotá (AAAA-MM-DD): la moneda se renueva a medianoche de la tienda. */
export const arcadeDay = (date = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date);

/**
 * Colores para el cuadro con la inicial (los muestra public/js/progress.js con la misma lista).
 * `nivel` (por defecto) sigue el color del nivel; `degradado`, el del logo en movimiento, se gana en Mítico.
 */
// «holo» reemplaza al antiguo «degradado» (era igual al color de Mítico); quien lo tenga guardado ve el de su nivel
// adepto · leyenda · mitico: el cuadro especial de cada nivel (se desbloquea al llegar); holo, el extra de Mítico;
// pixel: «DZ pixelado», las letras DZ sobre tramado pixel, que no se gana con nivel sino con el logro secreto Viejo truco
export const AVATAR_COLORS = ['nivel', 'cian', 'rosa', 'ambar', 'lila', 'verde', 'naranja', 'lima', 'rojo', 'hueso', 'adepto', 'leyenda', 'mitico', 'holo', 'pixel'];
export const AVATAR_COLOR_LEVEL = { adepto: 2, leyenda: 3, mitico: 4, holo: 4 };
export const AVATAR_COLOR_ACHIEVEMENT = { pixel: 'viejo-truco' };

/** El color guardado si existe y ya se desbloqueó (nivel o logro); si no (p. ej. perdió el nivel), el del nivel. */
export function avatarColorFor(color, level, achievements = {}) {
  if (!AVATAR_COLORS.includes(color)) return 'nivel';
  const logro = AVATAR_COLOR_ACHIEVEMENT[color];
  if (logro && !achievements?.[logro]) return 'nivel';
  return level >= (AVATAR_COLOR_LEVEL[color] ?? 1) ? color : 'nivel';
}

/**
 * Logros del registro de vistas: cuántas piezas del índice (zona «Todo») ha visto la credencial.
 * Igual que seenRules en public/js/progress.js.
 */
export function seenAchievements(count, total) {
  const ids = [];
  if (count >= 1) ids.push('primer-vistazo');

  if (total > 0 && count >= total) ids.push('archivo-completo');
  return ids;
}

export function levelFor(xp) {
  let level = 1;
  while (level < LEVEL_XP.length && xp >= LEVEL_XP[level]) level += 1;
  return level;
}

/**
 * XP, nivel y logros de una cuenta tal como los ve el navegador.
 * `user.achievements` es { id: fecha del primer desbloqueo }; los ids que ya no existan se ignoran.
 */
export function progressOf(user) {
  const unlocked = Object.entries(user.achievements ?? {}).filter(([id, at]) => XP_BY_ID.has(id) && at instanceof Date);
  const extra = Number.isInteger(user.extraXp) && user.extraXp > 0 ? Math.min(user.extraXp, MAX_EXTRA_XP) : 0;
  const arcadeXp = Number.isInteger(user.arcadeXp) && user.arcadeXp > 0 ? Math.min(user.arcadeXp, MAX_EXTRA_XP) : 0;
  const purchaseXp = Number.isInteger(user.purchaseXp) && user.purchaseXp > 0 ? Math.min(user.purchaseXp, MAX_EXTRA_XP) : 0;
  const xp = unlocked.reduce((sum, [id]) => sum + XP_BY_ID.get(id), 0) + extra + arcadeXp + purchaseXp;
  return {
    xp,
    arcadeXp,
    purchaseXp,
    level: levelFor(xp),
    achievements: Object.fromEntries(unlocked.map(([id, at]) => [id, at.toISOString()])),
  };
}
