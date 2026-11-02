/* DREAM ZONE — Pago: resumen del carrito, datos de entrega y paso a la página segura de Wompi.
   Al volver de Wompi (pago.html?ref=…&k=…&id=…) muestra el resultado y, si sigue en proceso, lo consulta
   cada pocos segundos. El total lo calcula siempre el servidor: aquí solo se muestra. */
(() => {
  'use strict';

  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const money = (cents) => {
    const whole = cents % 100 === 0;
    return `$${(cents / 100).toLocaleString('es-CO', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
  };
  const progress = window.DZProgress;
  const params = new URLSearchParams(window.location.search);
  const REF = params.get('ref');
  const KEY = params.get('k');
  const TX = params.get('id'); // Wompi lo agrega al volver
  const STORE = 'dz.pago'; // datos recordados en este navegador
  const LAST = 'dz.pago.ultimo'; // el último pedido creado aquí, por si se cierra la pestaña de Wompi
  const POLL_MS = 3000;
  const POLL_MAX = 40; // ~2 minutos; PSE puede tardar más y entonces se ofrece consultar de nuevo
  const METHODS = {
    CARD: 'tarjeta', NEQUI: 'Nequi', PSE: 'PSE', DAVIPLATA: 'Daviplata', BANCOLOMBIA_TRANSFER: 'botón Bancolombia',
    BANCOLOMBIA_QR: 'QR Bancolombia', BANCOLOMBIA_BNPL: 'Compra y paga después Bancolombia', SU_PLUS: 'SU+ Pay', SIMULADO: 'un pago simulado',
  };

  const form = $('#pay-form');
  const F = form.elements;
  const stateEl = $('#pay-state');
  const msg = $('#pay-msg');
  const goBtn = $('#pay-go');
  let quote = null;
  let user = null;
  let site = null;
  let quoteRequest = 0;
  let busy = false;

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
    if (!res.ok) throw Object.assign(new Error(data?.error || `Error ${res.status}`), { status: res.status });
    return data;
  }

  const saved = () => {
    try {
      return JSON.parse(localStorage.getItem(STORE) ?? 'null') ?? {};
    } catch {
      return {};
    }
  };
  function remember(data) {
    try {
      if (data) localStorage.setItem(STORE, JSON.stringify(data));
      else localStorage.removeItem(STORE);
    } catch {
      /* modo privado */
    }
  }

  /* ---------- Resumen (cotización o pedido) ---------- */
  const levelTag = (level) => `<span class="lv" data-lv="${level}">Lv ${pad(level)} · ${esc(progress.levelName(level))}</span>`;

  function shippingRow(src) {
    if (src.delivery?.method === 'tienda' || src.shipping?.method === 'tienda') return ['Entrega', 'Recoges en la tienda · gratis'];
    const ship = src.shipping ?? { cents: src.shippingCents, free: src.freeShipping, known: true };
    const carrier = src.shipping?.option?.carrierName ?? src.shippingQuote?.carrierName; // cotización en vivo o pedido
    const label = carrier ? `Envío · ${esc(carrier)}` : 'Envío';
    if (ship.free === 'mitico') return [label, '<span class="receipt__free">Gratis · beneficio Mítico</span>'];
    if (ship.free === 'promo') return [label, '<span class="receipt__free">Gratis</span>'];
    if (ship.cents == null) {
      return ['Envío', ship.blocker ? 'sin cotizar' : ship.need === 'region' ? 'elige el departamento' : 'escribe tu municipio'];
    }
    return [label, money(ship.cents)];
  }

  function renderReceipt(src, { count } = {}) {
    const units = src.lines.reduce((n, l) => n + l.qty, 0);
    $('#receipt-count').textContent = count ?? `${pad(units)} ${units === 1 ? 'pieza' : 'piezas'}`;
    $('#receipt-lines').innerHTML = src.lines.length ? src.lines.map((l) => `
      <li class="receipt__line${l.problem ? ' has-problem' : ''}${l.kind === 'drop' ? ' is-drop' : ''}"${l.category ? ` data-zone="${esc(l.category)}"` : ''}>
        <span class="receipt__name">${esc(l.name)}</span>
        <span class="receipt__amount mono">${money(l.totalCents)}</span>
        <span class="receipt__meta mono">${l.qty} × ${money(l.unitCents)}${l.includes ? ` · ${esc(l.includes.map((x) => x.name).join(' + '))}` : ''}</span>
        ${l.discountCents ? `<span class="receipt__off mono">−${l.discountPct}% por ser ${esc(progress.levelName(src.level))} · −${money(l.discountCents)}</span>` : ''}
        ${l.problem ? `<span class="receipt__problem mono">${esc(l.problem)}</span>` : ''}
      </li>`).join('') : '<li class="receipt__empty mono">&gt; tu carrito está vacío.</li>';

    if (!src.lines.length) {
      $('#receipt-totals').innerHTML = ''; // sin piezas no hay envío ni total que mostrar
      return;
    }
    const rows = [];
    if (src.discountCents) {
      rows.push(['Subtotal', money(src.subtotalCents)]);
      rows.push([`Beneficio ${levelTag(src.level)}`, `<span class="receipt__free">−${money(src.discountCents)}</span>`]);
    }
    rows.push(shippingRow(src));
    const unknownShip = src.shipping && src.shipping.cents == null && src.shipping.method !== 'tienda';
    rows.push([unknownShip ? 'Total sin envío' : 'Total', `<b>${money(src.totalCents)}</b>`]);
    $('#receipt-totals').innerHTML = rows.map(([dt, dd], i) => `<div${i === rows.length - 1 ? ' class="receipt__total"' : ''}><dt>${dt}</dt><dd>${dd}</dd></div>`).join('');
  }

  /** Lo que el nivel hace (o haría) por este pedido. */
  function renderPerk(q) {
    const el = $('#receipt-perk');
    if (!q.lines.length) {
      el.hidden = true;
      return;
    }
    const parts = [];
    if (!user) {
      parts.push(`Para pagar, <a class="link" href="/cuenta?next=pago#entrar">entra con tu credencial</a>: además pagas con tu nivel (Adepto ahorra 5% en piezas y Leyenda 10% en drops).`);
    } else if (q.level === 1) {
      parts.push(`${levelTag(1)} · con Adepto (los 12 logros del archivo) pagarías 5% menos en las piezas.`);
    } else if (!q.discountCents) {
      parts.push(`${levelTag(q.level)} · tu descuento aplica a ${q.perks.dropPct ? 'piezas y drops' : 'las piezas sueltas'}.`);
    }
    if (q.shipping?.missingCents) {
      parts.push(`Te faltan ${money(q.shipping.missingCents)} en productos para el envío gratis${q.shipping.missingReason === 'mitico' ? ' de Mítico' : ''}.`);
    }
    el.innerHTML = parts.join('<br>');
    el.hidden = !parts.length;
  }

  /* ---------- Cotización ---------- */
  /** Lo que define el precio del envío: forma de entrega, departamento, ciudad y transportadora elegida. */
  const deliveryParams = () => {
    const p = new URLSearchParams({ method: F.method.value });
    if (F.method.value === 'envio' && F.region.value) {
      p.set('region', F.region.value);
      const city = F.city.value.trim().replace(/\s+/g, ' ');
      if (city.length >= 2) p.set('city', city);
      if (F.shipOption?.value) p.set('option', F.shipOption.value);
    }
    return p.toString();
  };
  let quotedFor = ''; // los parámetros de la última cotización que se pintó

  /** Las transportadoras que cotizaron (la elegida marcada) y la nota de abajo. */
  function renderCarriers(ship) {
    const options = ship?.method === 'envio' ? ship.options ?? [] : [];
    $('#pay-carriers').hidden = !options.length;
    // con una sola transportadora no hay nada que elegir: se muestra como dato
    $('#pay-carrier-list').innerHTML = options.length === 1
      ? `<p class="pay__carrier is-only"><span class="pay__carrier-name">${esc(options[0].carrierName)}</span><span class="pay__carrier-eta mono">${esc(options[0].estimate ?? '')}</span><b class="pay__carrier-price mono">${money(options[0].cents)}</b></p>`
      : options.map((o) => `
      <label class="pay__carrier">
        <input type="radio" name="shipOption" value="${esc(o.id)}"${o.id === ship.option?.id ? ' checked' : ''}>
        <span class="pay__carrier-name">${esc(o.carrierName)}</span>
        <span class="pay__carrier-eta mono">${esc(o.estimate ?? '')}</span>
        <b class="pay__carrier-price mono">${money(o.cents)}</b>
      </label>`).join('');
    let text = '';
    const blocked = ship?.method === 'envio' && Boolean(ship.blocker);
    if (ship?.method === 'envio') {
      const eta = ship.option?.estimate ? ` (${ship.option.estimate.toLowerCase()})` : '';
      if (blocked) text = ship.blocker;
      else if (ship.need === 'city') text = 'Elige tu municipio para cotizar el envío.';
      else if (ship.free && ship.option) text = `Envío gratis: lo lleva ${ship.option.carrierName}${eta}.`;
      else if (options.length === 1 && ship.place) text = `Precio en vivo de ${options[0].carrierName} para ${ship.place}, según el peso de tus piezas.`;
      else if (options.length && ship.place) text = `Precios en vivo de las transportadoras para ${ship.place}.`;
    }
    const note = $('#pay-ship-note');
    note.textContent = text;
    note.hidden = !text;
    note.toggleAttribute('data-error', blocked);
    if (blocked && !ship.place) F.city.setAttribute('aria-invalid', 'true'); // el municipio no está en la lista
    else if (F.city.getAttribute('aria-invalid') === 'true' && ship?.place) F.city.removeAttribute('aria-invalid');
    // «¿quisiste decir…?»: un clic pone el nombre oficial y vuelve a cotizar. Si el municipio existe pero el envío
    // no se pudo cotizar (lejos o sin respuesta), los botones llevan a escribirnos por Instagram o TikTok.
    const suggest = $('#pay-suggest');
    const names = blocked ? ship.suggestions ?? [] : [];
    const contact = blocked && ship.place ? quote?.contact ?? {} : {};
    const social = [['instagram', 'Instagram'], ['tiktok', 'TikTok']].filter(([key]) => /^https:\/\//.test(contact[key] ?? ''));
    suggest.innerHTML = names.map((n) => `<button class="pay__suggest-btn mono" type="button" data-city="${esc(n)}">${esc(n)}</button>`).join('')
      + social.map(([key, label]) => `<a class="pay__suggest-btn mono" href="${esc(contact[key])}" target="_blank" rel="noopener">${label} ↗</a>`).join('');
    suggest.hidden = !names.length && !social.length;
    $('#pay-times').hidden = options.length > 0; // con precios en vivo, cada transportadora trae su tiempo de entrega
  }

  /* Municipios del departamento elegido (lista oficial del DANE), en un desplegable igual al de departamento. */
  let cities = null;
  const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  function fillCities() {
    const region = F.region.value;
    const list = cities?.[region] ?? [];
    const want = F.city.value || F.city.dataset.want || '';
    const head = !region ? 'Primero el departamento' : cities ? 'Elige…' : 'Cargando municipios…';
    F.city.innerHTML = `<option value="">${head}</option>${list.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}`;
    F.city.disabled = !list.length;
    // el que ya estaba elegido (o el guardado en este navegador) si es de este departamento; Bogotá D.C. tiene uno solo
    F.city.value = list.find((n) => fold(n) === fold(want)) ?? (list.length === 1 ? list[0] : '');
    if (cities) delete F.city.dataset.want;
  }
  api('/api/checkout/places')
    .then((data) => {
      cities = data.cities;
      fillCities();
      if (quote && deliveryParams() !== quotedFor) loadQuote().catch((err) => say(err.message, 'error'));
    })
    .catch(() => { F.city.innerHTML = '<option value="">No cargaron: recarga la página</option>'; });

  $('#pay-suggest').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-city]');
    if (!btn) return;
    F.city.value = btn.dataset.city;
    F.city.removeAttribute('aria-invalid');
    clearTimeout(cityTimer);
    loadQuote().catch((err) => say(err.message, 'error'));
  });

  async function loadQuote() {
    const request = ++quoteRequest;
    const params = deliveryParams();
    if (params.includes('city=')) {
      const note = $('#pay-ship-note');
      note.textContent = 'Cotizando con las transportadoras…';
      note.hidden = false;
    }
    const data = await api(`/api/checkout/quote?${params}`);
    if (request !== quoteRequest) return null; // llegó una cotización más nueva
    // piezas o drops que la curaduría borró: salieron del carrito al cotizar
    if (data.removed) {
      say(data.removed === 1
        ? 'Una pieza de tu carrito ya no está en el archivo: la quitamos.'
        : `${data.removed} piezas de tu carrito ya no están en el archivo: las quitamos.`);
    }
    quote = data.quote;
    quotedFor = deliveryParams(); // con la opción que quedó marcada
    renderReceipt(quote);
    renderPerk(quote);
    renderCarriers(quote.shipping);
    const ship = quote.shipping;
    $('#opt-envio').textContent = ship.method === 'envio' && (ship.free || ship.cents != null)
      ? (ship.free ? 'Gratis' : money(ship.cents))
      : 'Según tu municipio';
    $('#pickup-where').textContent = quote.pickup.address;
    $('#pickup-note').textContent = quote.pickup.note;
    $('#pay-times').textContent = quote.times;
    paintButton();
    return data;
  }

  function paintButton() {
    if (busy) return;
    const blocked = !quote?.lines.length || quote.problems.length;
    goBtn.disabled = Boolean(blocked);
    const known = quote && !(quote.shipping.method === 'envio' && quote.shipping.cents == null);
    goBtn.textContent = known ? `Pagar ${money(quote.totalCents)} con Wompi` : 'Pagar con Wompi';
    if (quote?.problems.length) say(quote.problems[0], 'error');
    else if (msg.dataset.state === 'error' && msg.dataset.from === 'quote') say('');
  }

  function say(text, kind = '', from = 'quote') {
    msg.textContent = text;
    if (kind) msg.dataset.state = kind;
    else delete msg.dataset.state;
    msg.dataset.from = from;
  }

  function showDelivery() {
    const envio = F.method.value === 'envio';
    $('#pay-address').hidden = !envio;
    $('#pay-pickup').hidden = envio;
    ['region', 'city', 'address'].forEach((name) => { F[name].required = envio; });
  }

  /* ---------- Validación (igual que lib/orders.js) ---------- */
  const cleanPhone = (v) => v.replace(/[\s().-]/g, '').replace(/^\+?57(?=3\d{9}$)/, '');
  const RULES = {
    name: (v) => v.trim().length >= 3 || 'Escribe tu nombre completo.',
    email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()) || 'Revisa tu correo: ahí llega la confirmación.',
    phone: (v) => /^3\d{9}$/.test(cleanPhone(v)) || 'Escribe un celular de 10 dígitos que empiece por 3.',
    idNumber: (v) => /^[0-9A-Za-z-]{5,15}$/.test(v.replace(/[\s.]/g, '')) || 'Revisa el número de documento.',
    region: (v) => F.method.value !== 'envio' || Boolean(v) || 'Elige el departamento.',
    city: (v) => F.method.value !== 'envio' || v.trim().length >= 2 || 'Elige tu municipio.',
    address: (v) => F.method.value !== 'envio' || v.trim().length >= 5 || 'Escribe la dirección de entrega.',
  };
  function validate() {
    let first = null;
    Object.entries(RULES).forEach(([name, rule]) => {
      const ok = rule(F[name].value);
      if (ok === true) F[name].removeAttribute('aria-invalid'); else F[name].setAttribute('aria-invalid', 'true');
      if (ok !== true && !first) first = [F[name], ok];
    });
    // la casilla de la política de datos: sin ella el servidor no crea el pedido
    if (F.consent.checked) F.consent.removeAttribute('aria-invalid'); else F.consent.setAttribute('aria-invalid', 'true');
    if (!first && !F.consent.checked) first = [F.consent, 'Para pagar, marca la casilla de la política de tratamiento de datos.'];
    if (first) {
      first[0].focus();
      say(first[1], 'error', 'form');
      return false;
    }
    return true;
  }

  function readForm() {
    return {
      customer: {
        name: F.name.value.trim(),
        email: F.email.value.trim(),
        phone: cleanPhone(F.phone.value),
        idType: F.idType.value,
        idNumber: F.idNumber.value.replace(/[\s.]/g, ''),
      },
      delivery: F.method.value === 'tienda' ? { method: 'tienda' } : {
        method: 'envio',
        region: F.region.value,
        city: F.city.value.trim(),
        option: F.shipOption?.value || null, // el servidor vuelve a cotizarla
        address: F.address.value.trim(),
        details: F.details.value.trim(),
      },
      notes: F.notes.value.trim(),
      consent: F.consent.checked,
    };
  }

  function prefill() {
    const data = saved();
    const set = (name, value) => { if (value && !F[name].value) F[name].value = value; };
    set('name', data.name ?? user?.name);
    set('email', data.email ?? user?.email);
    set('phone', data.phone);
    if (data.idType) F.idType.value = data.idType;
    set('idNumber', data.idNumber);
    if (data.method === 'tienda') F.method.value = 'tienda';
    if (data.region) F.region.value = data.region;
    if (data.city) F.city.dataset.want = data.city; // se elige cuando llegue la lista de municipios
    set('address', data.address);
    set('details', data.details);
  }

  const readLast = () => {
    try {
      return JSON.parse(localStorage.getItem(LAST) ?? 'null');
    } catch {
      return null; // nada guardado o modo privado
    }
  };
  function forgetLast(ref) {
    try {
      if (!ref || readLast()?.ref === ref) localStorage.removeItem(LAST);
    } catch {
      /* modo privado */
    }
  }

  /**
   * Si hace poco se abrió Wompi desde aquí y ese pago sigue en proceso (PSE o Nequi tardan), lo avisa
   * antes de pagar otra vez. Si se salió sin pagar, o el pago ya se resolvió, no dice nada.
   */
  async function showLast() {
    const last = readLast();
    if (!last) return;
    if (!/^\/pago\.html\?ref=DZ\d{6}-[A-Z2-9]{6}&k=[\w-]+$/.test(last.path ?? '') || !(Date.now() - last.at < 86400e3)) {
      forgetLast();
      return;
    }
    let found;
    try {
      found = await api(`/api/checkout/status?${last.path.split('?')[1]}`);
    } catch (err) {
      if (err.status === 404) forgetLast(last.ref);
      return;
    }
    const { order, checked } = found;
    if (order.status !== 'pending') {
      forgetLast(order.reference); // ya se pagó o se rechazó: nada que recordar
      return;
    }
    if (!order.paymentStarted || !checked) return; // salió de Wompi sin pagar: puede pagar de nuevo sin problema
    form.insertAdjacentHTML('afterbegin', `<p class="pay__last mono">Tu pago del pedido ${esc(order.reference)} sigue en proceso con Wompi. Antes de pagar otra vez, <a class="link" href="${esc(last.path.slice(1))}">mira su estado →</a></p>`);
  }

  /* ---------- Estados del panel ---------- */
  function showState(html) {
    form.hidden = true;
    stateEl.hidden = false;
    stateEl.innerHTML = html;
  }

  async function startCheckout() {
    try {
      const data = await loadQuote();
      if (!data) return;
      if (!quote.lines.length) {
        $('#pay-lead').textContent = 'Tu carrito está vacío: primero elige qué reliquias te llevas.';
        showState(`
          <p class="acct__kicker mono">Nada que pagar todavía</p>
          <p class="acct__sub">Tu carrito está vacío.</p>
          <p class="pay__state-text">Añade piezas o un drop desde el índice y vuelve aquí para pagar.</p>
          <div class="profile__actions"><a class="btn" href="/#indice">Ir al índice →</a></div>`);
        return;
      }
      if (!user) {
        $('#pay-lead').textContent = 'Para pagar necesitas tu credencial: entra o crea una, tu carrito te espera.';
        showState(`
          <p class="acct__kicker mono">Inicia sesión para pagar</p>
          <p class="acct__sub">Pagar exige una credencial.</p>
          <p class="pay__state-text">Así tu pedido queda en «Mis pedidos», te llega el recibo y pagas con el beneficio de tu nivel. Tu carrito se conserva.</p>
          <div class="profile__actions"><a class="btn" href="/cuenta?next=pago#entrar">Entrar →</a><a class="link mono" href="/cuenta?next=pago#registro">Crear credencial</a></div>`);
        return;
      }
      if (!data.ready) {
        showState(`
          <p class="acct__kicker mono">Pagos en línea</p>
          <p class="acct__sub">Los pagos aún no están activos.</p>
          <p class="pay__state-text">Muy pronto podrás pagar aquí con Wompi. Mientras tanto, escríbenos o ven a la tienda: tu carrito se guarda 30 días.</p>
          <div class="profile__actions"><a class="btn" href="/#visita">Ver la tienda →</a></div>`);
        return;
      }
      const regions = data.departments.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
      F.region.insertAdjacentHTML('beforeend', regions);
      prefill();
      fillCities();
      showDelivery();
      form.hidden = false;
      showLast();
      if (F.region.value || F.method.value === 'tienda') await loadQuote();
    } catch (err) {
      showState(`<p class="acct__kicker mono">Algo falló</p><p class="acct__sub">No pudimos cargar tu pedido.</p>
        <p class="pay__state-text">${esc(err.message)}</p><div class="profile__actions"><a class="btn" href="/pago">Intentar de nuevo</a></div>`);
    }
  }

  form.addEventListener('change', (e) => {
    if (e.target.name === 'method') showDelivery();
    if (e.target.name === 'region') fillCities();
    if (['method', 'region', 'city', 'shipOption'].includes(e.target.name)) {
      clearTimeout(cityTimer);
      if (deliveryParams() !== quotedFor) loadQuote().catch((err) => say(err.message, 'error'));
    }
  });
  let cityTimer = 0;
  form.addEventListener('input', (e) => {
    e.target.removeAttribute('aria-invalid');
    if (msg.dataset.from === 'form') say('');
    // la ciudad se cotiza al dejar de escribir (y al salir del campo)
    if (e.target.name === 'city') {
      clearTimeout(cityTimer);
      cityTimer = setTimeout(() => {
        if (deliveryParams() !== quotedFor) loadQuote().catch((err) => say(err.message, 'error'));
      }, 900);
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy || !validate()) return;
    // el envío cambió (otra ciudad o transportadora) y aún no se ve su precio: primero se muestra el total nuevo
    if (deliveryParams() !== quotedFor) {
      clearTimeout(cityTimer);
      const before = quote?.totalCents;
      try {
        await loadQuote();
      } catch (err) {
        say(err.message, 'error', 'form');
        return;
      }
      if (quote?.totalCents !== before && !quote?.shipping.blocker) {
        say(`Actualizamos el envío para tu ciudad: el total ahora es ${money(quote.totalCents)}. Revísalo y vuelve a pagar.`, 'error', 'form');
        return;
      }
    }
    // sin un municipio de la lista (o sin precio de envío) no se paga
    const ship = quote?.shipping;
    if (ship?.method === 'envio' && (ship.blocker || ship.cents == null)) {
      if (!ship.place) F.city.setAttribute('aria-invalid', 'true');
      (ship.place ? F.region : F.city).focus();
      say(ship.blocker ?? 'Elige tu municipio para cotizar el envío.', 'error', 'form');
      return;
    }
    const body = readForm();
    remember(F.remember.checked ? { ...body.customer, ...body.delivery } : null);
    busy = true;
    goBtn.disabled = true;
    goBtn.textContent = 'Preparando tu pago…';
    say('');
    try {
      const { url, reference, statusPath } = await api('/api/checkout/create', { method: 'POST', body });
      try {
        localStorage.setItem(LAST, JSON.stringify({ ref: reference, path: statusPath, at: Date.now() }));
      } catch {
        /* modo privado */
      }
      goBtn.textContent = 'Abriendo Wompi…';
      say(`Pedido ${reference} listo. Te llevamos a la página segura de Wompi…`, 'ok', 'form');
      window.location.assign(url);
    } catch (err) {
      busy = false;
      say(err.message, 'error', 'form');
      loadQuote().catch(() => {}); // si cambió el stock o un drop cerró, el resumen lo muestra
    }
  });

  /* ---------- Vuelta de Wompi: el resultado ---------- */
  const RESULT = {
    approved: { kicker: 'Pago aprobado', title: '¡Es <em class="echo" data-text="tuyo">tuyo</em>!', stamp: 'Pagado' },
    pending: { kicker: 'Confirmando con Wompi', title: 'Tu pago está en <em class="echo" data-text="camino">camino</em>.', stamp: 'En proceso' },
    unpaid: { kicker: 'Pago sin terminar', title: 'Aún no has <em class="echo" data-text="pagado">pagado</em>.', stamp: 'Sin pagar' },
    declined: { kicker: 'Pago rechazado', title: 'El pago no <em class="echo" data-text="pasó">pasó</em>.', stamp: 'Rechazado' },
    voided: { kicker: 'Pago anulado', title: 'El pago se <em class="echo" data-text="anuló">anuló</em>.', stamp: 'Anulado' },
    error: { kicker: 'Hubo un problema', title: 'Algo salió <em class="echo" data-text="mal">mal</em>.', stamp: 'Error' },
  };

  function deliveryText(o) {
    if (o.delivery.method === 'tienda') return `Lo recoges en la tienda${quote?.pickup ? ` (${esc(quote.pickup.address)})` : ''}: te avisamos por correo cuando esté listo para recoger.`;
    const place = `${o.delivery.city}, ${o.delivery.region}`.replace(/\.$/, ''); // «Bogotá D.C.» ya trae su punto
    const q = o.shippingQuote;
    const how = q ? ` Va con ${esc(q.carrierName)}${q.estimate ? ` (${esc(q.estimate.toLowerCase())})` : ''}.` : '';
    return `Lo enviamos a ${esc(o.delivery.address)}${o.delivery.details ? `, ${esc(o.delivery.details)}` : ''} · ${esc(place)}.${how}`;
  }

  /** Ya despachado: con qué distribuidora y guía salió (o que ya está listo para recoger en la tienda). */
  function shipmentText(o) {
    const s = o.shipment;
    if (!s) return '';
    const day = new Date(s.at).toLocaleDateString('es-CO', { day: 'numeric', month: 'long' });
    if (o.delivery.method === 'tienda') return `<p class="pay__state-text">Listo para recoger en la tienda desde el ${esc(day)}. Al llegar, di la referencia <b class="mono">${esc(o.reference)}</b>.</p>`;
    return `<p class="pay__state-text">Salió el ${esc(day)} con <b>${esc(s.carrierName)}</b> · guía <b class="mono">${esc(s.tracking)}</b>${s.url ? ` · <a class="link" href="${esc(s.url)}" target="_blank" rel="noopener">rastrear ↗</a>` : ''}</p>`;
  }

  async function celebrate(o) {
    // solo al volver de pagar: abrir un recibo viejo desde «Mis pedidos» no repite el aviso de XP
    if (!TX && !(Date.now() - Date.parse(o.paidAt) < 15 * 60e3)) return;
    const flag = `dz.pago.xp.${o.reference}`;
    try {
      if (!o.xp || sessionStorage.getItem(flag)) return;
      sessionStorage.setItem(flag, '1');
    } catch {
      if (!o.xp) return;
    }
    try {
      const { user: fresh } = await api('/api/auth/me');
      if (fresh) progress.gainXp(fresh, o.xp, `Compra · ${o.reference}`);
    } catch {
      /* el XP ya está en la credencial; el aviso es solo un extra */
    }
  }

  /** `view` es el estado del pedido, o «unpaid» si sigue pendiente y Wompi no tiene ningún pago suyo. */
  function renderResult(o, view = o.status) {
    const r = RESULT[view] ?? RESULT.error;
    document.title = `${r.kicker} · ${o.reference} — Dream Zone`;
    $('#pay-kicker').textContent = `Pedido ${o.reference}`;
    $('#pay-title').innerHTML = r.title;
    $('#receipt-kicker').textContent = `Pedido ${o.reference}`;
    renderReceipt(o);
    $('#receipt-perk').hidden = true;
    const stamp = $('#receipt-stamp');
    stamp.hidden = false;
    stamp.dataset.status = view;
    stamp.textContent = r.stamp;

    const method = o.method ? (METHODS[o.method] ?? o.method.toLowerCase()) : null;
    const actions = [];
    let body = '';
    if (o.status === 'approved') {
      $('#pay-lead').textContent = site?.pago?.gracias ?? 'Tus reliquias ya tienen dueño. Te escribimos cuando salgan del archivo.';
      body = `
        <p class="pay__state-text">${deliveryText(o)}</p>
        ${shipmentText(o)}
        <p class="pay__state-text">Pagaste ${money(o.totalCents)}${method ? ` con ${esc(method)}` : ''}. La confirmación llega a <b>${esc(o.customer.email)}</b>.</p>
        ${o.xp ? `<p class="pay__xp mono">${progress.COIN}+${o.xp} XP en tu credencial</p>` : ''}`;
      actions.push('<a class="btn" href="/">Volver al archivo →</a>');
      if (user) actions.push('<a class="link mono" href="/cuenta#pedidos">Ver mis pedidos</a>');
      celebrate(o);
    } else if (view === 'unpaid') {
      $('#pay-lead').textContent = 'Wompi no tiene ningún pago para este pedido: saliste antes de terminar. No se cobró nada y tu carrito sigue intacto.';
      body = `<p class="pay__state-text">Puedes pagarlo ahora desde tu carrito, con el mismo u otro método.</p>
        <p class="pay__state-text">¿Acabas de pagar por PSE o Nequi y aún no aparece? Consulta de nuevo en un minuto.</p>`;
      actions.push('<a class="btn" href="/pago">Pagar ahora →</a>', '<button class="btn btn--ghost" type="button" data-recheck>Consultar de nuevo</button>');
    } else if (view === 'pending') {
      $('#pay-lead').textContent = 'Wompi está confirmando el pago con tu banco. No cierres esta página: se actualiza sola.';
      body = `<p class="pay__state-text pay__wait"><span class="cursor" aria-hidden="true"></span> Esperando la respuesta${method ? ` de ${esc(method)}` : ''}…</p>
        <p class="pay__state-text">Si pagaste por PSE o Nequi puede tardar unos minutos. Te avisamos por correo apenas se confirme.</p>`;
      actions.push('<button class="btn btn--ghost" type="button" data-recheck>Consultar de nuevo</button>');
    } else {
      $('#pay-lead').textContent = o.status === 'declined'
        ? 'Tu banco o Wompi no aprobaron el pago. No se cobró nada y tu carrito sigue intacto.'
        : 'No se completó el pago. No se cobró nada y tu carrito sigue intacto.';
      body = `${o.message ? `<p class="pay__state-text">Wompi dice: «${esc(o.message)}»</p>` : ''}
        <p class="pay__state-text">Puedes intentarlo otra vez con el mismo u otro método de pago.</p>`;
      actions.push('<a class="btn" href="/pago">Intentar de nuevo →</a>', '<a class="link mono" href="/">Volver al archivo</a>');
    }
    showState(`
      <p class="acct__kicker mono">${esc(r.kicker)}</p>
      <p class="acct__sub">Pedido ${esc(o.reference)}</p>
      ${body}
      <div class="profile__actions">${actions.join('')}</div>`);
  }

  async function followOrder() {
    let tries = 0;
    let first = true;
    const check = async () => {
      tries += 1;
      try {
        const q = new URLSearchParams({ ref: REF, k: KEY ?? '' });
        if (TX) q.set('id', TX);
        const { order, checked } = await api(`/api/checkout/status?${q}`);
        const view = order.status === 'pending' && !order.paymentStarted && checked ? 'unpaid' : order.status;
        renderResult(order, view);
        if (order.status !== 'pending') forgetLast(order.reference);
        if (view === 'pending' && tries < POLL_MAX) setTimeout(check, POLL_MS);
      } catch (err) {
        if (first || err.status === 404) {
          showState(`<p class="acct__kicker mono">Pedido ${esc(REF)}</p><p class="acct__sub">No encontramos ese pedido.</p>
            <p class="pay__state-text">${esc(err.message)} Si ya pagaste, revisa tu correo o escríbenos con la referencia.</p>
            <div class="profile__actions"><a class="btn" href="/">Volver al archivo →</a></div>`);
          $('#receipt').hidden = true;
        } else if (tries < POLL_MAX) setTimeout(check, POLL_MS);
      }
      first = false;
    };
    stateEl.addEventListener('click', (e) => {
      if (!e.target.closest('[data-recheck]')) return;
      tries = 0;
      check();
    });
    form.hidden = true;
    showState('<p class="pay__state-text pay__wait"><span class="cursor" aria-hidden="true"></span> Consultando tu pago con Wompi…</p>');
    await check();
  }

  /* ---------- Arranque ---------- */
  (async () => {
    try {
      ({ user } = await api('/api/auth/me'));
    } catch {
      user = null;
    }
    progress.setUser(user);
    site = (await api('/api/site').catch(() => null))?.site ?? null; // el mensaje de gracias lo edita la curaduría
    if (REF) await followOrder();
    else await startCheckout();
  })();
})();