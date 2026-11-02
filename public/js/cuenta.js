/* DREAM ZONE — Credencial de jugador: entrar, registrarse, recuperar la contraseña y ver el perfil. */
(() => {
  'use strict';

  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));
  const pad = (n) => String(n).padStart(2, '0');
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const num = (n) => Number(n).toLocaleString('en-US');
  const money = (cents) => `$${Math.round(cents / 100).toLocaleString('es-CO')}`;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const RARITY = ['', 'Común', 'Poco común', 'Rara', 'Épica', 'Legendaria'];
  /** Logros, XP y nivel: public/js/progress.js (compartido con la tienda). */
  const progress = window.DZProgress;

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

  /* ---------- Parámetros: token de recuperación y destino tras entrar ---------- */
  const params = new URLSearchParams(window.location.search);
  const resetToken = params.get('token');
  const nextParam = params.get('next');
  // solo páginas propias: «pago» o «admin» (los enlaces viejos con .html también valen) → /pago
  const next = nextParam && /^[a-z0-9-]+(?:\.html)?$/.test(nextParam) ? `/${nextParam.replace(/\.html$/, '')}` : null;
  const TOKEN_VIEWS = ['restablecer', 'activar'];
  if (resetToken) {
    // el token no se queda en el historial ni en la barra de direcciones
    const tokenView = window.location.hash === '#activar' ? 'activar' : 'restablecer';
    window.history.replaceState(null, '', `${window.location.pathname}${next ? `?next=${next.slice(1)}` : ''}#${tokenView}`);
  }

  let user = null;
  let view = null;

  /* ---------- Vistas ---------- */
  const COPY = {
    entrar: {
      title: 'Entra al <em class="echo" data-text="archivo">archivo</em>.',
      lead: 'Tu credencial guarda tus pedidos, tus logros y el XP de cada compra: con tu nivel pagas menos.',
    },
    registro: {
      title: 'Crea tu <em class="echo" data-text="credencial">credencial</em>.',
      lead: 'Nombre, correo y una contraseña. La tarjeta se llena mientras escribes.',
    },
    recuperar: {
      title: 'Recupera tu <em class="echo" data-text="acceso">acceso</em>.',
      lead: 'Escribe el correo de tu credencial: te mandamos un código de 6 dígitos para elegir una contraseña nueva.',
    },
    restablecer: {
      title: 'Elige una contraseña <em class="echo" data-text="nueva">nueva</em>.',
      lead: 'El enlace sirve una sola vez. Al guardar cerramos tus otras sesiones y entras aquí mismo.',
    },
    activar: {
      title: 'Activa tu credencial de <em class="echo" data-text="curaduría">curaduría</em>.',
      lead: 'Te invitaron a editar Dream Zone. Elige cómo te llamamos y tu contraseña: con eso queda activa tu credencial.',
    },
  };

  function setView(name) {
    view = name;
    if (user && !TOKEN_VIEWS.includes(view)) view = 'perfil';
    if (!user && !COPY[view]) view = 'entrar';
    if (TOKEN_VIEWS.includes(view) && !resetToken) {
      view = 'recuperar';
      say($('#f-recuperar'), 'Ese enlace no es válido o ya se usó. Pide un código aquí.', 'error');
    }

    $$('[data-view]').forEach((el) => { el.hidden = el.dataset.view !== view; });
    $('#tabs').hidden = !['entrar', 'registro'].includes(view);
    $('#trophies').hidden = view !== 'perfil'; // los logros van debajo de la credencial
    $$('[data-view-link]').forEach((a) => {
      if (a.dataset.viewLink === view) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });

    if (view === 'perfil') {
      loadOrders();
      // «¿Olvidaste tu contraseña?» con la sesión abierta: no hace falta salir, se cambia con un código aquí mismo
      if (name === 'recuperar') {
        requestAnimationFrame(() => {
          pwForm.scrollIntoView({ block: 'center', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
          $('[data-pw-forgot]', pwForm).focus({ preventScroll: true });
        });
        say(pwForm, 'Ya tienes la sesión abierta: pide un código aquí y elige tu contraseña nueva sin salir.', 'ok');
      }
      const first = user.nickname || user.name.split(' ')[0];
      $('#acct-title').innerHTML = `Hola, <em class="echo" data-text="${esc(first)}">${esc(first)}</em>.`;
      renderLead();
      document.title = 'Tu credencial — Dream Zone';
    } else {
      $('#acct-title').innerHTML = COPY[view].title;
      // el enlace «Pedidos» del pie de la tienda llega aquí sin sesión: después de entrar va directo a ellos
      $('#acct-lead').textContent = name === 'pedidos' && view === 'entrar'
        ? 'Entra con tu credencial para ver tus pedidos y la guía de cada envío.'
        : COPY[view].lead;
      document.title = `${$('#acct-title').textContent} — Dream Zone`;
    }
    renderCard();
  }

  /* ---------- Mis pedidos: lo pagado, de 5 en 5, y con qué guía va cada envío ---------- */
  const METHOD_LABEL = {
    CARD: 'Tarjeta', NEQUI: 'Nequi', PSE: 'PSE', DAVIPLATA: 'Daviplata', BANCOLOMBIA_TRANSFER: 'Botón Bancolombia',
    BANCOLOMBIA_QR: 'QR Bancolombia', BANCOLOMBIA_BNPL: 'Compra y paga después', SU_PLUS: 'SU+ Pay', SIMULADO: 'Pago simulado',
  };
  const mineList = $('#mine-list');
  const minePager = $('#mine-pager');
  let ordersFor = null; // «correo#página» de lo que está pintado
  let ordersPage = 1;
  let ordersScrolled = false;

  const pickup = (o) => o.delivery.method === 'tienda';
  const stateLabel = (o) => (o.fulfillment !== 'enviado' ? 'Pagado' : pickup(o) ? 'Listo para recoger' : 'Enviado');

  /** La entrega: con qué distribuidora salió y su guía, o qué falta para que salga. */
  function shipHtml(o) {
    const s = o.shipment;
    if (pickup(o)) {
      return `<p class="mine__ship mono">${s
        ? `Listo para recoger en la tienda desde el ${esc(fmtDate(s.at))}. Al llegar, di la referencia ${esc(o.reference)}.`
        : 'Lo recoges en la tienda: te escribimos por correo cuando esté listo para recoger.'}</p>`;
    }
    if (!s) return `<p class="mine__ship mono">Preparando tu envío a ${esc(o.delivery.city)}. Cuando salga verás aquí la distribuidora y el número de guía.</p>`;
    return `
      <div class="mine__ship is-out">
        <p class="mono">Salió el ${esc(fmtDate(s.at))} con <b>${esc(s.carrierName ?? 'la distribuidora')}</b></p>
        <p class="mine__guide"><span class="mono">Guía</span><b class="mono">${esc(s.tracking)}</b><button class="link mono" type="button" data-copy="${esc(s.tracking)}">Copiar</button>${s.url ? `<a class="link mono" href="${esc(s.url)}" target="_blank" rel="noopener">Rastrear en ${esc(s.carrierName)} ↗</a>` : ''}</p>
      </div>`;
  }

  /** Un recibo: plegado se ve qué, cuándo, cuánto y su estado; desplegado, la entrega y cada pieza. */
  function orderHtml(o, open) {
    const units = o.lines.reduce((n, l) => n + l.qty, 0);
    const [first] = o.lines;
    const more = o.lines.length - 1;
    const meta = [
      `${pad(units)} ${units === 1 ? 'pieza' : 'piezas'}`,
      o.method ? esc(METHOD_LABEL[o.method] ?? o.method) : '',
      pickup(o) ? 'Recoges en la tienda' : `Envío a ${esc(o.delivery.city)}${o.shippingQuote ? ` · ${esc(o.shippingQuote.carrierName)}` : ''}`,
      o.xp ? `+${num(o.xp)} XP` : '',
    ].filter(Boolean);
    return `
      <li class="mine__item" data-status="${esc(o.fulfillment)}">
        <details${open ? ' open' : ''}>
          <summary class="mine__row">
            <span class="mine__top mono"><span>${esc(o.reference)}</span><span>${esc(fmtDate(o.paidAt ?? o.createdAt))}</span></span>
            <span class="mine__what">${first.qty} × ${esc(first.name)}${more ? ` <span class="mono">+${more} más</span>` : ''}</span>
            <span class="mine__end"><span class="mine__pill mono">${stateLabel(o)}</span><b class="mine__total mono">${money(o.totalCents)}</b></span>
          </summary>
          <div class="mine__body">
            ${shipHtml(o)}
            <ul class="mine__lines" role="list">${o.lines.map((l) => `
              <li><span class="mine__name">${l.qty} × ${esc(l.name)}</span><span class="mine__amount mono">${money(l.totalCents)}</span>${l.includes ? `<span class="mine__inc mono">${esc(l.includes.map((x) => x.name).join(' + '))}</span>` : ''}</li>`).join('')}
            </ul>
            <p class="mine__meta mono">${meta.map((m) => `<span>${m}</span>`).join('')}</p>
            <a class="link mono mine__receipt" href="/pago?ref=${encodeURIComponent(o.reference)}">Ver recibo →</a>
          </div>
        </details>
      </li>`;
  }

  function minePagerHtml(page, pages) {
    const nums = [];
    for (let n = 1; n <= pages; n += 1) {
      if (n === 1 || n === pages || Math.abs(n - page) <= 1) nums.push(n);
      else if (nums[nums.length - 1] !== '…') nums.push('…');
    }
    return `
      <button class="pager__step" type="button" data-page="${page - 1}"${page === 1 ? ' disabled' : ''}>← Recientes</button>
      <ol class="pager__list" role="list">${nums.map((n) => (n === '…'
        ? '<li class="pager__gap" aria-hidden="true">…</li>'
        : `<li><button class="pager__num" type="button" data-page="${n}" aria-label="Página ${n}"${n === page ? ' aria-current="page"' : ''}>${pad(n)}</button></li>`)).join('')}</ol>
      <button class="pager__step" type="button" data-page="${page + 1}"${page === pages ? ' disabled' : ''}>Anteriores →</button>`;
  }

  async function loadOrders(page = ordersPage) {
    if (!user) return;
    if (!ordersFor?.startsWith(`${user.email}#`)) page = 1; // otra credencial: desde la primera página
    const key = `${user.email}#${page}`;
    if (ordersFor === key) return;
    ordersFor = key;
    const sum = $('#mine-sum');
    const status = $('#mine-status');
    try {
      const data = await api(`/api/checkout/mine?page=${page}`);
      ordersPage = data.page;
      ordersFor = `${user.email}#${data.page}`;
      mineList.innerHTML = data.orders.map((o, i) => orderHtml(o, data.page === 1 && i === 0)).join(''); // el más reciente, abierto
      sum.innerHTML = `<b>${pad(data.count)}</b> ${data.count === 1 ? 'pedido pagado' : 'pedidos pagados'} · <b>${money(data.totalCents)}</b>${data.xp ? ` · +${num(data.xp)} XP` : ''}${data.pages > 1 ? ` · página ${pad(data.page)} de ${pad(data.pages)}` : ''}`;
      sum.hidden = !data.count;
      minePager.hidden = data.pages <= 1;
      minePager.innerHTML = data.pages > 1 ? minePagerHtml(data.page, data.pages) : '';
      status.hidden = data.count > 0;
      status.textContent = '> todavía no has pagado ningún pedido. Cuando pagues uno, aquí ves su envío y su guía.';
      if (window.location.hash === '#pedidos' && !ordersScrolled) {
        ordersScrolled = true;
        $('#pedidos').scrollIntoView({ block: 'start' });
      }
    } catch (err) {
      ordersFor = null;
      status.hidden = false;
      status.textContent = `> no pudimos cargar tus pedidos (${err.message}).`;
    }
  }

  minePager.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-page]');
    if (!btn || btn.disabled) return;
    await loadOrders(Number(btn.dataset.page));
    $('#pedidos').scrollIntoView({ block: 'start', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  });
  mineList.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      btn.textContent = 'Copiada ✓';
    } catch {
      btn.textContent = 'Cópiala a mano';
    }
    setTimeout(() => { btn.textContent = 'Copiar'; }, 1800);
  });

  function currentView() {
    return window.location.hash.slice(1) || 'entrar';
  }
  window.addEventListener('hashchange', () => {
    setView(currentView());
    const form = $(`form[data-view="${currentView()}"]`);
    if (form && !form.hidden) form.querySelector('input')?.focus();
  });

  /* ---------- La credencial ---------- */
  const card = $('#idcard');
  const fmtDate = (iso) => {
    const d = new Date(iso);
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}`;
  };
  /** ID corto y estable a partir del correo (FNV-1a): solo decorativo. */
  const cardId = (text) => {
    let h = 0x811c9dc5;
    for (const ch of text) {
      h ^= ch.codePointAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `DZ-${h.toString(16).toUpperCase().padStart(8, '0').slice(0, 4)}`;
  };

  /* Lo que se edita en «Editar credencial» se ve en la tarjeta antes de guardar. */
  const profileForm = $('#f-perfil');
  const profileDraft = () => {
    const f = profileForm.elements;
    return {
      name: f.name.value.trim().replace(/\s+/g, ' '),
      nickname: f.nickname.value.trim().replace(/\s+/g, ' '),
      color: f.color?.value || 'nivel',
    };
  };

  function renderCard() {
    const activating = !$('#f-activar').hidden;
    const draftForm = [$('#f-registro'), $('#f-activar')].find((f) => !f.hidden);
    const draft = draftForm && (!user || activating) ? draftForm.elements.name.value.trim() : '';
    const own = Boolean(user) && !activating;
    const edit = own ? profileDraft() : null;
    const realName = own ? edit.name || user.name : draft;
    const nick = own ? edit.nickname : '';
    const shown = nick || realName;
    // en grande va el apodo (o el nombre); si hay apodo, el nombre va debajo en pequeño
    const nameEl = $('#card-name');
    nameEl.textContent = shown || 'Tu nombre aquí';
    nameEl.classList.toggle('is-placeholder', !shown);
    const len = Array.from(shown).length;
    nameEl.dataset.long = len > 24 ? '2' : len > 15 ? '1' : '0'; // los nombres largos se achican y no tocan el sello
    $('#card-real').hidden = !nick;
    $('#card-real').textContent = realName;
    $('#card-since').textContent = user ? fmtDate(user.createdAt) : '—';
    const mail = user?.email ?? (!$('#f-registro').hidden ? $('#f-registro').elements.email.value.trim() : '');
    $('#card-id').textContent = mail && !activating ? cardId(mail.toLowerCase()) : 'DZ-····';
    $('#card-role').hidden = user?.role !== 'admin' && !activating;

    // nivel y XP: los de tu credencial; una credencial nueva (registro o invitación) empieza en Lv 01
    const s = progress.stats();
    const level = own ? s.level : 1;
    const xp = own ? s.xp : 0;
    const nextXp = own ? s.next : progress.LEVEL_XP[1];
    card.dataset.lv = String(level);
    $('#card-level').dataset.lv = String(level);
    $('#card-level').textContent = `Lv ${pad(level)} · ${progress.levelName(level)}`;
    $('#card-bar').style.setProperty('--v', (own ? s.ratio : 0).toFixed(3));
    $('#card-xp').innerHTML = nextXp ? `<b>${num(xp)}</b> / ${num(nextXp)} XP` : `<b>${num(xp)}</b> XP · nivel máximo`;
    progress.paintAvatar($('#card-avatar'), { name: shown || '?', color: own ? edit.color : 'nivel', level });
    $$('[data-swatch]').forEach((el) => progress.paintAvatar(el, { name: shown, color: el.dataset.swatch, level, preview: true }));
  }
  $('#f-registro').addEventListener('input', renderCard);
  $('#f-activar').addEventListener('input', renderCard);

  // Lámina holográfica: sigue al cursor y la tarjeta se inclina un poco
  const intro = $('.acct__intro');
  intro.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || reduceMotion.matches) return;
    const r = card.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    card.classList.add('is-tilting');
    card.style.setProperty('--mx', `${(x * 100).toFixed(1)}%`);
    card.style.setProperty('--my', `${(y * 100).toFixed(1)}%`);
    card.style.setProperty('--ry', `${((x - 0.5) * 14).toFixed(2)}deg`);
    card.style.setProperty('--rx', `${((0.5 - y) * 10).toFixed(2)}deg`);
  });
  intro.addEventListener('pointerleave', () => {
    card.classList.remove('is-tilting');
    card.style.setProperty('--rx', '0deg');
    card.style.setProperty('--ry', '0deg');
  });

  /* ---------- Perfil ---------- */
  function renderProfile() {
    if (!user) return;
    $('#p-name').textContent = user.name;
    $('#p-nick').textContent = user.nickname || '—';
    $('#p-email').textContent = user.email;
    $('#p-role').textContent = user.role === 'admin' ? 'Curaduría (admin)' : 'Jugador';
    $('#p-since').textContent = fmtDate(user.createdAt);
    $$('[data-admin-link]').forEach((a) => { a.hidden = user.role !== 'admin'; });

    const s = progress.stats();
    $('#p-level').dataset.lv = String(s.level);
    $('#p-level').textContent = `Lv ${pad(s.level)} · ${progress.levelName(s.level)} · ${num(s.xp)} XP`;
    renderSwatches();
    $('#tr-count').textContent = `${pad(s.count)}/${pad(s.total)}`;
    $('#tr-next').textContent = progress.nextStep(s);
    $('#tr-list').innerHTML = progress.list().map((a) => {
      const hidden = a.secret && !a.done;
      return `
        <li class="trophy${a.done ? ' is-done' : ''}" data-r="${a.rarity}">
          <span class="trophy__icon" aria-hidden="true">${progress.TROPHY}</span>
          <span><b class="trophy__name">${hidden ? '???' : esc(a.name)}</b><span class="trophy__desc mono">${hidden ? `Logro secreto · pista: ${esc(a.hint)}` : esc(a.desc)}</span></span>
          <span class="trophy__side mono"><span class="trophy__xp">${a.done ? '+' : ''}${hidden ? '??' : a.xp} XP</span><span>${a.done ? `<span class="sr-only">Desbloqueado </span>${a.at ? fmtDate(a.at) : 'desbloqueado'}` : 'bloqueado'}</span></span>
        </li>`;
    }).join('');
  }

  function renderLead() {
    if (view === 'perfil' && user) $('#acct-lead').textContent = `Esta es tu credencial de jugador. ${progress.nextStep()}`;
  }

  // un logro o un nivel nuevo (también los que llegan desde otra pestaña al sincronizar) se ve al instante
  progress.subscribe(() => {
    renderCard();
    renderProfile();
    renderLead();
  });

  /** `fresh`: la credencial se acaba de crear (se anuncia su primer logro). */
  function signedIn(nextUser, message, { fresh = false } = {}) {
    user = nextUser;
    progress.setUser(nextUser); // pasa a la cuenta los logros ganados sin sesión en este navegador
    fillProfileForm();
    if (fresh) progress.toastAchievement('credencial');
    if (next) {
      window.location.href = next;
      return;
    }
    renderProfile();
    const hash = window.location.hash === '#pedidos' ? '#pedidos' : '#perfil'; // si venía a ver sus pedidos, ahí queda
    if (window.location.hash !== hash) window.history.replaceState(null, '', `${window.location.pathname}${hash}`);
    setView('perfil');
    say($('#v-perfil'), message, 'ok');
  }

  /* ---------- Formularios ---------- */
  function say(scope, text, stateName) {
    const msg = scope.querySelector('.form-msg');
    msg.textContent = text;
    if (stateName) msg.dataset.state = stateName;
    else delete msg.dataset.state;
  }

  function invalid(form, input, text) {
    input.setAttribute('aria-invalid', 'true');
    say(form, text, 'error');
    input.focus();
    return false;
  }

  function clearInvalid(form) {
    $$('[aria-invalid]', form).forEach((el) => el.removeAttribute('aria-invalid'));
  }

  // al corregir un campo marcado se le quita el rojo y el aviso de error de la ficha
  $$('form.ficha--acct').forEach((form) => form.addEventListener('input', (e) => {
    if (!e.target.hasAttribute?.('aria-invalid')) return;
    e.target.removeAttribute('aria-invalid');
    if (form.querySelector('.form-msg')?.dataset.state === 'error') say(form, '');
  }));

  /** Envía un formulario con su botón bloqueado; los errores de la API se muestran en la ficha. */
  async function submit(form, run) {
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    say(form, '> procesando…');
    try {
      await run();
    } catch (err) {
      say(form, err.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  const validEmail = (input) => input.value.trim() && input.checkValidity();

  $('#f-entrar').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const { email, password } = form.elements;
    clearInvalid(form);
    if (!validEmail(email)) return invalid(form, email, 'Revisa tu correo (ej. nombre@correo.com).');
    if (!password.value) return invalid(form, password, 'Escribe tu contraseña.');
    return submit(form, async () => {
      const data = await api('/api/auth/login', { method: 'POST', body: { email: email.value, password: password.value } });
      form.reset();
      say(form, '');
      signedIn(data.user, `Bienvenido de vuelta, ${data.user.name.split(' ')[0]}.`);
    });
  });

  $('#f-registro').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const { name, email, password, consent } = form.elements;
    clearInvalid(form);
    if (name.value.trim().length < 2) return invalid(form, name, 'Tu nombre necesita al menos 2 letras.');
    if (!validEmail(email)) return invalid(form, email, 'Revisa tu correo (ej. nombre@correo.com).');
    if (password.value.length < 8) return invalid(form, password, 'La contraseña necesita al menos 8 caracteres.');
    if (!consent.checked) return invalid(form, consent, 'Para crear tu credencial, marca la casilla de la política de tratamiento de datos.');
    return submit(form, async () => {
      const data = await api('/api/auth/register', {
        method: 'POST',
        body: { name: name.value, email: email.value, password: password.value, consent: true },
      });
      form.reset();
      say(form, '');
      signedIn(data.user, 'Credencial creada. Te damos la bienvenida al archivo.', { fresh: true });
    });
  });

  /* Códigos de 6 dígitos: se pegan con o sin espacio (o con texto alrededor) y se ven como «123 456» */
  $$('.ficha__code').forEach((input) => input.addEventListener('input', () => {
    const d = input.value.replace(/\D/g, '').slice(0, 6);
    input.value = d.length > 3 ? `${d.slice(0, 3)} ${d.slice(3)}` : d;
  }));

  const RESEND_S = 60;
  /** «Reenviar en 60 s»: el botón para pedir otro código se habilita pasado un minuto. Devuelve el intervalo. */
  function cooldown(btn, previous) {
    clearInterval(previous);
    let left = RESEND_S;
    const tick = () => {
      btn.disabled = left > 0;
      btn.textContent = left > 0 ? `Reenviar en ${left} s` : 'Reenviar código';
      if (left <= 0) clearInterval(timer);
      left -= 1;
    };
    const timer = setInterval(tick, 1000);
    tick();
    return timer;
  }

  /* Recuperar: primero el correo (le llega un código); después, en la misma ficha, código + contraseña nueva */
  const recForm = $('#f-recuperar');
  let resendTimer = null;

  function codeStep(on) {
    const { email, code } = recForm.elements;
    recForm.dataset.step = on ? 'code' : 'email';
    $('[data-code-step]', recForm).hidden = !on;
    $('[data-code-links]', recForm).hidden = !on;
    email.readOnly = on;
    $('[data-step-note]', recForm).textContent = on
      ? `Escribe el código que enviamos a ${email.value.trim()} (revisa también spam). Vence en 15 minutos.`
      : 'Te mandamos un código de 6 dígitos. Vence en 15 minutos.';
    recForm.querySelector('[type="submit"]').textContent = on ? 'Guardar y entrar →' : 'Enviar código →';
    if (on) code.focus();
  }

  async function sendCode() {
    const { email } = recForm.elements;
    await api('/api/auth/forgot', { method: 'POST', body: { email: email.value } });
    codeStep(true);
    resendTimer = cooldown($('[data-resend]', recForm), resendTimer);
    say(recForm, `Si ${email.value.trim()} tiene credencial, ya va un código en camino.`, 'ok');
  }

  recForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const { email, code, password } = recForm.elements;
    clearInvalid(recForm);
    if (recForm.dataset.step !== 'code') {
      if (!validEmail(email)) return invalid(recForm, email, 'Revisa tu correo (ej. nombre@correo.com).');
      return submit(recForm, sendCode);
    }
    const digits = code.value.replace(/\D/g, '');
    if (digits.length !== 6) return invalid(recForm, code, 'El código tiene 6 dígitos: cópialo del correo.');
    if (password.value.length < 8) return invalid(recForm, password, 'La contraseña nueva necesita al menos 8 caracteres.');
    return submit(recForm, async () => {
      const data = await api('/api/auth/reset', { method: 'POST', body: { email: email.value, code: digits, password: password.value } });
      clearInterval(resendTimer);
      recForm.reset();
      codeStep(false);
      say(recForm, '');
      signedIn(data.user, 'Contraseña nueva guardada. Ya estás dentro.');
    });
  });
  recForm.addEventListener('click', (e) => {
    if (e.target.closest('[data-resend]')) {
      clearInvalid(recForm);
      submit(recForm, sendCode);
    } else if (e.target.closest('[data-other-email]')) {
      clearInterval(resendTimer);
      recForm.elements.code.value = '';
      recForm.elements.password.value = '';
      codeStep(false);
      say(recForm, '');
      recForm.elements.email.focus();
    }
  });

  $('#f-restablecer').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const { password } = form.elements;
    clearInvalid(form);
    if (password.value.length < 8) return invalid(form, password, 'La contraseña necesita al menos 8 caracteres.');
    return submit(form, async () => {
      const data = await api('/api/auth/reset', { method: 'POST', body: { token: resetToken, password: password.value } });
      form.reset();
      say(form, '');
      signedIn(data.user, 'Contraseña nueva guardada. Ya estás dentro.');
    });
  });

  $('#f-activar').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const { name, password } = form.elements;
    clearInvalid(form);
    if (name.value.trim().length < 2) return invalid(form, name, 'Tu nombre necesita al menos 2 letras.');
    if (password.value.length < 8) return invalid(form, password, 'La contraseña necesita al menos 8 caracteres.');
    return submit(form, async () => {
      const data = await api('/api/auth/reset', {
        method: 'POST',
        body: { token: resetToken, password: password.value, name: name.value },
      });
      form.reset();
      say(form, '');
      signedIn(data.user, 'Credencial activada. Ya puedes abrir la curaduría.');
    });
  });

  /* Cambiar contraseña: con la actual o, si no la recuerdas, con un código que llega al correo de la cuenta */
  const pwForm = $('#f-password');
  const PW_NOTE = 'Al guardar se cierran tus sesiones en otros dispositivos.';
  let pwResendTimer = null;

  function pwMode(mode) {
    pwForm.dataset.mode = mode;
    $$('[data-pw-mode]', pwForm).forEach((el) => { el.hidden = el.dataset.pwMode !== mode; });
    $('[data-pw-forgot]', pwForm).hidden = mode === 'code';
    if (mode === 'code') return;
    clearInterval(pwResendTimer);
    pwForm.elements.code.value = '';
    $('[data-pw-note]', pwForm).textContent = PW_NOTE;
  }

  async function pwSendCode() {
    const data = await api('/api/auth/password', { method: 'POST', body: { step: 'code' } });
    pwMode('code');
    pwResendTimer = cooldown($('[data-pw-resend]', pwForm), pwResendTimer);
    $('[data-pw-note]', pwForm).textContent = `Escribe el código que enviamos a ${data.email} (revisa también spam; vence en 15 minutos) y tu contraseña nueva. ${PW_NOTE}`;
    say(pwForm, `Código enviado a ${data.email}.`, 'ok');
    pwForm.elements.code.focus();
  }

  pwForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const { current, code, password } = pwForm.elements;
    const withCode = pwForm.dataset.mode === 'code';
    const digits = code.value.replace(/\D/g, '');
    clearInvalid(pwForm);
    if (withCode && digits.length !== 6) return invalid(pwForm, code, 'El código tiene 6 dígitos: cópialo del correo.');
    if (!withCode && !current.value) return invalid(pwForm, current, 'Escribe tu contraseña actual.');
    if (password.value.length < 8) return invalid(pwForm, password, 'La contraseña nueva necesita al menos 8 caracteres.');
    return submit(pwForm, async () => {
      const body = withCode ? { code: digits, password: password.value } : { current: current.value, password: password.value };
      await api('/api/auth/password', { method: 'POST', body });
      pwForm.reset();
      pwMode('current');
      renderStrength($('[data-strength-for="new-pass"]'));
      say(pwForm, 'Contraseña actualizada. Cerramos tus otras sesiones.', 'ok');
    });
  });
  pwForm.addEventListener('click', (e) => {
    if (e.target.closest('[data-pw-forgot], [data-pw-resend]')) {
      clearInvalid(pwForm);
      submit(pwForm, pwSendCode);
    } else if (e.target.closest('[data-pw-current]')) {
      clearInvalid(pwForm);
      pwMode('current');
      say(pwForm, '');
      pwForm.elements.current.focus();
    }
  });

  /* ---------- Editar credencial: nombre, apodo y color del cuadro ---------- */
  /** Igual que NICK_RE en lib/validate.js. */
  const NICK_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u;

  /**
   * Muestras de color; las que piden más nivel (los cuadros de Adepto, Leyenda y Mítico, y Holo) o un logro (DZ
   * pixelado, con el secreto Viejo truco) quedan bloqueadas. Se rehacen cuando cambia el nivel o lo desbloqueado.
   */
  function renderSwatches(force = false) {
    const box = $('#swatches');
    const { level } = progress.stats();
    const key = `${level}:${progress.AVATAR_COLORS.map((c) => (progress.colorLock(c, level) ? 0 : 1)).join('')}`;
    if (!user || (!force && box.dataset.level === key)) return;
    const chosen = force ? user.avatarColor ?? 'nivel' : profileForm.elements.color?.value || user.avatarColor || 'nivel';
    box.dataset.level = key;
    const own = progress.levelSpecial(level); // el cuadro de tu nivel ya es «Tu nivel»: no se repite
    box.innerHTML = progress.AVATAR_COLORS.filter((c) => c.id !== own).map((c) => {
      const lock = progress.colorLock(c, level);
      const locked = Boolean(lock);
      const note = lock ?? (c.id === 'nivel' ? progress.levelName(level) : '');
      return `
        <label class="swatch${locked ? ' is-locked' : ''}">
          <input type="radio" name="color" value="${c.id}"${locked ? ' disabled' : ''}${c.id === chosen && !locked ? ' checked' : ''}>
          <span class="avatar" data-swatch="${c.id}" aria-hidden="true"></span>
          <span class="swatch__name mono">${esc(c.label)}${note ? `<small>${esc(note)}</small>` : ''}</span>
        </label>`;
    }).join('');
    if (!box.querySelector('input:checked')) box.querySelector('input[value="nivel"]').checked = true;
  }

  /** La ficha vuelve a lo guardado en la cuenta (al entrar, al guardar y al deshacer). */
  function fillProfileForm() {
    if (!user) return;
    profileForm.elements.name.value = user.name;
    profileForm.elements.nickname.value = user.nickname ?? '';
    renderSwatches(true);
    $('#perfil-undo').disabled = true;
  }

  profileForm.addEventListener('input', () => {
    $('#perfil-undo').disabled = false;
    say(profileForm, '');
    renderCard();
  });

  $('#perfil-undo').addEventListener('click', () => {
    clearInvalid(profileForm);
    fillProfileForm();
    say(profileForm, '');
    renderCard();
  });

  profileForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const { name, nickname } = profileForm.elements;
    clearInvalid(profileForm);
    const d = profileDraft();
    if (d.name.length < 2) return invalid(profileForm, name, 'Tu nombre necesita al menos 2 letras.');
    if (d.nickname && (d.nickname.length < 2 || d.nickname.length > 24)) {
      return invalid(profileForm, nickname, 'El apodo va de 2 a 24 caracteres (o déjalo vacío).');
    }
    if (d.nickname && !NICK_RE.test(d.nickname)) {
      return invalid(profileForm, nickname, "El apodo solo admite letras, números, espacios y . _ - '");
    }
    return submit(profileForm, async () => {
      const data = await api('/api/auth/profile', {
        method: 'POST',
        body: { name: d.name, nickname: d.nickname, avatarColor: d.color },
      });
      user = data.user;
      progress.setUser(user);
      fillProfileForm();
      renderProfile();
      setView('perfil'); // el saludo usa el apodo nuevo
      say(profileForm, 'Credencial guardada. Así te ven ahora en el archivo.', 'ok');
    });
  });

  /* ---------- Borrar la credencial: 1) contraseña · 2) código del correo · 3) escribir BORRAR ---------- */
  const delForm = $('#f-borrar');
  let delResendTimer = null;

  function delStage(stage) {
    delForm.dataset.stage = stage;
    const open = stage !== 'closed';
    $('[data-del-closed]', delForm).hidden = open;
    $('[data-del-open-panel]', delForm).hidden = !open;
    $$('[data-del-step="code"]', delForm).forEach((el) => { el.hidden = stage !== 'code'; });
    $('[data-del-resend]', delForm).hidden = stage !== 'code';
    delForm.elements.password.readOnly = stage === 'code';
    delForm.querySelector('[type="submit"]').textContent = stage === 'code' ? 'Borrar mi credencial para siempre' : 'Enviar código →';
    $('[data-del-note]', delForm).textContent = stage === 'code'
      ? `Pasos 2 y 3: escribe el código que enviamos a ${user?.email ?? 'tu correo'} (revisa también spam; vence en 15 minutos) y la palabra BORRAR.`
      : 'Paso 1 de 3: confirma que eres tú. Después te llega un código al correo.';
    if (!open) {
      clearInterval(delResendTimer);
      delForm.reset();
      clearInvalid(delForm);
      say(delForm, '');
    }
  }

  async function delSendCode() {
    const data = await api('/api/auth/delete', { method: 'POST', body: { step: 'start', password: delForm.elements.password.value } });
    delStage('code');
    delResendTimer = cooldown($('[data-del-resend]', delForm), delResendTimer);
    say(delForm, `Código enviado a ${data.email}.`, 'ok');
    delForm.elements.code.focus();
  }

  delForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const { password, code, phrase, unsubscribe } = delForm.elements;
    clearInvalid(delForm);
    if (delForm.dataset.stage !== 'code') {
      if (!password.value) return invalid(delForm, password, 'Escribe tu contraseña.');
      return submit(delForm, delSendCode);
    }
    const digits = code.value.replace(/\D/g, '');
    if (digits.length !== 6) return invalid(delForm, code, 'El código tiene 6 dígitos: cópialo del correo.');
    if (phrase.value.trim().toUpperCase() !== 'BORRAR') return invalid(delForm, phrase, 'Escribe BORRAR para confirmar.');
    return submit(delForm, async () => {
      await api('/api/auth/delete', { method: 'POST', body: { step: 'confirm', code: digits, phrase: phrase.value, unsubscribe: unsubscribe.checked } });
      clearInterval(delResendTimer);
      user = null;
      progress.setUser(null);
      progress.clearLocal(); // los logros de este navegador eran de la credencial borrada
      $$('[data-admin-link]').forEach((a) => { a.hidden = true; });
      delStage('closed');
      window.history.replaceState(null, '', `${window.location.pathname}#registro`);
      setView('registro');
      say($('#f-registro'), 'Tu credencial se borró. Gracias por pasar por el archivo.', 'ok');
    });
  });
  delForm.addEventListener('click', (e) => {
    if (e.target.closest('[data-del-open]')) {
      delStage('password');
      delForm.elements.password.focus();
    } else if (e.target.closest('[data-del-cancel]')) {
      delStage('closed');
    } else if (e.target.closest('[data-del-resend]')) {
      clearInvalid(delForm);
      submit(delForm, delSendCode);
    }
  });

  $('#logout').addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST', body: {} });
    } catch {
      /* si falla, igual se olvida localmente */
    }
    user = null;
    progress.setUser(null);
    delStage('closed');
    pwForm.reset();
    pwMode('current');
    say(pwForm, '');
    $$('[data-admin-link]').forEach((a) => { a.hidden = true; });
    window.history.replaceState(null, '', `${window.location.pathname}#entrar`);
    setView('entrar');
    say($('#f-entrar'), 'Sesión cerrada. Vuelve pronto.', 'ok');
  });

  /* ---------- Contraseña: ver/ocultar y "defensa" medida como rareza ---------- */
  $$('[data-reveal]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.reveal);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? 'ocultar' : 'ver';
      btn.setAttribute('aria-pressed', String(show));
    });
  });

  function defense(pw) {
    let score = 0;
    if (pw.length >= 8) score += 1;
    if (pw.length >= 12) score += 1;
    if (pw.length >= 16) score += 1;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score += 1;
    if (/\d/.test(pw)) score += 1;
    if (/[^A-Za-z0-9]/.test(pw)) score += 1;
    return Math.max(1, Math.min(5, score));
  }

  function renderStrength(el) {
    const pw = document.getElementById(el.dataset.strengthFor).value;
    if (!pw) {
      el.innerHTML = '';
      return;
    }
    if (pw.length < 8) {
      el.innerHTML = `<span class="muted">faltan ${8 - pw.length} caracteres</span>`;
      return;
    }
    const r = defense(pw);
    const cells = Array.from({ length: 5 }, (_, k) => `<i${k < r ? ' class="on"' : ''}></i>`).join('');
    el.innerHTML = `<span class="pips" data-r="${r}" aria-hidden="true">${cells}</span>defensa: <span class="rar" data-r="${r}">${RARITY[r]}</span>`;
  }

  $$('[data-strength-for]').forEach((el) => {
    document.getElementById(el.dataset.strengthFor).addEventListener('input', () => renderStrength(el));
  });

  /* ---------- Inicio ---------- */
  async function init() {
    // nombres de logros y niveles que haya cambiado la curaduría
    api('/api/site').then(({ site }) => progress.applyCopy(site)).catch(() => {});
    try {
      ({ user } = await api('/api/auth/me'));
    } catch (err) {
      say($('#f-entrar'), `No pudimos conectar con el archivo (${err.message}).`, 'error');
    }
    if (user && next && !resetToken) {
      window.location.replace(next);
      return;
    }
    progress.setUser(user);
    fillProfileForm();
    setView(currentView());
  }

  init();
})();