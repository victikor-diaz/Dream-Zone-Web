/* DREAM ZONE — Logros, registro de vistas y niveles de la credencial. Lo usan la tienda (main.js) y la
   credencial (cuenta.js). Mismos ids, XP y rarezas que lib/achievements.js: el servidor guarda los logros
   y las piezas vistas de cada cuenta y calcula su XP y su nivel. Los nombres, descripciones, pistas de los
   logros secretos y beneficios los cambia la curaduría (llegan con /api/site).
   Sin sesión, logros y vistas se guardan en este navegador y pasan a la credencial al entrar o registrarse.
   Cada logro nuevo aparece en una notificación en la esquina, como en Steam. */
window.DZProgress = (() => {
  'use strict';

  const ACHIEVEMENTS = [
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
  const BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));
  /** Entre todos los logros suman justo el XP de Adepto (igual que en lib/achievements.js). */
  const ACHIEVEMENTS_XP = ACHIEVEMENTS.reduce((sum, a) => sum + a.xp, 0);
  const LEVEL_XP = [0, ACHIEVEMENTS_XP, 2000, 5000];
  /** Nombres (admiten *énfasis*) y beneficios por defecto; la curaduría los reemplaza. */
  const LEVELS = [
    { name: 'Novato', perk: 'Tu credencial y acceso a la comunidad.' },
    { name: 'Adepto', perk: '5% en todos los productos.' },
    { name: 'Leyenda', perk: 'Lo de Adepto y 10% en todos los drops.' },
    { name: '*Mítico*', perk: 'Lo de Leyenda y envío gratis desde $50.000.' },
  ];
  /** Beneficios al pagar (se acumulan). Mismos números que LEVEL_PERKS en lib/achievements.js. */
  const LEVEL_PERKS = [
    { productPct: 0, dropPct: 0, freeShippingFrom: null },
    { productPct: 5, dropPct: 0, freeShippingFrom: null },
    { productPct: 5, dropPct: 10, freeShippingFrom: null },
    { productPct: 5, dropPct: 10, freeShippingFrom: 5_000_000 },
  ];
  const perksFor = (level) => LEVEL_PERKS[Math.min(Math.max(level, 1), LEVEL_PERKS.length) - 1];
  const KEY = 'dz.achievements';
  const SEEN_KEY = 'dz.seen';
  const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/; // igual que en lib/validate.js
  const INDEX_SIZE = 48; // igual que en lib/catalog.js

  /** Colores del cuadro con la inicial (mismos ids que AVATAR_COLORS en lib/achievements.js). `level`: desde qué nivel se puede usar. */
  const AVATAR_COLORS = [
    { id: 'nivel', label: 'Tu nivel' },
    { id: 'cian', label: 'Cian', hex: '#3DB8F5' },
    { id: 'rosa', label: 'Rosa', hex: '#FF5C9D' },
    { id: 'ambar', label: 'Ámbar', hex: '#FFB238' },
    { id: 'lila', label: 'Lila', hex: '#A78BFA' },
    { id: 'verde', label: 'Verde', hex: '#4ADE80' },
    { id: 'naranja', label: 'Naranja', hex: '#FF7849' },
    { id: 'lima', label: 'Lima', hex: '#E4FF5E' },
    { id: 'rojo', label: 'Rojo', hex: '#FF6B6B' },
    { id: 'hueso', label: 'Hueso', hex: '#EDEDEB' },
    // el cuadro especial de cada nivel: se desbloquea al llegar y es el que usa «Tu nivel»
    { id: 'adepto', label: 'Adepto', level: 2 }, // tramado pixel de cartucho
    { id: 'leyenda', label: 'Leyenda', level: 3 }, // amatista facetada con destello
    { id: 'mitico', label: 'Mítico', level: 4 }, // la ola del logo
    { id: 'holo', label: 'Holo', level: 4 }, // lámina tornasol de carta holográfica
    // no se gana con nivel sino con un logro (AVATAR_COLOR_ACHIEVEMENT en lib/achievements.js)
    { id: 'pixel', label: 'DZ pixelado', logro: 'viejo-truco' }, // las letras DZ sobre un tramado pixel de los azules del logo
  ];
  const COLOR_BY_ID = new Map(AVATAR_COLORS.map((c) => [c.id, c]));
  /** Lo que se ve con «Tu nivel» en cada nivel (Novato: el gris de su nivel). */
  const LEVEL_SPECIAL = [null, null, 'adepto', 'leyenda', 'mitico'];
  const SPECIAL_CLASS = { adepto: 'is-adepto', leyenda: 'is-leyenda', mitico: 'is-flow', holo: 'is-holo', pixel: 'is-pixel' };
  const levelSpecial = (level) => LEVEL_SPECIAL[Math.min(Math.max(level, 1), 4)] ?? null;

  /** Trofeo en pixel art (16 × 16): copa, asas, pie y un brillo. */
  const TROPHY = '<svg class="trophy-px" viewBox="0 0 16 16" aria-hidden="true" shape-rendering="crispEdges">'
    + '<path d="M4 2h8v6H4zM5 8h6v1H5zM6 9h4v1H6zM7 10h2v2H7zM5 12h6v1H5zM4 13h8v1H4zM1 3h3v1H1zM1 4h1v2H1zM2 6h2v1H2zM12 3h3v1h-3zM14 4h1v2h-1zM12 6h2v1h-2z"/>'
    + '<path class="trophy-px__shine" d="M6 3h1v3H6z"/></svg>';

  /** Moneda del arcade en pixel art (16 × 16): canto, ranura y un brillo. */
  const COIN = '<svg class="coin-px" viewBox="0 0 16 16" aria-hidden="true" shape-rendering="crispEdges">'
    + '<path d="M5 1h6v1h2v1h1v2h1v6h-1v2h-1v1h-2v1H5v-1H3v-1H2v-2H1V5h1V3h1V2h2z"/>'
    + '<path class="coin-px__mark" d="M7 4h2v8H7z"/><path class="coin-px__shine" d="M4 5h1v4H4z"/></svg>';

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const pad = (n) => String(n).padStart(2, '0');
  const num = (n) => Number(n).toLocaleString('en-US');
  const plain = (s) => String(s).replace(/\*/g, '');

  let preview = false;
  let user = null; // credencial con sesión
  // id → fecha ISO del desbloqueo (null: ganado sin sesión en una versión vieja). Hasta saber si hay
  // sesión se muestran los del navegador.
  let unlocked = readLocal();
  let seen = readSeenLocal(); // slugs de las piezas registradas en el visor
  let index = null; // slugs del índice (zona «Todo»): base de los logros de vistas
  let known = false; // ya se sabe si hay sesión
  let markReady;
  const ready = new Promise((resolve) => { markReady = resolve; });
  let saving = Promise.resolve();
  const listeners = new Set();

  function emit(info = {}) {
    listeners.forEach((fn) => {
      try {
        fn(info);
      } catch (err) {
        console.error(err);
      }
    });
  }

  /* ---------- Logros sin sesión: en este navegador ---------- */
  function readLocal() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
      // la versión anterior guardaba solo la lista de ids
      const entries = Array.isArray(raw) ? raw.map((id) => [id, null]) : Object.entries(raw ?? {});
      // «Curador» (5 piezas vistas) pasó a ser «Primera moneda»: quien lo tenía lo conserva
      return new Map(entries.map(([id, at]) => [id === 'curador' ? 'primera-moneda' : id, at]).filter(([id]) => BY_ID.has(id)));
    } catch {
      return new Map();
    }
  }
  function writeLocal(map) {
    if (preview) return;
    try {
      if (map.size) localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(map)));
      else localStorage.removeItem(KEY);
    } catch {
      /* modo privado o almacenamiento bloqueado */
    }
  }

  function readSeenLocal() {
    try {
      const raw = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]');
      return new Set(Array.isArray(raw) ? raw.filter((id) => typeof id === 'string' && SLUG_RE.test(id)) : []);
    } catch {
      return new Set();
    }
  }
  function writeSeenLocal(set) {
    if (preview) return;
    try {
      if (set.size) localStorage.setItem(SEEN_KEY, JSON.stringify([...set]));
      else localStorage.removeItem(SEEN_KEY);
    } catch {
      /* modo privado o almacenamiento bloqueado */
    }
  }

  /** Logros del registro de vistas (igual que seenAchievements en lib/achievements.js). */
  function seenRules(count, total) {
    const ids = [];
    if (count >= 1) ids.push('primer-vistazo');

    if (total > 0 && count >= total) ids.push('archivo-completo');
    return ids;
  }

  /* ---------- XP y nivel ---------- */
  function levelFor(xp) {
    let level = 1;
    while (level < LEVEL_XP.length && xp >= LEVEL_XP[level]) level += 1;
    return level;
  }

  /** Progreso visible. Con sesión, XP y nivel son los de la cuenta (incluye el XP extra); sin sesión, los de este navegador. */
  function stats() {
    const achXp = [...unlocked.keys()].reduce((sum, id) => sum + BY_ID.get(id).xp, 0);
    const xp = Number.isInteger(user?.xp) ? user.xp : achXp;
    const level = Number.isInteger(user?.level) ? user.level : levelFor(xp);
    const floor = LEVEL_XP[level - 1];
    const next = LEVEL_XP[level] ?? null;
    return {
      signedIn: Boolean(user),
      count: unlocked.size,
      total: ACHIEVEMENTS.length,
      achXp,
      achTotal: ACHIEVEMENTS_XP,
      xp,
      level,
      floor,
      next,
      ratio: next ? Math.min(1, Math.max(0, (xp - floor) / (next - floor))) : 1,
    };
  }

  const levelName = (n) => plain(LEVELS[n - 1].name);

  /** Cómo se presenta una cuenta: su apodo o, si no tiene, su nombre. */
  const displayName = (u) => (u?.nickname || u?.name || '').trim();

  /**
   * Pinta un cuadro de jugador (.avatar): el color elegido (o el del nivel), el nivel (halo y destello en
   * Mítico), la inicial y la barrita de XP. `preview` muestra un color aunque aún no esté desbloqueado.
   * Solo cambia atributos: rehacer el HTML reiniciaría las animaciones.
   */
  function paintAvatar(el, { name = '', color = 'nivel', level = 1, ratio = null, preview = false } = {}) {
    let c = COLOR_BY_ID.get(color) ?? COLOR_BY_ID.get('nivel');
    if (!preview && level < (c.level ?? 1)) c = COLOR_BY_ID.get('nivel');
    const look = c.id === 'nivel' ? levelSpecial(level) : c.id; // «Tu nivel» toma el cuadro especial de su nivel
    el.dataset.lv = String(level);
    if (c.hex) el.style.setProperty('--fill', c.hex);
    else el.style.removeProperty('--fill');
    Object.entries(SPECIAL_CLASS).forEach(([id, cls]) => el.classList.toggle(cls, look === id));
    if (ratio !== null) el.style.setProperty('--p', ratio.toFixed(3));
    // «DZ pixelado» lleva las letras DZ (más chicas, para que quepan dos); los demás cuadros, la inicial
    const initial = (Array.from(String(name).trim())[0] ?? '?').toUpperCase();
    const face = look === 'pixel' ? 'DZ' : initial;
    if (el.textContent !== face) {
      if (look === 'pixel') el.innerHTML = '<span class="avatar__dz">DZ</span>';
      else el.textContent = initial;
    }
  }

  /**
   * Si esta credencial aún no puede usar ese cuadro, qué lo desbloquea («solo Leyenda», «logro secreto»); si ya
   * puede, null. Los de logro miran los logros de esta sesión (el servidor vuelve a comprobarlo al guardar).
   */
  function colorLock(c, level = stats().level) {
    if (c.logro && !unlocked.has(c.logro)) return 'logro secreto';
    if (level < (c.level ?? 1)) return `solo ${levelName(c.level)}`;
    return null;
  }

  /** Una frase con lo que falta para el siguiente nivel. */
  function nextStep(s = stats()) {
    if (!s.next) return `Nivel máximo: eres ${levelName(s.level)}.`;
    if (s.level === 1) {
      const missing = s.total - s.count;
      return `Te ${missing === 1 ? 'falta 1 logro' : `faltan ${missing} logros`} para ${levelName(2)}.`;
    }
    return `${levelName(s.level + 1)} pide ${num(s.next)} XP (te faltan ${num(s.next - s.xp)}): suman la moneda diaria del arcade (hasta 50 XP por partida) y tus compras (5 XP por cada $1.000).`;
  }

  /* ---------- Guardar en la credencial ---------- */
  async function post(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || `Error ${res.status}`);
    return data;
  }

  /** Toma la credencial que devolvió el servidor (sin perder vistas que aún van en camino). */
  function adopt(next) {
    user = next;
    unlocked = new Map(Object.entries(next.achievements ?? {}));
    seen = new Set([...(next.seen ?? []), ...seen]);
  }

  /** Manda logros a la cuenta, de a uno por vez. Si falla, quedan en el navegador y se reintentan en la próxima visita. */
  function claim(ids) {
    saving = saving.then(async () => {
      const owner = user;
      if (!owner) return false;
      const before = stats().level;
      try {
        const data = await post('/api/auth/achievements', { ids });
        if (user !== owner) return true; // se cerró la sesión mientras tanto
        adopt(data.user);
        emit();
        if (user.level > before) toastLevel(user.level);
        return true;
      } catch {
        const local = readLocal();
        ids.forEach((id) => { if (!local.has(id)) local.set(id, unlocked.get(id) ?? null); });
        writeLocal(local);
        return false;
      }
    });
    return saving;
  }

  /**
   * Suma piezas al registro de vistas de la credencial (de a 48). El servidor otorga Primer vistazo,
   * Curador y Archivo completo según ese registro y aquí se anuncian. `[]` solo vuelve a revisarlos.
   */
  function sendSeen(ids) {
    const batches = [];
    for (let i = 0; i < ids.length; i += INDEX_SIZE) batches.push(ids.slice(i, i + INDEX_SIZE));
    if (!batches.length) batches.push([]);
    batches.forEach((batch) => {
      saving = saving.then(async () => {
        const owner = user;
        if (!owner) return false;
        const before = stats().level;
        try {
          const data = await post('/api/auth/seen', { ids: batch });
          if (user !== owner) return true;
          adopt(data.user);
          data.unlocked.forEach((id) => toastAchievement(id));
          emit({ fresh: data.unlocked[0] });
          if (user.level > before) toastLevel(user.level);
          return true;
        } catch {
          const local = readSeenLocal();
          batch.forEach((id) => local.add(id));
          writeSeenLocal(local);
          return false;
        }
      });
    });
    return saving;
  }

  /** Revisa los logros de vistas con lo registrado y el índice actual (no da por hecho nada que no se haya visto). */
  function checkSeen() {
    if (!index || !known || preview) return;
    const count = index.filter((id) => seen.has(id)).length;
    const earned = seenRules(count, index.length).filter((id) => !unlocked.has(id));
    if (!earned.length) return;
    if (user) sendSeen([]); // el servidor los da con el registro de la credencial
    else earned.forEach((id) => unlock(id));
  }

  /**
   * La credencial con sesión (o null). Lo que se ganó o se vio sin sesión en este navegador pasa a la
   * cuenta (sin repetir notificaciones) y las credenciales de antes de los logros reciben «Credencial en mano».
   */
  async function setUser(next) {
    user = next ?? null;
    known = true;
    const local = readLocal();
    const localSeen = readSeenLocal();
    unlocked = user ? new Map(Object.entries(user.achievements ?? {})) : local;
    seen = user ? new Set([...(user.seen ?? []), ...localSeen]) : localSeen;
    markReady();
    emit();
    if (preview) return;
    if (!user) {
      checkSeen();
      return;
    }

    const pending = [...local.keys()].filter((id) => !unlocked.has(id));
    const fresh = unlocked.has('credencial') ? [] : ['credencial'];
    if (pending.length || fresh.length) {
      pending.forEach((id) => unlocked.set(id, local.get(id)));
      fresh.forEach((id) => {
        unlocked.set(id, new Date().toISOString());
        toastAchievement(id);
      });
      emit();
      if (await claim([...pending, ...fresh])) writeLocal(new Map());
    } else if (local.size) {
      writeLocal(new Map()); // ya estaban todos en la cuenta
    }
    if (!user) return; // se cerró la sesión mientras tanto

    // las piezas vistas sin sesión pasan al registro de la credencial
    const accountSeen = new Set(user.seen ?? []);
    const pendingSeen = [...localSeen].filter((id) => !accountSeen.has(id));
    if (pendingSeen.length) {
      if (await sendSeen(pendingSeen)) writeSeenLocal(new Set());
    } else {
      if (localSeen.size) writeSeenLocal(new Set());
      checkSeen();
    }
  }

  /** Registra una pieza como vista. Devuelve false si ya lo estaba. */
  function markSeen(id) {
    if (preview || !SLUG_RE.test(id) || seen.has(id)) return false;
    seen.add(id);
    emit();
    if (user) {
      sendSeen([id]);
    } else {
      writeSeenLocal(seen);
      checkSeen();
    }
    return true;
  }

  /** Las piezas del índice (zona «Todo»): con ellas se cuentan Curador y Archivo completo. */
  function setIndex(ids) {
    index = [...ids];
    checkSeen();
  }

  /** Desbloquea un logro (si aún no lo tiene) y lo anuncia. */
  async function unlock(id) {
    if (preview || !BY_ID.has(id)) return false;
    await ready;
    if (unlocked.has(id)) return false;
    unlocked.set(id, new Date().toISOString());
    toastAchievement(id);
    emit({ fresh: id });
    if (user) await claim([id]);
    else writeLocal(unlocked);
    return true;
  }

  /** Olvida los logros y las vistas guardados en este navegador (los de la credencial no se tocan). */
  function clearLocal() {
    writeLocal(new Map());
    writeSeenLocal(new Set());
    if (!user) {
      unlocked = new Map();
      seen = new Set();
      emit();
    }
  }

  /** Textos de la curaduría: nombres, descripciones y pistas de logros, nombres y beneficios de niveles. */
  function applyCopy(site) {
    Object.entries(site?.logros?.items ?? {}).forEach(([id, item]) => {
      const a = BY_ID.get(id);
      if (!a || !item) return;
      if (typeof item.name === 'string' && item.name) a.name = item.name;
      if (typeof item.desc === 'string' && item.desc) a.desc = item.desc;
      if (a.secret && typeof item.hint === 'string' && item.hint) a.hint = item.hint;
    });
    const levels = site?.niveles?.levels;
    if (Array.isArray(levels)) {
      levels.slice(0, LEVELS.length).forEach((l, i) => {
        if (typeof l?.name === 'string' && l.name) LEVELS[i].name = l.name;
        if (typeof l?.perk === 'string') LEVELS[i].perk = l.perk;
      });
    }
    emit();
  }

  /* ---------- Notificaciones (estilo Steam) ---------- */
  const MAX_VISIBLE = 3;
  const queue = [];
  let visible = 0;
  const stack = document.createElement('div');
  stack.className = 'toasts';
  stack.setAttribute('role', 'status');
  stack.setAttribute('aria-live', 'polite');
  document.body.append(stack);

  function pump() {
    while (visible < MAX_VISIBLE && queue.length) showToast(queue.shift());
  }
  function showToast({ html, kind, lv }) {
    const el = document.createElement('div');
    el.className = `toast toast--${kind}`;
    if (lv) el.dataset.lv = String(lv);
    el.innerHTML = html;
    stack.append(el);
    visible += 1;
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('is-in')));
    let timer = 0;
    const close = () => {
      if (el.classList.contains('is-out')) return;
      clearTimeout(timer);
      el.classList.add('is-out');
      setTimeout(() => {
        el.remove();
        visible -= 1;
        pump();
      }, 450);
    };
    timer = setTimeout(close, kind === 'level' ? 7000 : 5600);
    el.addEventListener('click', close);
    // con el cursor encima no se va (para alcanzar a leerla)
    el.addEventListener('pointerenter', () => clearTimeout(timer));
    el.addEventListener('pointerleave', () => { timer = setTimeout(close, 1800); });
  }
  function toast(item) {
    if (preview) return;
    queue.push(item);
    pump();
  }

  function toastAchievement(id) {
    const a = BY_ID.get(id);
    if (!a) return;
    toast({
      kind: 'ach',
      html: `
        <span class="toast__icon" data-r="${a.rarity}">${TROPHY}</span>
        <span class="toast__body">
          <span class="toast__kicker mono">Logro desbloqueado</span>
          <b class="toast__name">${esc(a.name)}</b>
          <span class="toast__meta mono">+${a.xp} XP · ${pad(unlocked.size)}/${pad(ACHIEVEMENTS.length)} logros</span>
        </span>`,
    });
  }

  /** Toma la credencial que devolvió el servidor por algo que no es un logro (p. ej. gastar la moneda del arcade). */
  function takeUser(next) {
    if (!user || !next) return;
    adopt(next);
    emit();
  }

  /** XP que no viene de logros (la partida del arcade): toma la credencial nueva, lo anuncia y, si toca, el nivel. */
  function gainXp(next, xp, label) {
    if (!user || !next) return;
    const before = stats().level;
    adopt(next);
    emit();
    toast({
      kind: 'xp',
      html: `
        <span class="toast__icon toast__icon--coin">${COIN}</span>
        <span class="toast__body">
          <span class="toast__kicker mono">${esc(label)}</span>
          <b class="toast__name">+${num(xp)} XP</b>
          <span class="toast__meta mono">${num(user.xp)} XP · Lv ${pad(user.level)} · ${esc(levelName(user.level))}</span>
        </span>`,
    });
    if (user.level > before) toastLevel(user.level);
  }

  function toastLevel(level) {
    const l = LEVELS[level - 1];
    if (!l) return;
    toast({
      kind: 'level',
      lv: level,
      html: `
        <span class="toast__icon toast__icon--lv"><b class="px">${pad(level)}</b></span>
        <span class="toast__body">
          <span class="toast__kicker mono">Subiste de nivel</span>
          <b class="toast__name"><span class="lv" data-lv="${level}">${esc(plain(l.name))}</span></b>
          <span class="toast__meta mono">Lv ${pad(level)} · ${esc(l.perk)}</span>
        </span>`,
    });
  }

  return {
    ACHIEVEMENTS_XP,
    LEVEL_XP,
    TROPHY,
    COIN,
    AVATAR_COLORS,
    configure(opts = {}) { preview = Boolean(opts.preview); },
    subscribe(fn) { listeners.add(fn); },
    /** Se cumple cuando ya se sabe si hay sesión (y de quién es). */
    whenReady: () => ready,
    list: () => ACHIEVEMENTS.map((a) => ({ ...a, done: unlocked.has(a.id), at: unlocked.get(a.id) ?? null })),
    levels: () => LEVELS.map((l) => ({ ...l })),
    levelName,
    /** Beneficios al pagar del nivel dado (o del de esta credencial; sin sesión, ninguno). */
    perks: (level) => perksFor(level ?? (user ? stats().level : 1)),
    displayName,
    paintAvatar,
    colorLock,
    levelSpecial,
    /** La credencial con sesión tal como la devolvió el servidor la última vez (o null). */
    currentUser: () => user,
    stats,
    nextStep,
    setUser,
    unlock,
    has: (id) => unlocked.has(id),
    hasSeen: (id) => seen.has(id),
    seenCount: () => seen.size,
    markSeen,
    setIndex,
    clearLocal,
    applyCopy,
    toastAchievement,
    toastLevel,
    takeUser,
    gainXp,
  };
})();
