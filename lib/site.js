import { HttpError } from './http.js';
import { COLLECTIONS } from './catalog.js';
import { SAFE_URL_RE } from './validate.js';
import { ACHIEVEMENTS, LEVEL_XP } from './achievements.js';
import { slugify } from './admin/common.js';

/*
 * Contenido editable de la página (textos, zonas, colores, niveles, pie…).
 * El esquema describe cada campo con su etiqueta en español: la curaduría arma el
 * formulario a partir de él y el servidor valida con las mismas reglas.
 * Lo guardado vive en settings/_id:"site"; lo que falte se completa con SITE_DEFAULTS,
 * así un campo nuevo en el esquema nunca deja huecos en la tienda.
 */

const SITE_ID = 'site';
const ECHO = 'Encierra entre *asteriscos* la palabra que quieras resaltar.';

const text = (label, max, extra = {}) => ({ type: 'text', label, max, ...extra });
const para = (label, max, extra = {}) => ({ type: 'text', label, max, multiline: true, ...extra });
const url = (label) => ({ type: 'url', label, max: 300 });
const color = (label) => ({ type: 'color', label });
const int = (label, min, max, extra = {}) => ({ type: 'int', label, min, max, ...extra });

const group = (label, fields, extra = {}) => ({ type: 'group', label, fields, ...extra });
const list = (label, item, extra) => ({ type: 'list', label, item, ...extra });

/**
 * Zonas de partida. La curaduría las renombra, recolorea, ordena, añade y quita. Cada pieza guarda el
 * `key` de su zona: lo pone el servidor al crear la zona (sale del nombre) y ya no cambia.
 */
const ZONE_DEFAULTS = [
  { key: 'figuras', label: 'Figuras', color: '#3db8f5' },
  { key: 'manga', label: 'Manga', color: '#ff5c9d' },
  { key: 'retro', label: 'Retro', color: '#ffb238' },
  { key: 'tcg', label: 'TCG & rol', color: '#a78bfa' },
  { key: 'mesa', label: 'Mesa', color: '#4ade80' },
  { key: 'merch', label: 'Merch', color: '#ff7849' },
];
export const MAX_ZONES = 12;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const xpLabel = (n) => n.toLocaleString('en-US');

/** Mismas claves que DAYS en public/js/main.js (ahí se calcula «abierto ahora» con la hora de Bogotá). */
const DAYS = [['lun', 'Lunes'], ['mar', 'Martes'], ['mie', 'Miércoles'], ['jue', 'Jueves'], ['vie', 'Viernes'], ['sab', 'Sábado'], ['dom', 'Domingo']];
const CLOCK = '(?:[01]?\\d|2[0-3]):[0-5]\\d';
// `hoursOrder`: el cierre va después de la apertura (formato 24 h: «10:00-6:00» sería abrir toda la noche)
const HOURS = { pattern: `^(?:[Cc]errado|${CLOCK} ?[-–] ?${CLOCK})$`, patternMsg: 'debe ser un horario como 11:00-20:00 o «cerrado»', hoursOrder: true };
const minutesOf = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const EMAIL = { pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$', patternMsg: 'debe ser un correo como nombre@dominio.com' };
const COORDS = {
  pattern: '^-?\\d{1,2}(?:\\.\\d+)?, ?-?\\d{1,3}(?:\\.\\d+)?$',
  patternMsg: 'deben ser dos números separados por coma, como 4.60968, -74.07029',
  hint: 'En Google Maps haz clic derecho sobre el local y copia los dos números que aparecen arriba. Ubican el marcador del mapa y el enlace de Waze.',
};

export const SITE_SCHEMA = group('Página', {
  general: group('General', {
    title: text('Título de la pestaña y de Google', 70),
    description: para('Descripción para buscadores y redes', 170),
  }, { anchor: '#top' }),

  intro: group('Portada', {
    kicker: text('Antetítulo', 120),
    title: text('Titular', 140, { hint: `${ECHO} Se ve con el eco de color.` }),
    lead: para('Entradilla', 320),
    facts: list('Datos rápidos', group('Dato', { value: text('Cifra', 16), label: text('Texto', 40) }, { inline: true }), {
      min: 4, max: 4, itemLabel: 'Dato',
      hint: 'Escribe {piezas} o {zonas} para mostrar cuántas piezas activas o cuántas zonas hay, y {horario} para el horario de hoy de la tienda (sale de «Visítanos», festivos incluidos: «9–19 h» o «Cerrado»).',
    }),
  }, { anchor: '#top' }),

  drops: group('Drops', {
    title: text('Título de la sección y del menú', 30),
    subtitle: text('Subtítulo', 80),
    empty: text('Aviso cuando no hay drops activos', 160),
  }, { anchor: '#drops', hint: 'Los drops (bundles de piezas con precio rebajado) se crean en el módulo Drops.' }),

  zonas: group('Zonas y colores', {
    items: list('Zonas', group('Zona', {
      key: { type: 'key', label: 'Identificador' }, // no se edita: lo asigna el servidor
      label: text('Nombre', 24),
      color: color('Color'),
    }, { inline: true }), {
      min: 1, max: MAX_ZONES, itemLabel: 'Zona',
      hint: 'El orden es el de los filtros del índice. Para quitar una zona, primero pasa sus piezas a otra (en Piezas).',
    }),
  }, { anchor: '#indice', hint: 'El color tiñe las filas, el visor, los filtros y las piezas de cada zona (salvo las que tienen color propio).' }),

  indice: group('Índice', {
    title: text('Título de la sección y del menú', 30),
    placeholder: text('Texto del buscador', 60),
    empty: text('Mensaje cuando una zona está vacía', 160),
  }, { anchor: '#indice' }),

  niveles: group('Niveles', {
    title: text('Título de la sección y del menú', 30),
    subtitle: text('Subtítulo', 80),
    levels: list('Niveles', group('Nivel', {
      name: text('Nombre', 30, { hint: ECHO }),
      perk: text('Beneficio', 140),
    }), {
      min: 4, max: 4, itemLabel: 'Nivel',
      hint: `El XP de cada nivel lo pone la tienda: Lv 02 = completar todos los logros (${xpLabel(LEVEL_XP[1])} XP) · Lv 03 = ${xpLabel(LEVEL_XP[2])} XP · Lv 04 = ${xpLabel(LEVEL_XP[3])} XP.`,
    }),
    note: text('Invitación a crear credencial (visitantes sin sesión)', 160),
  }, { anchor: '#niveles' }),

  logros: group('Logros', {
    title: text('Título del bloque', 60),
    items: group('Logros', Object.fromEntries(ACHIEVEMENTS.map(({ id, name, xp, secret }) => [
      id, group(`${name} · ${xp} XP${secret ? ' · secreto' : ''}`, {
        name: text('Nombre', 40),
        desc: text('Descripción', 120),
        ...(secret ? { hint: text('Pista (se ve mientras está oculto)', 80) } : {}),
      }, { inline: true }),
    ]))),
  }, {
    anchor: '#logros',
    hint: `Cada logro se desbloquea con su acción y da su XP; entre todos suman ${xpLabel(LEVEL_XP[1])} XP, lo que pide Adepto. Aquí cambias cómo se llama cada uno, qué dice y, en los secretos, la pista que se ve antes de desbloquearlos.`,
  }),

  encargos: group('Encargos', {
    title: text('Título de la sección y del menú', 30),
    subtitle: text('Subtítulo', 80),
    steps: list('Pasos', text('Paso', 160), { min: 3, max: 3, itemLabel: 'Paso' }),
    form: text('Encabezado de la ficha', 40),
    pieceLabel: text('Etiqueta del campo «pieza»', 40),
    piecePlaceholder: text('Ejemplo dentro del campo «pieza»', 80),
    contactLabel: text('Etiqueta del campo «WhatsApp»', 40),
    button: text('Botón', 30),
    success: text('Mensaje al enviar', 160, { hint: '{codigo} se reemplaza por el número de la ficha.' }),
  }, { anchor: '#encargos' }),

  visita: group('Visítanos (tienda física)', {
    title: text('Título de la sección y del menú', 30),
    subtitle: text('Subtítulo', 80),
    address: text('Dirección', 60),
    city: text('Ciudad y país', 60),
    reference: text('Cómo encontrarnos', 160),
    payment: text('Pago en tienda', 80),
    directions: text('Botón «cómo llegar»', 30),
    coords: text('Coordenadas del local', 40, COORDS),
    hours: group('Horario (hora de Bogotá)', Object.fromEntries([...DAYS, ['fes', 'Festivos']].map(([key, name]) => [key, text(name, 13, HOURS)])), {
      inline: true,
      hint: 'Escribe cada día en formato 24 h, como 10:00-18:00 (las 6 de la tarde son 18:00), o «cerrado». «Festivos» rige los festivos de Colombia (los que se corren al lunes incluidos). La tienda muestra en vivo si está abierta.',
    }),
  }, { anchor: '#visita', hint: 'La dirección y la ciudad arman el enlace «cómo llegar» de Google Maps.' }),

  correo: group('Correo', {
    nav: text('Nombre en el menú', 24),
    title: text('Titular', 120, { hint: ECHO }),
    label: text('Etiqueta del campo', 40),
    button: text('Botón', 30),
    note: text('Nota bajo el campo', 120),
    success: text('Mensaje al suscribirse', 160),
    already: text('Mensaje si ya estaba suscrito', 160),
  }, { anchor: '#correo' }),

  arcade: group('Arcade', {
    title: text('Título de la sección', 30),
    subtitle: text('Subtítulo', 80),
  }, { anchor: '#arcade', hint: 'Los juegos del final de la página (Breakout, Snake y Pac-Man): una moneda al día, y cada partida da hasta 50 XP.' }),

  inventario: group('Carrito', {
    checkout: text('Botón de pago', 40),
    note: text('Nota bajo el botón', 160),
    empty: text('Mensaje del carrito vacío', 120),
  }, { anchor: 'cart' }),

  pago: group('Pago y envíos', {
    envioBogota: int('Tarifa fija en Bogotá (pesos · solo sin Envia)', 0, 500_000),
    envioNacional: int('Tarifa fija al resto del país (pesos · solo sin Envia)', 0, 500_000),
    envioGratisDesde: int('Envío gratis para todos desde (pesos · 0 = nunca)', 0, 100_000_000),
    pesoPieza: int('Peso por pieza (gramos)', 1, 50_000, { hint: 'Para cotizar el envío cuando la pieza no tiene su peso (se pone en Piezas › Existencias). El empaque no se cuenta.' }),
    envioRecargo: int('Recargo sobre la cotización (pesos)', 0, 200_000, { hint: 'Se suma a lo que cobra la transportadora (empaque, manejo). 0 = el precio de la transportadora.' }),
    tiempos: text('Tiempos de entrega', 160),
    tienda: text('Recoger en la tienda', 160, { hint: 'Se muestra junto a la opción de recoger. La dirección sale de «Visítanos».' }),
    gracias: text('Mensaje cuando el pago se aprueba', 160),
  }, {
    anchor: 'cart',
    hint: 'Se cobran con Wompi. El envío se cotiza en vivo con Interrapidísimo (Envia.com) según el peso de las piezas y el municipio, que tiene que estar en la lista oficial del DANE: si no está, si Interrapidísimo no llega o si Envia no responde, el pago no sigue y se ofrece recoger en la tienda. Las tarifas fijas solo rigen sin la llave de Envia (pruebas). Mítico tiene envío gratis desde $50.000.',
  }),

  pie: group('Pie de página', {
    line: para('Frase del pie', 160),
    columns: list('Columnas', group('Columna', {
      title: text('Título', 24),
      links: list('Enlaces', group('Enlace', { label: text('Texto', 40), url: url('Dirección') }, { inline: true }), {
        min: 0, max: 8, itemLabel: 'Enlace',
        hint: 'Dirección: https://…, mailto:, tel:, una sección (#visita) o una página (/cuenta). Los enlaces de Instagram, TikTok y WhatsApp (https://wa.me/57 y el celular, ej. https://wa.me/573001234567) salen con su logo.',
      }),
    }), { min: 3, max: 3, itemLabel: 'Columna' }),
    legal: text('Línea legal', 200),
    privacy: group('Enlace legal', { label: text('Texto', 30), url: url('Dirección') }, { inline: true, hint: 'La política de privacidad está en /privacidad; sus datos se editan en «Política de privacidad».' }),
  }, { anchor: '.colophon' }),

  contacto: group('Contacto (Instagram y TikTok)', {
    instagram: url('Instagram'),
    tiktok: url('TikTok'),
  }, {
    anchor: 'cart',
    hint: 'Adonde escribe quien quiere pedir algo que el pago no alcanza: un municipio al que no se pudo cotizar el envío o alguien de otro país. Salen como botones en el pago cuando el envío no se puede cotizar.',
  }),

  privacidad: group('Política de privacidad', {
    owner: text('Responsable del tratamiento (razón social)', 120, { hint: 'Quien responde por los datos ante la ley: el nombre completo de la persona natural o la razón social de la sociedad dueña de la tienda, como sale en el RUT. No el nombre comercial «Dream Zone».' }),
    idDoc: text('NIT o cédula del responsable', 40, { hint: 'Como «NIT 901.234.567-8» o «C.C. 1.020.304.050». Mientras diga «Por definir», la política no muestra esa línea.' }),
    email: text('Correo del área de servicio al cliente', 120, { ...EMAIL, hint: 'Donde llegan las consultas y reclamos sobre datos personales.' }),
    phone: text('Teléfono del responsable', 40, { hint: 'Mientras diga «Por definir», la política dice «Aún no contamos con línea telefónica».' }),
    billing: text('Proveedor de factura electrónica', 120, { hint: 'Nombre y país del software de facturación habilitado por la DIAN, como «Alegra (Colombia)». Mientras diga «Por definir», la política lo nombra en general.' }),
  }, {
    anchor: '.colophon',
    hint: 'Datos de la política de tratamiento de datos (privacidad.html: Ley 1581 de 2012 y Decreto 1074 de 2015). Domicilio y dirección salen de «Visítanos». La versión y la fecha de vigencia van con el texto de la política, en el código.',
  }),
});

export const SITE_DEFAULTS = {
  general: {
    title: 'Dream Zone',
    description: 'Tienda geek: figuras, mangas, merch de culto.',
  },
  intro: {
    kicker: 'Tienda geek — figuras, mangas, camisas, accesorios y más',
    title: 'Un archivo de reliquias para quienes coleccionan *sueños*.',
    lead: 'Hecho por geeks, envíos a todo el país. Recorre el índice: cada pieza aparece en el visor.',
    facts: [
      { value: '{piezas}', label: 'piezas en archivo' },
      { value: '{zonas}', label: 'zonas' },
      { value: '1–5 días', label: 'de envío con Interrapidísimo' },
      { value: '{horario}', label: 'hoy en tienda' },
    ],
  },
  drops: {
    title: 'Drops',
    subtitle: 'Bundles · más baratos juntos',
    empty: 'Sin drop activo. El próximo se está cocinando.',
  },
  zonas: { items: ZONE_DEFAULTS },
  indice: {
    title: 'Índice',
    placeholder: 'nombre, sku o formato…',
    empty: 'esta zona está vacía por ahora. Vuelve el viernes.',
  },
  niveles: {
    title: 'Niveles',
    subtitle: 'Programa de lealtad · cada compra suma XP',
    levels: [
      { name: 'Novato', perk: 'Tu credencial y acceso a la comunidad.' },
      { name: 'Adepto', perk: '5% en todos los productos.' },
      { name: 'Leyenda', perk: 'Lo de Adepto y 10% en todos los drops.' },
      { name: '*Mítico*', perk: 'Lo de Leyenda y envío gratis desde $50.000.' },
    ],
    note: 'Las credenciales de jugador ya están abiertas.',
  },
  logros: {
    title: 'Logros del archivo',
    items: Object.fromEntries(ACHIEVEMENTS.map(({ id, name, desc, hint }) => [id, hint ? { name, desc, hint } : { name, desc }])),
  },
  encargos: {
    title: 'Encargos',
    subtitle: '¿No está en el índice? Lo cazamos por ti',
    steps: [
      'Cuéntanos qué pieza buscas: personaje, edición, escala.',
      'Cotizamos en 48 h con proveedores de Japón, EE. UU. y Europa.',
      'Apartas con el 30% y liquidas cuando aterriza.',
    ],
    form: 'Ficha de encargo',
    pieceLabel: 'Pieza buscada',
    piecePlaceholder: 'ej. figura de mi personaje favorito, ed. 2019',
    contactLabel: 'WhatsApp de contacto',
    button: 'Enviar ficha →',
    success: 'Ficha {codigo} archivada. Te escribimos por WhatsApp en menos de 48 h.',
  },
  visita: {
    title: 'Visítanos',
    subtitle: 'La sala física (Local 2) · Bogotá',
    address: 'Cra. 7 #23-65',
    city: 'Bogotá, Colombia',
    reference: 'Sobre la Séptima, entre las calles 23 y 24, a una cuadra de la Torre Colpatria.',
    payment: 'Tarjeta · Transferencia · Efectivo',
    directions: 'Cómo llegar',
    coords: '4.60968, -74.07029',
    hours: { lun: '9:00-19:00', mar: '9:00-19:00', mie: '9:00-19:00', jue: '9:00-19:00', vie: '9:00-19:00', sab: '10:00-18:00', dom: '10:00-18:00', fes: '10:00-18:00' },
  },
  correo: {
    nav: 'Correo',
    title: 'Recibe los drops *al instante.*',
    label: 'Correo electrónico',
    button: 'Suscribirme →',
    note: 'Cero spam. Palabra de honor.',
    success: 'Listo: te avisamos al instante cada vez que salga un drop. Te damos la bienvenida a la zona.',
    already: 'Ya estabas en la lista. Nos vemos en el próximo drop.',
  },
  arcade: {
    title: 'Arcade',
    subtitle: 'Una moneda al día · juega y gana XP',
  },
  inventario: {
    checkout: 'Ir a pagar →',
    note: 'Pago seguro con Wompi: tarjeta, PSE, Nequi, Daviplata y más. Tu carrito se guarda 30 días.',
    empty: 'Carrito vacío. Ve a lootear al índice.',
  },
  pago: {
    envioBogota: 9000,
    envioNacional: 16000,
    envioGratisDesde: 0,
    pesoPieza: 400,
    envioRecargo: 0,
    tiempos: 'Bogotá: 1 a 2 días hábiles · resto del país: 2 a 5 días hábiles.',
    tienda: 'Gratis. Te avisamos por correo cuando esté listo para recoger.',
    gracias: 'Tus reliquias ya tienen dueño. Te escribimos cuando salgan del archivo.',
  },
  pie: {
    line: '¿No llegamos a tu ciudad? Escríbenos por Instagram o TikTok y armamos tu pedido.',
    columns: [
      { title: 'Tienda', links: [{ label: 'Índice', url: '#indice' }, { label: 'Encargos', url: '#encargos' }] },
      { title: 'Ayuda', links: [{ label: 'Mi cuenta', url: '/cuenta' }, { label: 'Pedidos', url: '/cuenta#pedidos' }] },
      { title: 'Redes', links: [
        { label: 'Instagram ↗', url: 'https://www.instagram.com/dreamzone_sh' }, { label: 'TikTok ↗', url: 'https://www.tiktok.com/@dreamzone66' },
      ] },
    ],
    legal: '© 2026 Dream Zone · Tarjeta · Transferencia · Efectivo en tienda',
    privacy: { label: 'Privacidad', url: '/privacidad' },
  },
  contacto: {
    instagram: 'https://www.instagram.com/dreamzone_sh',
    tiktok: 'https://www.tiktok.com/@dreamzone66',
  },
  privacidad: {
    owner: 'Dream Zone',
    idDoc: 'Por definir',
    email: 'dreamzone0611@gmail.com',
    phone: 'Por definir',
    billing: 'Por definir',
  },
};

const DAY_SHORT = { lun: 'Lun', mar: 'Mar', mie: 'Mié', jue: 'Jue', vie: 'Vie', sab: 'Sáb', dom: 'Dom' };

/**
 * El horario en una línea, para los correos: «Lun – Vie 9:00 – 19:00 · Sáb – Dom 10:00 – 18:00 · Festivos 10:00 – 18:00».
 * Los días seguidos con el mismo horario van juntos, como en la sección Visítanos.
 */
export function hoursSummary(hours) {
  const label = (v) => {
    const s = String(v ?? '').trim();
    return !s || /^cerrado$/i.test(s) ? 'cerrado' : s.replace(/ ?[-–] ?/, ' – ');
  };
  const rows = [];
  DAYS.forEach(([key]) => {
    const l = label(hours?.[key]);
    const last = rows[rows.length - 1];
    if (last?.label === l) last.to = DAY_SHORT[key];
    else rows.push({ from: DAY_SHORT[key], to: '', label: l });
  });
  rows.push({ from: 'Festivos', to: '', label: label(hours?.fes) });
  return rows.map((r) => `${r.to ? `${r.from} – ${r.to}` : r.from} ${r.label}`).join(' · ');
}

/* ---------- Validación ---------- */

const COLOR_RE = /^#[0-9a-f]{6}$/i;

function check(spec, value, where) {
  const field = where.join(' › ');
  switch (spec.type) {
    case 'text': {
      if (typeof value !== 'string') throw new HttpError(400, `Falta «${field}».`);
      const clean = value.trim().replace(/\s+/g, ' ');
      if (!clean) throw new HttpError(400, `«${field}» no puede quedar vacío.`);
      if (clean.length > spec.max) throw new HttpError(400, `«${field}» admite máximo ${spec.max} caracteres.`);
      if (spec.pattern && !new RegExp(spec.pattern).test(clean)) throw new HttpError(400, `«${field}» ${spec.patternMsg}.`);
      if (spec.hoursOrder && !/^cerrado$/i.test(clean)) {
        const [open, close] = clean.split(/ ?[-–] ?/).map(minutesOf);
        if (close <= open) throw new HttpError(400, `«${field}» cierra antes de abrir: usa formato 24 h (ej. 10:00-18:00).`);
      }
      return clean;
    }
    case 'url': {
      const clean = typeof value === 'string' ? value.trim() : '';
      if (!clean) throw new HttpError(400, `Falta la dirección de «${field}» (usa # si aún no la tienes).`);
      if (clean.length > spec.max || !SAFE_URL_RE.test(clean)) {
        throw new HttpError(400, `La dirección de «${field}» no es válida: usa https://…, mailto:, tel:, #seccion o /pagina.`);
      }
      return clean;
    }
    case 'key': {
      // vacío en una zona nueva: validateSite le asigna uno
      if (value == null || value === '') return '';
      if (typeof value !== 'string' || value.length > 40 || !SLUG_RE.test(value)) throw new HttpError(400, `«${field}» no es válido.`);
      return value;
    }
    case 'color': {
      if (typeof value !== 'string' || !COLOR_RE.test(value)) throw new HttpError(400, `«${field}» debe ser un color hex tipo #ff6fae.`);
      return value.toLowerCase();
    }
    case 'int': {
      if (!Number.isInteger(value) || value < spec.min || value > spec.max) {
        throw new HttpError(400, `«${field}» debe ser un entero entre ${spec.min} y ${spec.max}.`);
      }
      return value;
    }
    case 'list': {
      if (!Array.isArray(value)) throw new HttpError(400, `Falta la lista «${field}».`);
      if (value.length < spec.min || value.length > spec.max) {
        throw new HttpError(400, spec.min === spec.max
          ? `«${field}» lleva exactamente ${spec.min} elementos.`
          : `«${field}» admite entre ${spec.min} y ${spec.max} elementos.`);
      }
      return value.map((item, i) => check(spec.item, item, [...where, `${spec.itemLabel} ${i + 1}`]));
    }
    case 'group': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, `Falta el bloque «${field}».`);
      return Object.fromEntries(Object.entries(spec.fields).map(([key, sub]) => [key, check(sub, value[key], [...where, sub.label])]));
    }
    default:
      throw new Error(`tipo de campo desconocido: ${spec.type}`);
  }
}

/**
 * Cada zona conserva su identificador (las piezas lo guardan); las nuevas lo sacan de su nombre,
 * sin repetir ninguno y sin usar «todo» (el filtro de todas las zonas).
 */
function withZoneKeys(zones) {
  const used = new Set(['todo']);
  const kept = zones.map((z) => {
    if (!z.key || used.has(z.key)) return { ...z, key: '' };
    used.add(z.key);
    return z;
  });
  return kept.map((z) => {
    if (z.key) return z;
    const base = slugify(z.label, 'zona').slice(0, 30).replace(/-+$/, '') || 'zona';
    let key = base;
    for (let n = 2; used.has(key); n += 1) key = `${base}-${n}`;
    used.add(key);
    return { ...z, key };
  });
}

/** Valida el contenido completo que manda la curaduría y devuelve una copia limpia. */
export function validateSite(input) {
  const clean = check(SITE_SCHEMA, input, []);
  clean.zonas.items = withZoneKeys(clean.zonas.items);
  return clean;
}

/** Antes las 6 zonas eran fijas y se guardaban como { figuras: { label, color }, … }: pasan a la lista. */
function legacyZones(content) {
  const zonas = content?.zonas;
  if (!zonas || typeof zonas !== 'object' || Array.isArray(zonas.items)) return content;
  const items = ZONE_DEFAULTS
    .filter((d) => zonas[d.key] && typeof zonas[d.key] === 'object')
    .map((d) => ({ key: d.key, label: zonas[d.key].label || d.label, color: zonas[d.key].color || d.color }));
  return { ...content, zonas: { items: items.length ? items : ZONE_DEFAULTS } };
}

/** Completa lo guardado con los valores por defecto (campos nuevos o bloques que falten). */
function merge(spec, fallback, stored) {
  if (stored === undefined || stored === null) return fallback;
  if (spec.type === 'group') {
    if (typeof stored !== 'object' || Array.isArray(stored)) return fallback;
    return Object.fromEntries(Object.keys(spec.fields).map((key) => [key, merge(spec.fields[key], fallback?.[key], stored[key])]));
  }
  if (spec.type === 'list') return Array.isArray(stored) ? stored : fallback;
  return typeof stored === typeof fallback ? stored : fallback;
}

export async function readSite(db) {
  const doc = await db.collection(COLLECTIONS.settings).findOne({ _id: SITE_ID });
  return {
    site: merge(SITE_SCHEMA, SITE_DEFAULTS, legacyZones(doc?.content)),
    updatedAt: doc?.updatedAt?.toISOString() ?? null,
  };
}

/** Identificadores de las zonas vigentes: validan la zona de cada pieza y el filtro del catálogo. */
export async function zoneKeys(db) {
  const { site } = await readSite(db);
  return site.zonas.items.map((z) => z.key);
}

/** Guarda con bloqueo optimista: `updatedAt` es la versión que la curaduría tenía abierta. */
export async function writeSite(db, { content, updatedAt, userId }) {
  const settings = db.collection(COLLECTIONS.settings);
  const current = await settings.findOne({ _id: SITE_ID }, { projection: { updatedAt: 1 } });
  const currentVersion = current?.updatedAt?.toISOString() ?? null;
  if ((updatedAt ?? null) !== currentVersion) {
    throw new HttpError(409, 'Alguien guardó la página mientras la editabas. Recarga para ver su versión.');
  }
  const now = new Date();
  await settings.updateOne(
    { _id: SITE_ID },
    { $set: { content, updatedAt: now, updatedBy: userId } },
    { upsert: true },
  );
  return now.toISOString();
}