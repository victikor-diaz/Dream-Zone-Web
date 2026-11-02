/* DREAM ZONE — Curaduría, módulo Piezas: alta, edición y baja de piezas con fotos y vista previa en vivo.
   Todo pasa por /api/admin/products y /api/media (solo admins; el servidor lo comprueba siempre).
   Los demás módulos (Página, Drops, Buzón, Equipo) viven en admin-modules.js. */
(() => {
  'use strict';

  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const money = (cents) => {
    if (!Number.isFinite(cents)) return '—';
    const whole = cents % 100 === 0;
    return `$${(cents / 100).toLocaleString('es-CO', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
  };
  const fold = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  /* Deben coincidir con lib/catalog.js */
  const ZONES = { figuras: 'Figuras', manga: 'Manga', retro: 'Retro', tcg: 'TCG & rol', mesa: 'Mesa', merch: 'Merch' };
  const ICONS = { mecha: 'Mecha', d20: 'Dado D20', book: 'Libro', pad: 'Control', cards: 'Cartas', helmet: 'Casco', cart: 'Cartucho', shirt: 'Playera', meeple: 'Meeple', cap: 'Gorra', wallet: 'Billetera', bag: 'Bolso' };
  const BADGES = [['', 'Ninguna'], ['nuevo', 'Nuevo'], ['ultimas', 'Últimas'], ['oferta', 'Oferta']];
  const STATUSES = [['active', 'Activa'], ['draft', 'Borrador'], ['archived', 'Archivada']];
  const STATUS_LABEL = Object.fromEntries(STATUSES);
  const RARITY = ['', 'Común', 'Poco común', 'Rara', 'Épica', 'Legendaria'];
  const TONES = ['#3db8f5', '#ff5c9d', '#ffb238', '#a78bfa', '#4ade80', '#ff7849', '#e4ff5e', '#ff5a5a', '#4c9bff', '#ededeb'];
  const HEX_RE = /^#[0-9a-f]{6}$/i;
  const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const SKU_RE = /^[A-Z0-9][A-Z0-9-]{1,23}$/;
  const MAX_IMAGES = 8;

  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  $$('[data-save-key]').forEach((el) => { el.textContent = isMac ? '⌘ S' : 'Ctrl S'; });

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
    if (!res.ok) {
      const err = new Error(data?.error || `Error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /* ---------- Avisos (barra de estado) ---------- */
  const statusbar = $('#statusbar');
  let noticeTimer = 0;
  function notify(msg, { tone = 'ok', tag } = {}) {
    $('#statusbar-tag').textContent = tag ?? (tone === 'error' ? 'err' : 'ok');
    $('#statusbar-msg').textContent = msg;
    statusbar.classList.toggle('is-error', tone === 'error');
    statusbar.classList.add('is-on');
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => statusbar.classList.remove('is-on'), tone === 'error' ? 5000 : 2600);
  }

  /* ---------- Estado ---------- */
  const state = {
    user: null,
    products: [],
    filter: 'all',
    query: '',
    current: null, // pieza guardada que se está editando (null = pieza nueva)
    open: false,
    images: [], // [{ id, url, cutout, fresh?, uploading?, key }]
    snapshot: '',
    createdAtInitial: '',
    slugTouched: false,
    saving: false,
    uploads: 0,
  };
  let imageKey = 0;

  const form = $('#ed');
  const F = form.elements;
  const listEl = $('#cur-list');
  const cur = $('#cur');

  /* ---------- Opciones del formulario (se generan una vez) ---------- */
  function radioChip(name, value, label, attrs = '') {
    return `<label class="chip" ${attrs}><input class="sr-only" type="radio" name="${name}" value="${esc(value)}">${esc(label)}</label>`;
  }
  /** Una ficha por zona (las define el módulo Página); conserva la elegida al rehacerlas. */
  function renderZoneChips() {
    const chosen = form.querySelector('input[name="category"]:checked')?.value;
    $('#opt-category').innerHTML = Object.entries(ZONES).map(([k, v]) => radioChip('category', k, v, `data-zone="${k}"`)).join('');
    const again = chosen && form.querySelector(`input[name="category"][value="${CSS.escape(chosen)}"]`);
    if (again) again.checked = true;
  }
  renderZoneChips();
  $('#opt-badge').innerHTML = BADGES.map(([k, v]) => radioChip('badge', k, v, `data-badge="${k || 'none'}"`)).join('');
  $('#opt-status').innerHTML = STATUSES.map(([k, v]) => radioChip('status', k, v, `data-status="${k}"`)).join('');
  $('#opt-rarity').innerHTML = [1, 2, 3, 4, 5].map((r) => `
    <label class="rar-opt" data-r="${r}">
      <input class="sr-only" type="radio" name="rarity" value="${r}">
      ${pips(r)}<span class="rar" data-r="${r}">${RARITY[r]}</span>
    </label>`).join('');
  $('#opt-icon').innerHTML = Object.entries(ICONS).map(([k, v]) => `
    <label class="icon-opt">
      <input class="sr-only" type="radio" name="icon" value="${k}">
      <svg class="ill" viewBox="-4 -4 128 128" aria-hidden="true"><use href="#i-${k}" width="120" height="120"/></svg>
      <span class="mono">${esc(v)}</span>
    </label>`).join('');
  $('#opt-tone').innerHTML = `
    <label class="sw sw--auto" title="Usa el color de su zona"><input class="sr-only" type="radio" name="tone" value=""><span class="mono">Auto · zona</span></label>
    ${TONES.map((t) => `<label class="sw" style="--sw:${t}" title="${t}"><input class="sr-only" type="radio" name="tone" value="${t}"><span class="sr-only">${t}</span></label>`).join('')}
    <label class="sw sw--custom" title="Color a medida"><input class="sr-only" type="radio" name="tone" value="custom"><input type="color" id="tone-custom" value="#ffffff" aria-label="Color a medida"></label>`;

  function pips(rarity) {
    const r = Math.min(5, Math.max(1, Number(rarity) || 1));
    const cells = Array.from({ length: 5 }, (_, k) => `<i${k < r ? ' class="on"' : ''}></i>`).join('');
    return `<span class="pips" data-r="${r}" aria-hidden="true">${cells}</span>`;
  }

  const radio = (name) => form.querySelector(`input[name="${name}"]:checked`)?.value ?? '';
  function setRadio(name, value) {
    const input = form.querySelector(`input[name="${name}"][value="${CSS.escape(String(value))}"]`);
    if (input) input.checked = true;
  }

  /* ---------- Utilidades de datos ---------- */
  const slugify = (s) => fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '');
  const digits = (sku) => (sku || '').replace(/\D/g, '') || '—';
  /** Pesos sin centavos se escriben enteros (59900), con centavos con punto (59900.50). */
  const centsToInput = (c) => (c % 100 === 0 ? String(c / 100) : (c / 100).toFixed(2));
  /**
   * Precio escrito a mano → centavos (NaN si no es un precio). Entiende el formato colombiano
   * («59.900», «1.299.900,50»), el gringo («59,900.50») y el número pelado («59900»).
   */
  function parseMoney(value) {
    let clean = String(value).replace(/[\s$]/g, '');
    if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(clean)) clean = clean.replace(/\./g, '').replace(',', '.');
    else if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(clean)) clean = clean.replace(/,/g, '');
    else if (/^\d+,\d{1,2}$/.test(clean)) clean = clean.replace(',', '.');
    if (!/^\d+(\.\d{1,2})?$/.test(clean)) return NaN;
    return Math.round(Number(clean) * 100);
  }
  function toLocalInput(iso) {
    const d = new Date(iso);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  const fmtDate = (iso) => {
    const d = new Date(iso);
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  function nextSku() {
    const max = state.products.reduce((m, p) => Math.max(m, Number.parseInt(digits(p.sku), 10) || 0), 0);
    return `DZ-${pad(max + 1, 4)}`;
  }
  function uniqueSlug(base) {
    const taken = new Set(state.products.filter((p) => p._id !== state.current?._id).map((p) => p.slug));
    let slug = base || 'pieza';
    for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`;
    return slug;
  }
  const toneOf = (data) => (HEX_RE.test(data.tone ?? '') ? data.tone : null);
  /* ---------- Formulario ⇄ datos ---------- */
  function readTone() {
    const value = radio('tone');
    if (value === 'custom') return $('#tone-custom').value.toLowerCase();
    return value || null;
  }
  function setTone(tone) {
    const t = (tone ?? '').toLowerCase();
    if (!t) return setRadio('tone', '');
    if (TONES.includes(t)) return setRadio('tone', t);
    $('#tone-custom').value = t;
    return setRadio('tone', 'custom');
  }

  function readForm() {
    return {
      name: F.name.value.trim(),
      subtitle: F.subtitle.value.trim(),
      category: radio('category'),
      slug: F.slug.value.trim(),
      sku: F.sku.value.trim().toUpperCase(),
      priceCents: parseMoney(F.price.value),
      compareAtCents: F.compareAt.value.trim() ? parseMoney(F.compareAt.value) : null,
      badge: radio('badge') || null,
      stock: F.hasSizes.checked ? sizesTotal() : F.stock.value === '' ? NaN : Number(F.stock.value),
      sizes: F.hasSizes.checked ? readSizes() : null,
      rarity: Number(radio('rarity')) || 1,
      icon: radio('icon') || 'mecha',
      tone: readTone(),
      lore: F.lore.value.trim(),
      weightGrams: F.weight.value === '' ? null : Number(F.weight.value),
      status: radio('status') || 'draft',
      // solo se manda si la cambiaste (el input pierde los segundos y reordenaría el índice)
      createdAt: F.createdAt.value && F.createdAt.value !== state.createdAtInitial ? new Date(F.createdAt.value).toISOString() : null,
      images: state.images.filter((img) => img.id).map((img) => img.id),
    };
  }

  function fillForm(p) {
    F.name.value = p.name ?? '';
    F.subtitle.value = p.subtitle ?? '';
    setRadio('category', p.category ?? 'figuras');
    F.slug.value = p.slug ?? '';
    F.sku.value = p.sku ?? '';
    F.price.value = Number.isFinite(p.priceCents) ? centsToInput(p.priceCents) : '';
    F.compareAt.value = p.compareAtCents ? centsToInput(p.compareAtCents) : '';
    setRadio('badge', p.badge ?? '');
    F.stock.value = p.stock ?? 0;
    fillSizes(p.sizes);
    setRadio('rarity', p.rarity ?? 1);
    setRadio('icon', p.icon ?? 'mecha');
    setTone(p.tone);
    F.lore.value = p.lore ?? '';
    F.weight.value = p.weightGrams ?? '';
    setRadio('status', p.status ?? 'draft');
    state.createdAtInitial = p.createdAt ? toLocalInput(p.createdAt) : '';
    F.createdAt.value = state.createdAtInitial;
    state.images = (p.images ?? []).map((img) => ({ ...img, key: (imageKey += 1) }));
    $$('[aria-invalid]', form).forEach((el) => el.removeAttribute('aria-invalid'));
    renderThumbs();
  }

  /* ---------- Tallas: existencias por talla (el total es la suma) ---------- */
  const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL']; // igual que SIZES en lib/catalog.js
  $('#sizes-grid').innerHTML = SIZES.map((s) => `
    <label class="sizes-ed__cell"><span class="mono">${s}</span><input type="number" min="0" max="100000" step="1" inputmode="numeric" data-size="${s}" placeholder="—" aria-label="Unidades en talla ${s}"></label>`).join('');
  const sizeInputs = () => $$('[data-size]', $('#sizes-grid'));
  /** Las tallas con un número (también 0: se muestra agotada); las vacías no se venden. */
  const readSizes = () => sizeInputs()
    .filter((el) => el.value !== '')
    .map((el) => ({ size: el.dataset.size, stock: Number(el.value) }));
  const sizesTotal = () => readSizes().reduce((sum, s) => sum + (Number.isFinite(s.stock) ? s.stock : 0), 0);
  function paintSizes() {
    const on = F.hasSizes.checked;
    $('#sizes-ed').hidden = !on;
    F.stock.readOnly = on;
    $('#stock-label').textContent = on ? 'Total en stock · suma de las tallas' : 'Unidades en stock';
    if (on) F.stock.value = String(sizesTotal());
    $('#stock-hint').textContent = on
      ? 'Una talla en 0 se ve agotada; las vacías no aparecen. Las piezas con tallas no pueden ir en un drop.'
      : 'Con 0 unidades la pieza se muestra agotada. Para venderla junto con otras más barata, créale un drop.';
  }
  function fillSizes(sizes) {
    const list = Array.isArray(sizes) ? sizes : [];
    F.hasSizes.checked = list.length > 0;
    sizeInputs().forEach((el) => {
      const found = list.find((s) => s.size === el.dataset.size);
      el.value = found ? String(found.stock) : '';
    });
    paintSizes();
  }
  form.addEventListener('input', (e) => { if (e.target.matches('[data-size]')) F.stock.value = String(sizesTotal()); });
  F.hasSizes.addEventListener('change', () => {
    // al activar las tallas, lo que había en stock arranca en M para no perderlo de vista
    if (F.hasSizes.checked && !readSizes().length && Number(F.stock.value) > 0) $('[data-size="M"]').value = F.stock.value;
    paintSizes();
  });

  const isDirty = () => state.open && JSON.stringify(readForm()) !== state.snapshot;
  const takeSnapshot = () => { state.snapshot = JSON.stringify(readForm()); };

  /* ---------- Índice de piezas ---------- */
  function matches(p) {
    if (state.filter !== 'all' && p.status !== state.filter) return false;
    const q = fold(state.query.trim());
    if (!q) return true;
    return fold(`${p.name} ${p.sku} ${p.slug} ${p.subtitle} ${ZONES[p.category] ?? ''}`).includes(q);
  }

  function itemHtml(p) {
    const tone = toneOf(p) ? ` style="--tone:${toneOf(p)}"` : '';
    const icon = ICONS[p.icon] ? p.icon : 'mecha';
    const thumb = p.images?.[0]
      ? `<img src="${esc(p.images[0].url)}" alt="" loading="lazy" decoding="async">`
      : `<svg class="ill" viewBox="-4 -4 128 128" aria-hidden="true"><use href="#i-${icon}" width="120" height="120"/></svg>`;
    const open = state.open && state.current?._id === p._id;
    return `
      <li class="it${open ? ' is-open' : ''}" data-zone="${esc(p.category)}"${tone}>
        <button class="it__btn" type="button" data-open="${esc(p._id)}"${open ? ' aria-current="true"' : ''}>
          <span class="it__thumb">${thumb}</span>
          <span class="it__main"><span class="it__name">${esc(p.name)}</span><span class="it__meta mono">${esc(p.sku)} · ${esc(ZONES[p.category] ?? p.category)}</span></span>
          <span class="it__status mono" data-status="${esc(p.status)}">${esc(STATUS_LABEL[p.status] ?? p.status)}</span>
          <span class="it__side mono"><span>${money(p.priceCents)}</span><span class="it__stock">${p.stock} u.</span></span>
        </button>
      </li>`;
  }

  function renderList() {
    const items = state.products.filter(matches);
    listEl.innerHTML = items.map(itemHtml).join('');
    const counts = { all: state.products.length, active: 0, draft: 0, archived: 0 };
    state.products.forEach((p) => { counts[p.status] = (counts[p.status] ?? 0) + 1; });
    $$('[data-sc]').forEach((el) => { el.textContent = counts[el.dataset.sc] ?? 0; });
    $('#cur-total').textContent = pad(state.products.length);
    const status = $('#cur-status');
    status.hidden = items.length > 0;
    status.innerHTML = state.products.length
      ? `&gt; nada coincide${state.query ? ` con “${esc(state.query)}”` : ''}.`
      : '&gt; el catálogo está vacío. Crea la primera pieza.';
  }

  async function loadProducts() {
    const { products } = await api('/api/admin/products');
    state.products = products;
    renderList();
  }

  $('#cur-search').addEventListener('input', (e) => {
    state.query = e.target.value;
    renderList();
  });
  $$('[data-filter]').forEach((chip) => chip.addEventListener('click', () => {
    state.filter = chip.dataset.filter;
    $$('[data-filter]').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
    renderList();
  }));
  listEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-open]');
    if (!btn) return;
    const p = state.products.find((item) => item._id === btn.dataset.open);
    if (p && confirmLeave()) openProduct(p);
  });

  /* ---------- Abrir / cerrar el editor ---------- */
  function confirmLeave() {
    return !isDirty() || window.confirm('Tienes cambios sin guardar en esta pieza. ¿Descartarlos?');
  }

  function showEditor() {
    // en móvil el editor reemplaza a la lista: se recuerda dónde iba para volver ahí con «← Piezas»
    if (!state.open) state.listY = window.scrollY;
    state.open = true;
    form.hidden = false;
    $('#cur-empty').hidden = true;
    cur.classList.add('is-editing');
    disarmDelete();
  }

  function openProduct(p) {
    discardFreshUploads();
    state.current = p;
    state.slugTouched = true;
    fillForm(p);
    showEditor();
    takeSnapshot();
    refresh();
    renderList();
    setState('');
    if (!window.matchMedia('(min-width: 1024px)').matches) window.scrollTo({ top: 0 });
  }

  function openNew(prefill = null) {
    discardFreshUploads();
    state.current = null;
    state.slugTouched = Boolean(prefill);
    fillForm(prefill ?? {
      name: '', subtitle: '', category: Object.keys(ZONES)[0] ?? '', slug: '', sku: nextSku(), priceCents: NaN, compareAtCents: null,
      badge: 'nuevo', stock: 0, rarity: 2, icon: 'mecha', tone: null,
      lore: '', status: 'draft', images: [],
    });
    showEditor();
    takeSnapshot();
    if (prefill) state.snapshot = ''; // un duplicado nace con cambios pendientes
    refresh();
    renderList();
    setState(prefill ? 'Copia sin guardar: revisa nombre, slug y SKU.' : 'Pieza nueva · se crea como borrador.', prefill ? 'dirty' : '');
    F.name.focus();
  }

  function closeEditor() {
    discardFreshUploads();
    state.open = false;
    state.current = null;
    state.images = [];
    form.hidden = true;
    $('#cur-empty').hidden = false;
    cur.classList.remove('is-editing');
    renderList();
    if (!window.matchMedia('(min-width: 1024px)').matches) window.scrollTo({ top: state.listY ?? 0 });
  }

  /** Subidas de esta sesión que nunca se guardaron: se borran para no dejar huérfanas. */
  function discardFreshUploads() {
    state.images.filter((img) => img.fresh && img.id).forEach((img) => {
      api(`/api/media?id=${img.id}`, { method: 'DELETE', body: {} }).catch(() => {});
    });
  }

  $('#new-product').addEventListener('click', () => { if (confirmLeave()) openNew(); });
  $('#ed-back').addEventListener('click', () => { if (confirmLeave()) closeEditor(); });
  $('#ed-discard').addEventListener('click', () => {
    if (!confirmLeave()) return;
    if (state.current) openProduct(state.current);
    else closeEditor();
  });
  $('#ed-duplicate').addEventListener('click', () => {
    if (state.current && isDirty()
      && !window.confirm('Los cambios sin guardar pasan a la copia; la pieza original se queda como estaba. ¿Seguir?')) return;
    const data = readForm();
    const base = slugify(`${data.slug || data.name}-copia`);
    openNew({
      ...data,
      name: `${data.name} (copia)`.slice(0, 80),
      slug: uniqueSlug(base),
      sku: nextSku(),
      status: 'draft',
      images: [], // las fotos pertenecen a una sola pieza
      createdAt: null,
    });
  });
  /* ---------- Estado del editor, pista del slug y vista previa ---------- */
  function setState(text, kind = '') {
    const el = $('#ed-state');
    el.textContent = text;
    if (kind) el.dataset.state = kind;
    else delete el.dataset.state;
  }

  function refresh() {
    const data = readForm();
    const tone = toneOf(data);
    const editor = $('#editor');
    editor.dataset.zone = data.category;
    if (tone) editor.style.setProperty('--tone', tone);
    else editor.style.removeProperty('--tone');

    $('#ed-kicker').textContent = state.current
      ? `Entrada nº ${digits(data.sku)} · ${ZONES[data.category] ?? ''}`
      : `Entrada nueva · ${ZONES[data.category] ?? ''}`;
    $('#ed-title').textContent = data.name || 'Sin nombre';
    $('#lore-count').textContent = F.lore.value.length;

    const hint = $('#slug-hint');
    if (state.current && data.slug !== state.current.slug) {
      hint.textContent = `Al guardar, los carritos y drops con «${state.current.slug}» pasan a «${data.slug || '…'}».`;
      hint.dataset.state = 'warn';
    } else {
      hint.textContent = 'El slug identifica la pieza en el carrito y en los drops: solo minúsculas, números y guiones.';
      delete hint.dataset.state;
    }

    $('#meta-line').textContent = state.current
      ? `Creada ${fmtDate(state.current.createdAt)} · editada ${fmtDate(state.current.updatedAt ?? state.current.createdAt)}`
      : 'Si dejas la fecha vacía se usa el momento de guardar.';

    if (state.open && !state.saving) {
      if (isDirty()) setState('● cambios sin guardar', 'dirty');
      else if ($('#ed-state').dataset.state === 'dirty') setState('');
    }
    renderPreview(data);
  }

  const stockText = (d) => {
    if (!(d.stock > 0)) return 'Agotado';
    const sizes = (d.sizes ?? []).filter((s) => s.stock > 0).length;
    return d.sizes ? `${d.stock} en stock · ${sizes} ${sizes === 1 ? 'talla' : 'tallas'}` : `${d.stock} en stock`;
  };

  /** Hasta cuándo se ve «Nuevo» en la tienda: un mes desde la fecha de alta (una pieza sin fecha, desde hoy). Igual que lib/catalog.js. */
  function newBadgeUntil() {
    const until = F.createdAt.value ? new Date(F.createdAt.value) : new Date();
    until.setMonth(until.getMonth() + 1);
    return until;
  }
  const longDay = (date) => date.toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' });

  function tagFor(d) {
    switch (d.badge) {
      case 'nuevo': return newBadgeUntil() > new Date() ? { text: 'Nuevo', tone: 'new' } : null;
      case 'ultimas': return { text: `Últimas ${d.stock}`, tone: 'warn' };
      case 'oferta':
        return {
          text: d.compareAtCents > d.priceCents ? `−${Math.round((1 - d.priceCents / d.compareAtCents) * 100)}%` : 'Oferta',
          tone: 'hot',
        };
      default: return null;
    }
  }

  function renderPreview(d) {
    const icon = ICONS[d.icon] ? d.icon : 'mecha';
    $('#pv-ill').setAttribute('href', `#i-${icon}`);
    $('#pv-sh').setAttribute('href', `#i-${icon}`);
    const cover = state.images.find((img) => img.url);
    const photo = $('#pv-photo');
    $('#pv-card').classList.toggle('has-photo', Boolean(cover));
    photo.hidden = !cover;
    // como en el visor de la tienda: la foto recortada a su contorno dentro de un marco cuadrado (js/photo.js)
    const want = cover?.url ?? '';
    if (photo.dataset.src !== want) {
      photo.dataset.src = want;
      if (want) {
        window.DZPhoto.trimmed(want).then((src) => {
          if (photo.dataset.src !== want) return;
          $('#pv-img').src = src;
          photo.style.setProperty('--photo', `url("${src}")`);
        });
      }
    }
    if (cover) photo.classList.toggle('is-cutout', Boolean(cover.cutout));

    $('#pv-entry').textContent = `Entrada nº ${digits(d.sku)} · ${ZONES[d.category] ?? ''}`;
    $('#pv-title').textContent = d.name || 'Sin nombre';
    $('#pv-lore').textContent = d.lore ? `“${d.lore}”` : '';
    $('#pv-lore').hidden = !d.lore;
    $('#pv-specs').innerHTML = [
      ['Formato', esc(d.subtitle || '—')],
      ['Rareza', `${pips(d.rarity)}<span class="rar" data-r="${d.rarity}">${RARITY[d.rarity]}</span>`],
      ['Existencias', d.stock > 0 ? esc(stockText(d)) : '<span class="is-out">Agotado</span>'],
      ['SKU', esc(d.sku || '—')],
    ].map(([dt, dd]) => `<div><dt>${dt}</dt><dd>${dd}</dd></div>`).join('');
    $('#pv-price').textContent = money(d.priceCents);
    $('#pv-old').textContent = d.compareAtCents > d.priceCents ? money(d.compareAtCents) : '';
    const soldOut = !(d.stock > 0);
    $('#pv-btn').textContent = soldOut ? 'Agotado' : 'Al carrito';
    $('#pv-btn').classList.toggle('is-off', soldOut);
    $('#pv-btn').classList.toggle('is-out', soldOut);

    const tag = tagFor(d);
    const until = newBadgeUntil();
    const badgeHint = $('#badge-hint');
    badgeHint.hidden = d.badge !== 'nuevo';
    if (d.badge === 'nuevo') {
      badgeHint.textContent = until > new Date()
        ? `«Nuevo» se ve en la tienda hasta el ${longDay(until)}: un mes desde la fecha de alta. Después la pieza queda sin etiqueta.`
        : `«Nuevo» ya venció (la fecha de alta tiene más de un mes): la tienda muestra la pieza sin etiqueta. Para volver a destacarla, cambia la fecha de alta.`;
    }
    const tone = toneOf(d) ? `;--tone:${toneOf(d)}` : '';
    const row = (current) => `
      <li class="row" data-zone="${esc(d.category)}" style="--i:0${tone}"${current ? ' aria-current="true"' : ''}>
        <div class="row__main">
          <span class="row__n mono"><i class="mark" aria-hidden="true"></i>${esc(digits(d.sku))}</span>
          <span class="row__name">${esc(d.name || 'Sin nombre')}${tag ? `<span class="row__tag" data-tone="${tag.tone}">${esc(tag.text)}</span>` : ''}</span>
          <span class="row__price mono">${money(d.priceCents)}</span>
        </div>
        <span class="row__add"><svg aria-hidden="true"><use href="#u-plus"/></svg></span>
      </li>`;
    $('#pv-rows').innerHTML = row(false) + row(true);
  }

  form.addEventListener('input', (e) => {
    if (e.target === F.name && !state.slugTouched) F.slug.value = uniqueSlug(slugify(F.name.value));
    if (e.target === F.slug) state.slugTouched = true;
    if (e.target.id === 'tone-custom') setRadio('tone', 'custom');
    if (e.target.matches('[aria-invalid]')) e.target.removeAttribute('aria-invalid');
    refresh();
  });
  form.addEventListener('change', refresh);
  F.sku.addEventListener('blur', () => { F.sku.value = F.sku.value.trim().toUpperCase(); refresh(); });
  F.slug.addEventListener('blur', () => { F.slug.value = slugify(F.slug.value); refresh(); });

  /* ---------- Imágenes: encuadrar y optimizar en el navegador (js/photo.js) y subir ---------- */
  const toBase64 = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('no se pudo leer la imagen'));
    reader.readAsDataURL(blob);
  });

  /** Recorta la foto al contorno de la pieza, le deja el aire de siempre y la lleva al tamaño estándar. */
  async function prepareImage(file) {
    const { blob, cutout } = await window.DZPhoto.prepare(file);
    return { data: await toBase64(blob), cutout };
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList).filter((f) => /^image\/(jpeg|png|webp)$/.test(f.type));
    const room = MAX_IMAGES - state.images.length;
    if (!files.length) {
      notify('Usa archivos JPG, PNG o WebP.', { tone: 'error' });
      return;
    }
    if (files.length > room) notify(`Máximo ${MAX_IMAGES} imágenes por pieza: subo ${Math.max(0, room)}.`, { tone: 'error' });
    for (const file of files.slice(0, Math.max(0, room))) {
      const temp = { key: (imageKey += 1), uploading: true, url: URL.createObjectURL(file), cutout: false };
      state.images.push(temp);
      state.uploads += 1;
      renderThumbs();
      try {
        const { data, cutout } = await prepareImage(file);
        const res = await api('/api/media', { method: 'POST', body: { data, cutout } });
        URL.revokeObjectURL(temp.url);
        Object.assign(temp, { id: res.id, url: res.url, cutout: res.cutout, uploading: false, fresh: true });
      } catch (err) {
        URL.revokeObjectURL(temp.url);
        state.images = state.images.filter((img) => img !== temp);
        notify(`${file.name}: ${err.message}`, { tone: 'error' });
      } finally {
        state.uploads -= 1;
      }
      renderThumbs();
      refresh();
    }
  }

  function renderThumbs() {
    const last = state.images.length - 1;
    $('#thumbs').innerHTML = state.images.map((img, i) => `
      <li class="thumb${img.uploading ? ' is-uploading' : ''}${i === 0 ? ' is-cover' : ''}" data-key="${img.key}">
        <img src="${esc(img.url)}" alt="Imagen ${i + 1}" decoding="async">
        ${i === 0 ? '<span class="thumb__badge mono">Portada</span>' : ''}
        ${img.cutout ? '<span class="thumb__cut mono">recorte</span>' : ''}
        <div class="thumb__tools">
          <button type="button" data-move="-1" aria-label="Mover antes"${i === 0 || img.uploading ? ' disabled' : ''}>←</button>
          <button type="button" data-move="1" aria-label="Mover después"${i === last || img.uploading ? ' disabled' : ''}>→</button>
          <button type="button" data-remove aria-label="Quitar imagen ${i + 1}"${img.uploading ? ' disabled' : ''}>×</button>
        </div>
      </li>`).join('');
    $('#dropzone').classList.toggle('is-full', state.images.length >= MAX_IMAGES);
  }

  $('#thumbs').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    const li = e.target.closest('.thumb');
    if (!btn || !li) return;
    const i = state.images.findIndex((img) => String(img.key) === li.dataset.key);
    if (i < 0) return;
    if (btn.hasAttribute('data-remove')) {
      const [img] = state.images.splice(i, 1);
      // si nunca se guardó en la pieza se borra ya; si estaba guardada, se borra al guardar
      if (img.fresh && img.id) api(`/api/media?id=${img.id}`, { method: 'DELETE', body: {} }).catch(() => {});
    } else {
      const j = i + Number(btn.dataset.move);
      if (j < 0 || j >= state.images.length) return;
      [state.images[i], state.images[j]] = [state.images[j], state.images[i]];
    }
    renderThumbs();
    refresh();
  });

  const dropzone = $('#dropzone');
  $('#file').addEventListener('change', (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  });
  ['dragenter', 'dragover'].forEach((type) => dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.add('is-over');
  }));
  ['dragleave', 'drop'].forEach((type) => dropzone.addEventListener(type, () => dropzone.classList.remove('is-over')));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });
  /* ---------- Guardar ---------- */
  function fail(input, message) {
    if (input) {
      input.setAttribute('aria-invalid', 'true');
      input.focus();
    }
    setState(message, 'error');
    notify(message, { tone: 'error' });
    return null;
  }

  /** Revisión rápida antes de mandar (el servidor vuelve a validar todo). */
  function validate(d) {
    if (d.name.length < 2) return fail(F.name, 'El nombre necesita al menos 2 caracteres.');
    if (d.subtitle.length < 2) return fail(F.subtitle, 'Escribe el formato (ej. Figura · Esc. 1/100).');
    if (!SLUG_RE.test(d.slug)) return fail(F.slug, 'Slug inválido: minúsculas, números y guiones.');
    if (!SKU_RE.test(d.sku)) return fail(F.sku, 'SKU inválido: letras, números y guiones (2 a 24).');
    if (!Number.isFinite(d.priceCents)) return fail(F.price, 'Precio inválido (ej. 59.900).');
    if (d.compareAtCents !== null && !Number.isFinite(d.compareAtCents)) return fail(F.compareAt, 'Precio anterior inválido.');
    if (d.compareAtCents !== null && d.compareAtCents <= d.priceCents) return fail(F.compareAt, 'El precio anterior debe ser mayor que el actual.');
    if (d.sizes) {
      if (!d.sizes.length) return fail($('[data-size="M"]'), 'Escribe las unidades de al menos una talla (0 si está agotada).');
      const bad = d.sizes.find((s) => !Number.isInteger(s.stock) || s.stock < 0);
      if (bad) return fail($(`[data-size="${bad.size}"]`), `Las unidades de la talla ${bad.size} deben ser un entero ≥ 0.`);
    } else if (!Number.isInteger(d.stock) || d.stock < 0) return fail(F.stock, 'Las existencias deben ser un entero ≥ 0.');
    if (d.weightGrams !== null && (!Number.isInteger(d.weightGrams) || d.weightGrams < 1 || d.weightGrams > 50000)) {
      return fail(F.weight, 'El peso va en gramos, de 1 a 50.000 (o vacío).');
    }
    if (state.uploads > 0) return fail(null, 'Espera a que terminen de subir las imágenes.');
    return d;
  }

  async function save() {
    if (!state.open || state.saving) return;
    const data = validate(readForm());
    if (!data) return;
    const isNew = !state.current;
    if (!isNew && !isDirty()) {
      setState('Sin cambios que guardar.', 'ok');
      return;
    }
    state.saving = true;
    $('#ed-save').disabled = true;
    setState('> guardando…');
    try {
      const body = isNew ? data : { ...data, updatedAt: state.current.updatedAt };
      const { product } = await api(isNew ? '/api/admin/products' : `/api/admin/products?id=${state.current._id}`, {
        method: isNew ? 'POST' : 'PUT',
        body,
      });
      const i = state.products.findIndex((p) => p._id === product._id);
      if (i >= 0) state.products[i] = product;
      else state.products.unshift(product);
      state.products.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      state.current = product;
      state.slugTouched = true;
      fillForm(product);
      takeSnapshot();
      state.saving = false;
      refresh();
      renderList();
      setState(`Guardada ${fmtDate(product.updatedAt)} · en la tienda en segundos`, 'ok');
      notify(`${product.name} ${isNew ? 'creada' : 'guardada'}.`, { tag: isNew ? 'nueva' : 'ok' });
    } catch (err) {
      setState(err.message, 'error');
      notify(err.message, { tone: 'error' });
    } finally {
      state.saving = false;
      $('#ed-save').disabled = false;
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    save();
  });

  /* ---------- Eliminar (confirmación en el mismo botón) ---------- */
  const removeBtn = $('#ed-delete');
  let armedUntil = 0;
  let armTimer = 0;
  function disarmDelete() {
    armedUntil = 0;
    clearTimeout(armTimer);
    removeBtn.classList.remove('is-armed');
    removeBtn.textContent = 'Eliminar pieza';
  }
  removeBtn.addEventListener('click', async () => {
    if (!state.current) {
      closeEditor(); // una pieza nueva sin guardar solo se descarta
      return;
    }
    if (Date.now() > armedUntil) {
      armedUntil = Date.now() + 4000;
      removeBtn.classList.add('is-armed');
      removeBtn.textContent = '¿Seguro? Clic otra vez para borrar';
      clearTimeout(armTimer);
      armTimer = setTimeout(disarmDelete, 4000);
      return;
    }
    disarmDelete();
    const { _id, name } = state.current;
    try {
      const { carts } = await api(`/api/admin/products?id=${_id}`, { method: 'DELETE', body: {} });
      state.products = state.products.filter((p) => p._id !== _id);
      state.images = [];
      closeEditor();
      const from = carts ? ` y de ${carts} ${carts === 1 ? 'carrito' : 'carritos'}` : '';
      notify(`${name} eliminada del archivo${from}.`, { tag: 'baja' });
    } catch (err) {
      setState(err.message, 'error');
      notify(err.message, { tone: 'error' });
    }
  });

  /* ---------- Teclado ---------- */
  document.addEventListener('keydown', (e) => {
    if ((document.body.dataset.view ?? 'piezas') !== 'piezas') return; // los otros módulos tienen sus atajos
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === 's') {
      e.preventDefault();
      save();
      return;
    }
    const typing = e.target.closest('input, textarea, select, [contenteditable]');
    if (e.key === 'Escape' && state.open && !typing) {
      if (confirmLeave()) closeEditor();
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (key === 'n') {
      e.preventDefault();
      if (confirmLeave()) openNew();
    } else if (e.key === '/') {
      e.preventDefault();
      $('#cur-search').focus();
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (isDirty()) e.preventDefault();
  });

  /* ---------- Zonas editadas en el módulo Página (admin-modules.js): nombres, colores, nuevas y quitadas ---------- */
  window.addEventListener('dz:zones', (e) => {
    const zones = Array.isArray(e.detail) ? e.detail : [];
    if (!zones.length) return;
    Object.keys(ZONES).forEach((key) => { delete ZONES[key]; });
    zones.forEach((z) => { ZONES[z.key] = z.label; });
    renderZoneChips();
    renderList();
    if (state.open) refresh();
  });

  /* ---------- Sesión ---------- */
  $('#logout').addEventListener('click', async () => {
    if (!confirmLeave()) return;
    state.snapshot = JSON.stringify(readForm()); // ya confirmado: no volver a preguntar al salir
    try {
      await api('/api/auth/logout', { method: 'POST', body: {} });
    } finally {
      window.location.href = '/cuenta';
    }
  });

  async function init() {
    let user = null;
    try {
      ({ user } = await api('/api/auth/me'));
    } catch (err) {
      $('#gate').hidden = false;
      $('#gate-text').textContent = `No pudimos conectar con el archivo (${err.message}).`;
      return;
    }
    if (!user) {
      window.location.replace('/cuenta?next=admin#entrar');
      return;
    }
    state.user = user;
    $('#cur-user').textContent = user.name;
    if (user.role !== 'admin') {
      $('#gate').hidden = false;
      $('#gate-text').textContent = `Tu credencial (${user.email}) no tiene permisos de curaduría.`;
      return;
    }
    // admin-modules.js arma la navegación y muestra el módulo que pida la URL (#piezas por defecto)
    window.DZ_ADMIN_USER = user;
    window.dispatchEvent(new CustomEvent('dz:admin', { detail: { user } }));
    try {
      await loadProducts();
    } catch (err) {
      $('#cur-status').hidden = false;
      $('#cur-status').dataset.state = 'error';
      $('#cur-status').textContent = `> error: ${err.message}`;
    }
  }

  init();
})();