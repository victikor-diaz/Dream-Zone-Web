/* DREAM ZONE — "Archivo de reliquias": visor + índice alimentados por /api/*, con capa geek
   (registro de piezas, carrito, logros, terminal de comandos, inspección 3D, modo arcade). */
(() => {
  'use strict';

  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const desktop = window.matchMedia('(min-width: 1024px)');

  const term = document.getElementById('term');
  const ICONS = new Set(['mecha', 'd20', 'book', 'pad', 'cards', 'helmet', 'cart', 'shirt', 'meeple', 'cap', 'wallet', 'bag']);
  const RARITY = ['', 'Común', 'Poco común', 'Rara', 'Épica', 'Legendaria', 'Mítica'];
  /** Zonas del índice: las define la curaduría (nombre, color, orden; se pueden añadir y quitar). Hasta que llegan, las de partida. */
  let zoneList = [
    { key: 'figuras', label: 'Figuras', color: '#3db8f5' },
    { key: 'manga', label: 'Manga', color: '#ff5c9d' },
    { key: 'retro', label: 'Retro', color: '#ffb238' },
    { key: 'tcg', label: 'TCG & rol', color: '#a78bfa' },
    { key: 'mesa', label: 'Mesa', color: '#4ade80' },
    { key: 'merch', label: 'Merch', color: '#ff7849' },
  ];
  const ZONES = Object.fromEntries(zoneList.map((z) => [z.key, z.label])); // key → nombre
  const MAX_SLOTS = 30; // igual que MAX_LINES en api/cart.js
  const MAX_QTY = 5; // igual que MAX_QTY_PER_ITEM en api/cart.js
  const HEX_RE = /^#[0-9a-f]{6}$/i;
  /** Dentro del panel de curaduría la tienda se abre en un iframe como vista previa en vivo. */
  const PREVIEW = new URLSearchParams(window.location.search).has('preview') && window.parent !== window;

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const money = (cents) => {
    const whole = cents % 100 === 0;
    return `$${(cents / 100).toLocaleString('es-CO', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
  };
  const num = (n) => Number(n).toLocaleString('en-US');
  const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const entryNo = (p) => (p.sku || '').replace(/\D/g, '') || '—';
  const hexOf = (p) => {
    const n = Number.parseInt(entryNo(p), 10);
    return Number.isNaN(n) ? '' : `0x${n.toString(16).toUpperCase().padStart(4, '0')}`;
  };
  const goTo = (sel) => $(sel)?.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  /** Color propio de la pieza (si la curaduría le puso uno); si no, manda el de su zona vía CSS. */
  const toneOf = (p) => (HEX_RE.test(p.tone ?? '') ? p.tone : null);


  /* ---------- Cliente de la API ---------- */
  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* respuesta sin JSON */
    }
    if (!res.ok) throw new Error(data?.error || `Error ${res.status}`);
    return data;
  }

  /* ---------- Barra de estado (avisos en cola) ---------- */
  const statusbar = $('#statusbar');
  const statusTag = $('#statusbar-tag');
  const statusMsg = $('#statusbar-msg');
  const queue = [];
  let showing = false;

  function nextNotice() {
    const item = queue.shift();
    if (!item) {
      statusbar.classList.remove('is-on');
      showing = false;
      return;
    }
    showing = true;
    statusTag.textContent = item.tag ?? (item.tone === 'error' ? 'err' : 'ok');
    statusMsg.textContent = item.msg;
    statusbar.classList.toggle('is-error', item.tone === 'error');
    statusbar.classList.add('is-on');
    setTimeout(nextNotice, item.tone === 'error' ? 4200 : 2800);
  }
  function notify(msg, { tone = 'ok', tag } = {}) {
    queue.push({ msg, tone, tag });
    if (!showing) nextNotice();
  }

  /* ---------- Fecha de la "edición" y atajo de la terminal según plataforma ---------- */
  const today = $('#today');
  if (today) {
    const d = new Date();
    today.dateTime = d.toISOString().slice(0, 10);
    today.textContent = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}`;
  }
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  $$('[data-term-key]').forEach((el) => { el.textContent = isMac ? '⌘ K' : 'Ctrl K'; });

  /* ---------- Estado ---------- */
  const PER_PAGE = 10; // piezas por página del índice
  const state = {
    products: [], // la página del índice que se ve
    page: 1,
    pages: 1,
    matched: 0, // piezas que cumplen la zona y la búsqueda (en todas las páginas)
    known: new Map(), // toda pieza que ya llegó de la API (de cualquier página), por id
    allIds: new Set(), // base de los logros de vistas: las INDEX_SIZE piezas más nuevas
    indexLoaded: false,
    total: 0,
    drops: [], // drops activos (bundles), del que cierra antes al que cierra después
    dropsLoaded: false,
    selectedId: null, // null: visor en espera · '__secret': la entrada 0000 del código Konami
    size: new Map(), // talla elegida por pieza (las que van por tallas)
    query: '',
    owned: new Set(),
    slots: 0,
    user: null,
    site: null, // textos y colores de la curaduría (/api/site)
    counts: null,
  };

  // la pieza puede estar en otra página o zona (o venir de un drop)
  const findProduct = (id) => state.products.find((p) => p.id === id)
    ?? state.known.get(id)
    ?? state.drops.flatMap((d) => d.items).find((p) => p.id === id)
    ?? null;
  /** Drops activos que traen esta pieza. */
  const dropsWith = (id) => state.drops.filter((d) => d.items.some((p) => p.id === id));
  /** «13 / 27»: su lugar en el índice filtrado, contando las páginas anteriores ('' si no está en esta página). */
  function positionOf(id) {
    const i = state.products.findIndex((p) => p.id === id);
    return i >= 0 ? `${pad((state.page - 1) * PER_PAGE + i + 1)} / ${pad(state.matched)}` : '';
  }

  /** Rareza en cuadros: 5 para las piezas; la Mítica (6, solo la entrada secreta) suma una tecla. */
  const pips = (rarity) => {
    const r = Math.min(6, Math.max(1, Number(rarity) || 1));
    const cells = Array.from({ length: Math.max(5, r) }, (_, k) => `<i${k < r ? ' class="on"' : ''}></i>`).join('');
    return `<span class="pips" data-r="${r}" aria-hidden="true">${cells}</span>`;
  };
  const rarityLabel = (r) => `<span class="rar" data-r="${r}">${RARITY[r]}</span>`;

  function tagFor(p) {
    switch (p.badge) {
      case 'nuevo': return { text: 'Nuevo', tone: 'new' };
      case 'ultimas': return { text: `Últimas ${p.stock}`, tone: 'warn' };
      case 'oferta':
        return {
          text: p.compareAtCents > p.priceCents ? `−${Math.round((1 - p.priceCents / p.compareAtCents) * 100)}%` : 'Oferta',
          tone: 'hot',
        };
      default: return null;
    }
  }

  function stockText(p) {
    if (p.stock <= 0) return 'Agotado';
    const sizes = (p.sizes ?? []).filter((s) => s.stock > 0).length;
    return p.sizes ? `${p.stock} en stock · ${sizes} ${sizes === 1 ? 'talla' : 'tallas'}` : `${p.stock} en stock`;
  }

  /** Etiqueta y estado del botón de compra para una pieza. */
  /** Con tallas, el botón espera a que se elija una. */
  function buyState(p) {
    if (p.stock <= 0) return { label: 'Agotado', disabled: true };
    if (!p.sizes) return { label: 'Al carrito', disabled: false };
    const size = state.size.get(p.id);
    return size ? { label: `Al carrito · ${size}`, disabled: false } : { label: 'Elige tu talla', disabled: true };
  }

  /* Drops: cuenta regresiva, ahorro y estado del botón del bundle */
  function formatRemaining(ms) {
    let t = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(t / 86400); t %= 86400;
    const h = Math.floor(t / 3600); t %= 3600;
    return `${pad(d)}d ${pad(h)}h ${pad(Math.floor(t / 60))}m ${pad(t % 60)}s`;
  }
  const countdown = (iso) => {
    const left = Date.parse(iso) - Date.now();
    return left > 0 ? formatRemaining(left) : 'cerrado';
  };
  /** Lo que se ahorra con el bundle frente a comprar sus piezas por separado (si los precios cambiaron, puede no haber ahorro). */
  function saving(d) {
    const cents = d.regularCents - d.priceCents;
    return cents > 0 ? { cents, pct: Math.round((cents / d.regularCents) * 100) } : null;
  }
  const listJoin = (parts) => (parts.length > 1 ? `${parts.slice(0, -1).join(', ')} y ${parts[parts.length - 1]}` : parts[0] ?? '');
  /**
   * Cuántos drops alcanzan: los que permite la pieza con menos existencias (4, 5 y 6 → 4), igual que dropAvailable
   * en lib/catalog.js. Cada drop pagado descuenta una de cada pieza. `low` es esa pieza.
   */
  function dropStock(d) {
    if (!d.items.length) return { left: 0, low: null };
    const low = d.items.reduce((a, b) => ((b.stock ?? 0) < (a.stock ?? 0) ? b : a));
    return { left: Math.max(0, low.stock ?? 0), low };
  }
  /** `out`: no alcanzan las existencias de sus piezas: el botón sale en rojo. */
  function dropBuyState(d, label) {
    if (Date.now() >= Date.parse(d.endsAt)) return { label: 'Drop cerrado', disabled: true };
    if (dropStock(d).left <= 0) return { label: 'Drop agotado', disabled: true, out: true };
    return { label, disabled: false };
  }

  /* ---------- Logros y niveles (la lógica vive en progress.js, compartido con la credencial) ---------- */
  const progress = window.DZProgress;
  progress.configure({ preview: PREVIEW });
  const unlock = (id) => { progress.unlock(id); };
  const fmtDay = (iso) => {
    const d = new Date(iso);
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}`;
  };

  function renderAchievements(freshId) {
    const s = progress.stats();
    $('#ach-grid').innerHTML = progress.list().map((a) => {
      const hidden = a.secret && !a.done;
      const when = a.done ? `<span class="sr-only">Desbloqueado </span>${a.at ? fmtDay(a.at) : 'desbloqueado'}` : 'bloqueado';
      return `
        <li class="ach${a.done ? ' is-unlocked' : ''}${a.id === freshId ? ' is-fresh' : ''}" data-r="${a.rarity}">
          <span class="ach__name">${hidden ? '???' : esc(a.name)}</span>
          <span class="ach__desc mono">${hidden ? `Secreto · pista: ${esc(a.hint)}` : esc(a.desc)}</span>
          <span class="ach__xp mono">${a.done ? '+' : ''}${hidden ? '??' : a.xp} XP</span>
          <span class="ach__when mono">${when}</span>
        </li>`;
    }).join('');
    $('#ach-count').textContent = `${pad(s.count)}/${pad(s.total)}`;
    $('#ach-xp').textContent = `${num(s.achXp)} / ${num(s.achTotal)} XP`;
    $('#ach-where').textContent = s.signedIn ? 'guardados en tu credencial' : 'se guardan en este navegador hasta que crees tu credencial';
    const meter = $('#ach-meter');
    meter.style.setProperty('--v', (s.achXp / s.achTotal).toFixed(3));
    meter.setAttribute('aria-valuemax', String(s.achTotal));
    meter.setAttribute('aria-valuenow', String(s.achXp));
  }

  /* Escalera de niveles: el XP de cada uno lo fija la tienda; nombres y beneficios, la curaduría. */
  function renderLadder() {
    const s = progress.stats();
    const mine = state.user ? s.level : 0;
    const how = ['al crear tu credencial', `completa los ${s.total} logros`, 'con el arcade diario y tus compras', 'con el arcade diario y tus compras'];
    $('#ladder').innerHTML = progress.levels().map((l, i) => {
      const n = i + 1;
      const current = n === mine;
      return `
        <li data-lv="${n}"${current ? ' class="is-current" aria-current="step"' : ''}>
          <span class="mono muted">Lv ${pad(n)} · ${num(progress.LEVEL_XP[i])} XP</span>
          <b>${rich(l.name, true)}</b>
          <span class="ladder__perk">${esc(l.perk)}</span>
          <span class="ladder__how mono">↳ ${how[i]}</span>
          ${current ? `<span class="ladder__you mono">Tú · ${num(s.xp)} XP</span>` : ''}
        </li>`;
    }).join('');
  }

  /* ---------- Registro: sin ver · vista · en el carrito ----------
     Lo guarda progress.js: con sesión, en la credencial (vale en cualquier dispositivo y el servidor da los
     logros de vistas); sin sesión, en este navegador hasta entrar o registrarse. */
  let seenTimer = 0;
  let seenTimerId = null;

  function seenInCatalog() {
    if (!state.allIds.size) return progress.seenCount();
    let n = 0;
    state.allIds.forEach((id) => { if (progress.hasSeen(id)) n += 1; });
    return n;
  }

  function updateRegistry() {
    $('#registry').textContent = `${pad(seenInCatalog())} vistas · ${pad(state.owned.size)} en el carrito`;
  }

  /** Lo registrado en el índice, el visor y el contador (también cuando llega el registro de la credencial). */
  function paintSeen() {
    $$('.row').forEach((row) => {
      const { id } = row.dataset;
      row.classList.toggle('is-seen', progress.hasSeen(id));
      const sr = $('.row__name .sr-only', row);
      if (sr) sr.textContent = state.owned.has(id) ? ', en el carrito' : progress.hasSeen(id) ? ', vista' : '';
    });
    const p = findProduct(state.selectedId);
    if (p) $('#v-entry').textContent = entryLine(p);
    updateRegistry();
  }

  function markSeen(id) {
    if (state.selectedId === id) progress.markSeen(id); // Primer vistazo, Curador y Archivo completo se revisan ahí
  }

  /* ---------- Visor ---------- */
  const viewer = $('#viewer');
  const stage = $('#v-stage');
  const stageIll = $('.stage__ill');
  const vSh = $('#v-sh');
  const vRot = $('#v-rot');
  const vBuy = $('#v-buy');
  const vDrop = $('#v-drop');
  const vLore = $('#v-lore');
  const vPhoto = $('#v-photo');
  const vPhotoSh = $('.stage__photo-sh');
  const vImg = $('#v-img');
  const vPlates = $('#v-plates');
  const vZoom = $('#v-zoom');
  // estado del zoom del visor (ver «Zoom del visor» más abajo); arriba para que exista antes de pintar una pieza
  const ZOOM_MIN = 1.5;
  const ZOOM_MAX = 4;
  const ZOOM_START = 2.5;
  const clampTo = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const zoom = { on: false, scale: ZOOM_START, ox: 50, oy: 50, pointers: new Map(), pinch: null, travel: 0, moved: false };
  let sheetOpener = null;

  const entryLine = (p) => `Entrada nº ${entryNo(p)} · ${ZONES[p.category] ?? ''} · ${progress.hasSeen(p.id) ? 'registrada' : 'sin registrar'}`;

  function renderBuy(p) {
    const { label, disabled } = buyState(p);
    vBuy.dataset.add = p.id;
    vBuy.dataset.name = p.name;
    vBuy.dataset.size = p.sizes ? state.size.get(p.id) ?? '' : '';
    if (vBuy.getAttribute('aria-busy') !== 'true') {
      vBuy.textContent = label;
      vBuy.disabled = disabled;
    }
    vBuy.classList.toggle('is-out', p.stock <= 0); // agotado: en rojo
    paintSizes(p);
    paintPerk(p);
  }

  /* Tallas: una casilla por talla; las agotadas se ven tachadas y no se pueden elegir */
  const sizeList = $('#v-size-list');
  function paintSizes(p) {
    const box = $('#v-sizes');
    box.hidden = !p?.sizes;
    if (box.hidden) return;
    const chosen = state.size.get(p.id);
    sizeList.innerHTML = p.sizes.map((s) => {
      const note = s.stock <= 0 ? ', agotada' : s.stock <= 3 ? `, quedan ${s.stock}` : '';
      return `<button class="size" type="button" role="radio" data-size="${esc(s.size)}" aria-checked="${s.size === chosen}" aria-label="Talla ${esc(s.size)}${note}"${s.stock <= 0 ? ' disabled' : ''}>${esc(s.size)}</button>`;
    }).join('');
    const pick = p.sizes.find((s) => s.size === chosen);
    $('#v-size-note').textContent = pick
      ? `${pick.stock <= 3 ? `quedan ${pick.stock}` : `${pick.stock} disponibles`} en ${pick.size}`
      : p.sizes.some((s) => s.stock <= 0) ? 'tachadas = agotadas' : '';
  }
  sizeList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-size]');
    const p = findProduct(state.selectedId);
    if (!btn || btn.disabled || !p) return;
    state.size.set(p.id, btn.dataset.size);
    renderBuy(p);
    $(`[data-size="${CSS.escape(btn.dataset.size)}"]`, sizeList)?.focus(); // el foco no se pierde al repintar
  });

  /* Beneficio de nivel al pagar (igual que quoteCart en lib/orders.js: se redondea al peso) */
  const withPct = (cents, pct) => cents - Math.round((cents * pct) / 10000) * 100;
  const levelNow = () => progress.levelName(progress.stats().level);
  /** Bajo el precio: lo que paga esta credencial con su nivel. */
  function paintPerk(p) {
    const el = $('#v-perk');
    const { productPct } = progress.perks();
    el.hidden = !productPct || !p || p.stock <= 0;
    if (!el.hidden) el.textContent = `Con tu nivel ${levelNow()}: ${money(withPct(p.priceCents, productPct))} al pagar (−${productPct}%)`;
  }
  /** En un drop: lo que paga Leyenda o Mítico. */
  function dropPerk(d) {
    const { dropPct } = progress.perks();
    return dropPct ? `${levelNow()}: ${money(withPct(d.priceCents, dropPct))} al pagar (−${dropPct}% más)` : '';
  }

  /** En la ficha: los drops activos que traen esta pieza y lo que se ahorra llevando el bundle. */
  function renderPieceDrops(p) {
    const list = dropsWith(p.id);
    vDrop.hidden = !list.length;
    vDrop.innerHTML = list.map((d) => {
      const others = d.items.filter((x) => x.id !== p.id).map((x) => `<b>${esc(x.name)}</b>`);
      const save = saving(d);
      const { label, disabled, out } = dropBuyState(d, 'Añadir el drop');
      return `
        <div class="plate__drop-item">
          <p class="mono plate__drop-line"><span>En el drop #${pad(d.number, 3)} · ${esc(d.title)}</span><span>cierra en <b data-ends="${esc(d.endsAt)}">${countdown(d.endsAt)}</b></span></p>
          <p class="plate__drop-deal">Llévala junto con ${listJoin(others)}: las ${d.items.length} piezas por <b>${money(d.priceCents)}</b> en lugar de <s>${money(d.regularCents)}</s>${save ? ` · ahorras ${money(save.cents)} (−${save.pct}%)` : ''}.${dropPerk(d) ? ` <span class="drop__perk mono">${dropPerk(d)}</span>` : ''}</p>
          <div class="plate__drop-actions">
            <button class="btn btn--drop${out ? ' is-out' : ''}" type="button" data-add-drop="${esc(d.code)}"${disabled ? ' disabled' : ''}>${label}</button>
            <button class="link mono" type="button" data-goto-drop="${esc(d.code)}">Ver el drop ↓</button>
          </div>
        </div>`;
    }).join('');
  }

  function scanStage() {
    if (reduceMotion.matches) return;
    stage.classList.remove('is-swap');
    void stage.offsetWidth; // reinicia la animación de escaneo
    stage.classList.add('is-swap');
  }

  /*
   * Fotos: la primera es la portada; con varias aparecen las láminas 01 02 03… Cada una se muestra recortada a su
   * contorno (js/photo.js ignora el margen transparente) dentro del marco cuadrado del visor, así todas miden lo
   * mismo. Mientras se recorta (una vez por foto) el marco queda vacío; si llega tarde, gana la última pedida.
   */
  const trimmed = (url) => (window.DZPhoto ? window.DZPhoto.trimmed(url) : Promise.resolve(url));
  let plateTicket = 0;
  function showPlate(p, i) {
    const img = p.images[i];
    const ticket = ++plateTicket;
    setZoom(false);
    vImg.alt = p.images.length > 1 ? `${p.name}, lámina ${i + 1} de ${p.images.length}` : p.name;
    vPhoto.classList.toggle('is-cutout', Boolean(img.cutout));
    vPhoto.classList.add('is-loading');
    $$('button', vPlates).forEach((b, k) => b.setAttribute('aria-pressed', String(k === i)));
    trimmed(img.url).then((src) => {
      if (ticket !== plateTicket) return;
      vImg.src = src;
      vPhoto.style.setProperty('--photo', `url("${src}")`);
      (vImg.decode?.() ?? Promise.resolve()).catch(() => {}).then(() => {
        if (ticket === plateTicket) vPhoto.classList.remove('is-loading');
      });
    });
  }

  function renderPhotos(p) {
    const images = p.images ?? [];
    stage.classList.toggle('has-photo', images.length > 0);
    vPhoto.hidden = !images.length;
    vPlates.hidden = images.length < 2;
    vZoom.hidden = !images.length;
    vPlates.innerHTML = images.length < 2 ? '' : images
      .map((_, k) => `<button type="button" data-plate="${k}" aria-label="Lámina ${k + 1}">${pad(k + 1)}</button>`)
      .join('');
    if (images.length) {
      showPlate(p, 0);
      images.slice(1).forEach((img) => trimmed(img.url)); // las otras láminas, listas para cuando las pidan
    } else {
      plateTicket += 1;
      vImg.removeAttribute('src');
    }
  }

  vPlates.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-plate]');
    const p = findProduct(state.selectedId);
    if (!btn || !p?.images?.length) return;
    showPlate(p, Number(btn.dataset.plate));
    scanStage();
  });

  function renderViewer(p) {
    const changed = state.selectedId !== p.id;
    state.selectedId = p.id;
    viewer.classList.remove('is-empty', 'is-secret');
    viewer.dataset.zone = p.category;
    if (toneOf(p)) viewer.style.setProperty('--tone', toneOf(p));
    else viewer.style.removeProperty('--tone');
    renderPhotos(p);

    const icon = ICONS.has(p.icon) ? p.icon : 'mecha';
    $('#v-ill').setAttribute('href', `#i-${icon}`);
    vSh.setAttribute('href', `#i-${icon}`);
    if (changed) scanStage();

    $('#v-kicker').textContent = 'Visor';
    $('#v-pos').textContent = positionOf(p.id);
    $('#v-fig').textContent = `fig. ${entryNo(p)} · ${hexOf(p)}`;
    $('#v-zone').textContent = ZONES[p.category] ?? '';
    $('#v-entry').textContent = entryLine(p);
    $('#v-title').textContent = p.name;
    vLore.textContent = p.lore ? `“${p.lore}”` : '';
    vLore.hidden = !p.lore;

    const rarity = Math.min(5, Math.max(1, Number(p.rarity) || 1));
    const specs = [
      ['Formato', esc(p.subtitle)],
      ['Rareza', `${pips(rarity)}${rarityLabel(rarity)}`],
      ['Existencias', p.stock <= 0 ? '<span class="is-out">Agotado</span>' : esc(stockText(p))],
      ['SKU', esc(p.sku)],
    ];
    $('#v-specs').innerHTML = specs.map(([dt, dd]) => `<div><dt>${dt}</dt><dd>${dd}</dd></div>`).join('');

    $('#v-price').textContent = money(p.priceCents);
    $('#v-old').textContent = p.compareAtCents > p.priceCents ? money(p.compareAtCents) : '';

    renderPieceDrops(p);
    renderBuy(p);
    markSelected();
  }

  /** Entrada 0000: la reliquia secreta del código Konami. Se queda en el visor hasta que eliges otra pieza. */
  function renderSecret() {
    state.selectedId = '__secret';
    $('#v-perk').hidden = true;
    $('#v-sizes').hidden = true;
    viewer.classList.remove('is-empty');
    viewer.classList.add('is-secret'); // el visor muestra el sprite del logo en lugar de una pieza
    delete viewer.dataset.zone;
    viewer.style.setProperty('--tone', 'var(--c-cyan)');
    setZoom(false);
    vZoom.hidden = true;
    vPhoto.hidden = true;
    vPlates.hidden = true;
    scanStage();
    $('#v-kicker').textContent = 'Entrada 0000';
    $('#v-pos').textContent = '?? / ??';
    $('#v-fig').textContent = 'fig. 0000 · 0x0000';
    $('#v-zone').textContent = 'Zona oculta';
    $('#v-entry').textContent = 'Entrada nº 0000 · Reliquia perdida · registrada';
    $('#v-title').textContent = 'El sueño original';
    vLore.textContent = '“No está a la venta. Nunca lo estuvo. Pero ahora sabes que existe.”';
    vLore.hidden = false;
    $('#v-specs').innerHTML = [
      ['Formato', 'Sprite · 32 × 32 píxeles'],
      ['Rareza', `${pips(6)}${rarityLabel(6)}`],
      ['Existencias', '1 de 1'],
      ['SKU', 'DZ-0000'],
    ].map(([dt, dd]) => `<div><dt>${dt}</dt><dd>${dd}</dd></div>`).join('');
    $('#v-price').textContent = '∞';
    $('#v-old').textContent = '';
    vDrop.hidden = true;
    delete vBuy.dataset.add;
    vBuy.textContent = 'No está a la venta';
    vBuy.disabled = true;
    vBuy.classList.remove('is-out');
    markSelected();
    if (!desktop.matches) openSheet();
  }

  function markSelected() {
    $$('.row').forEach((row) => {
      // en móvil no hay visor lateral: no se marca ninguna fila como activa
      if (desktop.matches && row.dataset.id === state.selectedId) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
    });
  }

  /** Lleva una pieza al visor. Solo pasa al elegirla (clic, Enter, ↑ ↓, terminal o «Ver ficha»): pasar el ratón no la cambia. */
  function select(id, { open = false } = {}) {
    const p = findProduct(id);
    if (!p) return;
    if (p.id !== state.selectedId) renderViewer(p);
    // se registra si te quedas mirándola; volver a elegir la misma pieza no reinicia la cuenta
    if (seenTimerId !== p.id) {
      clearTimeout(seenTimer);
      seenTimerId = p.id;
      seenTimer = setTimeout(() => {
        seenTimerId = null;
        markSeen(p.id);
      }, 650);
    }
    if (open && !desktop.matches) openSheet();
  }

  /* Inspección: la pieza gira siguiendo el cursor y su copia en degradado se desplaza (profundidad). */
  const signed = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1).padStart(4, '0')}`;
  stage.addEventListener('pointermove', (e) => {
    if (zoom.on || e.pointerType !== 'mouse' || reduceMotion.matches || viewer.matches('.is-empty, .is-secret')) return;
    const r = stage.getBoundingClientRect();
    const nx = (e.clientX - r.left) / r.width - 0.5;
    const ny = (e.clientY - r.top) / r.height - 0.5;
    const ry = nx * 26;
    const rx = -ny * 18;
    stage.classList.add('is-inspecting');
    const tilt = `rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
    stageIll.style.transform = tilt;
    vPhoto.style.transform = tilt;
    vSh.setAttribute('transform', `translate(${(-3 - nx * 7).toFixed(2)} ${(4 - ny * 7).toFixed(2)})`);
    vPhotoSh.style.transform = `translate(${(-2.5 - nx * 5).toFixed(2)}%, ${(3.5 - ny * 5).toFixed(2)}%)`;
    vRot.textContent = `rot x ${signed(rx)}° y ${signed(ry)}°`;
  });
  stage.addEventListener('pointerleave', () => {
    stage.classList.remove('is-inspecting');
    stageIll.style.transform = '';
    vPhoto.style.transform = '';
    vSh.setAttribute('transform', 'translate(-3 4)');
    vPhotoSh.style.transform = '';
    vRot.textContent = 'inspeccionar';
  });

  /*
   * Zoom del visor: «zoom +» (o un clic en la foto) la amplía ×2.5 dentro del visor para verla a detalle. Con ratón la
   * lupa sigue al cursor y la rueda cambia el aumento (×1.5 a ×4); con el dedo se arrastra para recorrerla y se
   * pellizca para acercar o alejar; con teclado (foco en el botón), las flechas la recorren y + / − cambian el
   * aumento. Esc, el botón o un clic (o un toque sin arrastrar) salen. Cambiar de pieza o de lámina lo apaga.
   */
  /** La parte de la caja de la foto que ocupa la imagen (object-fit: contain), en % de la caja. */
  function zoomBounds() {
    const w = vImg.offsetWidth || 1;
    const h = vImg.offsetHeight || 1;
    const ratio = (vImg.naturalWidth || w) / (vImg.naturalHeight || h);
    const x = ((w - Math.min(w, h * ratio)) / 2 / w) * 100;
    const y = ((h - Math.min(h, w / ratio)) / 2 / h) * 100;
    return { x0: x, x1: 100 - x, y0: y, y1: 100 - y };
  }
  function paintZoom() {
    const b = zoomBounds(); // el centro del aumento nunca sale de la imagen: no se amplía el vacío
    zoom.ox = clampTo(zoom.ox, b.x0, b.x1);
    zoom.oy = clampTo(zoom.oy, b.y0, b.y1);
    vImg.style.transformOrigin = `${zoom.ox.toFixed(2)}% ${zoom.oy.toFixed(2)}%`;
    vImg.style.transform = zoom.on ? `scale(${zoom.scale.toFixed(2)})` : '';
    vZoom.textContent = zoom.on ? `×${zoom.scale.toFixed(1)} · salir` : 'zoom +';
    vZoom.setAttribute('aria-pressed', String(zoom.on));
    vZoom.setAttribute('aria-label', zoom.on ? `Salir del zoom (×${zoom.scale.toFixed(1)})` : 'Ampliar la foto');
  }
  /** Lleva el centro del aumento al punto (x, y) de la pantalla (con medidas sin transformar). */
  function aimZoom(x, y) {
    const s = stage.getBoundingClientRect();
    zoom.ox = ((x - s.left - vPhoto.offsetLeft - vImg.offsetLeft) / (vImg.offsetWidth || 1)) * 100;
    zoom.oy = ((y - s.top - vPhoto.offsetTop - vImg.offsetTop) / (vImg.offsetHeight || 1)) * 100;
  }
  function setZoom(on, at = null) {
    const can = stage.classList.contains('has-photo') && !viewer.matches('.is-empty, .is-secret') && vImg.hasAttribute('src');
    zoom.on = Boolean(on) && can;
    zoom.scale = ZOOM_START;
    zoom.pointers.clear();
    zoom.pinch = null;
    if (zoom.on) {
      // la inclinación de «inspeccionar» se suelta mientras dura el zoom
      stage.classList.remove('is-inspecting');
      stageIll.style.transform = '';
      vPhoto.style.transform = '';
      vPhotoSh.style.transform = '';
      if (at) aimZoom(at.x, at.y);
      else [zoom.ox, zoom.oy] = [50, 50];
    }
    stage.classList.toggle('is-zoom', zoom.on);
    stage.classList.remove('is-panning');
    vRot.textContent = 'inspeccionar';
    paintZoom();
  }
  const spread = () => {
    const [a, b] = [...zoom.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y) || 1;
  };

  vZoom.addEventListener('click', () => setZoom(!zoom.on));
  vPhoto.addEventListener('click', (e) => {
    if (zoom.moved) { zoom.moved = false; return; } // fue un arrastre, no un toque
    setZoom(!zoom.on, { x: e.clientX, y: e.clientY });
  });
  stage.addEventListener('pointerdown', (e) => {
    if (!zoom.on || e.pointerType === 'mouse') return;
    zoom.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (zoom.pointers.size === 1) { zoom.travel = 0; zoom.moved = false; }
    zoom.pinch = zoom.pointers.size === 2 ? { d: spread(), scale: zoom.scale } : null;
    stage.classList.add('is-panning');
  });
  stage.addEventListener('pointermove', (e) => {
    if (!zoom.on) return;
    if (e.pointerType === 'mouse') {
      aimZoom(e.clientX, e.clientY);
      paintZoom();
      return;
    }
    const prev = zoom.pointers.get(e.pointerId);
    if (!prev) return;
    const now = { x: e.clientX, y: e.clientY };
    zoom.pointers.set(e.pointerId, now);
    zoom.travel += Math.hypot(now.x - prev.x, now.y - prev.y);
    if (zoom.travel > 8) zoom.moved = true;
    if (zoom.pinch && zoom.pointers.size === 2) {
      zoom.scale = clampTo(zoom.pinch.scale * (spread() / zoom.pinch.d), ZOOM_MIN, ZOOM_MAX);
    } else if (zoom.pointers.size === 1) {
      // la imagen sigue al dedo: el centro del aumento se mueve al revés, más despacio cuanto más aumento
      const k = 100 / (zoom.scale - 1);
      zoom.ox -= ((now.x - prev.x) / (vImg.offsetWidth || 1)) * k;
      zoom.oy -= ((now.y - prev.y) / (vImg.offsetHeight || 1)) * k;
    }
    paintZoom();
  });
  ['pointerup', 'pointercancel'].forEach((type) => stage.addEventListener(type, (e) => {
    zoom.pointers.delete(e.pointerId);
    if (zoom.pointers.size < 2) zoom.pinch = null;
    if (!zoom.pointers.size) stage.classList.remove('is-panning');
  }));
  stage.addEventListener('wheel', (e) => {
    if (!zoom.on) return;
    e.preventDefault();
    zoom.scale = clampTo(zoom.scale * Math.exp(-e.deltaY * 0.0015), ZOOM_MIN, ZOOM_MAX);
    aimZoom(e.clientX, e.clientY);
    paintZoom();
  }, { passive: false });
  vZoom.addEventListener('keydown', (e) => {
    if (!zoom.on) return;
    const step = { ArrowLeft: [-8, 0], ArrowRight: [8, 0], ArrowUp: [0, -8], ArrowDown: [0, 8] }[e.key];
    if (step) {
      e.preventDefault();
      zoom.ox += step[0];
      zoom.oy += step[1];
    } else if (e.key === '+' || e.key === '=' || e.key === '-') {
      e.preventDefault();
      zoom.scale = clampTo(zoom.scale + (e.key === '-' ? -0.5 : 0.5), ZOOM_MIN, ZOOM_MAX);
    } else return;
    paintZoom();
  });

  /* Hoja del visor en móvil */
  /** Elemento al que volver al cerrar un panel (nunca la terminal, que se cierra antes). */
  const openerFor = (fallback) => (term.contains(document.activeElement) ? fallback : document.activeElement);

  function openSheet() {
    sheetOpener = openerFor(null);
    viewer.classList.add('is-open');
    viewer.setAttribute('role', 'dialog');
    viewer.setAttribute('aria-modal', 'true');
    document.body.classList.add('is-locked');
    $('.viewer__close').focus();
  }
  function closeSheet() {
    if (!viewer.classList.contains('is-open')) return;
    setZoom(false);
    viewer.classList.remove('is-open');
    viewer.removeAttribute('role');
    viewer.removeAttribute('aria-modal');
    document.body.classList.remove('is-locked');
    if (sheetOpener?.isConnected) sheetOpener.focus();
  }
  $('.viewer__close').addEventListener('click', closeSheet);
  desktop.addEventListener('change', () => {
    closeSheet();
    markSelected();
  });

  /* ---------- Índice ---------- */
  const listEl = $('#products');
  const listStatus = $('#products-status');
  const productsCount = $('#products-count');
  const zonesEl = $('#zones');
  let catalogRequest = 0;
  let keyboardSteps = 0;

  function rowHtml(p, i) {
    const soldOut = p.stock <= 0;
    // agotada: la etiqueta roja reemplaza a la que tenga (Nuevo, Oferta…)
    const tag = soldOut ? { text: 'Agotado', tone: 'out' } : tagFor(p);
    const action = soldOut ? `${p.name}: agotado` : `Añadir ${p.name} al carrito`;
    const inDrop = dropsWith(p.id).length > 0;
    const flags = `${progress.hasSeen(p.id) ? ' is-seen' : ''}${state.owned.has(p.id) ? ' is-owned' : ''}`;
    const srState = state.owned.has(p.id) ? ', en el carrito' : progress.hasSeen(p.id) ? ', vista' : '';
    const tone = toneOf(p) ? `;--tone:${toneOf(p)}` : '';
    return `
      <li class="row${flags}" data-id="${esc(p.id)}" data-zone="${esc(p.category)}" style="--i:${i}${tone}">
        <button class="row__main" type="button" aria-controls="viewer">
          <span class="row__n mono"><i class="mark" aria-hidden="true"></i>${esc(entryNo(p))}</span>
          <span class="row__thumb" aria-hidden="true">${thumb(p)}</span>
          <span class="row__name">${esc(p.name)}${tag ? `<span class="row__tag" data-tone="${tag.tone}">${esc(tag.text)}</span>` : ''}${inDrop ? '<span class="row__tag" data-tone="drop">Drop</span>' : ''}<span class="sr-only">${srState}</span></span>
          <span class="row__zone mono">${esc(p.subtitle)}</span>
          <span class="row__rar">${pips(p.rarity)}</span>
          <span class="row__price mono">${money(p.priceCents)}</span>
        </button>
        <button class="row__add" type="button" ${p.sizes ? `data-pick-size="${esc(p.id)}"` : `data-add="${esc(p.id)}"`} data-name="${esc(p.name)}" aria-label="${esc(p.sizes && !soldOut ? `Elegir la talla de ${p.name}` : action)}"${soldOut ? ' disabled' : ''}>
          <svg aria-hidden="true"><use href="#u-cart"/></svg>
        </button>
      </li>`;
  }

  function setListStatus(html, stateName) {
    listStatus.innerHTML = html;
    listStatus.hidden = !html;
    if (stateName) listStatus.dataset.state = stateName;
    else delete listStatus.dataset.state;
  }

  function renderList() {
    const items = state.products;
    listEl.innerHTML = items.map(rowHtml).join('');
    productsCount.textContent = `${pad(state.matched)} ${state.matched === 1 ? 'entrada' : 'entradas'}`;
    if (items.length) setListStatus('');
    else if (state.query.trim()) setListStatus(`&gt; 0 coincidencias para “${esc(state.query.trim())}”. Ni con un 20 natural.`);
    else setListStatus(`&gt; ${esc(copy('indice.empty', 'esta zona está vacía por ahora. Vuelve el viernes.'))}`);
    markSelected();
    if (items.some((p) => p.id === state.selectedId)) $('#v-pos').textContent = positionOf(state.selectedId);
    renderPager();
  }

  /** Páginas del índice (solo si hay más de PER_PAGE piezas): anterior, los números (con … si son muchas) y siguiente. */
  const pager = $('#pager');
  function renderPager() {
    const { page, pages } = state;
    pager.hidden = pages <= 1;
    if (pages <= 1) {
      pager.innerHTML = '';
      return;
    }
    const nums = [];
    for (let n = 1; n <= pages; n += 1) {
      if (n === 1 || n === pages || Math.abs(n - page) <= 1) nums.push(n);
      else if (nums[nums.length - 1] !== '…') nums.push('…');
    }
    pager.innerHTML = `
      <button class="pager__step" type="button" data-page="${page - 1}"${page === 1 ? ' disabled' : ''}>← Anterior</button>
      <ol class="pager__list" role="list">${nums.map((n) => (n === '…'
        ? '<li class="pager__gap" aria-hidden="true">…</li>'
        : `<li><button class="pager__num" type="button" data-page="${n}" aria-label="Página ${n}"${n === page ? ' aria-current="page"' : ''}>${pad(n)}</button></li>`)).join('')}</ol>
      <button class="pager__step" type="button" data-page="${page + 1}"${page === pages ? ' disabled' : ''}>Siguiente →</button>`;
  }
  const currentZone = () => $('.zone[aria-pressed="true"]', zonesEl)?.dataset.filter ?? 'todo';
  pager.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-page]');
    if (btn && !btn.disabled) loadCatalog(currentZone(), { page: Number(btn.dataset.page), scroll: true });
  });

  function renderCounts(counts, total) {
    state.counts = { counts, total };
    $$('[data-count]').forEach((el) => {
      const key = el.dataset.count;
      el.textContent = num(key === 'total' ? total : counts[key] ?? 0);
    });
  }

  /** Una página del índice: la zona elegida, lo que dice el buscador (en todo el archivo) y el número de página. */
  async function loadCatalog(category = 'todo', { page = 1, scroll = false } = {}) {
    const request = ++catalogRequest;
    listEl.setAttribute('aria-busy', 'true');
    const params = new URLSearchParams({ limit: String(PER_PAGE), page: String(page) });
    if (category !== 'todo') params.set('category', category);
    if (state.query.trim()) params.set('q', state.query.trim());
    if (!state.indexLoaded) params.set('index', '1');
    try {
      const data = await api(`/api/catalog?${params}`);
      if (request !== catalogRequest) return; // llegó una respuesta más nueva
      state.products = data.products;
      state.page = data.page;
      state.pages = data.pages;
      state.matched = data.matched;
      state.total = data.total;
      data.products.forEach((p) => state.known.set(p.id, p));
      if (data.index) {
        state.indexLoaded = true;
        state.allIds = new Set(data.index);
        progress.setIndex(state.allIds); // base de Curador y Archivo completo (igual que INDEX_SIZE en el servidor)
      }
      renderCounts(data.counts, data.total);
      renderList();
      updateRegistry();
      if (scroll) goTo('#indice');
    } catch (err) {
      if (request !== catalogRequest) return;
      listEl.innerHTML = '';
      setListStatus(`&gt; error: ${esc(err.message)}<button class="btn" type="button" data-retry>Reintentar</button>`, 'error');
    } finally {
      if (request === catalogRequest) listEl.setAttribute('aria-busy', 'false');
    }
  }

  function setZone(filter) {
    $$('.zone[data-filter]', zonesEl).forEach((z) => z.setAttribute('aria-pressed', String(z.dataset.filter === filter)));
    return loadCatalog(filter);
  }
  zonesEl.addEventListener('click', (e) => {
    const zone = e.target.closest('.zone[data-filter]');
    if (zone) setZone(zone.dataset.filter);
  });

  /** Filtros del índice: «Todo» y una pestaña por zona, en el orden de la curaduría. */
  function renderZones() {
    const current = $('.zone[aria-pressed="true"]', zonesEl)?.dataset.filter ?? 'todo';
    const active = current === 'todo' || current in ZONES ? current : 'todo';
    zonesEl.innerHTML = [
      `<button class="zone" type="button" data-filter="todo" aria-pressed="${active === 'todo'}">Todo<sup data-count="total">—</sup></button>`,
      ...zoneList.map((z) => `<button class="zone" type="button" data-filter="${esc(z.key)}" data-zone="${esc(z.key)}" aria-pressed="${active === z.key}"><span>${esc(z.label)}</span><sup data-count="${esc(z.key)}">—</sup></button>`),
    ].join('');
    if (state.counts) renderCounts(state.counts.counts, state.counts.total);
    if (active !== current) setZone('todo'); // la zona que se estaba viendo ya no existe
  }

  /** El color de cada zona tiñe todo lo que lleva data-zone: filas, visor, filtros, drops, ladrillos del arcade. */
  function paintZoneTones() {
    let tag = $('#dz-zones');
    if (!tag) {
      tag = document.createElement('style');
      tag.id = 'dz-zones';
      document.head.append(tag);
    }
    tag.textContent = zoneList.filter((z) => HEX_RE.test(z.color)).map((z) => `[data-zone="${z.key}"]{--tone:${z.color}}`).join('\n');
  }
  renderZones();
  listStatus.addEventListener('click', (e) => {
    if (e.target.closest('[data-retry]')) setZone($('.zone[aria-pressed="true"]')?.dataset.filter ?? 'todo');
  });

  // Pasar el ratón por una fila no mueve el visor, pero deja recortada su portada para cuando hagas clic
  listEl.addEventListener('pointerover', (e) => {
    const id = e.target.closest?.('.row')?.dataset.id;
    const url = id ? findProduct(id)?.images?.[0]?.url : null;
    if (url) trimmed(url);
  });

  // El visor cambia al hacer clic (o Enter) en una fila; pasar el ratón no lo mueve, así lo que estás
  // viendo no se pierde al cruzar el índice. En móvil el clic abre la hoja.
  listEl.addEventListener('click', (e) => {
    const main = e.target.closest('.row__main');
    if (main) select(main.closest('.row').dataset.id, { open: true });
    // el «+» de una pieza con tallas abre el visor para elegirla antes de añadir
    const pick = e.target.closest('[data-pick-size]');
    if (!pick || pick.disabled) return;
    select(pick.dataset.pickSize, { open: true });
    if (!state.size.get(pick.dataset.pickSize)) notify(`Elige la talla de ${pick.dataset.name}.`, { tag: 'talla' });
    requestAnimationFrame(() => $('.size:not(:disabled)', sizeList)?.focus());
  });
  // ↑ ↓ o j k para moverse entre filas: j sube y k baja
  listEl.addEventListener('keydown', (e) => {
    const step = { ArrowDown: 1, k: 1, ArrowUp: -1, j: -1 }[e.key];
    if (!step || e.ctrlKey || e.metaKey || e.altKey) return;
    const current = e.target.closest('.row__main');
    if (!current) return;
    const mains = $$('.row__main', listEl);
    const next = mains[mains.indexOf(current) + step];
    if (next) {
      e.preventDefault();
      next.focus();
      if (desktop.matches) select(next.closest('.row').dataset.id); // el visor sigue al teclado
      keyboardSteps += 1;
      if (keyboardSteps >= 5) unlock('sin-raton');
    }
  });

  // el buscador mira todo el archivo (no solo esta página): pide la primera página de resultados al dejar de escribir
  const search = $('#search');
  let searchTimer = 0;
  search.addEventListener('input', () => {
    state.query = search.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadCatalog(currentZone()), 250);
  });

  /* ---------- Drops: bundles de piezas del índice con precio rebajado ---------- */
  const dropsList = $('#drops-list');
  const dropsStatus = $('#drops-status');
  const noDropText = () => copy('drops.empty', 'Sin drop activo. El próximo se está cocinando.');

  /** Miniatura de una pieza del bundle: su foto o su ilustración line-art. */
  function thumb(p) {
    if (p.images?.length) return `<img src="${esc(p.images[0].url)}" alt="" loading="lazy" decoding="async">`;
    const icon = ICONS.has(p.icon) ? p.icon : 'mecha';
    return `<svg class="ill" viewBox="-4 -4 128 128" aria-hidden="true"><use href="#i-${icon}" width="120" height="120"/></svg>`;
  }

  function dropCard(d) {
    const save = saving(d);
    const { left } = dropStock(d);
    const { label, disabled, out } = dropBuyState(d, 'Añadir el drop al carrito');
    const pieces = d.items.map((p) => `
      <li data-zone="${esc(p.category)}"${toneOf(p) ? ` style="--tone:${toneOf(p)}"` : ''}>
        <button class="drop__piece" type="button" data-view="${esc(p.id)}" aria-label="Ver ${esc(p.name)} en el visor">
          <span class="drop__thumb">${thumb(p)}</span>
          <span class="drop__piece-n mono">nº ${esc(entryNo(p))}</span>
          <span class="drop__piece-name">${esc(p.name)}</span>
          <span class="drop__piece-price mono">${money(p.priceCents)}</span>
        </button>
      </li>`).join('');
    return `
      <li class="drop" id="${esc(d.code)}">
        <p class="drop__head mono"><span>Drop #${pad(d.number, 3)} · ${pad(d.items.length)} piezas</span><span>cierra en <b data-ends="${esc(d.endsAt)}">${countdown(d.endsAt)}</b></span></p>
        <h3 class="drop__title">${esc(d.title)}</h3>
        ${d.specs ? `<p class="drop__specs">${esc(d.specs)}</p>` : ''}
        <ol class="drop__pieces" role="list">${pieces}</ol>
        <div class="drop__foot">
          <div class="drop__deal">
            <p class="drop__price"><s class="mono">${money(d.regularCents)}</s> <b>${money(d.priceCents)}</b></p>
            ${save ? `<p class="drop__save mono">−${save.pct}% · ahorras ${money(save.cents)}</p>` : ''}
            ${dropPerk(d) ? `<p class="drop__perk mono">${dropPerk(d)}</p>` : ''}
          </div>
          <div class="drop__stock${left ? '' : ' is-out'}">
            <p class="drop__left mono"><b>${num(left)}</b> ${left === 1 ? 'drop disponible' : 'drops disponibles'}</p>
          </div>
          <button class="buy drop__buy${out ? ' is-out' : ''}" type="button" data-add-drop="${esc(d.code)}"${disabled ? ' disabled' : ''}>${label}</button>
        </div>
      </li>`;
  }

  /** La sección Drops. */
  function renderDrops() {
    const { drops } = state;
    dropsList.innerHTML = drops.map(dropCard).join('');
    dropsList.setAttribute('aria-busy', 'false');
    dropsStatus.hidden = drops.length > 0;
    delete dropsStatus.dataset.state;
    if (!drops.length) dropsStatus.innerHTML = `&gt; ${esc(noDropText())} <a class="link" href="#correo">Avísame por correo →</a>`;
  }

  /** Todo lo que depende de los drops: su sección, las etiquetas del índice y la ficha abierta. */
  function renderDropsUI() {
    renderDrops();
    if (listEl.getAttribute('aria-busy') === 'false') renderList();
    const current = findProduct(state.selectedId);
    if (current) renderViewer(current);
  }

  async function loadDrops() {
    try {
      ({ drops: state.drops } = await api('/api/drops'));
      state.dropsLoaded = true;
      renderDropsUI();
    } catch (err) {
      dropsList.setAttribute('aria-busy', 'false');
      dropsStatus.hidden = false;
      dropsStatus.dataset.state = 'error';
      dropsStatus.textContent = `> error: ${err.message}`;
    }
  }

  /** Cada cuenta regresiva sabe su cierre (data-ends); cuando un drop llega a cero deja de venderse. */
  function tickCountdown() {
    let closed = false;
    $$('[data-ends]').forEach((el) => {
      const text = countdown(el.dataset.ends);
      if (text === 'cerrado' && el.textContent !== 'cerrado') closed = true;
      el.textContent = text;
    });
    if (closed) renderDropsUI();
  }
  setInterval(tickCountdown, 1000);

  dropsList.addEventListener('click', (e) => {
    const piece = e.target.closest('[data-view]');
    if (piece) select(piece.dataset.view, { open: true });
  });
  // desde la ficha: en móvil la hoja del visor se cierra para ver el drop
  viewer.addEventListener('click', (e) => {
    const link = e.target.closest('[data-goto-drop]');
    if (!link) return;
    closeSheet();
    goTo(`#${link.dataset.gotoDrop}`);
  });

  /* ---------- Carrito ---------- */
  const cartEl = $('#cart');
  const cartList = $('#cart-list');
  const cartSubtotal = $('#cart-subtotal');
  const cartBtn = $('.bar__cart');
  let cartOpener = null;

  const removedNote = (n) => (n === 1
    ? 'Una pieza de tu carrito ya no está en el archivo: la quitamos.'
    : `${n} piezas de tu carrito ya no están en el archivo: las quitamos.`);

  function applyCart(cart) {
    if (cart.removed) notify(removedNote(cart.removed), { tag: 'retiradas' }); // piezas o drops que la curaduría borró
    // las piezas de un bundle también cuentan como «en el carrito»
    state.owned = new Set(cart.items.flatMap((i) => (i.drop ? (i.closed ? [] : i.includes.map((x) => x.id)) : [i.id])));
    state.slots = cart.items.length;
    $$('[data-cart-count]').forEach((el) => { el.textContent = String(cart.count); });
    cartBtn.setAttribute('aria-label', `Carrito, ${cart.count} ${cart.count === 1 ? 'pieza' : 'piezas'}`);
    $('#cart-slots').textContent = `${pad(state.slots)}/${MAX_SLOTS}`;
    $$('.row').forEach((row) => row.classList.toggle('is-owned', state.owned.has(row.dataset.id)));
    const pay = $('#cart-pay');
    pay.setAttribute('aria-disabled', String(!cart.count));
    if (cart.count) pay.removeAttribute('tabindex');
    else pay.setAttribute('tabindex', '-1');
    state.cart = cart;
    paintCartPerk();
    updateRegistry();
  }

  /** Bajo el subtotal: qué hace tu nivel al pagar (o qué haría tener credencial). */
  function paintCartPerk() {
    const el = $('#cart-perk');
    // pagar exige sesión: sin ella, el botón lleva a entrar y vuelve al pago
    const pay = $('#cart-pay');
    const signedIn = Boolean(progress.currentUser());
    pay.href = signedIn ? '/pago' : '/cuenta?next=pago#entrar';
    $('[data-pay-in]', pay).hidden = !signedIn;
    $('[data-pay-out]', pay).hidden = signedIn;
    if (!state.cart?.count) {
      el.hidden = true;
      return;
    }
    const perks = progress.perks();
    const parts = [
      perks.productPct ? `−${perks.productPct}% en piezas` : '',
      perks.dropPct ? `−${perks.dropPct}% en drops` : '',
      perks.freeShippingFrom ? `envío gratis desde ${money(perks.freeShippingFrom)}` : '',
    ].filter(Boolean);
    if (!progress.currentUser()) {
      el.innerHTML = 'Para pagar necesitas tu credencial (y pagas según tu nivel: Adepto −5% en piezas, Leyenda −10% en drops). <a class="link" href="/cuenta?next=pago#registro">Crear credencial</a>';
    } else if (parts.length) {
      el.textContent = `Lv ${pad(progress.stats().level)} · ${levelNow()}: ${parts.join(' · ')} al pagar.`;
    } else {
      el.textContent = 'Completa los 12 logros del archivo (Adepto) y paga 5% menos en las piezas.';
    }
    el.hidden = false;
  }

  function renderCart(cart) {
    cartList.innerHTML = cart.items.length
      ? cart.items.map((i) => {
        // agotada o retirada: sale en rojo, no suma al total y solo se puede quitar
        const out = i.out === 'agotado' ? 'agotado' : i.out ? 'no disponible' : '';
        const cls = [i.drop && 'cart__drop', i.closed && 'is-closed', out && 'is-out'].filter(Boolean).join(' ');
        const controls = i.closed || out ? '' : `
          <button type="button" data-step="-1" aria-label="Una unidad menos de ${esc(i.name)}"${i.qty <= 1 ? ' disabled' : ''}>−</button>
          <b class="mono" aria-label="${i.qty} ${i.qty === 1 ? 'unidad' : 'unidades'}">${i.qty}</b>
          <button type="button" data-step="1" aria-label="Una unidad más de ${esc(i.name)}"${i.qty >= MAX_QTY ? ' disabled' : ''}>+</button>`;
        return `
          <li${cls ? ` class="${cls}"` : ''} data-kind="${i.drop ? 'drop' : 'product'}" data-id="${esc(i.drop ?? i.id)}" data-size="${esc(i.size ?? '')}" data-qty="${i.qty}">
            <span class="cart__item-name">${esc(i.name)}</span>
            <span class="cart__item-total mono">${i.closed ? 'drop cerrado' : out || money(i.qty * i.priceCents)}</span>
            <span class="cart__item-meta mono">${i.qty} × ${money(i.priceCents)}${i.drop ? ` · ${esc(i.includes.map((x) => x.name).join(' + '))}` : ''}</span>
            <span class="cart__qty">${controls}<button class="link mono" type="button" data-remove aria-label="Quitar ${esc(i.name)} del carrito">Quitar</button></span>
          </li>`;
      }).join('')
      : `<li class="cart__empty mono">${esc(copy('inventario.empty', 'Carrito vacío. Ve a lootear al índice.'))}</li>`;
    cartSubtotal.textContent = money(cart.subtotalCents);
  }

  // − / + / Quitar: el servidor fija las unidades (y libera el apartado de un drop)
  cartList.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-step], [data-remove]');
    const li = btn?.closest('li[data-id]');
    if (!btn || !li || btn.disabled) return;
    const qty = btn.hasAttribute('data-remove') ? 0 : Number(li.dataset.qty) + Number(btn.dataset.step);
    const isDrop = li.dataset.kind === 'drop';
    const name = $('.cart__item-name', li).textContent;
    li.setAttribute('aria-busy', 'true');
    $$('button', li).forEach((b) => { b.disabled = true; });
    try {
      const body = isDrop ? { dropCode: li.dataset.id, qty } : { productId: li.dataset.id, qty, ...(li.dataset.size ? { size: li.dataset.size } : {}) };
      const { cart } = await api('/api/cart', { method: 'PATCH', body });
      applyCart(cart);
      renderCart(cart);
      if (!isDrop) {
        const current = findProduct(state.selectedId);
        if (current) renderBuy(current);
      }
      if (!qty) notify(`${name} salió del carrito.`, { tag: 'baja' });
      const again = $(`li[data-id="${CSS.escape(li.dataset.id)}"][data-size="${CSS.escape(li.dataset.size)}"] [data-step="${btn.dataset.step}"]`, cartList);
      (again && !again.disabled ? again : $('.cart__close')).focus(); // el foco no se pierde al repintar
    } catch (err) {
      notify(err.message, { tone: 'error' });
      const cart = await loadCart();
      if (cart) renderCart(cart);
    }
  });

  async function loadCart() {
    try {
      const cart = await api('/api/cart');
      applyCart(cart);
      return cart;
    } catch {
      return null; // el contador se queda en 0; no bloquea la página
    }
  }

  async function openCart() {
    cartOpener = openerFor(cartBtn);
    cartList.innerHTML = '<li class="cart__empty mono">&gt; abriendo tu carrito<span class="cursor" aria-hidden="true"></span></li>';
    cartEl.hidden = false;
    document.body.classList.add('is-locked');
    if (!PREVIEW) $('.cart__close').focus(); // en la vista previa el foco se queda en el formulario
    const cart = await loadCart();
    if (cart) renderCart(cart);
    else cartList.innerHTML = '<li class="cart__empty mono">No pudimos abrir tu carrito. Intenta de nuevo.</li>';
  }
  function closeCart() {
    if (cartEl.hidden) return;
    cartEl.hidden = true;
    if (!viewer.classList.contains('is-open')) document.body.classList.remove('is-locked');
    if (cartOpener?.isConnected && !PREVIEW) cartOpener.focus();
  }
  cartBtn.addEventListener('click', openCart);
  cartEl.addEventListener('click', (e) => { if (e.target.closest('[data-close-cart]')) closeCart(); });

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-add], [data-add-drop]');
    if (!btn || btn.disabled || btn.getAttribute('aria-busy') === 'true') return;
    const dropCode = btn.dataset.addDrop;

    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;
    try {
      const body = dropCode ? { dropCode } : { productId: btn.dataset.add, ...(btn.dataset.size ? { size: btn.dataset.size } : {}) };
      const { cart, added } = await api('/api/cart', { method: 'POST', body });
      applyCart(cart);
      notify(`${added.name} → carrito · slot ${pad(cart.items.length)}/${MAX_SLOTS}`, { tag: `+${added.qty}` });
      unlock('primer-botin');
    } catch (err) {
      notify(err.message, { tone: 'error' });
    } finally {
      btn.removeAttribute('aria-busy');
      btn.disabled = false;
      if (dropCode) renderDropsUI(); // los botones de los drops se vuelven a pintar con su estado
      else {
        const current = findProduct(state.selectedId);
        if (current) renderBuy(current);
      }
    }
  });


  /* ---------- Menú móvil ---------- */
  const menu = $('#menu');
  const menuBtn = $('.bar__menu');
  const setMenu = (open, restoreFocus = true) => {
    menu.hidden = !open;
    menuBtn.setAttribute('aria-expanded', String(open));
    menuBtn.textContent = open ? 'Cerrar' : 'Menú';
    document.body.classList.toggle('is-locked', open);
    if (open) menu.querySelector('a').focus();
    else if (restoreFocus) menuBtn.focus();
  };
  menuBtn.addEventListener('click', () => setMenu(menu.hidden));
  $('.menu__close').addEventListener('click', () => setMenu(false));
  menu.addEventListener('click', (e) => { if (e.target.closest('a')) setMenu(false, false); });

  /* ---------- Modo arcade ---------- */
  function setArcade(on) {
    document.documentElement.classList.toggle('is-arcade', on);
    return on;
  }

  /* ---------- Terminal de comandos (Ctrl/⌘ K o ":") ---------- */
  const termInput = $('#term-input');
  const termList = $('#term-list');
  const termOut = $('#term-out');
  let termOpener = null;
  let termMatches = [];
  let termIndex = 0;

  const findPiece = (q) => {
    const needle = fold(q.trim());
    const pool = [...state.products, ...state.known.values()];
    return pool.find((p) => entryNo(p) === needle || fold(p.sku) === needle)
      ?? pool.find((p) => fold(p.name).includes(needle));
  };

  const SECTIONS = [
    ['indice', 'Ir al índice de piezas'], ['drops', 'Ir a los drops: bundles más baratos juntos'], ['niveles', 'Ir a los niveles de la credencial'],
    ['logros', 'Ir a los logros'], ['encargos', 'Ir a encargos: pide una pieza que no está'], ['visita', 'Ir a Visítanos: la tienda en el mapa'],
    ['correo', 'Ir al correo: avisos de cada drop'], ['arcade', 'Ir al arcade: la moneda del día'],
  ];
  const termCurator = () => (progress.currentUser() ?? state.user)?.role === 'admin';
  // `desc` puede ser una función: los ejemplos salen de las zonas y piezas que hay de verdad
  const COMMANDS = [
    ...SECTIONS.map(([s, desc]) => ({ cmd: `ir ${s}`, desc, run: () => goTo(`#${s}`) })),
    {
      cmd: 'zona', arg: '<nombre>', desc: () => `Filtrar el índice por zona · ej. zona ${state.site && zoneList[0] ? fold(zoneList[0].label) : 'todo'}`,
      run: (q) => {
        const needle = fold(q.trim());
        const key = needle === 'todo' ? 'todo'
          : (zoneList.find((z) => z.key === needle || fold(z.label) === needle) ?? zoneList.find((z) => fold(z.label).startsWith(needle)))?.key;
        if (!key) return { keep: true, error: `no hay ninguna zona «${q}». Zonas: ${zoneList.map((z) => z.label).join(', ')}.` };
        setZone(key);
        goTo('#indice');
        return null;
      },
    },
    {
      cmd: 'buscar', arg: '<texto>', desc: 'Buscar piezas por nombre o SKU en todo el índice',
      run: (q) => { search.value = q; state.query = q; loadCatalog(currentZone()); goTo('#indice'); },
    },
    {
      cmd: 'ver', arg: '<nº o nombre>', desc: () => `Abrir una pieza en el visor · ej. ver ${state.products[0] ? entryNo(state.products[0]) : 'camiseta'}`,
      run: (q) => {
        const p = findPiece(q);
        if (p) {
          select(p.id, { open: true });
          if (desktop.matches) goTo('#indice');
          return null;
        }
        // puede estar en otra página: se busca en todo el archivo
        api(`/api/catalog?limit=1&q=${encodeURIComponent(q)}`)
          .then(({ products: [found] }) => {
            if (!found) {
              notify(`No hay ninguna entrada que coincida con «${q}».`, { tone: 'error' });
              return;
            }
            state.known.set(found.id, found);
            select(found.id, { open: true });
          })
          .catch((err) => notify(err.message, { tone: 'error' }));
        return null;
      },
    },
    {
      cmd: 'azar', desc: 'Tirar 1d20 y abrir una pieza al azar',
      run: () => {
        if (!state.products.length) return { keep: true, error: 'el índice aún no carga.' };
        const roll = 1 + Math.floor(Math.random() * 20);
        const p = state.products[Math.floor(Math.random() * state.products.length)];
        select(p.id, { open: true });
        if (desktop.matches) goTo('#indice');
        const extra = roll === 20 ? ' · ¡crítico!' : roll === 1 ? ' · pifia' : '';
        notify(`1d20 → ${roll}${extra} · ${p.name}`, { tag: 'd20' });
        return null;
      },
    },
    { cmd: 'carrito', desc: 'Abrir tu carrito', run: () => { openCart(); } },
    { cmd: 'cuenta', desc: 'Tu credencial de jugador: entrar, registrarte o verla', run: () => { window.location.href = '/cuenta'; } },
    { cmd: 'pedidos', desc: 'Ver tus pedidos y cómo va cada envío', run: () => { window.location.href = '/cuenta#pedidos'; } },
    { cmd: 'curaduria', desc: 'Abrir el panel de la curaduría', admin: true, run: () => { window.location.href = '/admin'; } },
    {
      cmd: 'modo arcade', desc: 'Prender o apagar el modo arcade: scanlines y tipografía de 8 bits',
      run: () => notify(setArcade(!document.documentElement.classList.contains('is-arcade')) ? 'Modo arcade prendido: scanlines y 8 bits.' : 'Modo arcade apagado.', { tag: 'crt' }),
    },
    {
      cmd: 'ayuda', desc: 'Ver todos los comandos',
      run: () => { termInput.value = ''; renderTerm(); return { keep: true, out: `${available().length} comandos · ↑ ↓ elegir · Tab completar · Enter ejecutar.` }; },
    },
  ];
  /** Los comandos de la curaduría solo se ven con una credencial de la curaduría. */
  const available = () => COMMANDS.filter((c) => !c.admin || termCurator());
  const descOf = (c) => (typeof c.desc === 'function' ? c.desc() : c.desc);

  function matchCommands(value) {
    const v = fold(value.trim());
    if (!v) return available();
    const head = v.split(' ')[0];
    return available().filter((c) => {
      const cmd = fold(c.cmd);
      return cmd.startsWith(v) || (c.arg && v.startsWith(`${cmd} `)) || cmd.includes(v) || (head.length > 1 && cmd.startsWith(head));
    });
  }

  function renderTerm() {
    termMatches = matchCommands(termInput.value);
    termIndex = Math.min(termIndex, Math.max(0, termMatches.length - 1));
    termList.innerHTML = termMatches.map((c, i) => `
      <li id="term-opt-${i}" role="option" aria-selected="${i === termIndex}" data-i="${i}">
        <span>${esc(c.cmd)}${c.arg ? ` <span class="muted">${esc(c.arg)}</span>` : ''}</span><span>${esc(descOf(c))}</span>
      </li>`).join('');
    termInput.setAttribute('aria-activedescendant', termMatches.length ? `term-opt-${termIndex}` : '');
    termList.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  function termPrint(text, isError = false) {
    termOut.textContent = text ? `> ${text}` : '';
    if (isError) termOut.dataset.state = 'error';
    else delete termOut.dataset.state;
  }

  function execute(value) {
    const raw = value.trim();
    const v = fold(raw);
    // comando con argumento escrito completo: "buscar mecha", "ver 0412"
    const withArg = available().find((c) => c.arg && v.startsWith(`${fold(c.cmd)} `) && raw.length > c.cmd.length + 1);
    const exact = available().find((c) => fold(c.cmd) === v);
    let command = withArg ?? exact;
    let arg = withArg ? raw.slice(withArg.cmd.length + 1).trim() : '';

    if (!command) {
      const picked = termMatches[termIndex];
      if (!picked || !raw) {
        termPrint(raw ? `comando no encontrado: "${raw}". escribe ayuda.` : 'escribe un comando o elige uno de la lista.', true);
        return;
      }
      command = picked;
      arg = '';
    }
    if (command.arg && !arg) {
      termInput.value = `${command.cmd} `; // pide el argumento
      renderTerm();
      termPrint(`${command.cmd} necesita ${command.arg}.`);
      return;
    }

    const result = command.run(arg);
    unlock('hola-terminal');
    if (result?.keep) {
      termPrint(result.error ?? result.out ?? '', Boolean(result.error));
      if (!result.error) termInput.select();
      return;
    }
    closeTerm(false);
  }

  function openTerm() {
    if (!term.hidden) return;
    termOpener = document.activeElement;
    if (!menu.hidden) setMenu(false, false);
    term.hidden = false;
    document.body.classList.add('is-locked');
    termInput.value = '';
    termIndex = 0;
    termPrint('');
    renderTerm();
    termInput.focus();
  }
  function closeTerm(restoreFocus = true) {
    if (term.hidden) return;
    term.hidden = true;
    if (cartEl.hidden && !viewer.classList.contains('is-open')) document.body.classList.remove('is-locked');
    if (restoreFocus && termOpener?.isConnected) termOpener.focus();
  }

  $$('[data-open-term]').forEach((b) => b.addEventListener('click', openTerm));
  term.addEventListener('click', (e) => {
    if (e.target.closest('[data-close-term]')) closeTerm();
    const opt = e.target.closest('[role="option"]');
    if (opt) {
      termIndex = Number(opt.dataset.i);
      const c = termMatches[termIndex];
      if (c?.arg) {
        termInput.value = `${c.cmd} `;
        renderTerm();
        termInput.focus();
      } else if (c) {
        execute(c.cmd);
      }
    }
  });
  termInput.addEventListener('input', () => {
    termIndex = 0;
    termPrint('');
    renderTerm();
  });
  termInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!termMatches.length) return;
      termIndex = (termIndex + (e.key === 'ArrowDown' ? 1 : -1) + termMatches.length) % termMatches.length;
      renderTerm();
    } else if (e.key === 'Tab' && termMatches[termIndex]) {
      e.preventDefault();
      const c = termMatches[termIndex];
      termInput.value = c.arg ? `${c.cmd} ` : c.cmd;
      renderTerm();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      execute(termInput.value);
    }
  });

  /* ---------- Código Konami ---------- */
  const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
  let konamiPos = 0;
  function konami() {
    setArcade(true);
    renderSecret();
    if (desktop.matches) window.scrollTo({ top: 0, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
    notify('↑↑↓↓←→←→BA · modo arcade', { tag: '1up' });
    unlock('viejo-truco');
  }

  /* ---------- Arcade: Breakout, Snake y Pac-Man con una moneda al día ---------- */
  // El XP de cada juego usa los mismos números que ARCADE_GAMES en lib/achievements.js.
  // Los juegos se dibujan en una pantalla de 192 × 126 píxeles de arcade que se amplía sin suavizar.
  (() => {
    const canvas = $('#arcade-canvas');
    if (!canvas) return;
    const screen = canvas.getContext('2d');
    const W = 192;
    const H = 126;
    const buffer = document.createElement('canvas');
    buffer.width = W;
    buffer.height = H;
    const ctx = buffer.getContext('2d');
    const cab = $('#cab');
    const screenEl = $('.cab__screen', cab);
    const msg = $('#arcade-msg');
    const coinBtn = $('#arcade-coin');
    const coinLabel = $('#arcade-coin-label');
    const note = $('#arcade-note');
    const pickEl = $('#arcade-games');
    const rulesEl = $('#arcade-rules');
    const LOCAL_KEY = 'dz.arcade'; // sin sesión: el día en que se usó la moneda en este navegador
    const GAME_KEY = 'dz.arcade.game'; // el último juego elegido
    const DIRS = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
    const rand = (n) => Math.floor(Math.random() * n);
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    /** Los colores de las zonas, en su orden: tiñen ladrillos, manzanas y fantasmas. */
    function palette() {
      const colors = zoneList.map((z) => z.color).filter((c) => HEX_RE.test(c ?? ''));
      return colors.length ? colors : ['#3db8f5', '#ff5c9d', '#ffb238', '#a78bfa', '#4ade80'];
    }
    /** Un rectángulo en píxeles enteros (nada cae entre dos píxeles). */
    function px(x, y, w, h, color) {
      ctx.fillStyle = color;
      ctx.fillRect(Math.round(x), Math.round(y), w, h);
    }
    /**
     * Sprite en pixel art: cada carácter es un color de `colors` (los que no están, transparentes).
     * `flip`: espejo horizontal · `turn`: 1 gira 90° a la derecha, 3 a la izquierda (sprites cuadrados).
     */
    function sprite(rows, x, y, colors, { flip = false, turn = 0 } = {}) {
      const n = rows.length;
      const m = rows[0].length;
      const ox = Math.round(x);
      const oy = Math.round(y);
      for (let r = 0; r < n; r += 1) {
        for (let c = 0; c < m; c += 1) {
          const color = colors[rows[r][c]];
          if (!color) continue;
          let cx = flip ? m - 1 - c : c;
          let cy = r;
          if (turn === 1) [cx, cy] = [n - 1 - cy, cx];
          else if (turn === 3) [cx, cy] = [cy, m - 1 - cx];
          ctx.fillStyle = color;
          ctx.fillRect(ox + cx, oy + cy, 1, 1);
        }
      }
    }

    /*
     * Cada juego: reset() (partida nueva), respawn() (tras perder una vida), launch(), key(dir, down),
     * update(dt, ready) → null | 'died' | 'cleared' | 'over', draw(mode) y `score` (lo que vale XP).
     * `aim`: la paleta sigue al puntero · `steer`: una dirección también arranca la partida.
     */

    /* ===== Breakout: la paleta, la bola y 40 ladrillos ===== */
    function breakout() {
      const COLS = 8;
      const ROWS = 5;
      const BRICK = { w: 20, h: 6, gap: 2, side: 9, top: 10 };
      const PAD = { w: 28, h: 3, y: H - 10 };
      const BALL = 3;
      const SPEED = { ball: 100, max: 180, paddle: 168 }; // píxeles por segundo
      const keys = { left: false, right: false };
      let bricks = [];
      let paddle = W / 2;
      let ball = null;
      const g = { score: 0, total: COLS * ROWS, aim: true };
      const stick = () => { ball = { x: paddle, y: PAD.y - BALL / 2 - 0.5, vx: 0, vy: 0 }; };

      g.reset = () => {
        const colors = palette();
        bricks = [];
        for (let r = 0; r < ROWS; r += 1) {
          for (let c = 0; c < COLS; c += 1) {
            bricks.push({ x: BRICK.side + c * (BRICK.w + BRICK.gap), y: BRICK.top + r * (BRICK.h + BRICK.gap), w: BRICK.w, h: BRICK.h, alive: true, color: colors[r % colors.length] });
          }
        }
        g.score = 0;
        paddle = W / 2;
        stick();
      };
      g.respawn = stick;
      g.launch = () => {
        const angle = (Math.random() - 0.5) * (Math.PI / 3);
        ball.vx = SPEED.ball * Math.sin(angle);
        ball.vy = -SPEED.ball * Math.cos(angle);
      };
      g.key = (k, down) => { if (k === 'left' || k === 'right') keys[k] = down; };
      g.release = () => { keys.left = false; keys.right = false; };
      g.pointer = (x) => { paddle = x; };

      function step(h) {
        const r = BALL / 2;
        ball.x += ball.vx * h;
        ball.y += ball.vy * h;
        if (ball.x < r) { ball.x = r; ball.vx = Math.abs(ball.vx); }
        else if (ball.x > W - r) { ball.x = W - r; ball.vx = -Math.abs(ball.vx); }
        if (ball.y < r) { ball.y = r; ball.vy = Math.abs(ball.vy); }
        // la paleta: según dónde pega, la bola sale más recta o más de lado (hasta 60°)
        if (ball.vy > 0 && ball.y + r >= PAD.y && ball.y - r <= PAD.y + PAD.h && Math.abs(ball.x - paddle) <= PAD.w / 2 + r) {
          const hit = clamp((ball.x - paddle) / (PAD.w / 2), -1, 1);
          const speed = Math.hypot(ball.vx, ball.vy);
          ball.vx = speed * Math.sin(hit * (Math.PI / 3));
          ball.vy = -speed * Math.cos(hit * (Math.PI / 3));
          ball.y = PAD.y - r;
        }
        for (const b of bricks) {
          if (!b.alive || ball.x + r < b.x || ball.x - r > b.x + b.w || ball.y + r < b.y || ball.y - r > b.y + b.h) continue;
          b.alive = false;
          g.score += 1;
          // rebota por el lado en que entró menos
          const dx = Math.min(ball.x + r - b.x, b.x + b.w - (ball.x - r));
          const dy = Math.min(ball.y + r - b.y, b.y + b.h - (ball.y - r));
          if (dx < dy) ball.vx = -ball.vx;
          else ball.vy = -ball.vy;
          const speed = Math.hypot(ball.vx, ball.vy);
          const faster = Math.min(SPEED.max, speed * 1.025) / speed; // cada ladrillo la acelera un poco
          ball.vx *= faster;
          ball.vy *= faster;
          return g.score === g.total ? 'cleared' : null;
        }
        return ball.y - r > H ? 'died' : null;
      }

      g.update = (dt, ready) => {
        const dir = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
        if (dir) paddle += dir * SPEED.paddle * dt;
        paddle = clamp(paddle, PAD.w / 2, W - PAD.w / 2);
        if (ready) {
          ball.x = paddle;
          return null;
        }
        // en pasos cortos para que la bola rápida no atraviese los ladrillos
        const steps = Math.max(1, Math.ceil(Math.hypot(ball.vx, ball.vy) * dt));
        for (let i = 0; i < steps; i += 1) {
          const result = step(dt / steps);
          if (result) return result;
        }
        return null;
      };

      g.draw = (mode) => {
        bricks.forEach((b) => {
          if (!b.alive) return;
          px(b.x, b.y, b.w, b.h, b.color);
          px(b.x, b.y, b.w, 1, 'rgba(255, 255, 255, .4)'); // luz arriba y sombra abajo, como un sprite
          px(b.x, b.y + b.h - 1, b.w, 1, 'rgba(0, 0, 0, .35)');
        });
        if (mode === 'idle') return;
        const left = paddle - PAD.w / 2;
        px(left, PAD.y, PAD.w, PAD.h, '#ededeb');
        px(left, PAD.y + PAD.h - 1, PAD.w, 1, '#2e9bda');
        if (mode !== 'over') {
          px(ball.x - 1.5, ball.y - 0.5, 3, 1, '#ffffff'); // bola en cruz, como en las máquinas de antes
          px(ball.x - 0.5, ball.y - 1.5, 1, 3, '#ffffff');
        }
      };
      return g;
    }
    /* ===== Snake: crece con cada manzana; los bordes y su propia cola terminan la partida ===== */
    const APPLE = [
      '...s..',
      '.aaaa.',
      'ahaaaa',
      'aaaaaa',
      'aaaaaa',
      '.aaaa.',
    ];
    function snake() {
      const C = 6; // una casilla: 6 × 6 píxeles
      const COLS = W / C; // 32
      const ROWS = H / C; // 21
      let body = [];
      let dir = DIRS.right;
      let queue = [];
      let apple = null;
      let timer = 0;
      let colors = palette();
      const g = { score: 0, total: 0, steer: true };

      function place() {
        const taken = new Set(body.map((s) => `${s.x},${s.y}`));
        const free = [];
        for (let y = 0; y < ROWS; y += 1) {
          for (let x = 0; x < COLS; x += 1) if (!taken.has(`${x},${y}`)) free.push({ x, y });
        }
        return free.length ? free[rand(free.length)] : null;
      }
      g.reset = () => {
        body = [{ x: 9, y: 10 }, { x: 8, y: 10 }, { x: 7, y: 10 }, { x: 6, y: 10 }];
        dir = DIRS.right;
        queue = [];
        timer = 0;
        g.score = 0;
        colors = palette();
        apple = place();
      };
      g.respawn = g.reset;
      g.key = (k, down) => {
        const d = DIRS[k];
        if (!down || !d || queue.length > 2) return;
        const prev = queue[queue.length - 1] ?? dir;
        if (d === prev || (d.x === -prev.x && d.y === -prev.y)) return; // no hay media vuelta
        queue.push(d);
      };
      g.update = (dt, ready) => {
        if (ready) return null;
        timer += dt;
        const every = Math.max(0.07, 0.14 - g.score * 0.002); // cada manzana lo acelera un poco
        while (timer >= every) {
          timer -= every;
          if (queue.length) dir = queue.shift();
          const head = { x: body[0].x + dir.x, y: body[0].y + dir.y };
          if (head.x < 0 || head.y < 0 || head.x >= COLS || head.y >= ROWS) return 'over';
          const eats = apple && head.x === apple.x && head.y === apple.y;
          const solid = eats ? body : body.slice(0, -1); // la cola se aparta, salvo cuando crece
          if (solid.some((s) => s.x === head.x && s.y === head.y)) return 'over';
          body.unshift(head);
          if (eats) {
            g.score += 1;
            apple = place();
            if (!apple) return 'cleared';
          } else body.pop();
        }
        return null;
      };
      g.draw = () => {
        if (apple) sprite(APPLE, apple.x * C, apple.y * C, { a: colors[g.score % colors.length], h: '#ffffff', s: '#4ade80' });
        // cada tramo es un bloque de 5 × 5 con 1 píxel de separación
        // verde: la cabeza más clara y el cuerpo en dos tonos que se alternan
        body.forEach((s, i) => px(s.x * C, s.y * C, C - 1, C - 1, i === 0 ? '#86efac' : i % 2 ? '#22c55e' : '#16a34a'));
        const hx = body[0].x * C;
        const hy = body[0].y * C;
        const ex = dir.x > 0 ? [3, 3] : dir.x < 0 ? [1, 1] : [1, 3];
        const ey = dir.y > 0 ? [3, 3] : dir.y < 0 ? [1, 1] : [1, 3];
        px(hx + ex[0], hy + ey[0], 1, 1, '#000000');
        px(hx + ex[1], hy + ey[1], 1, 1, '#000000');
      };
      return g;
    }
    /* ===== Pac-Man: 251 puntos en este laberinto, 4 fantasmas y los puntos grandes que los asustan ===== */
    const MAZE = [
      '############################',
      '#............##............#',
      '#.####.#####.##.#####.####.#',
      '#o####.#####.##.#####.####o#',
      '#..........................#',
      '#.####.##.########.##.####.#',
      '#......##....##....##......#',
      '######.#####.##.#####.######',
      '######.##..........##.######',
      '######.##.###--###.##.######',
      '..........#GGGGGG#..........', // el túnel: se sale por un lado y se entra por el otro
      '######.##.########.##.######',
      '######.##....P.....##.######',
      '######.##.########.##.######',
      '#............##............#',
      '#.####.#####.##.#####.####.#',
      '#o..##................##..o#',
      '###.##.##.########.##.##.###',
      '#......##....##....##......#',
      '#..........................#',
      '############################',
    ];
    /* Sprites de 7 × 7 mirando a la derecha (se giran y se reflejan para las otras direcciones) */
    const PAC = [
      ['..###..', '.#####.', '#######', '#######', '#######', '.#####.', '..###..'], // boca cerrada
      ['..###..', '.#####.', '#####..', '####...', '#####..', '.#####.', '..###..'], // entreabierta
      ['..###..', '.####..', '####...', '###....', '####...', '.####..', '..###..'], // abierta
    ];
    const GHOST = [
      ['..###..', '.#####.', '#ww#ww#', '#ww#ww#', '#######', '#######', '#.#.#.#'],
      ['..###..', '.#####.', '#ww#ww#', '#ww#ww#', '#######', '#######', '.#.#.#.'], // los pies se mueven
    ];
    const SCARED = [
      ['..###..', '.#####.', '#######', '#f###f#', '#######', '#f#f#f#', '#.#.#.#'],
      ['..###..', '.#####.', '#######', '#f###f#', '#######', '#f#f#f#', '.#.#.#.'],
    ];
    const WALL = '#2e9bda';
    function pacman() {
      const T = 6; // una casilla: 6 × 6 píxeles
      const COLS = MAZE[0].length; // 28
      const ROWS = MAZE.length; // 21
      const OX = (W - COLS * T) / 2;
      const SPEED = { pac: 6, ghost: 5.1, scared: 3.2 }; // casillas por segundo
      const REACH = 0.95; // a esta distancia (en casillas) Pac-Man toca a un fantasma
      const CORNERS = [{ x: COLS - 2, y: 0 }, { x: 1, y: 0 }, { x: COLS - 2, y: ROWS }, { x: 1, y: ROWS }];
      const pal = palette();
      const ghostColors = [0, 1, 2, 3].map((i) => pal[i] ?? ['#ff5c5c', '#ff9de2', '#5bd3ff', '#ffb238'][i]);
      const g = { score: 0, total: 0, steer: true };
      let dots = new Map(); // "x,y" → 'dot' | 'power'
      let pac = null;
      let ghosts = [];
      let fright = 0;
      let clock = 0;
      let layer = null; // el laberinto, pintado una sola vez
      let start = { x: 13, y: 12 };
      MAZE.forEach((row, y) => { const x = row.indexOf('P'); if (x >= 0) start = { x, y }; });

      const wall = (x, y) => y < 0 || y >= ROWS || '#G-'.includes(MAZE[y][(x + COLS) % COLS]);
      const opposite = (a, b) => Boolean(a && b) && a.x === -b.x && a.y === -b.y;
      const spot = (e) => ({ x: e.x + (e.dir ? e.dir.x * e.prog : 0), y: e.y + (e.dir ? e.dir.y * e.prog : 0) });

      /** Las paredes como en las máquinas de antes: un contorno de 1 píxel a 1 píxel de cada pasillo. */
      function paintLayer() {
        layer = document.createElement('canvas');
        layer.width = W;
        layer.height = H;
        const l = layer.getContext('2d');
        const solid = (x, y) => x >= 0 && x < COLS && y >= 0 && y < ROWS && MAZE[y][x] === '#';
        const open = (x, y) => x >= 0 && x < COLS && y >= 0 && y < ROWS && MAZE[y][x] !== '#';
        for (let y = 0; y < ROWS; y += 1) {
          for (let x = 0; x < COLS; x += 1) {
            const X = OX + x * T;
            const Y = y * T;
            if (MAZE[y][x] === '-') { // la puerta de la casa de los fantasmas
              l.fillStyle = '#ff9de2';
              l.fillRect(X, Y + 2, T, 1);
              continue;
            }
            if (!solid(x, y)) continue;
            l.fillStyle = WALL;
            const x0 = open(x - 1, y) ? X + 1 : X;
            const x1 = open(x + 1, y) ? X + T - 2 : X + T - 1;
            const y0 = open(x, y - 1) ? Y + 1 : Y;
            const y1 = open(x, y + 1) ? Y + T - 2 : Y + T - 1;
            if (open(x, y - 1)) l.fillRect(x0, Y + 1, x1 - x0 + 1, 1);
            if (open(x, y + 1)) l.fillRect(x0, Y + T - 2, x1 - x0 + 1, 1);
            if (open(x - 1, y)) l.fillRect(X + 1, y0, 1, y1 - y0 + 1);
            if (open(x + 1, y)) l.fillRect(X + T - 2, y0, 1, y1 - y0 + 1);
            // esquinas hacia adentro: pasillo en diagonal y pared a los dos lados
            if (!open(x, y - 1) && !open(x - 1, y) && open(x - 1, y - 1)) { l.fillRect(X, Y + 1, 2, 1); l.fillRect(X + 1, Y, 1, 1); }
            if (!open(x, y - 1) && !open(x + 1, y) && open(x + 1, y - 1)) { l.fillRect(X + T - 2, Y + 1, 2, 1); l.fillRect(X + T - 2, Y, 1, 1); }
            if (!open(x, y + 1) && !open(x - 1, y) && open(x - 1, y + 1)) { l.fillRect(X, Y + T - 2, 2, 1); l.fillRect(X + 1, Y + T - 1, 1, 1); }
            if (!open(x, y + 1) && !open(x + 1, y) && open(x + 1, y + 1)) { l.fillRect(X + T - 2, Y + T - 2, 2, 1); l.fillRect(X + T - 2, Y + T - 1, 1, 1); }
          }
        }
      }

      /** Pac-Man al inicio y los fantasmas en su casa, saliendo de a uno. */
      function spawn() {
        pac = { x: start.x, y: start.y, dir: null, next: DIRS.left, prog: 0 };
        ghosts = ghostColors.map((color, i) => ({ color, i, home: true, releaseAt: clock + 1 + i * 2.5, x: 12 + i, y: 10, dir: null, prog: 0, scared: false }));
        fright = 0;
      }
      g.reset = () => {
        dots = new Map();
        MAZE.forEach((row, y) => [...row].forEach((c, x) => {
          if (c === '.') dots.set(`${x},${y}`, 'dot');
          if (c === 'o') dots.set(`${x},${y}`, 'power');
        }));
        g.total = dots.size;
        g.score = 0;
        clock = 0;
        paintLayer();
        spawn();
      };
      g.respawn = spawn; // los puntos comidos siguen comidos

      /** Media vuelta en mitad de un pasillo. */
      function reverse(e) {
        if (!e.dir) return;
        if (e.prog > 0) {
          e.x = (e.x + e.dir.x + COLS) % COLS;
          e.y += e.dir.y;
          e.prog = 1 - e.prog;
        }
        e.dir = { x: -e.dir.x, y: -e.dir.y };
      }
      g.key = (k, down) => {
        const d = DIRS[k];
        if (!down || !d) return;
        pac.next = d;
        if (opposite(d, pac.dir)) reverse(pac);
      };
      /** Avanza casilla a casilla: en cada centro decide si gira (`turn`) y qué pasa al llegar (`arrive`). */
      function move(e, speed, dt, turn, arrive) {
        if (!e.dir) {
          turn(e);
          if (!e.dir) return;
        }
        e.prog += speed * dt;
        while (e.prog >= 1) {
          e.prog -= 1;
          e.x = (e.x + e.dir.x + COLS) % COLS;
          e.y += e.dir.y;
          arrive?.(e);
          turn(e);
          if (!e.dir) {
            e.prog = 0;
            return;
          }
        }
      }
      function turnPac(e) {
        if (e.next && !wall(e.x + e.next.x, e.y + e.next.y)) e.dir = e.next;
        if (e.dir && wall(e.x + e.dir.x, e.y + e.dir.y)) e.dir = null;
      }
      /** Come el punto de la casilla en la que ya está más de la mitad de Pac-Man (no espera a llegar al centro). */
      function eat(e) {
        const s = spot(e);
        const key = `${(Math.round(s.x) + COLS) % COLS},${Math.round(s.y)}`;
        const kind = dots.get(key);
        if (!kind) return;
        dots.delete(key);
        g.score += 1;
        if (kind === 'power') {
          fright = 6;
          ghosts.forEach((gh) => {
            if (gh.home) return;
            gh.scared = true;
            reverse(gh);
          });
        }
      }
      /** A dónde va cada fantasma: a ratos a su esquina; si no, cada uno persigue a su manera. */
      function target(gh) {
        if (clock % 22 < 6) return CORNERS[gh.i];
        const pd = pac.dir ?? { x: 0, y: 0 };
        if (gh.i === 0) return pac;
        if (gh.i === 1) return { x: pac.x + pd.x * 4, y: pac.y + pd.y * 4 };
        if (gh.i === 2) return { x: pac.x * 2 - ghosts[0].x, y: pac.y * 2 - ghosts[0].y };
        return (gh.x - pac.x) ** 2 + (gh.y - pac.y) ** 2 > 64 ? pac : CORNERS[3];
      }
      function turnGhost(gh) {
        const ways = Object.values(DIRS).filter((d) => !wall(gh.x + d.x, gh.y + d.y));
        const ahead = ways.filter((d) => !opposite(d, gh.dir));
        const pool = ahead.length ? ahead : ways;
        if (gh.scared) {
          gh.dir = pool[rand(pool.length)] ?? null;
          return;
        }
        const t = target(gh);
        let best = pool[0] ?? null;
        let bestD = Infinity;
        pool.forEach((d) => {
          const dd = (gh.x + d.x - t.x) ** 2 + (gh.y + d.y - t.y) ** 2;
          if (dd < bestD) { bestD = dd; best = d; }
        });
        gh.dir = best;
      }
      const sendHome = (gh, wait) => Object.assign(gh, { home: true, releaseAt: clock + wait, x: 12 + gh.i, y: 10, dir: null, prog: 0, scared: false });

      g.update = (dt, ready) => {
        if (ready) return null;
        clock += dt;
        if (fright > 0) {
          fright -= dt;
          if (fright <= 0) ghosts.forEach((gh) => { gh.scared = false; });
        }
        move(pac, SPEED.pac, dt, turnPac);
        eat(pac);
        if (!dots.size) return 'cleared';
        for (const gh of ghosts) {
          if (gh.home) {
            if (clock >= gh.releaseAt) Object.assign(gh, { home: false, x: 13 + (gh.i % 2), y: 8, dir: gh.i % 2 ? DIRS.right : DIRS.left, prog: 0 });
            continue;
          }
          move(gh, gh.scared ? SPEED.scared : SPEED.ghost, dt, turnGhost);
          const p = spot(pac);
          const q = spot(gh);
          if (Math.hypot(p.x - q.x, p.y - q.y) < REACH) {
            if (gh.scared) sendHome(gh, 4); // asustado: vuelve a su casa un rato
            else return 'died';
          }
        }
        return null;
      };

      /** Un sprite de 7 × 7 sobre su casilla (la desborda 1 píxel, como en las máquinas). */
      const at = (s) => ({ x: OX + s.x * T, y: s.y * T });
      function drawPac() {
        const frame = pac.dir ? [0, 1, 2, 1][Math.floor(clock * 16) % 4] : 1;
        const d = pac.dir ?? DIRS.left;
        const p = at(spot(pac));
        sprite(PAC[frame], p.x, p.y, { '#': '#ffd23f' }, { flip: d.x < 0, turn: d.y > 0 ? 1 : d.y < 0 ? 3 : 0 });
      }
      function drawGhost(gh) {
        const p = at(gh.home ? gh : spot(gh));
        const step = Math.floor(clock * 8) % 2;
        if (gh.scared) {
          const blink = fright < 2 && Math.floor(clock * 6) % 2 === 0; // parpadea cuando se le acaba el susto
          sprite(SCARED[step], p.x, p.y, { '#': blink ? '#ededeb' : '#2b4bd8', f: blink ? '#ff5c5c' : '#ffb8ae' });
          return;
        }
        sprite(GHOST[step], p.x, p.y, { '#': gh.color, w: '#ffffff' });
        const d = gh.dir ?? DIRS.down; // las pupilas miran hacia donde va
        const ox = d.x > 0 ? 1 : 0;
        const oy = d.y < 0 ? 0 : 1;
        px(p.x + 1 + ox, p.y + 2 + oy, 1, 1, '#1b2a8a');
        px(p.x + 4 + ox, p.y + 2 + oy, 1, 1, '#1b2a8a');
      }
      g.draw = (mode) => {
        if (layer) ctx.drawImage(layer, 0, 0);
        const pulse = mode !== 'playing' || Math.floor(clock * 4) % 2 === 0;
        dots.forEach((kind, key) => {
          const [x, y] = key.split(',').map(Number);
          const X = OX + x * T;
          const Y = y * T;
          if (kind === 'dot') px(X + 2, Y + 2, 2, 2, '#ffd27a');
          else if (pulse) { // punto grande: 4 × 4 con las esquinas recortadas
            px(X + 1, Y + 2, 4, 2, '#ffb238');
            px(X + 2, Y + 1, 2, 4, '#ffb238');
          }
        });
        ctx.save();
        ctx.beginPath();
        ctx.rect(OX, 0, COLS * T, H); // por el túnel se sale de este laberinto, no de la pantalla
        ctx.clip();
        ghosts.forEach(drawGhost);
        drawPac();
        ctx.restore();
      };
      return g;
    }
    /* ===== La máquina: elegir juego, moneda, marcador, controles ===== */
    const GAMES = {
      breakout: {
        name: 'Breakout', unit: 'Ladrillos', lives: 3, per: 4, make: breakout, start: 'Espacio o clic para lanzar',
        rules: ['Ratón, dedo o ← → mueven la paleta', 'Espacio, Enter o clic lanzan la bola', '3 vidas por moneda', '5 XP por cada 4 ladrillos'],
      },
      snake: {
        name: 'Snake', unit: 'Manzanas', lives: 1, per: 3, make: snake, start: 'Una flecha o desliza para empezar',
        rules: ['Flechas, WASD o deslizar giran la serpiente', 'Los bordes y tu propia cola terminan la partida', '1 vida por moneda', '5 XP por cada 3 manzanas'],
      },
      pacman: {
        name: 'Pac-Man', unit: 'Puntos', lives: 3, per: 25, make: pacman, start: 'Una flecha o desliza para empezar',
        rules: ['Flechas, WASD o deslizar mueven a Pac-Man', 'Los puntos grandes asustan a los fantasmas: ahí te los puedes comer', '3 vidas por moneda', '5 XP por cada 25 puntos'],
      },
    };

    let gameId = 'breakout';
    try {
      const saved = localStorage.getItem(GAME_KEY);
      if (Object.hasOwn(GAMES, saved ?? '')) gameId = saved;
    } catch { /* almacenamiento bloqueado */ }
    let game = null;
    let mode = 'idle'; // idle · ready (espera para arrancar) · playing · over
    let lives = 0;
    let cleared = false;
    let free = false; // partida libre de la curaduría: no suma XP
    let earned = null; // XP que dio la última partida (lo confirma el servidor)
    let known = false; // ya se sabe si hay sesión
    let localDay = ''; // por si el navegador no deja guardar
    let shownScore = -1;
    let last = 0;
    let raf = 0;
    const ARCADE_XP = { step: 5, max: 50 }; // igual que ARCADE_XP_STEP y ARCADE_MAX_XP en lib/achievements.js
    const xpFor = (score) => Math.min(ARCADE_XP.max, Math.max(1, Math.ceil((score * ARCADE_XP.step) / GAMES[gameId].per)));

    /* La moneda se renueva a medianoche de Bogotá (UTC−5 todo el año, sin horario de verano) */
    const BOGOTA = -5 * 3600e3;
    const today = () => new Date(Date.now() + BOGOTA).toISOString().slice(0, 10);
    const isCurator = () => progress.currentUser()?.role === 'admin';
    const dailySpent = () => progress.currentUser()?.arcade?.day === today();
    function coinUsed() {
      const u = progress.currentUser();
      if (u) return u.role !== 'admin' && dailySpent(); // la curaduría tiene monedas ilimitadas
      try {
        if (localStorage.getItem(LOCAL_KEY) === today()) return true;
      } catch { /* almacenamiento bloqueado */ }
      return localDay === today();
    }
    function waitText() {
      const ms = 86400e3 - ((Date.now() + BOGOTA) % 86400e3);
      return `${pad(Math.floor(ms / 3600e3))}h ${pad(Math.floor((ms % 3600e3) / 60e3))}m`;
    }

    /** Pinta el juego en los 192 × 126 píxeles y los amplía por un entero, sin suavizar. */
    function draw() {
      ctx.clearRect(0, 0, W, H);
      game.draw(mode);
      screen.imageSmoothingEnabled = false;
      screen.clearRect(0, 0, canvas.width, canvas.height);
      screen.drawImage(buffer, 0, 0, canvas.width, canvas.height);
    }
    /** La pantalla real mide un múltiplo entero de 192 × 126 (al menos lo que ocupa en el monitor): los píxeles salen parejos. */
    function fit() {
      const k = Math.max(2, Math.ceil(((canvas.clientWidth || W * 3) * (window.devicePixelRatio || 1)) / W));
      if (canvas.width === W * k) return;
      canvas.width = W * k;
      canvas.height = H * k;
    }

    function paintHud() {
      const def = GAMES[gameId];
      $('#arcade-unit').textContent = def.unit;
      $('#arcade-score').textContent = game.total ? `${pad(game.score, String(game.total).length)}/${game.total}` : pad(game.score);
      $('#arcade-lives').textContent = '♥'.repeat(Math.max(0, lives)) + '♡'.repeat(Math.max(0, def.lives - lives));
      $('#arcade-xp').textContent = free ? 'Libre' : `+${mode === 'idle' ? 0 : earned ?? xpFor(game.score)} XP`;
      shownScore = game.score;
    }

    function paintMsg() {
      const def = GAMES[gameId];
      msg.dataset.mode = mode;
      if (mode === 'idle') {
        msg.innerHTML = coinUsed()
          ? `<p class="cab__title">${esc(def.name)}</p><p class="cab__small">Moneda usada · vuelve en ${waitText()}</p>`
          : `<p class="cab__title">${esc(def.name)}</p><p class="cab__small cab__blink">Inserta una moneda</p>`;
      } else if (mode === 'ready') {
        msg.innerHTML = `<p class="cab__small cab__blink">${lives < def.lives ? `${lives} ${lives === 1 ? 'vida' : 'vidas'} · ` : ''}${esc(def.start)}</p>`;
      } else if (mode === 'playing') {
        msg.innerHTML = '';
      } else {
        const xp = earned ?? xpFor(game.score);
        const reward = free ? 'partida libre, sin XP' : progress.currentUser() ? `+${xp} XP` : `${xp} XP sin guardar`;
        msg.innerHTML = `<p>${cleared ? '¡Pantalla limpia!' : 'Fin del juego'}</p>
          <p class="cab__small">${pad(game.score)} ${esc(def.unit.toLowerCase())} · ${reward}</p>
          <p class="cab__small">${isCurator() ? 'Curaduría: otra moneda cuando quieras' : `Otra moneda en ${waitText()}`}</p>`;
      }
    }

    /* Jugando, la página no se mueve: un mal deslizamiento en el móvil ya no saca la pantalla de la vista (y la moneda
       con ella). Los paneles abiertos encima (carrito, terminal) siguen desplazándose. */
    const holdPage = (e) => { if (!e.target.closest?.('[role="dialog"]')) e.preventDefault(); };
    let held = false;
    let pageH = 0;
    function holdScroll(on) {
      if (on === held) return;
      held = on;
      document.documentElement.classList.toggle('is-gaming', on);
      if (on) {
        document.addEventListener('touchmove', holdPage, { passive: false });
        pageH = document.body.offsetHeight;
        relayout.observe(document.body);
      } else {
        document.removeEventListener('touchmove', holdPage);
        relayout.disconnect();
      }
    }
    /* La posición de juego es siempre la misma: la pantalla entera justo bajo la barra (el CSS la limita para que quepa
       en cualquier ventana). Se toma al insertar la moneda, aunque estuviera cortada, y se recupera si se gira el móvil
       o si algo de más arriba termina de cargar y empuja la página. «instant»: el html desliza suave por defecto. */
    const frameScreen = (smooth) => screenEl.scrollIntoView({ block: 'start', behavior: smooth && !reduceMotion.matches ? 'smooth' : 'instant' });
    const relayout = new ResizeObserver(() => {
      const h = document.body.offsetHeight;
      if (held && h !== pageH) frameScreen(false);
      pageH = h;
    });
    window.addEventListener('resize', () => { if (held) frameScreen(false); });

    /** La ranura, el selector, las reglas y la pantalla según la moneda y la partida. */
    function paint() {
      const def = GAMES[gameId];
      const busy = mode === 'ready' || mode === 'playing';
      const used = coinUsed();
      const curator = isCurator();
      coinBtn.disabled = !known || busy || used;
      coinLabel.textContent = !known ? 'Cargando…' : busy ? 'En juego…' : used ? 'Moneda usada' : curator && dailySpent() ? 'Moneda de curaduría' : 'Insertar moneda';
      if (curator) {
        if (busy) note.textContent = free ? 'Curaduría: partida libre, no suma XP.' : 'Curaduría: esta partida suma XP; las siguientes de hoy son libres.';
        else note.textContent = dailySpent()
          ? 'Curaduría: monedas ilimitadas. Ya jugaste la partida con XP de hoy; las demás son libres.'
          : 'Curaduría: monedas ilimitadas. La primera partida de cada día suma XP a tu credencial.';
      } else if (progress.currentUser()) {
        note.textContent = used && !busy
          ? `Vuelve en ${waitText()} por otra moneda. El XP va a tu credencial.`
          : 'Una moneda por día (hora de Bogotá): elige el juego antes de insertarla. El XP va a tu credencial.';
      } else {
        note.innerHTML = `${used && !busy ? `Vuelve en ${waitText()} por otra moneda.` : 'Una moneda por día: elige el juego antes de insertarla.'} Sin credencial juegas igual, pero el XP no se guarda. <a class="link" href="/cuenta#registro">Crear credencial →</a>`;
      }
      $$('[data-game]', pickEl).forEach((b) => {
        b.setAttribute('aria-pressed', String(b.dataset.game === gameId));
        b.disabled = busy;
      });
      rulesEl.innerHTML = [...def.rules, `Hasta ${ARCADE_XP.max} XP por partida`].map((rule) => `<li>${esc(rule)}</li>`).join('');
      canvas.setAttribute('aria-label', `${def.name}. ${def.rules[0]}. ${def.rules[1]}.`);
      cab.classList.toggle('is-playing', busy);
      holdScroll(busy);
      paintMsg();
      paintHud();
    }
    /** Elige el juego de la próxima moneda (se ve en la pantalla de espera). */
    function choose(id) {
      if (!Object.hasOwn(GAMES, id) || mode === 'ready' || mode === 'playing') return;
      gameId = id;
      try {
        localStorage.setItem(GAME_KEY, id);
      } catch { /* almacenamiento bloqueado */ }
      game = GAMES[id].make();
      game.reset();
      lives = GAMES[id].lives;
      mode = 'idle';
      earned = null;
      free = false;
      draw();
      paint();
    }

    function play() {
      if (mode !== 'ready') return;
      mode = 'playing';
      game.launch?.();
      paintMsg();
    }

    function loop() {
      cancelAnimationFrame(raf);
      last = performance.now();
      const frame = (t) => {
        const dt = Math.min(0.033, Math.max(0, (t - last) / 1000));
        last = t;
        const result = game.update(dt, mode === 'ready');
        if (game.score !== shownScore) paintHud();
        if (result === 'died') {
          lives -= 1;
          if (lives > 0) {
            mode = 'ready';
            game.respawn();
            paint();
          } else end(false);
        } else if (result === 'cleared' || result === 'over') end(result === 'cleared');
        draw();
        if (mode === 'ready' || mode === 'playing') raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    }

    function start() {
      game = GAMES[gameId].make();
      game.reset();
      lives = GAMES[gameId].lives;
      cleared = false;
      earned = null;
      mode = 'ready';
      paint();
      loop();
      frameScreen(true);
      canvas.focus({ preventScroll: true });
    }

    /** Fin de la partida: con sesión, el servidor la cierra y suma su XP (una sola vez; la partida libre no suma). */
    async function end(win) {
      mode = 'over';
      cleared = win;
      cancelAnimationFrame(raf);
      game.release?.();
      draw();
      paint();
      if (!progress.currentUser()) return;
      try {
        const data = await api('/api/auth/arcade', { method: 'POST', body: { step: 'finish', score: game.score } });
        earned = data.xp;
        if (data.xp > 0) progress.gainXp(data.user, data.xp, `Arcade · ${GAMES[gameId].name}`);
        else progress.takeUser(data.user);
      } catch (err) {
        notify(err.message, { tone: 'error' });
      }
      paint();
    }

    async function insertCoin() {
      if (!known || mode === 'ready' || mode === 'playing' || coinUsed()) return;
      coinBtn.disabled = true;
      coinBtn.classList.remove('is-in');
      void coinBtn.offsetWidth; // reinicia la animación de la moneda entrando
      coinBtn.classList.add('is-in');
      try {
        if (progress.currentUser()) {
          const { user } = await api('/api/auth/arcade', { method: 'POST', body: { step: 'start', game: gameId } });
          free = Boolean(user.arcade?.free);
          progress.takeUser(user);
        } else {
          free = false;
          localDay = today();
          try {
            localStorage.setItem(LOCAL_KEY, localDay);
          } catch { /* modo privado: la moneda dura lo que la pestaña */ }
        }
        unlock('primera-moneda');
        start();
      } catch (err) {
        notify(err.message, { tone: 'error' });
        paint();
      }
    }

    coinBtn.insertAdjacentHTML('afterbegin', `<span class="cab__coin-icon">${progress.COIN}</span>`);
    coinBtn.addEventListener('click', insertCoin);
    pickEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-game]');
      if (btn) choose(btn.dataset.game);
    });

    /* Controles: teclado (flechas, WASD, espacio), el puntero mueve la paleta y deslizar gira */
    const KEYS = { ArrowLeft: 'left', a: 'left', ArrowRight: 'right', d: 'right', ArrowUp: 'up', w: 'up', ArrowDown: 'down', s: 'down', ' ': 'action', Enter: 'action' };
    const keyOf = (e) => KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    const active = () => mode === 'ready' || mode === 'playing';
    canvas.addEventListener('keydown', (e) => {
      const k = keyOf(e);
      if (!active() || !k) return;
      e.preventDefault(); // jugando, las flechas y el espacio no mueven la página
      if (k === 'action') {
        play();
        return;
      }
      if (mode === 'ready' && game.steer) play();
      game.key(k, true);
    });
    canvas.addEventListener('keyup', (e) => {
      const k = keyOf(e);
      if (k && k !== 'action') game.key(k, false);
    });
    canvas.addEventListener('blur', () => game.release?.());

    // todo el marco de la pantalla (no solo el lienzo) recibe el dedo: un deslizamiento que empieza en el borde o en el
    // marcador también juega
    let swipe = null;
    const toXY = (e) => {
      const box = canvas.getBoundingClientRect();
      return { x: ((e.clientX - box.left) / box.width) * W, y: ((e.clientY - box.top) / box.height) * H };
    };
    screenEl.addEventListener('pointerdown', (e) => {
      if (!active()) return;
      const p = toXY(e);
      if (e.pointerType !== 'mouse') screenEl.setPointerCapture?.(e.pointerId); // el dedo sigue fuera de la pantalla
      if (game.aim) game.pointer(p.x);
      else swipe = p;
      play();
    });
    screenEl.addEventListener('pointermove', (e) => {
      if (!active()) return;
      const p = toXY(e);
      if (game.aim) {
        game.pointer(p.x);
        return;
      }
      if (!swipe) return;
      const dx = p.x - swipe.x;
      const dy = p.y - swipe.y;
      if (Math.hypot(dx, dy) < 24) return;
      game.key(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'), true);
      swipe = p;
    });
    ['pointerup', 'pointercancel'].forEach((type) => screenEl.addEventListener(type, () => { swipe = null; }));

    progress.subscribe(paint);
    progress.whenReady().then(() => {
      known = true;
      paint();
    });
    setInterval(() => { if (mode === 'idle' || mode === 'over') paint(); }, 30000); // la cuenta para la próxima moneda
    fit();
    choose(gameId);
    new ResizeObserver(() => {
      fit();
      draw();
    }).observe(canvas);
  })();
  /* ---------- Buscador de la barra: piezas, drops, zonas y secciones, de lo que mejor calza a lo que menos ---------- */
  // Prioridades: cada resultado tiene un puntaje de 0 a 100 (matchScore, igual que en lib/search.js: igual > empieza
  // así > una palabra empieza así > lo contiene). Las piezas las ordena el servidor (nombre y SKU pesan más que zona y
  // formato; lo agotado baja un escalón). Los grupos salen en el orden de su mejor resultado y, a igual puntaje,
  // piezas > drops > zonas > secciones. Si nada calza, el servidor corrige la búsqueda («camsia» → «camisa»).
  const bar = $('.bar');
  const seek = $('#seek');
  const seekInput = $('#seek-input');
  const seekPanel = $('#seek-panel');
  const seekList = $('#seek-list');
  const seekOpenBtn = $('[data-seek-open]');
  /** Hasta 1279 px el buscador es un botón: al abrirlo, la barra entera se vuelve el buscador. */
  const seekNarrow = window.matchMedia('(max-width: 1279px)');
  const SEEK_LIMITS = { pieza: 6, drop: 3, zona: 3, seccion: 3 };
  const SEEK_RANK = { pieza: 4, drop: 3, zona: 2, seccion: 1 };
  const SEEK_GROUPS = { pieza: 'Piezas', drop: 'Drops', zona: 'Zonas', seccion: 'Ir a', encargo: '¿No está en el archivo?', reciente: 'Búsquedas recientes' };
  const RECENT_KEY = 'dz.seek.recent'; // las últimas búsquedas en este navegador
  const seekCache = new Map(); // palabras → respuesta de /api/catalog?suggest
  const seekFailed = new Map(); // palabras → error
  let seekOptions = [];
  let seekActive = -1;
  let seekTimer = 0;

  const seekClean = (s) => fold(s ?? '').replace(/\s+/g, ' ').trim();
  const seekWords = () => seekClean(seekInput.value).split(' ').filter(Boolean).slice(0, 6);
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startsWord = (v, t) => new RegExp(`(?:^|[^a-z0-9])${reEsc(t)}`).test(v);
  const hasWord = (v, t) => (t.length < 3 ? startsWord(v, t) : v.includes(t));
  /** Igual que matchScore en lib/search.js. */
  function matchScore(value, words) {
    const v = seekClean(value);
    const q = words.join(' ');
    if (!v || !q) return 0;
    if (v === q) return 100;
    if (v.startsWith(q)) return 90;
    if (startsWord(v, q)) return 80;
    if (q.length >= 3 && v.includes(q)) return 65;
    if (words.every((t) => startsWord(v, t))) return 60;
    if (words.every((t) => hasWord(v, t))) return 45;
    return 0;
  }

  /** El texto con lo que calza dentro de <mark> (sin importar tildes ni mayúsculas). */
  function marked(text, words) {
    const chars = [...String(text ?? '')];
    let flat = '';
    const at = []; // a qué letra del original corresponde cada letra de `flat`
    chars.forEach((c, i) => {
      for (const f of fold(c)) {
        flat += f;
        at.push(i);
      }
    });
    const on = chars.map(() => false);
    for (const w of words) {
      for (let from = flat.indexOf(w); from !== -1; from = flat.indexOf(w, from + 1)) {
        if (w.length < 3 && /[a-z0-9]/.test(flat[from - 1] ?? '')) continue;
        for (let k = from; k < from + w.length; k += 1) on[at[k]] = true;
      }
    }
    let html = '';
    chars.forEach((c, i) => {
      if (on[i] && !on[i - 1]) html += '<mark>';
      html += esc(c);
      if (on[i] && !on[i + 1]) html += '</mark>';
    });
    return html;
  }

  const closesIn = (iso) => {
    const min = Math.floor((Date.parse(iso) - Date.now()) / 60000);
    if (min <= 0) return 'cerrado';
    if (min >= 1440) return `cierra en ${Math.floor(min / 1440)} d ${Math.floor((min % 1440) / 60)} h`;
    return min >= 60 ? `cierra en ${Math.floor(min / 60)} h ${min % 60} min` : `cierra en ${min} min`;
  };

  /** Secciones y páginas: su nombre (el que puso la curaduría) y las palabras con que la gente las busca. */
  const PLACES = [
    { label: () => copy('indice.title', 'Índice'), desc: () => `Las ${num(state.total)} piezas del archivo, por zona`, go: '#indice', keys: 'catalogo productos piezas archivo tienda todo' },
    { label: () => copy('drops.title', 'Drops'), desc: () => 'Bundles de piezas más baratos juntos', go: '#drops', keys: 'bundle combo kit promocion oferta descuento paquete' },
    { label: () => copy('niveles.title', 'Niveles'), desc: () => 'Programa de lealtad: cada compra suma XP y baja el precio', go: '#niveles', keys: 'nivel xp lealtad puntos descuento novato adepto leyenda mitico beneficios envio gratis' },
    { label: () => 'Logros', desc: () => 'Lo que se desbloquea recorriendo el archivo', go: '#logros', keys: 'logro trofeo insignia medalla secreto' },
    { label: () => copy('encargos.title', 'Encargos'), desc: () => 'Pide una pieza que no está y te la buscamos', go: '#encargos', keys: 'encargo pedido especial importar conseguir buscar pieza cotizar' },
    { label: () => copy('visita.title', 'Visítanos'), desc: () => `${copy('visita.address', 'Cra. 7 #23-65')} · hoy ${todayHours()}`, go: '#visita', keys: 'tienda fisica local direccion ubicacion mapa horario abierto bogota como llegar waze recoger' },
    { label: () => copy('correo.nav', 'Correo'), desc: () => 'Te avisamos de cada drop al instante', go: '#correo', keys: 'newsletter suscribir avisos notificaciones email correo' },
    { label: () => copy('arcade.title', 'Arcade'), desc: () => 'La moneda del día: Breakout, Snake y Pac-Man', go: '#arcade', keys: 'juego jugar breakout snake pacman pac-man moneda maquinita' },
    { label: () => 'Carrito', desc: () => `Lo que vas a llevar · ${pad(state.slots)} ${state.slots === 1 ? 'slot' : 'slots'}`, run: () => openCart(), keys: 'carro inventario compra comprar pagar checkout bolsa' },
    { label: () => 'Mi cuenta', desc: () => 'Tu credencial: entrar, registrarte, tu nivel y tu contraseña', href: '/cuenta', keys: 'cuenta credencial perfil entrar login iniciar sesion registro registrarse contrasena clave olvide' },
    { label: () => 'Pedidos', desc: () => 'Tus pedidos y la guía de cada envío', href: '/cuenta#pedidos', keys: 'pedido compras envio envios guia rastreo seguimiento interrapidisimo entrega domicilio' },
    { label: () => 'Privacidad', desc: () => 'Cómo tratamos tus datos (Ley 1581 de 2012)', href: '/privacidad', keys: 'datos politica habeas data ley 1581 privacidad terminos' },
    { label: () => 'Terminal', desc: () => 'Comandos para recorrer el archivo con el teclado', run: () => openTerm(), keys: 'terminal comandos consola atajos teclado' },
    { label: () => 'Curaduría', desc: () => 'El panel para editar la tienda', href: '/admin', keys: 'curaduria admin administrador panel editar', admin: true },
  ];

  /** Zonas, drops y secciones: se buscan aquí mismo, sin esperar al servidor. */
  function localResults(words) {
    const out = [];
    for (const z of zoneList) {
      const score = matchScore(z.label, words) * (state.counts?.counts?.[z.key] === 0 ? 0.6 : 1); // una zona vacía no gana
      if (score) out.push({ type: 'zona', score: Math.round(score), zone: z });
    }
    for (const d of state.drops) {
      const score = Math.max(
        matchScore(d.title, words),
        matchScore(`drop ${d.number} #${pad(d.number, 3)} ${d.code}`, words),
        matchScore(d.specs, words) * 0.6,
        ...d.items.map((p) => matchScore(p.name, words) * 0.6),
      );
      if (score) out.push({ type: 'drop', score: Math.round(score), drop: d });
    }
    for (const place of PLACES) {
      if (place.admin && !termCurator()) continue;
      const score = Math.max(matchScore(place.label(), words), matchScore(place.keys, words) * 0.85);
      if (score) out.push({ type: 'seccion', score: Math.round(score), place });
    }
    return out;
  }

  /** Agrupa por tipo (con su tope) y ordena los grupos por su mejor puntaje; a igual puntaje, por tipo. */
  function groupResults(items) {
    const groups = new Map();
    for (const it of [...items].sort((a, b) => b.score - a.score)) {
      if (!groups.has(it.type)) groups.set(it.type, []);
      const list = groups.get(it.type);
      if (list.length < SEEK_LIMITS[it.type]) list.push(it);
    }
    return [...groups].sort(([ta, a], [tb, b]) => b[0].score - a[0].score || SEEK_RANK[tb] - SEEK_RANK[ta]);
  }

  function recentSearches() {
    try {
      const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
      return Array.isArray(list) ? list.filter((s) => typeof s === 'string' && s.trim()).slice(0, 5) : [];
    } catch {
      return [];
    }
  }
  function rememberSearch(q) {
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify([q, ...recentSearches().filter((s) => seekClean(s) !== seekClean(q))].slice(0, 5)));
    } catch {
      /* sin almacenamiento: no se recuerda */
    }
  }

  /** Cada opción: su HTML y lo que hace al elegirla. */
  function seekOption(it, words, raw) {
    const opt = (html, run, extra = '') => ({ html, run, extra });
    switch (it.type) {
      case 'pieza': {
        const p = it.product;
        const tag = p.stock <= 0 ? '<span class="row__tag" data-tone="out">Agotado</span>'
          : dropsWith(p.id).length ? '<span class="row__tag" data-tone="drop">Drop</span>' : '';
        const meta = [`nº ${marked(entryNo(p), words)}`, esc(ZONES[p.category] ?? ''), marked(p.subtitle, words)].filter(Boolean).join(' · ');
        return opt(`
          <span class="seek__thumb">${thumb(p)}</span>
          <span class="seek__main"><span class="seek__name">${marked(p.name, words)}${tag}</span><span class="seek__meta mono">${meta}</span></span>
          <span class="seek__side mono">${money(p.priceCents)}</span>`,
        () => select(p.id, { open: true }),
        ` data-zone="${esc(p.category)}"${toneOf(p) ? ` style="--tone:${toneOf(p)}"` : ''}`);
      }
      case 'drop': {
        const d = it.drop;
        return opt(`
          <span class="seek__thumb seek__thumb--drop px">${pad(d.number, 3)}</span>
          <span class="seek__main"><span class="seek__name">${marked(d.title, words)}</span><span class="seek__meta mono">Drop · ${pad(d.items.length)} piezas · ${closesIn(d.endsAt)}</span></span>
          <span class="seek__side mono">${money(d.priceCents)}</span>`,
        () => {
          const card = document.getElementById(d.code);
          if (!card) return goTo('#drops');
          card.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'start' });
          card.classList.remove('is-found');
          requestAnimationFrame(() => card.classList.add('is-found'));
          return null;
        });
      }
      case 'zona': {
        const z = it.zone;
        const count = state.counts?.counts?.[z.key];
        return opt(`
          <span class="seek__thumb seek__thumb--zone px">${count === undefined ? '··' : pad(count)}</span>
          <span class="seek__main"><span class="seek__name">${marked(z.label, words)}</span><span class="seek__meta mono">Zona${count === undefined ? '' : ` · ${count === 1 ? '1 pieza' : `${num(count)} piezas`}`}</span></span>
          <span class="seek__side mono">filtrar →</span>`,
        () => {
          search.value = '';
          state.query = '';
          setZone(z.key);
          goTo('#indice');
        },
        ` data-zone="${esc(z.key)}"`);
      }
      case 'seccion': {
        const { place } = it;
        return opt(`
          <span class="seek__thumb seek__thumb--place mono">${place.go ? '#' : '↗'}</span>
          <span class="seek__main"><span class="seek__name">${marked(place.label(), words)}</span><span class="seek__meta mono">${esc(place.desc())}</span></span>
          <span class="seek__side mono">${place.href ? 'abrir →' : 'ir →'}</span>`,
        () => {
          if (place.go) goTo(place.go);
          else if (place.href) window.location.href = place.href;
          else place.run();
        });
      }
      case 'todas':
        return opt(`
          <span class="seek__thumb seek__thumb--place mono">≡</span>
          <span class="seek__main"><span class="seek__name seek__name--mono mono">Ver las ${num(it.matched)} piezas en el índice</span></span>
          <span class="seek__side mono">→</span>`,
        () => {
          search.value = raw;
          state.query = raw;
          setZone('todo');
          goTo('#indice');
        });
      case 'encargo':
        return opt(`
          <span class="seek__thumb seek__thumb--place mono">?</span>
          <span class="seek__main"><span class="seek__name">Encárganos «${esc(raw)}»</span><span class="seek__meta mono">La buscamos por ti y te escribimos por WhatsApp</span></span>
          <span class="seek__side mono">→</span>`,
        () => {
          huntForm.elements.pieza.value = raw;
          goTo('#encargos');
          setTimeout(() => huntForm.elements.whatsapp.focus({ preventScroll: true }), reduceMotion.matches ? 0 : 450);
        });
      case 'reciente':
        return opt(`
          <span class="seek__thumb seek__thumb--place mono">↺</span>
          <span class="seek__main"><span class="seek__name">${esc(it.text)}</span></span>
          <span class="seek__side mono">buscar</span>`,
        () => {
          seekInput.value = it.text;
          openSeek();
        });
      default:
        return null;
    }
  }

  function renderSeek() {
    const raw = seekInput.value.trim().slice(0, 60);
    const words = seekWords();
    const key = words.join(' ');
    const groups = [];
    let note = '';
    let hl = words; // lo que se resalta en cada resultado

    if (!words.length) {
      // sin texto: lo último que buscaste y las zonas, para empezar por algún lado
      const recent = recentSearches().map((text) => ({ type: 'reciente', text }));
      if (recent.length) groups.push(['reciente', recent]);
      groups.push(['zona', zoneList.map((zone) => ({ type: 'zona', zone }))]);
    } else {
      const data = seekCache.get(key);
      const fixed = data?.corrected ? data.corrected.split(' ') : null;
      if (fixed) hl = [...words, ...fixed];
      let items = localResults(words);
      if (fixed && !items.length) items = localResults(fixed);
      if (data) items.push(...data.products.map((product) => ({ type: 'pieza', score: product.score, product })));
      groups.push(...groupResults(items));
      const pieces = groups.find(([type]) => type === 'pieza');
      if (pieces && data.matched > pieces[1].length) pieces[1].push({ type: 'todas', matched: data.matched });
      if (seekFailed.has(key)) note = `&gt; no pudimos buscar piezas (${esc(seekFailed.get(key))}).`;
      else if (!data) note = '&gt; buscando piezas<span class="cursor" aria-hidden="true"></span>';
      else if (fixed) note = `Sin resultados para «${esc(raw)}» · mostrando <b>«${esc(data.corrected)}»</b>`;
      else if (!groups.length) note = `&gt; 0 coincidencias para «${esc(raw)}». Ni con un 20 natural.`;
      // ninguna pieza (ni una sección: quien busca «envíos» no quiere encargar nada) → que la busquemos nosotros
      if (data && !data.matched && raw.length >= 3 && !groups.some(([type]) => type === 'seccion')) groups.push(['encargo', [{ type: 'encargo' }]]);
    }

    seekOptions = [];
    const html = groups.map(([type, list]) => `
      <div class="seek__group" role="group" aria-label="${esc(SEEK_GROUPS[type])}">
        <p class="seek__label mono" aria-hidden="true">${esc(SEEK_GROUPS[type])}</p>
        ${list.map((it) => {
          const o = seekOption(it, hl, raw);
          const i = seekOptions.push(o) - 1;
          return `<div class="seek__opt" id="seek-opt-${i}" role="option" aria-selected="false" data-i="${i}"${o.extra}>${o.html}</div>`;
        }).join('')}
      </div>`).join('');
    seekList.innerHTML = `${note ? `<p class="seek__note mono">${note}</p>` : ''}${html}`;
    seekActive = Math.min(seekActive, seekOptions.length - 1);
    paintSeekActive();
  }

  function paintSeekActive() {
    $$('.seek__opt', seekList).forEach((el) => el.setAttribute('aria-selected', String(Number(el.dataset.i) === seekActive)));
    const active = seekActive >= 0 ? $(`#seek-opt-${seekActive}`) : null;
    if (active) {
      seekInput.setAttribute('aria-activedescendant', active.id);
      active.scrollIntoView({ block: 'nearest' });
    } else {
      seekInput.removeAttribute('aria-activedescendant');
    }
  }

  /** Lo de aquí (zonas, drops, secciones) sale al instante; las piezas, cuando responde el servidor. */
  function querySeek() {
    const key = seekWords().join(' ');
    clearTimeout(seekTimer);
    renderSeek();
    if (!key || seekCache.has(key)) return;
    seekTimer = setTimeout(async () => {
      try {
        const data = await api(`/api/catalog?suggest=${encodeURIComponent(key)}`);
        data.products.forEach((p) => state.known.set(p.id, p));
        seekFailed.delete(key);
        seekCache.set(key, data);
        if (seekCache.size > 60) seekCache.delete(seekCache.keys().next().value);
      } catch (err) {
        seekFailed.set(key, err.message);
      }
      if (!seekPanel.hidden && seekWords().join(' ') === key) renderSeek();
    }, 140);
  }

  const seekIsOpen = () => !seekPanel.hidden;
  function openSeek() {
    if (!menu.hidden) setMenu(false, false);
    bar.classList.add('is-seeking');
    seekOpenBtn.setAttribute('aria-expanded', 'true');
    seekInput.setAttribute('aria-expanded', 'true');
    seekPanel.hidden = false;
    if (seekNarrow.matches && !desktop.matches) document.body.classList.add('is-locked');
    if (document.activeElement !== seekInput) seekInput.focus();
    seekActive = -1;
    querySeek();
  }
  function closeSeek({ restoreFocus = false } = {}) {
    if (!seekIsOpen() && !bar.classList.contains('is-seeking')) return;
    clearTimeout(seekTimer);
    seekPanel.hidden = true;
    seekInput.setAttribute('aria-expanded', 'false');
    seekInput.removeAttribute('aria-activedescendant');
    bar.classList.remove('is-seeking');
    seekOpenBtn.setAttribute('aria-expanded', 'false');
    if (cartEl.hidden && term.hidden && menu.hidden && !viewer.classList.contains('is-open')) document.body.classList.remove('is-locked');
    const hadFocus = document.activeElement === seekInput;
    if (hadFocus) seekInput.blur();
    if (restoreFocus && hadFocus && seekNarrow.matches) seekOpenBtn.focus();
  }
  function pickSeek(i) {
    const o = seekOptions[i];
    if (!o) return;
    const raw = seekInput.value.trim();
    if (raw) rememberSearch(raw);
    closeSeek();
    o.run();
  }

  seekOpenBtn.addEventListener('click', openSeek);
  $('[data-seek-close]').addEventListener('click', () => {
    seekInput.value = '';
    closeSeek({ restoreFocus: true });
  });
  seekInput.addEventListener('focus', () => { if (!seekIsOpen()) openSeek(); });
  seekInput.addEventListener('input', () => {
    if (!seekIsOpen()) return openSeek(); // escribir también abre los resultados
    seekActive = -1;
    return querySeek();
  });
  seekInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!seekIsOpen()) openSeek();
      if (!seekOptions.length) return;
      const n = seekOptions.length;
      seekActive = seekActive < 0 ? (e.key === 'ArrowDown' ? 0 : n - 1) : (seekActive + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      paintSeekActive();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pickSeek(seekActive >= 0 ? seekActive : 0); // Enter sin elegir abre el mejor resultado
    }
  });
  // el clic en una opción no le quita el foco al campo (si no, el panel se cerraría antes del clic)
  seekPanel.addEventListener('mousedown', (e) => e.preventDefault());
  seekList.addEventListener('click', (e) => {
    const el = e.target.closest('.seek__opt');
    if (el) pickSeek(Number(el.dataset.i));
  });
  seekList.addEventListener('pointermove', (e) => {
    const el = e.target.closest('.seek__opt');
    if (!el || e.pointerType !== 'mouse' || Number(el.dataset.i) === seekActive) return;
    seekActive = Number(el.dataset.i);
    paintSeekActive();
  });
  // fuera del buscador (clic o Tab) se cierra
  document.addEventListener('pointerdown', (e) => {
    if (seekIsOpen() && !seek.contains(e.target) && !seekOpenBtn.contains(e.target)) closeSeek();
  });
  document.addEventListener('focusin', (e) => {
    if (seekIsOpen() && !seek.contains(e.target)) closeSeek();
  });
  seekNarrow.addEventListener('change', () => closeSeek());

  /* ---------- Teclado global ---------- */
  document.addEventListener('keydown', (e) => {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    konamiPos = key === KONAMI[konamiPos] ? konamiPos + 1 : key === KONAMI[0] ? 1 : 0;
    if (konamiPos === KONAMI.length) {
      konamiPos = 0;
      konami();
    }

    const typing = e.target.closest('input, textarea, [contenteditable]');
    if ((e.ctrlKey || e.metaKey) && key === 'k') {
      e.preventDefault();
      if (term.hidden) openTerm();
      else closeTerm();
      return;
    }
    if (e.key === 'Escape') {
      if (seekIsOpen()) closeSeek({ restoreFocus: true });
      else if (!term.hidden) closeTerm();
      else if (!cartEl.hidden) closeCart();
      else if (zoom.on) setZoom(false);
      else if (viewer.classList.contains('is-open')) closeSheet();
      else if (!menu.hidden) setMenu(false);
      return;
    }
    if (typing) return;
    if (e.key === '/') {
      e.preventDefault();
      openSeek();
    } else if (e.key === ':') {
      e.preventDefault();
      openTerm();
    }
  });

  /* ---------- Encargos ---------- */
  const huntForm = $('#hunt-form');
  const huntLog = $('#hunt-log');
  const huntStamp = $('#hunt-stamp');
  const huntCode = $('#hunt-code');

  huntForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const piece = huntForm.elements.pieza;
    const phone = huntForm.elements.whatsapp;
    const submit = huntForm.querySelector('[type="submit"]');
    piece.removeAttribute('aria-invalid');
    phone.removeAttribute('aria-invalid');
    huntLog.dataset.state = 'error';

    if (piece.value.trim().length < 3) {
      piece.setAttribute('aria-invalid', 'true');
      huntLog.textContent = 'Dinos qué pieza buscas (mínimo 3 caracteres).';
      piece.focus();
      return;
    }
    // igual que whatsappNumber en api/special-orders.js: celular colombiano, con o sin +57
    if (!/^3\d{9}$/.test(phone.value.replace(/[\s().-]/g, '').replace(/^\+?57(?=3\d{9}$)/, ''))) {
      phone.setAttribute('aria-invalid', 'true');
      huntLog.textContent = 'Escribe tu WhatsApp: un celular de 10 dígitos que empiece por 3.';
      phone.focus();
      return;
    }
    const consent = huntForm.elements.consent;
    consent.removeAttribute('aria-invalid');
    if (!consent.checked) {
      consent.setAttribute('aria-invalid', 'true');
      huntLog.textContent = 'Para enviar la ficha, marca la casilla de la política de tratamiento de datos.';
      consent.focus();
      return;
    }

    submit.disabled = true;
    delete huntLog.dataset.state;
    huntLog.textContent = 'Archivando tu ficha…';
    try {
      const { code } = await api('/api/special-orders', { method: 'POST', body: { piece: piece.value, whatsapp: phone.value, consent: true } });
      huntCode.textContent = `nº ${code}`;
      huntStamp.innerHTML = `Recibido<br>${esc(code)}`;
      huntStamp.hidden = false;
      huntForm.classList.add('is-stamped');
      huntLog.dataset.state = 'ok';
      huntLog.textContent = copy('encargos.success', 'Ficha {codigo} archivada. Te escribimos por WhatsApp en menos de 48 h.').replace('{codigo}', code);
      huntForm.reset();
      unlock('cazador');
    } catch (err) {
      huntLog.dataset.state = 'error';
      huntLog.textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  });

  /* ---------- Correo ---------- */
  const joinForm = $('#join-form');
  const joinMsg = $('#join-msg');
  joinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = joinForm.elements.email;
    const submit = joinForm.querySelector('[type="submit"]');
    if (!email.checkValidity()) {
      email.setAttribute('aria-invalid', 'true');
      joinMsg.dataset.state = 'error';
      joinMsg.textContent = 'Revisa tu correo: falta algo (ej. nombre@correo.com).';
      email.focus();
      return;
    }
    email.removeAttribute('aria-invalid');
    const consent = joinForm.elements.consent;
    consent.removeAttribute('aria-invalid');
    if (!consent.checked) {
      consent.setAttribute('aria-invalid', 'true');
      joinMsg.dataset.state = 'error';
      joinMsg.textContent = 'Para suscribirte, marca la casilla de la política de tratamiento de datos.';
      consent.focus();
      return;
    }
    submit.disabled = true;
    try {
      const res = await api('/api/subscribe', {
        method: 'POST',
        body: { email: email.value, website: joinForm.elements.website.value, consent: true },
      });
      joinMsg.dataset.state = 'ok';
      joinMsg.textContent = res.already
        ? copy('correo.already', 'Ya estabas en la lista. Nos vemos en el próximo drop.')
        : copy('correo.success', 'Listo: te avisamos al instante cada vez que salga un drop. Te damos la bienvenida a la zona.');
      joinForm.reset();
      unlock('en-la-lista');
    } catch (err) {
      joinMsg.dataset.state = 'error';
      joinMsg.textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  });

  // vuelta del enlace «darte de baja» de un correo de drops (/api/subscribe?baja=… redirige a /?baja=ok#correo)
  const baja = new URLSearchParams(window.location.search).get('baja');
  if (baja) {
    joinMsg.removeAttribute('data-cms'); // que el texto editable de la nota no lo pise al cargar
    joinMsg.dataset.state = 'ok';
    joinMsg.textContent = baja === 'ok'
      ? 'Listo: te diste de baja y ya no te llegarán avisos de drops. Si fue un error, vuelve a suscribirte aquí.'
      : 'Ese enlace de baja ya se usó: no estás en la lista.';
    window.history.replaceState(null, '', `${window.location.pathname}#correo`);
  }

  /* ---------- Cuenta: la barra muestra tu credencial con su nivel (y la curaduría si eres admin) ---------- */
  function renderAccount() {
    if (!state.user) return;
    const user = progress.currentUser() ?? state.user; // la versión más nueva (trae apodo y color)
    const s = progress.stats();
    const link = $('[data-account]');
    const shown = user.nickname || user.name.split(' ')[0];
    const label = Array.from(shown).length > 16 ? `${Array.from(shown).slice(0, 15).join('')}…` : shown;
    const level = `Lv ${pad(s.level)} · ${progress.levelName(s.level)}`;
    if (!$('.avatar', link)) {
      link.innerHTML = '<span class="avatar" aria-hidden="true"></span><span data-account-label></span><span class="bar__lv lv mono" aria-hidden="true"></span>';
    }
    // el cuadro: color elegido en la credencial (o el del nivel), inicial del apodo y barrita de XP
    progress.paintAvatar($('.avatar', link), { name: shown, color: user.avatarColor, level: s.level, ratio: s.ratio });
    $('[data-account-label]', link).textContent = label;
    const tag = $('.bar__lv', link);
    tag.dataset.lv = String(s.level);
    tag.textContent = `Lv${s.level}`;
    link.setAttribute('aria-label', `Tu credencial: ${user.nickname ? `${user.nickname} (${user.name})` : user.name} · ${level}`);
    link.title = `${level} · ${num(s.xp)}${s.next ? ` / ${num(s.next)}` : ''} XP`;
  }

  function renderLadderNote() {
    const note = $('#ladder-note');
    const s = progress.stats();
    if (!state.user) {
      const local = s.count
        ? ` Llevas ${s.count} ${s.count === 1 ? 'logro' : 'logros'} en este navegador: pasan a tu credencial cuando la crees.`
        : '';
      note.innerHTML = `<span data-cms="niveles.note">${esc(copy('niveles.note', 'Las credenciales de jugador ya están abiertas.'))}</span>${esc(local)} <a class="link" href="/cuenta#registro">Crea la tuya →</a>`;
      return;
    }
    note.innerHTML = `Tu credencial: <b>${esc(progress.displayName(progress.currentUser() ?? state.user))}</b> · <span class="lv" data-lv="${s.level}">Lv ${pad(s.level)} · ${esc(progress.levelName(s.level))}</span> · ${num(s.xp)} XP. ${esc(progress.nextStep(s))} <a class="link" href="/cuenta">Ver credencial →</a>`;
  }

  async function loadAccount() {
    let user = null;
    try {
      ({ user } = await api('/api/auth/me'));
    } catch {
      /* sin API o sin base: se queda el enlace "Entrar" y los logros siguen en el navegador */
    }
    state.user = user;
    if (user) {
      $('[data-account-menu]').lastChild.textContent = 'Mi credencial';
      $('[data-admin-link]').hidden = user.role !== 'admin';
    }
    progress.setUser(user);
  }

  // cada cambio de logros o de nivel se refleja en la cuadrícula, la escalera y la barra
  progress.subscribe(({ fresh } = {}) => {
    // el nivel cambia lo que se paga: precio con beneficio, drops y carrito
    const current = findProduct(state.selectedId);
    if (current) paintPerk(current);
    if (state.dropsLoaded) renderDrops();
    paintCartPerk();
    paintSeen();
    renderAchievements(fresh);
    renderLadder();
    renderLadderNote();
    renderAccount();
  });

  /* ---------- Visítanos: dirección, horario en vivo (hora de Bogotá) y plano ---------- */
  /** Mismas claves que DAYS en lib/site.js, con su abreviatura, «el lunes» y el día en schema.org. */
  const DAYS = [
    ['lun', 'Lun', 'el lunes', 'Monday'], ['mar', 'Mar', 'el martes', 'Tuesday'], ['mie', 'Mié', 'el miércoles', 'Wednesday'],
    ['jue', 'Jue', 'el jueves', 'Thursday'], ['vie', 'Vie', 'el viernes', 'Friday'], ['sab', 'Sáb', 'el sábado', 'Saturday'],
    ['dom', 'Dom', 'el domingo', 'Sunday'],
  ];
  /** Igual que SITE_DEFAULTS.visita en lib/site.js: rige mientras carga /api/site (o si falla). */
  const VISIT = {
    address: 'Cra. 7 #23-65',
    city: 'Bogotá, Colombia',
    coords: '4.60968, -74.07029',
    hours: { lun: '9:00-19:00', mar: '9:00-19:00', mie: '9:00-19:00', jue: '9:00-19:00', vie: '9:00-19:00', sab: '10:00-18:00', dom: '10:00-18:00', fes: '10:00-18:00' },
  };

  /*
   * Festivos de Colombia (Ley 51 de 1983, «Ley Emiliani»): los fijos, los que se corren al lunes siguiente y los
   * que dependen de la Pascua. Esos días la tienda usa el horario «Festivos» en lugar del de su día de la semana.
   */
  const festivosCache = new Map();
  function festivosCO(year) {
    if (festivosCache.has(year)) return festivosCache.get(year);
    const utc = (m, d) => new Date(Date.UTC(year, m - 1, d));
    const plus = (date, days) => new Date(date.getTime() + days * 864e5);
    const nextMonday = (date) => plus(date, (8 - date.getUTCDay()) % 7); // si ya cae lunes, se queda
    // domingo de Pascua (algoritmo de Meeus/Jones/Butcher)
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const h = (19 * a + b - Math.floor(b / 4) - Math.floor((b - Math.floor((b + 8) / 25) + 1) / 3) + 15) % 30;
    const l = (32 + 2 * (b % 4) + 2 * Math.floor(c / 4) - h - (c % 4)) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const easter = utc(Math.floor((h + l - 7 * m + 114) / 31), ((h + l - 7 * m + 114) % 31) + 1);
    const days = [
      utc(1, 1), utc(5, 1), utc(7, 20), utc(8, 7), utc(12, 8), utc(12, 25), // fijos
      ...[[1, 6], [3, 19], [6, 29], [8, 15], [10, 12], [11, 1], [11, 11]].map(([mm, dd]) => nextMonday(utc(mm, dd))), // al lunes
      plus(easter, -3), plus(easter, -2), // jueves y viernes santo
      plus(easter, 43), plus(easter, 64), plus(easter, 71), // Ascensión, Corpus Christi y Sagrado Corazón, ya en lunes
    ];
    const set = new Set(days.map((d) => d.toISOString().slice(0, 10)));
    festivosCache.set(year, set);
    return set;
  }
  const addDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
  /** Qué horario rige un día (AAAA-MM-DD): el de festivos si lo es; si no, el de su día de la semana. */
  function dayInfo(iso) {
    const date = new Date(`${iso}T12:00:00Z`);
    const idx = (date.getUTCDay() + 6) % 7; // 0 = lunes
    const festivo = festivosCO(date.getUTCFullYear()).has(iso);
    return { key: festivo ? 'fes' : DAYS[idx][0], idx, festivo };
  }
  /** El próximo festivo desde hoy (incluido), para mostrarlo junto al horario. */
  function nextFestivo(iso) {
    for (let i = 0; i < 370; i += 1) {
      const d = addDays(iso, i);
      if (dayInfo(d).festivo) return d;
    }
    return null;
  }
  const visitMap = { el: $('#sala-map'), map: null, pin: null, loading: null };
  ['#sala-route', '#sala-waze'].forEach((sel) => $(sel).addEventListener('click', () => unlock('cartografo')));

  const visit = (key) => pick(`visita.${key}`) ?? VISIT[key];
  const clock = (min) => `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;
  /** "11:00-20:00" → minutos desde la medianoche; "cerrado" (o algo ilegible) → null. */
  function shift(value) {
    const m = /^(\d{1,2}):(\d{2}) ?[-–] ?(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
    if (!m) return null;
    const open = Number(m[1]) * 60 + Number(m[2]);
    let close = Number(m[3]) * 60 + Number(m[4]);
    if (close <= open) close += 24 * 60; // cierra pasada la medianoche
    return { open, close, label: `${clock(open)} – ${clock(close)}` };
  }
  function coordsOf(value) {
    const m = /^(-?\d{1,2}(?:\.\d+)?), ?(-?\d{1,3}(?:\.\d+)?)$/.exec(String(value ?? '').trim());
    return m ? [Number(m[1]), Number(m[2])] : null;
  }
  /** Día (0 = lunes), fecha (AAAA-MM-DD) y minuto actuales en Bogotá, se mire la página desde donde se mire. */
  function bogotaNow() {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Bogota', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map((p) => [p.type, p.value]));
    return {
      day: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday),
      date: `${parts.year}-${parts.month}-${parts.day}`,
      min: Number(parts.hour) * 60 + Number(parts.minute),
    };
  }

  function renderVisitStatus() {
    const hours = visit('hours');
    const { date, min } = bogotaNow();
    const now = dayInfo(date);
    const today = shift(hours[now.key]);
    const yesterday = shift(hours[dayInfo(addDays(date, -1)).key]);
    let closesAt = null;
    if (today && min >= today.open && min < today.close) closesAt = today.close;
    else if (yesterday && min + 24 * 60 < yesterday.close) closesAt = yesterday.close; // turno de ayer que pasa la medianoche
    const tag = now.festivo ? ' · hoy es festivo' : '';
    let html = closesAt === null ? `<b>Cerrado</b>${tag || ' por ahora'}` : `<b>Abierto ahora</b>${tag} · cierra a las ${clock(closesAt)}`;
    // cerrado: busca el próximo turno (i = 7 es este mismo día, la semana que viene); los festivos usan su horario
    for (let i = 0; i <= 7 && closesAt === null; i++) {
      const d = dayInfo(addDays(date, i));
      const next = shift(hours[d.key]);
      if (!next || (i === 0 && min >= next.open)) continue;
      const when = i === 0 ? 'hoy' : i === 1 ? 'mañana' : DAYS[d.idx][2];
      html = `<b>Cerrado</b>${tag} · abre ${when}${i > 0 && d.festivo ? ' (festivo)' : ''} a las ${clock(next.open)}`;
      break;
    }
    $('#sala-status').dataset.open = String(closesAt !== null);
    $('#sala-status-text').innerHTML = html;
    $$('[data-horario]').forEach((el) => { el.textContent = todayHours(); }); // el dato «hoy en tienda» de la portada
  }

  /** El horario de hoy en corto, para el token {horario} de los datos de la portada: «9–19 h», «9:30–19 h» o «Cerrado». */
  function todayHours() {
    const s = shift(visit('hours')[dayInfo(bogotaNow().date).key]);
    if (!s) return 'Cerrado';
    const short = (min) => `${Math.floor(min / 60) % 24}${min % 60 ? `:${pad(min % 60)}` : ''}`;
    return `${short(s.open)}–${short(s.close)} h`;
  }

  function renderVisit() {
    const hours = visit('hours');
    const address = visit('address');
    const city = visit('city');
    const place = `${address}, ${city}`;
    const ll = coordsOf(visit('coords'));
    const { day, date } = bogotaNow();
    const festivoHoy = dayInfo(date).festivo;

    // días seguidos con el mismo horario van en una sola fila: Lun – Sáb · 11:00 – 20:00
    const rows = [];
    DAYS.forEach(([key, short], i) => {
      const s = shift(hours[key]);
      const label = s?.label ?? 'Cerrado';
      const last = rows[rows.length - 1];
      if (last?.label === label) {
        last.to = short;
        last.days.push(i);
      } else {
        rows.push({ from: short, to: '', label, open: Boolean(s), days: [i] });
      }
    });
    // los festivos de Colombia, con el próximo que viene
    const fes = shift(hours.fes);
    const proximo = nextFestivo(date);
    const proximoTxt = proximo
      ? new Date(`${proximo}T12:00:00Z`).toLocaleDateString('es-CO', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).replace(/\./g, '')
      : '';
    rows.push({ from: 'Festivos', to: '', label: fes?.label ?? 'Cerrado', open: Boolean(fes), days: [], festivo: true, note: proximo === date ? 'hoy' : proximoTxt ? `próx. ${proximoTxt}` : '' });
    $('#sala-hours').innerHTML = rows.map((r) => {
      const today = r.festivo ? festivoHoy : !festivoHoy && r.days.includes(day);
      const cls = [r.open ? '' : 'is-closed', today ? 'is-today' : '', r.festivo ? 'is-festivo' : ''].join(' ').trim();
      const name = r.to ? `${r.from} – ${r.to}` : r.from;
      return `<li${cls ? ` class="${cls}"` : ''}${today ? ' aria-current="date"' : ''}><span>${name}${r.note ? ` <small>${r.note}</small>` : ''}</span><b>${r.label}</b></li>`;
    }).join('');

    $('#sala-route').href = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(place)}`;
    $('.plano__fallback')?.setAttribute('href', `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`);
    $('#sala-waze').hidden = !ll;
    visitMap.el.setAttribute('aria-label', `Mapa: Dream Zone en ${place}`);
    if (ll) {
      $('#sala-waze').href = `https://waze.com/ul?ll=${ll[0]},${ll[1]}&navigate=yes`;
      $('#sala-coords').textContent = `${Math.abs(ll[0]).toFixed(5)}° ${ll[0] < 0 ? 'S' : 'N'} · ${Math.abs(ll[1]).toFixed(5)}° ${ll[1] < 0 ? 'O' : 'E'}`;
      if (visitMap.map) {
        visitMap.pin.setLatLng(ll);
        visitMap.map.setView(ll, visitMap.map.getZoom(), { animate: false });
      }
    }
    renderVisitStatus();

    // ficha para buscadores con la dirección y el horario vigentes
    const opening = [];
    DAYS.forEach(([key, , , dayOfWeek]) => {
      const s = shift(hours[key]);
      if (!s) return;
      const same = opening.find((o) => o.opens === clock(s.open) && o.closes === clock(s.close));
      if (same) same.dayOfWeek.push(dayOfWeek);
      else opening.push({ '@type': 'OpeningHoursSpecification', dayOfWeek: [dayOfWeek], opens: clock(s.open), closes: clock(s.close) });
    });
    const ld = $('#ld-store');
    if (ld) {
      ld.textContent = JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Store',
        name: 'Dream Zone',
        address: { '@type': 'PostalAddress', streetAddress: address, addressLocality: city.split(',')[0].trim(), addressCountry: 'CO' },
        ...(ll ? { geo: { '@type': 'GeoCoordinates', latitude: ll[0], longitude: ll[1] } } : {}),
        openingHoursSpecification: opening,
      });
    }
  }

  /* El plano usa Leaflet (alojado en /js/vendor) con tiles de OpenStreetMap; se carga solo al acercarse a la sección. */
  function loadLeaflet() {
    if (window.L) return Promise.resolve(window.L);
    visitMap.loading ??= new Promise((resolve, reject) => {
      const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'css/vendor/leaflet.css' });
      const js = Object.assign(document.createElement('script'), { src: 'js/vendor/leaflet.js' });
      const ready = (el) => new Promise((ok, fail) => { el.onload = ok; el.onerror = fail; });
      Promise.all([ready(css), ready(js)]).then(() => resolve(window.L), (err) => {
        visitMap.loading = null;
        css.remove();
        js.remove();
        reject(err);
      });
      // antes de styles.css: con la misma especificidad ganan nuestras reglas
      document.head.insertBefore(css, $('link[href="css/styles.css"]'));
      document.head.append(js);
    });
    return visitMap.loading;
  }

  async function mountMap() {
    if (visitMap.map || !coordsOf(visit('coords'))) return;
    let L;
    try {
      L = await loadLeaflet();
    } catch {
      return; // sin Leaflet queda el enlace a Google Maps
    }
    const ll = coordsOf(visit('coords'));
    if (visitMap.map || !ll) return;
    visitMap.el.textContent = '';
    const motion = !reduceMotion.matches;
    const map = L.map(visitMap.el, {
      center: ll,
      zoom: 17,
      minZoom: 12,
      maxZoom: 19,
      zoomControl: false,
      attributionControl: false, // el crédito de OpenStreetMap va en el pie del plano
      scrollWheelZoom: false,
      dragging: !L.Browser.mobile, // en el celular un dedo mueve la página y dos hacen zoom
      zoomAnimation: motion,
      fadeAnimation: motion,
      markerZoomAnimation: motion,
    });
    L.control.zoom({ position: 'bottomright', zoomInTitle: 'Acercar', zoomOutTitle: 'Alejar' }).addTo(map);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, className: 'plano__tiles' }).addTo(map);
    visitMap.pin = L.marker(ll, {
      icon: L.divIcon({
        className: 'pin',
        iconSize: [0, 0],
        html: '<span class="pin__logo"></span><span class="pin__stem"></span><span class="pin__dot"></span><span class="pin__label">Dream Zone</span>',
      }),
      keyboard: false,
      interactive: false,
    }).addTo(map);
    visitMap.map = map;

    const center = $('#sala-center');
    center.hidden = false;
    center.addEventListener('click', () => {
      const here = coordsOf(visit('coords'));
      if (here) map.setView(here, 17, { animate: motion });
    });
  }

  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      mountMap();
    }, { rootMargin: '600px 0px' });
    io.observe(visitMap.el);
  } else {
    mountMap();
  }

  /* ---------- Contenido editable: textos, zonas y colores de la curaduría ---------- */
  function pick(path) {
    return path.split('.').reduce((obj, key) => (obj == null ? undefined : obj[key]), state.site);
  }
  /** Texto de la curaduría o, si aún no carga (o falla la API), el texto original. */
  function copy(path, fallback) {
    const value = pick(path);
    return typeof value === 'string' && value ? value : fallback;
  }
  /** *palabra* → énfasis (con eco de color en los titulares). El texto se escapa antes. */
  function rich(value, echo) {
    return esc(value).replace(/\*([^*]+)\*/g, (_, w) => (echo ? `<em class="echo" data-text="${w}">${w}</em>` : `<em>${w}</em>`));
  }
  function linkAttrs(url) {
    // una página propia guardada como «cuenta.html#pedidos» sale con la dirección limpia: /cuenta#pedidos
    const raw = String(url ?? '').trim().replace(/^(?:\/)?([a-z0-9-]+)\.html(?=$|[?#])/i, (_, page) => (page === 'index' ? '/' : `/${page}`));
    const href = /^(?:https?:\/\/|mailto:|tel:|#|\/)/i.test(raw) ? raw : '#';
    return /^https?:/i.test(href) ? `href="${esc(href)}" target="_blank" rel="noopener"` : `href="${esc(href)}"`;
  }
  /** Redes con logo en el pie: se reconocen por la dirección del enlace (los logos están en el sprite, #s-…). */
  const NETWORKS = [
    ['instagram', /(?:^|\.)instagram\.com$/i],
    ['tiktok', /(?:^|\.)tiktok\.com$/i],
    ['whatsapp', /^(?:wa\.me|(?:[a-z]+\.)?whatsapp\.com)$/i],
  ];
  function networkOf(url) {
    try {
      const { hostname } = new URL(String(url ?? '').trim());
      return NETWORKS.find(([, re]) => re.test(hostname))?.[0] ?? null;
    } catch {
      return null; // una sección (#visita) o una página propia
    }
  }
  function footerLink(l) {
    const net = networkOf(l.url);
    if (!net) return `<a ${linkAttrs(l.url)}>${esc(l.label)}</a>`;
    return `<a class="social" data-net="${net}" ${linkAttrs(l.url)}><svg class="social__logo" aria-hidden="true"><use href="#s-${net}"/></svg>${esc(l.label)}</a>`;
  }

  function applySite(next) {
    if (!next || typeof next !== 'object') return;
    state.site = next;
    document.title = copy('general.title', document.title);
    $('meta[name="description"]')?.setAttribute('content', copy('general.description', ''));

    $$('[data-cms]').forEach((el) => {
      const value = pick(el.dataset.cms);
      if (typeof value !== 'string') return;
      if (el.dataset.rich) el.innerHTML = rich(value, el.dataset.rich === 'echo');
      else el.textContent = value;
    });
    $$('[data-cms-ph]').forEach((el) => {
      const value = pick(el.dataset.cmsPh);
      if (typeof value === 'string') el.placeholder = value;
    });

    // una zona recién añadida en la curaduría aún no tiene identificador: en la vista previa usa uno provisional
    const zonas = (pick('zonas.items') ?? []).filter((z) => z?.label).map((z, i) => ({ ...z, key: z.key || `nueva-${i}` }));
    if (zonas.length) {
      zoneList = zonas;
      Object.keys(ZONES).forEach((key) => { delete ZONES[key]; });
      zoneList.forEach((z) => { ZONES[z.key] = z.label; });
      paintZoneTones();
      renderZones();
    }

    const facts = pick('intro.facts');
    if (Array.isArray(facts)) {
      // {piezas} y {zonas} se cuentan; {horario} es el de hoy (renderVisitStatus lo pone y lo actualiza cada minuto)
      const tokens = (s) => esc(s).replace('{piezas}', '<span data-count="total">—</span>').replace('{zonas}', pad(zoneList.length))
        .replace('{horario}', `<span data-horario>${esc(todayHours())}</span>`);
      $('#facts').innerHTML = facts.map((f) => `<li><b>${tokens(f.value)}</b> ${tokens(f.label)}</li>`).join('');
      if (state.counts) renderCounts(state.counts.counts, state.counts.total);
    }


    const steps = pick('encargos.steps');
    if (Array.isArray(steps)) {
      $('#hunt-steps').innerHTML = steps.map((step, i) => `<li><span class="mono">${pad(i + 1)}</span>${esc(step)}</li>`).join('');
    }

    const columns = pick('pie.columns');
    if (Array.isArray(columns)) {
      $('#footer-cols').innerHTML = columns.map((col) => `
        <nav aria-label="${esc(col.title)}"><p class="muted">${esc(col.title)}</p>${(col.links ?? []).map(footerLink).join('')}</nav>`).join('');
    }
    const legal = pick('pie.legal');
    const privacy = pick('pie.privacy');
    if (typeof legal === 'string') {
      $('#footer-legal').innerHTML = `${esc(legal)}${privacy?.label ? ` · <a class="link" ${linkAttrs(privacy.url)}>${esc(privacy.label)}</a>` : ''}`;
    }

    progress.applyCopy(next); // nombres de logros y niveles: vuelve a pintar la escalera y la cuadrícula
    renderVisit();

    // lo que ya está en pantalla y depende de estos textos
    if (state.dropsLoaded) renderDrops();
    if (listEl.getAttribute('aria-busy') === 'false') renderList();
    const current = findProduct(state.selectedId);
    if (current) renderViewer(current);
  }

  async function loadSite() {
    try {
      const { site } = await api('/api/site');
      applySite(site);
    } catch {
      /* sin API: se quedan los textos del HTML */
    }
  }

  /* Vista previa: el panel manda el borrador por postMessage (solo desde este mismo sitio). */
  function previewScroll(target) {
    if (target === 'cart') {
      openCart();
      return;
    }
    closeCart();
    const el = $(target);
    // window.scrollTo y no scrollIntoView: este último también movería la página del panel
    if (el) window.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top + window.scrollY - 64), behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  }
  if (PREVIEW) {
    let lastFocus = null;
    window.addEventListener('message', (e) => {
      if (e.origin !== window.location.origin || e.source !== window.parent || e.data?.type !== 'dz:site') return;
      applySite(e.data.site);
      if (e.data.focus && e.data.focus !== lastFocus) {
        lastFocus = e.data.focus;
        previewScroll(e.data.focus);
      }
    });
    // en la vista previa los enlaces a otras páginas no navegan (se perdería el borrador)
    document.addEventListener('click', (e) => {
      const a = e.target.closest('a[href]');
      if (a && !a.getAttribute('href').startsWith('#')) e.preventDefault();
    }, true);
  }

  /* ---------- Para quien abre la consola ---------- */
  console.log(
    '%c DZ %c Archivo de reliquias',
    'background:linear-gradient(100deg,#2E9BDA,#2B6CB4,#4A47A3);color:#fff;font:700 20px monospace;padding:4px 10px',
    'color:#EDEDEB;font:16px monospace;padding:4px 8px',
  );
  console.log('¿Inspeccionando el código? Eres de los nuestros.\nPrueba Ctrl/⌘ K en la página… o un viejo código de 10 teclas.');

  /* ---------- Carga inicial ---------- */
  renderAchievements();
  renderLadder();
  renderLadderNote();
  renderVisit();
  setInterval(renderVisitStatus, 60 * 1000);
  if (PREVIEW) window.parent.postMessage({ type: 'dz:preview-ready' }, window.location.origin);
  const loads = [PREVIEW ? null : loadSite(), loadCatalog(), loadDrops()];
  // un enlace a una sección desde otra página (/#encargos, del 404 o del correo): el índice y los drops cargan
  // después y empujan la sección hacia abajo, así que se vuelve a ubicar cuando ya cargaron (si nadie ha movido la página)
  const landing = !PREVIEW && /^#[\w-]+$/.test(window.location.hash) ? document.getElementById(window.location.hash.slice(1)) : null;
  if (landing) {
    let moved = false;
    const stop = () => { moved = true; };
    ['wheel', 'touchmove', 'keydown', 'pointerdown'].forEach((type) => window.addEventListener(type, stop, { once: true, passive: true }));
    Promise.allSettled(loads).then(() => requestAnimationFrame(() => { if (!moved) landing.scrollIntoView({ block: 'start' }); }));
  }
  loadCart();
  loadAccount();
  if (new Date().getHours() < 5) setTimeout(() => unlock('buho'), 1500);
})();
