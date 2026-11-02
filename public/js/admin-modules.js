/* DREAM ZONE — Curaduría: navegación entre módulos y los módulos Página, Drops, Buzón y Equipo.
   El módulo Piezas vive en admin.js. Todo pasa por /api/admin/<módulo>; el servidor comprueba el rol siempre. */
(() => {
  'use strict';

  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const SAVE_KEY = isMac ? '⌘ S' : 'Ctrl S';
  const HEX_RE = /^#[0-9a-f]{6}$/i;
  /* Igual que SAFE_URL_RE en lib/validate.js (el servidor vuelve a validar). */
  const URL_RE = /^(?:https?:\/\/[^\s<>"'`]+|mailto:[^\s<>"'`]+|tel:\+?[\d\s()-]+|#[\w-]*|\/[^\s<>"'`]*|[a-z0-9-]+\.html(?:[?#][^\s<>"'`]*)?)$/i;

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

  const fmtDate = (iso) => {
    const d = new Date(iso);
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const fmtDay = (iso) => {
    const d = new Date(iso);
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}`;
  };
  function toLocalInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  const fromLocalInput = (value) => (value ? new Date(value).toISOString() : '');
  const money = (cents) => {
    if (!Number.isFinite(cents)) return '—';
    const whole = cents % 100 === 0;
    return `$${(cents / 100).toLocaleString('es-CO', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
  };
  /** «59.900», «59,900.50» o «59900» → centavos (NaN si no es un precio). Igual que en admin.js. */
  function parseMoney(value) {
    let clean = String(value).replace(/[\s$]/g, '');
    if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(clean)) clean = clean.replace(/\./g, '').replace(',', '.');
    else if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(clean)) clean = clean.replace(/,/g, '');
    else if (/^\d+,\d{1,2}$/.test(clean)) clean = clean.replace(',', '.');
    return /^\d+(\.\d{1,2})?$/.test(clean) ? Math.round(Number(clean) * 100) : NaN;
  }
  function remaining(iso) {
    let t = Math.max(0, Math.floor((Date.parse(iso) - Date.now()) / 1000));
    const d = Math.floor(t / 86400); t %= 86400;
    const h = Math.floor(t / 3600); t %= 3600;
    return `${pad(d)}d ${pad(h)}h ${pad(Math.floor(t / 60))}m`;
  }


  /* =====================================================================
     Navegación entre módulos (#piezas, #pagina, #drops, #pedidos, #buzon, #equipo)
     ===================================================================== */
  const VIEWS = ['piezas', 'pagina', 'drops', 'pedidos', 'buzon', 'equipo'];
  const modules = {};
  let currentView = null;
  let started = false;
  let me = null;

  function show(view) {
    currentView = view;
    document.body.dataset.view = view;
    $$('.adm-view').forEach((el) => { el.hidden = el.dataset.view !== view; });
    const nav = $('#adm-nav');
    $$('[data-tab]').forEach((a) => {
      if (a.dataset.tab !== view) {
        a.removeAttribute('aria-current');
        return;
      }
      a.setAttribute('aria-current', 'page');
      // en móvil la barra de módulos se desliza: la pestaña activa siempre queda a la vista
      if (a.offsetLeft < nav.scrollLeft || a.offsetLeft + a.offsetWidth > nav.scrollLeft + nav.clientWidth) {
        nav.scrollTo({ left: a.offsetLeft - 16 });
      }
    });
    modules[view]?.enter?.();
  }
  const viewFromHash = () => {
    const view = window.location.hash.slice(1);
    return VIEWS.includes(view) ? view : null;
  };
  window.addEventListener('hashchange', () => {
    const view = viewFromHash();
    if (started && view) show(view); // otros anclajes (#editor…) no cambian de módulo
  });

  function start(user) {
    if (started) return;
    started = true;
    me = user;
    $('#adm-nav').hidden = false;
    show(viewFromHash() ?? 'piezas');
    modules.pagina.preload();
    refreshInboxBadge();
    refreshOrdersBadge();
  }
  window.addEventListener('dz:admin', (e) => start(e.detail.user));

  document.addEventListener('keydown', (e) => {
    if (!started || currentView === 'piezas') return; // Piezas tiene sus propios atajos (admin.js)
    const mod = modules[currentView];
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      mod?.save?.();
    } else if (e.key === 'Escape' && !e.target.closest('input, textarea, select')) {
      mod?.escape?.();
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (Object.values(modules).some((m) => m.dirty?.())) e.preventDefault();
  });

  function setBadge(name, n) {
    const el = $(`[data-badge="${name}"]`);
    if (!el) return;
    el.textContent = n ? String(n) : '';
    el.hidden = !n;
  }

  /* Zonas: las de la página (nombre, color, orden) también tiñen la curaduría y arman las fichas de zona de Piezas. */
  function applyZones(site) {
    const zones = (site?.zonas?.items ?? []).filter((z) => z?.key && z.label);
    let tag = $('#dz-zones');
    if (!tag) {
      tag = document.createElement('style');
      tag.id = 'dz-zones';
      document.head.append(tag);
    }
    tag.textContent = zones.filter((z) => HEX_RE.test(z.color ?? '')).map((z) => `[data-zone="${z.key}"]{--tone:${z.color}}`).join('\n');
    window.dispatchEvent(new CustomEvent('dz:zones', { detail: zones }));
  }

  /* ---------- Estado de guardado en la barra de cada editor ---------- */
  function stateLine(el) {
    return (text, kind = '') => {
      el.textContent = text;
      if (kind) el.dataset.state = kind;
      else delete el.dataset.state;
    };
  }
  /** Doble clic para confirmar acciones destructivas (el botón cambia de texto durante 4 s). */
  function confirmClick(btn, label) {
    if (Number(btn.dataset.armedUntil) > Date.now()) return true;
    const original = btn.dataset.label ?? btn.textContent;
    btn.dataset.label = original;
    btn.dataset.armedUntil = String(Date.now() + 4000);
    btn.textContent = label;
    btn.classList.add('is-armed');
    setTimeout(() => {
      if (!btn.isConnected) return;
      btn.textContent = btn.dataset.label;
      btn.classList.remove('is-armed');
      delete btn.dataset.armedUntil;
    }, 4000);
    return false;
  }

  /* =====================================================================
     Página: formulario armado desde el esquema del servidor + vista previa en vivo
     ===================================================================== */
  modules.pagina = (() => {
    const root = $('#v-pagina');
    const form = $('#pg-form');
    const toc = $('#pg-toc');
    const frame = $('#pg-iframe');
    const frameBox = $('#pg-frame');
    const say = stateLine($('#pg-state'));
    const pg = { schema: null, defaults: null, saved: null, draft: null, updatedAt: null, saving: false, loading: null };
    let frameReady = false;
    let previewTimer = 0;
    let focus = '#top';
    let device = 'desktop';

    const get = (obj, path) => path.reduce((o, k) => (o == null ? undefined : o[k]), obj);
    function set(obj, path, value) {
      const parent = get(obj, path.slice(0, -1));
      if (parent != null) parent[path[path.length - 1]] = value;
    }
    const specAt = (path) => path.reduce((spec, key) => (spec.type === 'list' ? spec.item : spec.fields[key]), pg.schema);
    const dirty = () => Boolean(pg.draft) && JSON.stringify(pg.draft) !== JSON.stringify(pg.saved);

    function blank(spec) {
      switch (spec.type) {
        case 'group': return Object.fromEntries(Object.entries(spec.fields).map(([key, sub]) => [key, blank(sub)]));
        case 'list': return [];
        case 'url': return '#';
        case 'color': return '#ffffff';
        case 'int': return spec.min;
        default: return '';
      }
    }

    /* ---------- Formulario ---------- */
    function fieldsHtml(spec, path) {
      return Object.entries(spec.fields).map(([key, sub]) => fieldHtml(sub, [...path, key])).join('');
    }

    function fieldHtml(spec, path, labelOverride) {
      const p = path.join('.');
      const label = esc(labelOverride ?? spec.label);
      const value = get(pg.draft, path);
      const hint = spec.hint ? `<small class="fld__hint mono">${esc(spec.hint)}</small>` : '';
      switch (spec.type) {
        case 'text': {
          const wide = spec.multiline || spec.max > 60 ? ' fld--wide' : '';
          const input = spec.multiline
            ? `<textarea data-path="${p}" rows="3" maxlength="${spec.max}">${esc(value)}</textarea>`
            : `<input type="text" data-path="${p}" maxlength="${spec.max}" value="${esc(value)}" autocomplete="off"${spec.pattern
              ? ` data-pattern="${esc(spec.pattern)}" data-pattern-msg="${esc(spec.patternMsg)}" spellcheck="false"` : ''}${spec.hoursOrder ? ' data-hours' : ''}>`;
          return `<label class="fld${wide}"><span>${label} · <b data-count-for="${p}">${String(value ?? '').length}</b>/${spec.max}</span>${input}${hint}</label>`;
        }
        case 'url':
          return `<label class="fld"><span>${label}</span><input class="mono" type="text" data-path="${p}" data-url maxlength="${spec.max}" value="${esc(value)}" placeholder="https://… · #seccion · /pagina" spellcheck="false" autocomplete="off">${hint}</label>`;
        case 'color':
          return `<div class="fld"><span class="fld__label">${label}</span><span class="clr" style="--sw:${esc(value)}"><input type="color" data-path="${p}" value="${esc(value)}" aria-label="${label}"><input class="mono" type="text" data-hex-for="${p}" value="${esc(value)}" maxlength="7" spellcheck="false" autocomplete="off" aria-label="${label} en hex"></span></div>`;
        case 'int':
          return `<label class="fld fld--int"><span>${label}</span><input type="number" data-path="${p}" data-int min="${spec.min}" max="${spec.max}" step="1" inputmode="numeric" value="${esc(value)}"></label>`;
        case 'group': {
          const title = path.length > 1 ? `<span class="fld__label sub__title">${label}</span>` : '';
          return `<div class="fld fld--wide sub${spec.inline ? ' sub--inline' : ''}">${title}<div class="sub__grid">${fieldsHtml(spec, path)}</div></div>`;
        }
        case 'list':
          return listHtml(spec, path, Array.isArray(value) ? value : []);
        default:
          return '';
      }
    }

    function listHtml(spec, path, items) {
      const p = path.join('.');
      const fixed = spec.min === spec.max;
      const head = `<span class="fld__label">${esc(spec.label)}</span>${spec.hint ? `<small class="fld__hint mono">${esc(spec.hint)}</small>` : ''}`;
      if (spec.item.type !== 'group') {
        const fields = items.map((_, i) => fieldHtml(spec.item, [...path, String(i)], `${spec.itemLabel} ${i + 1}`)).join('');
        return `<div class="fld fld--wide lst">${head}<div class="sub__grid">${fields}</div></div>`;
      }
      const rows = items.map((_, i) => {
        const tools = fixed ? '' : `
          <span class="lst__tools">
            <button type="button" data-move="${p}" data-i="${i}" data-step="-1" aria-label="Subir ${esc(spec.itemLabel)} ${i + 1}"${i === 0 ? ' disabled' : ''}>↑</button>
            <button type="button" data-move="${p}" data-i="${i}" data-step="1" aria-label="Bajar ${esc(spec.itemLabel)} ${i + 1}"${i === items.length - 1 ? ' disabled' : ''}>↓</button>
            <button type="button" data-remove="${p}" data-i="${i}" aria-label="Quitar ${esc(spec.itemLabel)} ${i + 1}"${items.length <= spec.min ? ' disabled' : ''}>×</button>
          </span>`;
        // cada zona se tiñe con su color (cambia en vivo al elegirlo)
        const color = p === 'zonas.items' ? get(pg.draft, [...path, String(i), 'color']) : null;
        const tint = HEX_RE.test(color ?? '') ? ` style="--tone:${color}"` : '';
        return `<li class="lst__item"${tint}><div class="lst__head mono"><span>${esc(spec.itemLabel)} ${pad(i + 1)}</span>${tools}</div><div class="sub__grid">${fieldsHtml(spec.item, [...path, String(i)])}</div></li>`;
      }).join('');
      const add = fixed ? '' : `<button class="btn btn--ghost lst__add" type="button" data-add="${p}"${items.length >= spec.max ? ' disabled' : ''}>+ ${esc(spec.itemLabel)}</button>`;
      return `<div class="fld fld--wide lst${fixed ? ' lst--fixed' : ''}">${head}<ol class="lst__items">${rows}</ol>${add}</div>`;
    }

    function render() {
      const sections = Object.entries(pg.schema.fields);
      toc.innerHTML = sections
        .map(([key, spec], i) => `<a href="#pg-${key}" data-jump="${key}"><span class="mono">${pad(i + 1)}</span>${esc(spec.label)}</a>`)
        .join('');
      const scroll = window.scrollY;
      form.innerHTML = sections.map(([key, spec], i) => `
        <fieldset class="fs pg__sec" id="pg-${key}" data-anchor="${esc(spec.anchor ?? '#top')}">
          <legend><span class="mono">${pad(i + 1)}</span>${esc(spec.label)}</legend>
          ${spec.hint ? `<p class="fld__hint mono pg__hint">${esc(spec.hint)}</p>` : ''}
          <div class="fs__grid">${fieldsHtml(spec, [key])}</div>
          <p class="pg__restore"><button class="link mono" type="button" data-restore="${key}">Restaurar los textos originales de «${esc(spec.label)}»</button></p>
        </fieldset>`).join('');
      window.scrollTo(0, scroll);
      spy.disconnect();
      sections.forEach(([key]) => spy.observe($(`#pg-${key}`)));
      refreshState();
    }

    function refreshState() {
      $('#pg-discard').disabled = !dirty();
      if (pg.saving) return;
      if (dirty()) say('● cambios sin guardar', 'dirty');
      else if ($('#pg-state').dataset.state === 'dirty') say('');
    }

    function commit(el, value) {
      set(pg.draft, el.dataset.path.split('.'), value);
      if (el.type === 'color') {
        el.closest('.clr')?.style.setProperty('--sw', value);
        el.closest('.lst__item')?.style.setProperty('--tone', value);
      }
      refreshState();
      schedulePreview();
    }

    form.addEventListener('input', (e) => {
      const el = e.target;
      if (el.dataset.hexFor) {
        const hex = el.value.trim().toLowerCase();
        if (!HEX_RE.test(hex)) return;
        const picker = form.querySelector(`[data-path="${el.dataset.hexFor}"]`);
        picker.value = hex;
        commit(picker, hex);
        return;
      }
      if (!el.dataset.path) return;
      let { value } = el;
      if (el.hasAttribute('data-int')) value = /^\d+$/.test(value) ? Number(value) : value;
      if (el.type === 'color') {
        const hexInput = form.querySelector(`[data-hex-for="${el.dataset.path}"]`);
        if (hexInput) hexInput.value = value;
      }
      const counter = form.querySelector(`[data-count-for="${el.dataset.path}"]`);
      if (counter) counter.textContent = String(el.value.length);
      el.removeAttribute('aria-invalid');
      commit(el, value);
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      save();
    });

    form.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-add], button[data-remove], button[data-move], button[data-restore]');
      if (!btn || !pg.draft) return;
      let focusPath = null;
      if (btn.dataset.restore) {
        const key = btn.dataset.restore;
        pg.draft[key] = clone(pg.defaults[key]);
        notify(`«${pg.schema.fields[key].label}» volvió a los textos originales. Guarda para publicarlo.`, { tag: 'orig' });
      } else {
        const p = btn.dataset.add ?? btn.dataset.remove ?? btn.dataset.move;
        const path = p.split('.');
        const list = get(pg.draft, path);
        const i = Number(btn.dataset.i);
        if (btn.dataset.add) {
          list.push(blank(specAt(path).item));
          focusPath = `${p}.${list.length - 1}.`;
        } else if (btn.dataset.remove) {
          list.splice(i, 1);
        } else {
          const j = i + Number(btn.dataset.step);
          [list[i], list[j]] = [list[j], list[i]];
        }
      }
      render();
      schedulePreview();
      if (focusPath) form.querySelector(`[data-path^="${focusPath}"]`)?.focus();
    });

    /* ---------- Índice de secciones y vista previa ---------- */
    function setFocus(anchor, sectionId) {
      $$('a', toc).forEach((a) => a.classList.toggle('is-on', `pg-${a.dataset.jump}` === sectionId));
      if (anchor === focus) return;
      focus = anchor;
      schedulePreview();
    }
    const spy = new IntersectionObserver((entries) => {
      const hit = entries.filter((en) => en.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (hit && root.contains(document.activeElement) === false) setFocus(hit.target.dataset.anchor, hit.target.id);
      else if (hit) $$('a', toc).forEach((a) => a.classList.toggle('is-on', `pg-${a.dataset.jump}` === hit.target.id));
    }, { rootMargin: '-35% 0px -60% 0px' });

    form.addEventListener('focusin', (e) => {
      const section = e.target.closest('.pg__sec');
      if (section) setFocus(section.dataset.anchor, section.id);
    });
    toc.addEventListener('click', (e) => {
      const a = e.target.closest('[data-jump]');
      if (!a) return;
      e.preventDefault();
      const section = $(`#pg-${a.dataset.jump}`);
      section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setFocus(section.dataset.anchor, section.id);
    });

    window.addEventListener('message', (e) => {
      if (e.origin !== window.location.origin || e.source !== frame.contentWindow || e.data?.type !== 'dz:preview-ready') return;
      frameReady = true;
      postPreview();
    });
    function postPreview() {
      if (!frameReady || !pg.draft) return;
      frame.contentWindow?.postMessage({ type: 'dz:site', site: pg.draft, focus }, window.location.origin);
    }
    function schedulePreview() {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(postPreview, 150);
    }

    /* La tienda se dibuja a su tamaño real (1280 o 390 px) y se escala para caber en el panel. */
    function fit() {
      const w = frameBox.clientWidth;
      const h = frameBox.clientHeight;
      if (!w || !h) return;
      const base = device === 'mobile' ? 390 : 1280;
      const scale = Math.min(1, w / base);
      frame.style.width = `${base}px`;
      frame.style.height = `${Math.round(h / scale)}px`;
      frame.style.transform = `translateX(${Math.max(0, Math.round((w - base * scale) / 2))}px) scale(${scale})`;
    }
    new ResizeObserver(fit).observe(frameBox);
    $$('[data-device]', root).forEach((btn) => btn.addEventListener('click', () => {
      device = btn.dataset.device;
      $$('[data-device]', root).forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      fit();
    }));
    $$('[data-preview-toggle]', root).forEach((btn) => btn.addEventListener('click', () => {
      const on = !root.classList.contains('is-previewing');
      root.classList.toggle('is-previewing', on);
      $('#pg-preview-btn').setAttribute('aria-pressed', String(on));
      requestAnimationFrame(fit);
    }));

    /* ---------- Guardar ---------- */
    function validate() {
      for (const el of $$('[data-path]', form)) {
        if (el.type === 'color') continue;
        const v = el.value.trim();
        let problem = '';
        if (el.hasAttribute('data-int')) {
          if (!/^\d+$/.test(v) || Number(v) < Number(el.min) || Number(v) > Number(el.max)) problem = `debe ser un entero entre ${el.min} y ${el.max}`;
        } else if (!v) {
          problem = 'no puede quedar vacío';
        } else if (el.hasAttribute('data-url') && !URL_RE.test(v)) {
          problem = 'no es un enlace válido (https://…, mailto:, tel:, #seccion o /pagina)';
        } else if (el.dataset.pattern && !new RegExp(el.dataset.pattern).test(v.replace(/\s+/g, ' '))) {
          problem = el.dataset.patternMsg;
        } else if (el.hasAttribute('data-hours') && !/^cerrado$/i.test(v)) {
          // igual que hoursOrder en lib/site.js: «10:00-6:00» sería abrir toda la noche
          const [open, close] = v.split(/ ?[-–] ?/).map((t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; });
          if (close <= open) problem = 'cierra antes de abrir: usa formato 24 h (ej. 10:00-18:00; las 6 de la tarde son 18:00)';
        }
        if (problem) {
          el.setAttribute('aria-invalid', 'true');
          el.focus();
          el.scrollIntoView({ block: 'center' });
          const field = el.closest('.fld')?.querySelector('span')?.textContent.split(' · ')[0] ?? 'Un campo';
          const section = el.closest('.pg__sec')?.querySelector('legend')?.textContent.replace(/^\d+/, '') ?? '';
          return `${section} › ${field}: ${problem}.`;
        }
      }
      return null;
    }

    async function save() {
      if (!pg.draft || pg.saving) return;
      if (!dirty()) {
        say('Sin cambios que guardar.', 'ok');
        return;
      }
      const problem = validate();
      if (problem) {
        say(problem, 'error');
        notify(problem, { tone: 'error' });
        return;
      }
      pg.saving = true;
      $('#pg-save').disabled = true;
      say('> guardando…');
      try {
        const data = await api('/api/admin/site', { method: 'PUT', body: { site: pg.draft, updatedAt: pg.updatedAt } });
        pg.saved = data.site;
        pg.draft = clone(data.site);
        pg.updatedAt = data.updatedAt;
        pg.saving = false;
        render();
        applyZones(data.site);
        postPreview();
        $('#pg-meta').textContent = `Última edición ${fmtDate(data.updatedAt)}`;
        say(`Guardada ${fmtDate(data.updatedAt)} · en la tienda en ≤ 1 min`, 'ok');
        notify('Página guardada.', { tag: 'ok' });
      } catch (err) {
        say(err.message, 'error');
        notify(err.message, { tone: 'error' });
      } finally {
        pg.saving = false;
        $('#pg-save').disabled = false;
      }
    }
    $('#pg-save').addEventListener('click', save);
    $('#pg-discard').addEventListener('click', () => {
      if (!dirty() || !window.confirm('¿Descartar todos los cambios sin guardar de la página?')) return;
      pg.draft = clone(pg.saved);
      render();
      postPreview();
      say('Cambios descartados.');
    });

    async function load() {
      const data = await api('/api/admin/site');
      pg.schema = data.schema;
      pg.defaults = data.defaults;
      pg.saved = data.site;
      pg.draft = clone(data.site);
      pg.updatedAt = data.updatedAt;
      applyZones(data.site);
      render();
      postPreview();
      $('#pg-meta').textContent = data.updatedAt ? `Última edición ${fmtDate(data.updatedAt)}` : 'Con los textos originales';
    }

    function preload() {
      pg.loading ??= load().catch((err) => {
        pg.loading = null;
        form.innerHTML = `<p class="list-status mono" data-state="error">&gt; error: ${esc(err.message)}</p>`;
      });
      return pg.loading;
    }

    return {
      preload,
      enter() {
        preload();
        if (!frame.getAttribute('src')) {
          frameReady = false;
          frame.src = '/?preview=1';
        }
        requestAnimationFrame(fit);
      },
      save,
      dirty,
    };
  })();
  /* =====================================================================
     Colecciones con lista + editor: Drops
     ===================================================================== */
  function collection(cfg) {
    const { root } = cfg;
    const byName = Object.fromEntries(cfg.fields.map((f) => [f.name, f]));

    function fieldHtml(f) {
      const wide = f.wide ? ' fld--wide' : '';
      const hint = f.hint ? `<small class="fld__hint mono">${esc(f.hint)}</small>` : '';
      const ph = f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : '';
      switch (f.type) {
        case 'int':
        case 'intOptional':
          return `<label class="fld${wide}"><span>${esc(f.label)}</span><input name="${f.name}" type="number" min="${f.min}" max="${f.max}" step="1" inputmode="numeric"${ph}>${hint}</label>`;
        case 'datetime':
          return `<label class="fld${wide}"><span>${esc(f.label)}</span><input name="${f.name}" type="datetime-local">${hint}</label>`;
        case 'select':
          return `<label class="fld${wide}"><span>${esc(f.label)}</span><select name="${f.name}"></select>${hint}</label>`;
        case 'money':
          return `<label class="fld${wide}"><span>${esc(f.label)}</span><span class="money"><i>$</i><input name="${f.name}" type="text" inputmode="decimal" placeholder="59.900" autocomplete="off"></span>${hint}</label>`;
        // varias piezas del catálogo (casillas) con un filtro; el valor es la lista de slugs marcados
        case 'picks':
          return `
            <div class="fld${wide} picks" data-picks="${f.name}" role="group" aria-label="${esc(f.label)}">
              <span class="fld__label">${esc(f.label)}</span>
              <input class="picks__filter" type="text" placeholder="Filtrar por nombre o SKU" aria-label="Filtrar piezas" autocomplete="off">
              <ul class="picks__list" role="list"></ul>
              <p class="picks__sum mono" data-picks-sum></p>
            </div>`;
        case 'toggle':
          return `<label class="toggle fld--wide"><input name="${f.name}" type="checkbox"><span class="toggle__ui" aria-hidden="true"></span><span>${esc(f.label)}</span></label>${f.hint ? `<p class="fld__hint fld--wide mono">${esc(f.hint)}</p>` : ''}`;
        case 'url':
          return `<label class="fld${wide}"><span>${esc(f.label)}</span><input class="mono" name="${f.name}" type="text" maxlength="300" spellcheck="false" autocomplete="off"${ph}>${hint}</label>`;
        default:
          return `<label class="fld${wide}"><span>${esc(f.label)}</span><input${f.big ? ' class="fld__big"' : ''} name="${f.name}" type="text" maxlength="${f.max}" autocomplete="off"${ph}>${hint}</label>`;
      }
    }

    root.innerHTML = `
      <aside class="cur__side" aria-label="${esc(cfg.title)}">
        <header class="cur__head">
          <h1 class="cur__title">${esc(cfg.title)}<sup class="mono" data-total>—</sup></h1>
          <button class="btn cur__new" type="button" data-new>+ ${esc(cfg.newShort)}</button>
        </header>
        <p class="cur__intro mono">${esc(cfg.intro)}</p>
        <ol class="cur__list" data-list></ol>
        <p class="list-status mono muted" data-status role="status">&gt; cargando<span class="cursor" aria-hidden="true"></span></p>
      </aside>
      <section class="cur__main" aria-label="Editor">
        <div class="cur__empty" data-empty>
          <p class="mono muted">Nada abierto</p>
          <h2 class="cur__empty-title">${cfg.emptyTitle}</h2>
          <p class="mono muted">Atajos: <kbd>${SAVE_KEY}</kbd> guardar · <kbd>Esc</kbd> cerrar</p>
        </div>
        <form class="ed" data-form novalidate hidden>
          <header class="ed__bar">
            <button class="ed__back mono" type="button" data-back>← ${esc(cfg.title)}</button>
            <div class="ed__id"><p class="mono" data-kicker>—</p><p class="ed__name" data-name>—</p></div>
            <p class="ed__state mono" data-state role="status" aria-live="polite"></p>
            <div class="ed__actions">
              <button class="btn btn--ghost" type="button" data-discard>Descartar</button>
              <button class="btn" type="submit" data-save>Guardar <kbd>${SAVE_KEY}</kbd></button>
            </div>
          </header>
          <div class="ed__body">
            <div class="ed__form">
              ${cfg.sections.map((sec, i) => `
                <fieldset class="fs">
                  <legend><span class="mono">${pad(i + 1)}</span>${esc(sec.title)}</legend>
                  <div class="fs__grid">${sec.fields.map((name) => fieldHtml(byName[name])).join('')}</div>
                </fieldset>`).join('')}
              <div class="danger"><button class="btn btn--danger" type="button" data-delete>Eliminar</button></div>
            </div>
            <aside class="pv" aria-label="Vista previa"><p class="pv__kicker mono">Así se ve en la tienda</p><div data-preview></div></aside>
          </div>
        </form>
      </section>`;

    const listEl = $('[data-list]', root);
    const statusEl = $('[data-status]', root);
    const form = $('[data-form]', root);
    const F = form.elements;
    const stateEl = $('[data-state]', root);
    const say = stateLine(stateEl);
    const saveBtn = $('[data-save]', root);
    const deleteBtn = $('[data-delete]', root);
    const st = { items: [], current: null, open: false, snapshot: '', saving: false };

    function readForm() {
      const out = {};
      cfg.fields.forEach((f) => {
        const el = F[f.name];
        if (f.type === 'picks') out[f.name] = $$(`input[name="${f.name}"]:checked`, form).map((box) => box.value);
        else if (f.type === 'money') out[f.name] = parseMoney(el.value);
        else if (f.type === 'toggle') out[f.name] = el.checked;
        else if (f.type === 'int') out[f.name] = el.value === '' ? NaN : Number(el.value);
        else if (f.type === 'intOptional') out[f.name] = el.value === '' ? null : Number(el.value);
        else if (f.type === 'datetime') out[f.name] = fromLocalInput(el.value);
        else out[f.name] = el.value.trim();
      });
      return out;
    }

    function fillForm(item) {
      cfg.fields.forEach((f) => {
        const v = item[f.name];
        if (f.type === 'picks') {
          const box = $(`[data-picks="${f.name}"]`, root);
          const chosen = new Set(Array.isArray(v) ? v : []);
          const opts = cfg.options[f.name]();
          const gone = [...chosen].filter((s) => !opts.some((o) => o.value === s)).map((s) => ({ value: s, name: s, meta: 'ya no existe', zone: '' }));
          $('.picks__list', box).innerHTML = [...gone, ...opts].map((o) => `
            <li data-zone="${esc(o.zone)}">
              <label class="picks__opt"><input type="checkbox" name="${f.name}" value="${esc(o.value)}"${chosen.has(o.value) ? ' checked' : ''}>
                <span class="picks__name">${esc(o.name)}</span><span class="picks__meta mono">${esc(o.meta)}</span></label>
            </li>`).join('');
          $('.picks__filter', box).value = '';
          box.removeAttribute('aria-invalid');
          return;
        }
        const el = F[f.name];
        if (f.type === 'select') {
          el.innerHTML = cfg.options[f.name]().map(([value, text]) => `<option value="${esc(value)}">${esc(text)}</option>`).join('');
          if (v && !Array.from(el.options).some((o) => o.value === v)) el.insertAdjacentHTML('beforeend', `<option value="${esc(v)}">${esc(v)} (ya no existe)</option>`);
        }
        if (f.type === 'money') el.value = Number.isFinite(v) ? (v % 100 === 0 ? String(v / 100) : (v / 100).toFixed(2)) : '';
        else if (f.type === 'toggle') el.checked = Boolean(v);
        else if (f.type === 'datetime') el.value = toLocalInput(v);
        else el.value = v ?? '';
        el.removeAttribute('aria-invalid');
      });
    }

    const isDirty = () => st.open && JSON.stringify(readForm()) !== st.snapshot;
    const snap = () => { st.snapshot = JSON.stringify(readForm()); };
    const confirmLeave = () => !isDirty() || window.confirm('Tienes cambios sin guardar. ¿Descartarlos?');

    function renderList() {
      listEl.innerHTML = st.items.map((item) => cfg.itemHtml(item, st.open && st.current?._id === item._id)).join('');
      $('[data-total]', root).textContent = pad(st.items.length);
      statusEl.hidden = st.items.length > 0;
      if (!st.items.length) {
        delete statusEl.dataset.state;
        statusEl.innerHTML = `&gt; ${esc(cfg.emptyList)}`;
      }
    }

    function refresh() {
      const data = readForm();
      $('[data-kicker]', root).textContent = cfg.kicker(data, Boolean(st.current));
      $('[data-name]', root).textContent = cfg.name(data) || 'Sin título';
      $('[data-preview]', root).innerHTML = cfg.preview(data, st.current);
      cfg.onRefresh?.(data);
      deleteBtn.textContent = st.current ? `Eliminar ${cfg.singular}` : 'Descartar borrador';
      deleteBtn.dataset.label = deleteBtn.textContent;
      delete deleteBtn.dataset.armedUntil; // editar desarma el borrado pendiente
      deleteBtn.classList.remove('is-armed');
      if (st.open && !st.saving) {
        if (isDirty()) say('● cambios sin guardar', 'dirty');
        else if (stateEl.dataset.state === 'dirty') say('');
      }
    }

    function showEditor() {
      st.open = true;
      form.hidden = false;
      $('[data-empty]', root).hidden = true;
      root.classList.add('is-editing');
    }
    function closeEditor() {
      st.open = false;
      st.current = null;
      form.hidden = true;
      $('[data-empty]', root).hidden = false;
      root.classList.remove('is-editing');
      renderList();
    }
    function openItem(item) {
      st.current = item;
      fillForm(item);
      showEditor();
      snap();
      refresh();
      renderList();
      say('');
      if (!window.matchMedia('(min-width: 1024px)').matches) window.scrollTo({ top: 0 });
    }
    function openNew() {
      st.current = null;
      fillForm(cfg.blank(st.items));
      showEditor();
      snap();
      st.snapshot = ''; // un borrador nuevo nace con cambios pendientes
      refresh();
      renderList();
      say(`${cfg.newLabel} sin guardar.`, 'dirty');
      form.querySelector('input, select')?.focus();
    }

    async function load() {
      try {
        if (cfg.beforeLoad) await cfg.beforeLoad();
        const data = await api(cfg.endpoint);
        cfg.onLoad?.(data);
        st.items = data[cfg.listKey].sort(cfg.sort);
        renderList();
        if (st.open && st.current) {
          const fresh = st.items.find((x) => x._id === st.current._id);
          if (fresh && !isDirty()) openItem(fresh);
        }
      } catch (err) {
        statusEl.hidden = false;
        statusEl.dataset.state = 'error';
        statusEl.textContent = `> error: ${err.message}`;
      }
    }

    async function save() {
      if (!st.open || st.saving) return;
      const data = readForm();
      const problem = cfg.validate(data);
      if (problem) {
        const [name, message] = problem;
        const picks = byName[name]?.type === 'picks' ? $(`[data-picks="${name}"]`, root) : null;
        (picks ?? F[name])?.setAttribute('aria-invalid', 'true');
        (picks ? $('.picks__filter', picks) : F[name])?.focus();
        say(message, 'error');
        notify(message, { tone: 'error' });
        return;
      }
      const isNew = !st.current;
      if (!isNew && !isDirty()) {
        say('Sin cambios que guardar.', 'ok');
        return;
      }
      st.saving = true;
      saveBtn.disabled = true;
      say('> guardando…');
      try {
        const res = await api(isNew ? cfg.endpoint : `${cfg.endpoint}?id=${st.current._id}`, {
          method: isNew ? 'POST' : 'PUT',
          body: isNew ? data : { ...data, updatedAt: st.current.updatedAt },
        });
        const item = res[cfg.itemKey];
        const i = st.items.findIndex((x) => x._id === item._id);
        if (i >= 0) st.items[i] = item;
        else st.items.push(item);
        st.items.sort(cfg.sort);
        st.current = item;
        fillForm(item);
        snap();
        st.saving = false;
        refresh();
        renderList();
        say(`Guardado ${fmtDate(item.updatedAt)} · en la tienda en segundos`, 'ok');
        notify(`${cfg.name(item)} · ${isNew ? 'creado' : 'guardado'}.`, { tag: isNew ? 'nuevo' : 'ok' });
        cfg.onSaved?.(item);
      } catch (err) {
        say(err.message, 'error');
        notify(err.message, { tone: 'error' });
      } finally {
        st.saving = false;
        saveBtn.disabled = false;
      }
    }

    form.addEventListener('input', (e) => {
      if (e.target.matches('.picks__filter')) {
        const q = e.target.value.trim().toLowerCase();
        $$('li', e.target.closest('[data-picks]')).forEach((li) => { li.hidden = Boolean(q) && !li.textContent.toLowerCase().includes(q); });
        return;
      }
      e.target.removeAttribute('aria-invalid');
      e.target.closest('[data-picks]')?.removeAttribute('aria-invalid');
      refresh();
    });
    form.addEventListener('change', refresh);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      save();
    });
    listEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-open]');
      const item = btn && st.items.find((x) => x._id === btn.dataset.open);
      if (item && confirmLeave()) openItem(item);
    });
    $('[data-new]', root).addEventListener('click', () => { if (confirmLeave()) openNew(); });
    $('[data-back]', root).addEventListener('click', () => { if (confirmLeave()) closeEditor(); });
    $('[data-discard]', root).addEventListener('click', () => {
      if (!confirmLeave()) return;
      if (st.current) openItem(st.current);
      else closeEditor();
    });
    deleteBtn.addEventListener('click', async () => {
      if (!st.current) {
        closeEditor();
        return;
      }
      if (!confirmClick(deleteBtn, '¿Seguro? Clic otra vez para borrar')) return;
      const { _id } = st.current;
      const name = cfg.name(st.current);
      try {
        const { carts } = await api(`${cfg.endpoint}?id=${_id}`, { method: 'DELETE', body: {} });
        st.items = st.items.filter((x) => x._id !== _id);
        closeEditor();
        notify(`${name} · eliminado${carts ? ` (salió de ${carts} ${carts === 1 ? 'carrito' : 'carritos'})` : ''}.`, { tag: 'baja' });
      } catch (err) {
        say(err.message, 'error');
        notify(err.message, { tone: 'error' });
      }
    });

    /** Botones dentro de la vista previa (p. ej. «Avisar ahora» de un drop): reciben lo guardado y cómo actualizarlo. */
    root.addEventListener('click', (e) => {
      if (!cfg.onPreviewClick || !e.target.closest('[data-preview]')) return;
      cfg.onPreviewClick(e, st.current, (item) => {
        const i = st.items.findIndex((x) => x._id === item._id);
        if (i >= 0) st.items[i] = item;
        if (st.current?._id === item._id) st.current = item; // sin tocar el formulario: no se pierde lo que se está editando
        refresh();
        renderList();
      });
    });

    return {
      enter: load,
      save,
      dirty: isDirty,
      escape() { if (st.open && confirmLeave()) closeEditor(); },
    };
  }

  /* ---------- Drops: bundles de piezas del catálogo con precio rebajado ---------- */
  let products = [];
  const DROP_MIN = 2; // igual que DROP_ITEMS en lib/catalog.js
  const DROP_MAX = 6;
  const inDays = (days, hour) => {
    const d = new Date(Date.now() + days * 86400000);
    d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  };
  function dropStatus(d) {
    if (!d.active) return { key: 'paused', label: 'Pausado' };
    if (Date.parse(d.endsAt) <= Date.now()) return { key: 'closed', label: 'Cerrado' };
    return { key: 'live', label: 'En vivo' };
  }
  const pieceOf = (slug) => products.find((p) => p.slug === slug);
  let newsletter = { mail: false, subscribers: 0 }; // GET /api/admin/drops: ¿hay SMTP? ¿cuántos suscriptores?

  /** El aviso por correo de un drop a la lista: qué pasará al guardarlo, cómo va o cuándo salió. */
  function announceHtml(d, saved) {
    const a = saved?.announce;
    const n = newsletter.subscribers;
    const people = `${n} ${n === 1 ? 'suscriptor' : 'suscriptores'}`;
    const open = d.active && d.endsAt && Date.parse(d.endsAt) > Date.now();
    let text;
    let action = '';
    if (a?.running) {
      text = `Avisando por correo… ${a.sent} enviados, faltan ${a.left}.`;
      action = '<button class="link mono" type="button" data-announce-check>Ver avance</button>';
    } else if (a?.finishedAt) {
      text = `Avisado por correo el ${fmtDate(a.finishedAt)} a ${a.sent} ${a.sent === 1 ? 'suscriptor' : 'suscriptores'}.`;
    } else if (a) {
      text = `Aviso incompleto: ${a.sent} enviados, faltan ${a.left}${a.failed ? ` (${a.failed} fallaron)` : ''}.`;
      action = newsletter.mail ? '<button class="link mono" type="button" data-announce>Reanudar aviso</button>' : '';
    } else if (!newsletter.mail) {
      text = `Aviso por correo apagado: falta configurar el SMTP para avisar a ${people}.`;
    } else if (!n) {
      text = 'Aún no hay suscriptores: no hay a quién avisar.';
    } else if (!d.notify) {
      const live = saved && saved.active && Date.parse(saved.endsAt) > Date.now();
      text = `Sin aviso por correo: lo apagaste. ${live ? `Si cambias de idea, avisa a ${people}:` : `Al guardarlo no le llega nada a ${people}.`}`;
      if (live && saved.notify === false) action = '<button class="link mono" type="button" data-announce>Avisar ahora</button>';
    } else if (saved && saved.active && Date.parse(saved.endsAt) > Date.now()) {
      text = `Aún sin avisar a ${people}.`;
      action = '<button class="link mono" type="button" data-announce>Avisar ahora</button>';
    } else {
      text = open ? `Al guardarlo se avisa por correo a ${people}.` : `Cuando lo guardes activo, se avisa por correo a ${people}.`;
    }
    return `<p class="mono pv-drop__note pv-drop__mail" data-status="${a?.finishedAt ? 'live' : a ? 'paused' : 'mail'}">✉ ${esc(text)} ${action}</p>`;
  }
  /** Lo que cuestan hoy las piezas elegidas por separado: el precio del drop tiene que quedar por debajo. */
  const regularOf = (items) => items.reduce((sum, s) => sum + (pieceOf(s)?.priceCents ?? 0), 0);
  /** Cuántos drops alcanzan: la pieza con menos existencias manda (4, 5 y 6 → 4); `low`, esa pieza. */
  function availableOf(items) {
    const pieces = items.map(pieceOf);
    if (!pieces.length) return { left: 0, low: null };
    const low = pieces.reduce((a, b) => ((b?.stock ?? 0) < (a?.stock ?? 0) ? b : a));
    return { left: Math.max(0, low?.stock ?? 0), low };
  }

  modules.drops = collection({
    root: $('#v-drops'),
    title: 'Drops',
    singular: 'drop',
    newShort: 'Nuevo',
    newLabel: 'Drop nuevo',
    endpoint: '/api/admin/drops',
    listKey: 'drops',
    itemKey: 'drop',
    intro: `Bundles: junta de ${DROP_MIN} a ${DROP_MAX} piezas del catálogo y ponles un precio menor que la suma. Alcanzan los que permita la pieza con menos existencias, y cada drop vendido descuenta una de cada pieza.`,
    emptyTitle: 'Elige un drop o arma uno <em class="echo" data-text="nuevo">nuevo</em>.',
    emptyList: 'aún no hay drops. Arma el primero.',
    async beforeLoad() {
      ({ products } = await api('/api/admin/products'));
    },
    onLoad(data) {
      newsletter = data.newsletter ?? newsletter;
    },
    onSaved(drop) {
      if (drop.announce?.running && !drop.announce.sent) notify(`Avisando del drop por correo a ${drop.announce.left} suscriptores.`, { tag: 'ok' });
    },
    async onPreviewClick(e, saved, put) {
      const btn = e.target.closest('[data-announce], [data-announce-check]');
      if (!btn || !saved) return;
      btn.disabled = true;
      try {
        if (btn.matches('[data-announce]')) {
          const { drop } = await api(`/api/admin/drops?announce=${saved._id}`, { method: 'POST', body: {} });
          put(drop);
          notify(`Avisando del drop por correo a ${drop.announce.left} suscriptores.`, { tag: 'ok' });
        } else {
          const data = await api('/api/admin/drops');
          newsletter = data.newsletter ?? newsletter;
          const fresh = data.drops.find((x) => x._id === saved._id);
          if (fresh) put(fresh);
        }
      } catch (err) {
        notify(err.message, { tone: 'error' });
        btn.disabled = false;
      }
    },
    sort: (a, b) => Date.parse(b.endsAt) - Date.parse(a.endsAt),
    sections: [
      { title: 'Nombre y número', fields: ['title', 'number', 'specs'] },
      { title: 'Piezas del bundle', fields: ['items'] },
      { title: 'Precio y cierre', fields: ['priceCents', 'endsAt', 'active'] },
      { title: 'Aviso por correo', fields: ['notify'] },
    ],
    fields: [
      { name: 'title', label: 'Nombre del drop', type: 'text', max: 60, wide: true, big: true, placeholder: 'Kit del piloto estelar' },
      { name: 'number', label: 'Número de drop', type: 'int', min: 1, max: 9999 },
      { name: 'specs', label: 'Descripción corta · opcional', type: 'text', max: 120, placeholder: 'Casco + figura · solo 50 kits' },
      { name: 'items', label: `Piezas · elige de ${DROP_MIN} a ${DROP_MAX}`, type: 'picks', wide: true },
      { name: 'priceCents', label: 'Precio del drop', type: 'money', hint: 'Menor que la suma de las piezas: es el ahorro que ve la tienda.' },
      { name: 'endsAt', label: 'Cierra', type: 'datetime', hint: 'No hay unidades aparte: alcanzan los drops que permitan las existencias de sus piezas (se editan en Piezas).' },
      { name: 'active', label: 'Activo: aparece en la tienda hasta que cierre', type: 'toggle' },
      {
        name: 'notify', label: 'Avisar por correo a los suscriptores', type: 'toggle', wide: true,
        hint: 'Encendido: al guardarlo activo y abierto le llega un correo a toda la lista, una sola vez. Apagado: no sale ningún correo; si cambias de idea, «Avisar ahora» lo envía.',
      },
    ],
    options: {
      items: () => products.map((p) => ({
        value: p.slug,
        name: p.name,
        meta: `${p.sku} · ${money(p.priceCents)}${p.status !== 'active' ? ' · no publicada' : ''}${p.stock > 0 ? '' : ' · agotada'}${p.sizes?.length ? ' · con tallas' : ''}`,
        zone: p.category,
      })),
    },
    blank: (items) => ({
      number: Math.max(0, ...items.map((d) => d.number)) + 1,
      title: '',
      specs: '',
      items: [],
      priceCents: NaN,
      endsAt: inDays(3, 20),
      active: true,
      notify: true,
    }),
    validate(d) {
      if (d.title.length < 2) return ['title', 'Ponle nombre al drop (ej. Kit del piloto estelar).'];
      if (!Number.isInteger(d.number) || d.number < 1 || d.number > 9999) return ['number', 'El número de drop va de 1 a 9999.'];
      if (d.items.length < DROP_MIN || d.items.length > DROP_MAX) return ['items', `Elige de ${DROP_MIN} a ${DROP_MAX} piezas para el bundle.`];
      const sized = d.items.map(pieceOf).find((p) => p?.sizes?.length);
      if (sized) return ['items', `«${sized.name}» va por tallas y aún no puede ir en un drop.`];
      if (!Number.isFinite(d.priceCents) || d.priceCents < 1) return ['priceCents', 'Precio inválido (ej. 59.900).'];
      const regular = regularOf(d.items);
      if (d.priceCents >= regular) return ['priceCents', `El precio del drop debe ser menor que la suma de sus piezas (${money(regular)}).`];

      if (!d.endsAt) return ['endsAt', 'Elige cuándo cierra el drop.'];
      return null;
    },
    /** Junto al selector: cuántas piezas van y cuánto suman. */
    onRefresh(d) {
      const sum = $('#v-drops [data-picks-sum]');
      if (!sum) return;
      const n = d.items.length;
      sum.textContent = n ? `${pad(n)} ${n === 1 ? 'pieza' : 'piezas'} · suman ${money(regularOf(d.items))}${n > DROP_MAX ? ` · máximo ${DROP_MAX}` : ''}` : 'Ninguna pieza elegida.';
    },
    kicker: (d, saved) => `${saved ? 'Drop' : 'Drop nuevo'} #${pad(Number.isInteger(d.number) ? d.number : 0, 3)}`,
    name: (d) => d.title || '',
    itemHtml(d, open) {
      const status = dropStatus(d);
      const { left } = availableOf(d.items);
      return `
        <li class="it it--drop${open ? ' is-open' : ''}">
          <button class="it__btn" type="button" data-open="${esc(d._id)}"${open ? ' aria-current="true"' : ''}>
            <span class="it__thumb it__num mono">#${pad(d.number, 3)}</span>
            <span class="it__main"><span class="it__name">${esc(d.title || 'Sin nombre')}</span><span class="it__meta mono">${pad(d.items.length)} piezas · ${money(d.priceCents)} · cierra ${esc(fmtDate(d.endsAt))}</span></span>
            <span class="it__status mono" data-status="${status.key}">${status.label}</span>
            <span class="it__side mono${left ? '' : ' is-out'}"><span>${left ? `quedan ${left}` : 'agotado'}</span></span>
          </button>
        </li>`;
    },
    preview(d, saved) {
      const pieces = d.items.map((s) => ({ slug: s, p: pieceOf(s) }));
      const regular = regularOf(d.items);
      const save = Number.isFinite(d.priceCents) && regular > d.priceCents ? regular - d.priceCents : 0;
      const status = dropStatus(d);
      const { left, low } = availableOf(d.items);
      const hidden = pieces.filter(({ p }) => !p || p.status !== 'active').map(({ p, slug }) => p?.name ?? slug);
      const soldOut = pieces.filter(({ p }) => p && p.status === 'active' && !(p.stock > 0)).map(({ p }) => p.name);
      const note = {
        live: 'En vivo: se ve en la sección Drops y en la ficha de cada una de sus piezas.',
        paused: 'Pausado: no aparece en la tienda.',
        closed: 'Ya cerró: no aparece en la tienda.',
      }[status.key];
      const list = pieces.length
        ? pieces.map(({ p, slug }) => `
            <li data-zone="${esc(p?.category ?? '')}"><span class="mono">${esc(p?.sku ?? '—')}</span><span>${esc(p?.name ?? `${slug} (ya no existe)`)}</span><span class="mono">${p ? money(p.priceCents) : ''}</span></li>`).join('')
        : '<li class="pv-drop__none mono">Elige las piezas del bundle</li>';
      return `
        <div class="pv-drop">
          <p class="pv-drop__head mono"><span>Drop #${pad(Number.isInteger(d.number) ? d.number : 0, 3)} · ${pad(d.items.length)} piezas</span><span>cierra en <b>${d.endsAt ? remaining(d.endsAt) : '—'}</b></span></p>
          <p class="pv-drop__title">${esc(d.title || 'Nombre del drop')}</p>
          ${d.specs ? `<p class="pv-drop__specs">${esc(d.specs)}</p>` : ''}
          <ol class="pv-drop__pieces">${list}</ol>
          <p class="pv-drop__price"><s class="mono">${money(regular)}</s> <b>${money(d.priceCents)}</b></p>
          ${save ? `<p class="mono pv-drop__save">−${Math.round((save / regular) * 100)}% · ahorras ${money(save)}</p>` : ''}
          ${d.items.length ? `<p class="mono pv-drop__left${left ? '' : ' is-out'}"><b>${left}</b> ${left === 1 ? 'drop disponible' : 'drops disponibles'} · manda ${esc(low?.name ?? '—')} (${low?.stock ?? 0} en stock)</p>` : ''}
          ${hidden.length ? `<p class="mono pv-drop__note" data-status="paused">Sin publicar: ${esc(hidden.join(', '))}. La tienda no muestra el drop hasta que todas sus piezas estén activas.</p>` : ''}
          ${soldOut.length ? `<p class="mono pv-drop__note" data-status="paused">Agotada: ${esc(soldOut.join(', '))}. El drop se ve, pero no se puede añadir hasta que haya existencias.</p>` : ''}
          ${status.key === 'live' && hidden.length ? '' : `<p class="mono pv-drop__note" data-status="${status.key}">${note}</p>`}
          ${announceHtml(d, saved)}
        </div>`;
    },
  });
  /* =====================================================================
     Pedidos: pagos con Wompi y su entrega
     ===================================================================== */
  const PAY_LABEL = { approved: 'Pagado', pending: 'Esperando pago', declined: 'Rechazado', voided: 'Anulado', error: 'Error de pago' };
  const METHOD_LABEL = {
    CARD: 'Tarjeta', NEQUI: 'Nequi', PSE: 'PSE', DAVIPLATA: 'Daviplata', BANCOLOMBIA_TRANSFER: 'Botón Bancolombia',
    BANCOLOMBIA_QR: 'QR Bancolombia', BANCOLOMBIA_BNPL: 'Compra y paga después', SU_PLUS: 'SU+ Pay', SIMULADO: 'Simulado',
  };
  const TAB_LABEL = { despachar: 'Por despachar', pagados: 'Pagados', pendientes: 'Esperando pago', fallidos: 'Rechazados' };

  async function refreshOrdersBadge() {
    try {
      const { counts } = await api('/api/admin/orders?summary=1');
      setBadge('pedidos', counts.toShip);
    } catch {
      /* el contador es solo una ayuda */
    }
  }

  modules.pedidos = (() => {
    // la búsqueda, el orden y las páginas los resuelve el servidor: con miles de pedidos solo viajan 24
    const st = { orders: [], carriers: [], filter: 'despachar', q: '', sort: 'recientes', page: 1, pages: 1, total: 0, counts: {}, summary: null };
    const list = $('#pd-list');
    const status = $('#pd-status');
    const pager = $('#pd-pager');
    const searchEl = $('#pd-search');
    let loadSeq = 0;
    let searchTimer = 0;

    /** Pagado → enviado. Un envío a domicilio no sale sin distribuidora y número de guía, que es lo que ve quien compró. */
    function shipHtml(o) {
      const s = o.shipment;
      const undo = '<button class="link mono pd__undo" type="button" data-unship>Deshacer</button>';
      if (o.delivery.method === 'tienda') {
        return s
          ? `<p class="pd__shipped mono">Listo para recoger desde el ${esc(fmtDate(s.at))}. ${undo}</p>`
          : '<form class="pd__ship" data-ship novalidate><p class="pd__note mono">Cuando esté empacado, márcalo: le llega un correo con la dirección y el horario de la tienda.</p><button class="btn" type="submit">Marcar listo para recoger</button></form>';
      }
      const picked = s?.carrier ?? o.shippingQuote?.carrier ?? 'interrapidisimo'; // la de la cotización; la tienda despacha con Interrapidísimo
      const options = st.carriers.map((c) => `<option value="${esc(c.id)}"${picked === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
      return `
        ${s ? `<p class="pd__shipped mono">Enviado el ${esc(fmtDate(s.at))} con <b>${esc(s.carrierName)}</b> · guía <b>${esc(s.tracking)}</b>. ${undo}</p>` : ''}
        <form class="pd__ship" data-ship novalidate>
          <label class="pd__field"><span class="mono">Distribuidora</span>
            <select name="carrier" required><option value="">Elige…</option>${options}</select>
          </label>
          <label class="pd__field" data-other${s?.carrier === 'otra' ? '' : ' hidden'}><span class="mono">¿Cuál?</span>
            <input name="carrierName" type="text" maxlength="40" value="${esc(s?.carrier === 'otra' ? s.carrierName ?? '' : '')}">
          </label>
          <label class="pd__field"><span class="mono">Número de guía</span>
            <input name="tracking" type="text" minlength="4" maxlength="40" required value="${esc(s?.tracking ?? '')}" autocomplete="off" spellcheck="false">
          </label>
          <button class="btn" type="submit">${s ? 'Corregir guía' : 'Marcar enviado'}</button>
          <p class="pd__msg mono" role="status" aria-live="polite"></p>
        </form>`;
    }

    function cardHtml(o) {
      const paid = o.status === 'approved';
      const unpaid = o.status === 'pending' && !o.wompi; // abrió Wompi y salió sin pagar
      const where = o.delivery.method === 'tienda'
        ? 'Recoge en la tienda'
        : `${esc(o.delivery.address)}${o.delivery.details ? `, ${esc(o.delivery.details)}` : ''} · ${esc(o.delivery.city)}, ${esc(o.delivery.region)}`;
      const perks = [
        o.discountCents ? `Beneficio Lv ${pad(o.level)} −${money(o.discountCents)}` : '',
        o.freeShipping === 'mitico' ? 'envío gratis (Mítico)' : o.freeShipping === 'promo' ? 'envío gratis (promoción)' : '',
        o.member ? `${o.xp ? `+${o.xp} XP` : 'con credencial'}` : 'sin credencial',
      ].filter(Boolean).join(' · ');
      const ship = o.delivery.method === 'tienda' ? 'tienda' : o.shippingCents ? `envío ${money(o.shippingCents)}` : 'envío gratis';
      return `
        <li class="ord pd" data-status="${esc(paid ? o.fulfillment : o.status)}" data-id="${esc(o._id)}">
          <div class="ord__head mono"><span>${esc(o.reference)} · ${esc(unpaid ? 'Sin pagar' : paid && o.fulfillment === 'enviado' ? (o.delivery.method === 'tienda' ? 'Listo para recoger' : 'Enviado') : PAY_LABEL[o.status] ?? o.status)}${o.demo ? ' · demostración' : o.simulated ? ' · simulado' : ''}</span><span>${esc(fmtDate(o.createdAt))}</span></div>
          <div class="pd__top"><p class="ord__piece">${esc(o.customer.name)}</p><p class="pd__total">${money(o.totalCents)}</p></div>
          <ul class="pd__lines mono">${o.lines.map((l) => `<li>${l.qty} × ${esc(l.name)} · ${money(l.totalCents)}</li>`).join('')}<li>${ship}</li></ul>
          <dl class="pd__meta mono">
            <div><dt>Entrega</dt><dd>${where}</dd></div>
            ${o.shippingQuote ? `<div><dt>Transporte</dt><dd>${esc(o.shippingQuote.carrierName)} · ${esc(o.shippingQuote.service)}${o.shippingQuote.estimate ? ` · ${esc(o.shippingQuote.estimate)}` : ''} · cuesta ${money(o.shippingCost)}${o.weightGrams ? ` · ${(o.weightGrams / 1000).toLocaleString('es-CO')} kg` : ''}</dd></div>` : ''}
            <div><dt>Contacto</dt><dd><a class="link" href="mailto:${esc(o.customer.email)}?subject=${encodeURIComponent(`Tu pedido ${o.reference} en Dream Zone`)}">${esc(o.customer.email)}</a> · <a class="link" href="tel:+57${esc(o.customer.phone)}">${esc(o.customer.phone)}</a></dd></div>
            <div><dt>Documento</dt><dd>${esc(o.customer.idType)} ${esc(o.customer.idNumber)}</dd></div>
            <div><dt>Pago</dt><dd>${o.wompi ? `${esc(METHOD_LABEL[o.wompi.method] ?? o.wompi.method ?? 'Wompi')} · transacción ${esc(o.wompi.transactionId)}` : 'sin transacción todavía'}${o.message ? ` · ${esc(o.message)}` : ''}</dd></div>
            <div><dt>Credencial</dt><dd>${perks}</dd></div>
            ${o.notes ? `<div><dt>Nota</dt><dd>«${esc(o.notes)}»</dd></div>` : ''}
          </dl>
          ${o.demo ? '<p class="pd__warn mono">Recibo de DEMOSTRACIÓN (npm run pago:simular -- recibos): no entró dinero ni movió existencias. No lo despaches de verdad.</p>'
            : o.simulated ? '<p class="pd__warn mono">Pago SIMULADO con npm run pago:simular: no entró dinero. No lo despaches; para quitarlo usa «npm run pago:simular -- referencia deshacer».</p>' : ''}
          ${o.stockIssues.length ? `<p class="pd__warn mono">Sin existencias suficientes de: ${esc(o.stockIssues.join(', '))}. Repón el producto en Catálogo y se descontará solo al volver a abrir Pedidos; no lo despaches mientras siga este aviso.</p>` : ''}
          ${paid ? `<div class="pd__foot">${shipHtml(o)}</div>` : `<p class="pd__note mono">${unpaid
            ? 'Abrió la página de Wompi pero no pagó: Wompi no tiene ninguna transacción. Si paga después, se actualiza solo.'
            : o.status === 'pending' ? 'Esperando que Wompi confirme el pago. Se actualiza solo cuando llega el aviso.' : 'No se cobró: no hay nada que despachar.'}</p>`}
        </li>`;
    }

    function pagerHtml() {
      const { page, pages } = st;
      const nums = [];
      for (let n = 1; n <= pages; n += 1) {
        if (n === 1 || n === pages || Math.abs(n - page) <= 1) nums.push(n);
        else if (nums[nums.length - 1] !== '…') nums.push('…');
      }
      return `
        <button class="pager__step" type="button" data-page="${page - 1}"${page === 1 ? ' disabled' : ''}>← Anterior</button>
        <ol class="pager__list" role="list">${nums.map((n) => (n === '…'
          ? '<li class="pager__gap" aria-hidden="true">…</li>'
          : `<li><button class="pager__num" type="button" data-page="${n}" aria-label="Página ${n}"${n === page ? ' aria-current="page"' : ''}>${pad(n)}</button></li>`)).join('')}</ol>
        <button class="pager__step" type="button" data-page="${page + 1}"${page === pages ? ' disabled' : ''}>Siguiente →</button>`;
    }

    function render() {
      const s = st.summary ?? { toShip: 0, paid: 0, soldCents: 0 };
      $('#pd-summary').innerHTML = `<b>${pad(s.toShip)}</b> por despachar · <b>${pad(s.paid)}</b> pagados por <b>${money(s.soldCents)}</b>`;
      Object.keys(TAB_LABEL).forEach((key) => { $(`[data-pd-n="${key}"]`).textContent = String(st.counts[key] ?? 0); });
      $$('[data-pd-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pdFilter === st.filter)));
      setBadge('pedidos', s.toShip);
      list.innerHTML = st.orders.map(cardHtml).join('');

      const found = $('#pd-found');
      found.hidden = !st.q || !st.total;
      found.textContent = st.q && st.total
        ? `${pad(st.total)} ${st.total === 1 ? 'pedido coincide' : 'pedidos coinciden'} con «${st.q}» en ${TAB_LABEL[st.filter]}${st.pages > 1 ? ` · página ${pad(st.page)} de ${pad(st.pages)}` : ''}`
        : '';
      status.hidden = st.orders.length > 0;
      delete status.dataset.state;
      const other = Object.keys(TAB_LABEL).filter((k) => k !== st.filter && st.counts[k]);
      status.textContent = st.q
        ? `> ningún pedido coincide con «${st.q}» en ${TAB_LABEL[st.filter]}.${other.length ? ` Hay coincidencias en ${other.map((k) => TAB_LABEL[k]).join(', ')}.` : ''}`
        : {
          despachar: '> nada por despachar. Los pagos aprobados aparecen aquí.',
          pagados: '> todavía no hay pagos aprobados.',
          pendientes: '> ningún pago esperando confirmación.',
          fallidos: '> ningún pago rechazado.',
        }[st.filter];
      pager.hidden = st.pages <= 1;
      pager.innerHTML = st.pages > 1 ? pagerHtml() : '';
    }

    async function load() {
      const seq = ++loadSeq; // si llega tarde una respuesta vieja (se escribió rápido), no pisa la nueva
      if (!st.orders.length) {
        status.hidden = false;
        status.textContent = '> revisando los pedidos…';
      }
      list.setAttribute('aria-busy', 'true');
      try {
        const params = new URLSearchParams({ filter: st.filter, sort: st.sort, page: String(st.page) });
        if (st.q) params.set('q', st.q);
        const data = await api(`/api/admin/orders?${params}`);
        if (seq !== loadSeq) return;
        Object.assign(st, {
          orders: data.orders, carriers: data.carriers, page: data.page, pages: data.pages,
          total: data.total, counts: data.counts, summary: data.summary,
        });
        render();
      } catch (err) {
        if (seq !== loadSeq) return;
        status.hidden = false;
        status.dataset.state = 'error';
        status.textContent = `> error: ${err.message}`;
      } finally {
        if (seq === loadSeq) list.removeAttribute('aria-busy');
      }
    }

    async function update(order, body) {
      const res = await api(`/api/admin/orders?id=${order._id}`, { method: 'PUT', body });
      Object.assign(order, res.order);
      await load(); // despachado o devuelto puede cambiar de pestaña: la lista y los conteos se piden de nuevo
      return res;
    }

    $$('[data-pd-filter]').forEach((btn) => btn.addEventListener('click', () => {
      st.filter = btn.dataset.pdFilter;
      st.page = 1;
      load();
    }));
    $('#pd-refresh').addEventListener('click', load);
    searchEl.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        const q = searchEl.value.trim().replace(/\s+/g, ' ');
        if (q === st.q) return;
        st.q = q;
        st.page = 1;
        load();
      }, 280);
    });
    searchEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && searchEl.value) {
        searchEl.value = '';
        searchEl.dispatchEvent(new Event('input'));
      }
    });
    $('#pd-sort').addEventListener('change', (e) => {
      st.sort = e.target.value;
      st.page = 1;
      load();
    });
    pager.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-page]');
      if (!btn || btn.disabled) return;
      st.page = Number(btn.dataset.page);
      await load();
      $('#pd-summary').scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    // «/» busca, igual que en Piezas
    document.addEventListener('keydown', (e) => {
      if (document.body.dataset.view !== 'pedidos' || e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target.closest('input, textarea, select, [contenteditable]')) return;
      e.preventDefault();
      searchEl.focus();
    });
    const orderOf = (el) => st.orders.find((o) => o._id === el.closest('.pd').dataset.id);
    list.addEventListener('change', (e) => {
      if (e.target.name !== 'carrier') return;
      const other = e.target.form.querySelector('[data-other]');
      other.hidden = e.target.value !== 'otra';
      other.querySelector('input').required = e.target.value === 'otra';
    });
    // deshacer un envío borra su guía: pide un segundo clic
    list.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-unship]');
      if (!btn) return;
      if (!(Number(btn.dataset.armedUntil) > Date.now())) {
        btn.dataset.armedUntil = String(Date.now() + 4000);
        btn.textContent = 'Clic otra vez: vuelve a «por despachar»';
        return;
      }
      const order = orderOf(btn);
      try {
        await update(order, { fulfillment: 'nuevo' });
        notify(`${order.reference} · de vuelta a por despachar.`, { tag: 'ok' });
      } catch (err) {
        notify(err.message, { tone: 'error' });
      }
    });
    list.addEventListener('submit', async (e) => {
      const formEl = e.target.closest('[data-ship]');
      if (!formEl) return;
      e.preventDefault();
      const order = orderOf(formEl);
      const f = formEl.elements;
      // validación propia (el formulario es novalidate): el aviso sale en la ficha, no en una burbuja del navegador
      const msg = formEl.querySelector('.pd__msg');
      formEl.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
      if (msg) msg.textContent = '';
      const fail = (input, text) => {
        input.setAttribute('aria-invalid', 'true');
        msg.textContent = text;
        input.focus();
      };
      if (f.carrier) {
        if (!f.carrier.value) return fail(f.carrier, 'Elige la distribuidora que lleva el pedido.');
        if (f.carrier.value === 'otra' && f.carrierName.value.trim().length < 2) return fail(f.carrierName, 'Escribe el nombre de la distribuidora.');
        if (!/^[A-Za-z0-9][A-Za-z0-9 -]{2,38}[A-Za-z0-9]$/.test(f.tracking.value.trim().replace(/\s+/g, ' '))) {
          return fail(f.tracking, 'Escribe el número de guía que te dio la distribuidora: de 4 a 40 letras o números.');
        }
      }
      const body = f.carrier
        ? { fulfillment: 'enviado', carrier: f.carrier.value, carrierName: f.carrierName.value, tracking: f.tracking.value }
        : { fulfillment: 'enviado' };
      try {
        const { mailed, mailOff } = await update(order, body);
        const s = order.shipment;
        const mail = mailed ? ` Le avisamos por correo a ${mailed}.` : mailOff ? ' Sin aviso por correo: el SMTP no está configurado.' : '';
        notify(`${s?.tracking ? `${order.reference} · enviado con ${s.carrierName}, guía ${s.tracking}.` : `${order.reference} · listo para recoger en la tienda.`}${mail}`, { tag: 'ok' });
      } catch (err) {
        if (msg) msg.textContent = err.message;
        else notify(err.message, { tone: 'error' });
      }
    });

    /* ---------- Compra en la sala física: sumar XP a una credencial y darle las gracias (lib/admin/sala.js) ---------- */
    const salaBox = $('#sala-xp');
    const salaForm = $('#sala-form');
    const salaOpen = $('#sala-open');
    const salaWho = $('#sala-who');
    const salaPreview = $('#sala-xp-preview');
    const salaMsg = $('#sala-msg');
    const salaList = $('#sala-list');
    const WHO_HINT = 'Pídele el correo con el que creó su credencial.';
    // rate: igual que PURCHASE_XP en lib/achievements.js (el servidor la confirma) · key: una por compra, contra el doble clic
    const sala = { rate: { xp: 5, cents: 100000 }, mail: true, customer: null, lookup: 0, key: '' };
    const newKey = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');
    const salaXp = (cents) => Math.floor(cents / sala.rate.cents) * sala.rate.xp;
    function salaSay(text, kind = '') {
      salaMsg.textContent = text;
      if (kind) salaMsg.dataset.state = kind;
      else delete salaMsg.dataset.state;
    }
    function salaWhoSay(text, kind = '') {
      salaWho.textContent = text;
      if (kind) salaWho.dataset.state = kind;
      else delete salaWho.dataset.state;
    }

    function paintSalaPreview() {
      const cents = parseMoney(salaForm.elements.amount.value);
      const xp = Number.isFinite(cents) ? salaXp(cents) : 0;
      if (!Number.isFinite(cents) || cents <= 0) salaPreview.textContent = `Cada ${money(sala.rate.cents)} suma ${sala.rate.xp} XP.`;
      else salaPreview.textContent = xp ? `${money(cents)} → +${xp} XP` : `Menos de ${money(sala.rate.cents)}: no suma XP.`;
    }

    /** Busca la credencial por su correo y la muestra (nombre, nivel y XP) para confirmar a quién se le suma. */
    async function lookupCustomer() {
      const input = salaForm.elements.email;
      const value = input.value.trim();
      sala.customer = null;
      const seq = ++sala.lookup;
      if (!value || !input.checkValidity()) return salaWhoSay(WHO_HINT);
      salaWhoSay('> buscando la credencial…');
      try {
        const { customer } = await api(`/api/admin/sala?email=${encodeURIComponent(value)}`);
        if (seq !== sala.lookup) return;
        sala.customer = customer;
        const who = customer.nickname ? `${customer.nickname} (${customer.name})` : customer.name;
        salaWhoSay(`✓ ${who} · Lv ${pad(customer.level)} ${customer.levelName} · ${customer.xp.toLocaleString('es-CO')} XP`, 'ok');
      } catch (err) {
        if (seq === sala.lookup) salaWhoSay(err.message, 'error');
      }
    }

    function renderSales(sales) {
      $('#sala-count').textContent = String(sales.length);
      salaList.innerHTML = sales.length ? sales.map((s) => `
        <li class="sala-sale" data-id="${esc(s._id)}">
          <div>
            <p class="sala-sale__name">${esc(s.name)}</p>
            <p class="mono muted">${esc(s.email)} · ${esc(fmtDate(s.createdAt))}${s.byName ? ` · registró ${esc(s.byName)}` : ''}${s.note ? ` · ${esc(s.note)}` : ''}</p>
          </div>
          <p class="sala-sale__xp mono">${money(s.amountCents)}<b>+${s.xp} XP</b>${s.mailed ? '<small>gracias enviado</small>' : ''}</p>
          <button class="link mono mem__danger" type="button" data-sala-undo>Deshacer</button>
        </li>`).join('') : '<li class="mono muted sala-empty">Aún no hay compras en la sala registradas.</li>';
    }
    async function loadSales() {
      try {
        const data = await api('/api/admin/sala');
        sala.rate = data.rate ?? sala.rate;
        sala.mail = Boolean(data.mail);
        renderSales(data.sales);
        paintSalaPreview();
      } catch (err) {
        salaList.innerHTML = `<li class="mono muted sala-empty">${esc(err.message)}</li>`;
      }
    }

    salaOpen.addEventListener('click', () => {
      const open = salaBox.hidden;
      salaBox.hidden = !open;
      salaOpen.setAttribute('aria-expanded', String(open));
      salaOpen.textContent = open ? '× Cerrar compra en la sala' : '+ Compra en la sala';
      if (!open) return;
      sala.key = newKey();
      loadSales();
      salaForm.elements.email.focus();
    });
    let lookupTimer = 0;
    salaForm.elements.email.addEventListener('input', () => {
      clearTimeout(lookupTimer);
      sala.customer = null;
      lookupTimer = setTimeout(lookupCustomer, 450);
    });
    salaForm.elements.email.addEventListener('change', () => {
      clearTimeout(lookupTimer);
      if (!sala.customer) lookupCustomer();
    });
    salaForm.elements.amount.addEventListener('input', paintSalaPreview);
    /*
     * Confirmación: «Sumar XP» no suma nada todavía; muestra a quién, cuánto compró y cuánto XP le llega, y solo
     * «Sí, sumar el XP» lo envía. Cambiar cualquier dato (o «Corregir», o Esc) cierra la confirmación sin sumar.
     */
    const salaConfirm = $('#sala-confirm');
    const salaYes = $('#sala-confirm-yes');
    let pending = null; // lo que se va a enviar mientras se confirma
    function closeConfirm({ focus = null } = {}) {
      pending = null;
      salaConfirm.hidden = true;
      salaForm.querySelector('[type="submit"]').hidden = false;
      focus?.focus();
    }
    $('#sala-confirm-no').addEventListener('click', () => {
      closeConfirm({ focus: salaForm.elements.amount });
      salaSay('Corrige lo que haga falta y vuelve a pulsar «Sumar XP».');
    });
    salaConfirm.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      closeConfirm({ focus: salaForm.elements.amount });
      salaSay('');
    });

    salaForm.addEventListener('input', (e) => {
      e.target.removeAttribute?.('aria-invalid');
      if (pending) closeConfirm(); // cambió un dato: hay que volver a confirmar
      if (salaMsg.dataset.state === 'error') salaSay('');
    });

    salaForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (pending) return; // ya está esperando la confirmación
      const { email: emailEl, amount, note } = salaForm.elements;
      const cents = parseMoney(amount.value);
      if (!sala.customer) {
        emailEl.setAttribute('aria-invalid', 'true');
        emailEl.focus();
        return salaSay(salaWho.dataset.state === 'error' ? salaWho.textContent : 'Escribe el correo de la credencial y espera a que aparezca su nombre.', 'error');
      }
      if (!Number.isFinite(cents) || salaXp(cents) <= 0) {
        amount.setAttribute('aria-invalid', 'true');
        amount.focus();
        return salaSay(`Escribe el valor de la compra (desde ${money(sala.rate.cents)}, ej. 59.900).`, 'error');
      }
      const c = sala.customer;
      const xp = salaXp(cents);
      const text = note.value.trim();
      pending = { email: c.email, amountCents: cents, note: text, key: sala.key };
      const who = c.nickname ? `${c.nickname} (${c.name})` : c.name;
      $('#sala-confirm-text').innerHTML = `Vas a sumar <b>+${xp} XP</b> a <b>${esc(who)}</b> · ${esc(c.email)} por una compra de <b>${money(cents)}</b>${text ? ` (${esc(text)})` : ''}. Pasará de ${c.xp.toLocaleString('es-CO')} a ${(c.xp + xp).toLocaleString('es-CO')} XP${sala.mail ? ' y le llegará un correo de gracias' : ''}.`;
      salaYes.textContent = `Sí, sumar +${xp} XP`;
      salaForm.querySelector('[type="submit"]').hidden = true;
      salaConfirm.hidden = false;
      salaSay('');
      salaConfirm.focus(); // al cuadro, no al botón: un Enter de más no confirma
    });

    salaYes.addEventListener('click', async () => {
      if (!pending) return;
      const body = pending;
      salaYes.disabled = true;
      salaSay('> sumando XP…');
      try {
        const res = await api('/api/admin/sala', { method: 'POST', body });
        const who = res.customer.nickname || res.customer.name;
        const thanks = res.mailed ? ' y le llegó un correo de gracias' : sala.mail ? ' (el correo de gracias no salió)' : ' (sin correo de gracias: el SMTP no está configurado)';
        salaSay(`¡Listo! +${res.sale.xp} XP para ${who}${thanks}.${res.levelUp ? ` Subió a ${res.customer.levelName}.` : ''}`, 'ok');
        notify(`Gracias, ${who}: +${res.sale.xp} XP por su compra en la sala.`, { tag: 'xp' });
        closeConfirm();
        salaForm.reset();
        sala.customer = null;
        sala.key = newKey();
        salaWhoSay(WHO_HINT);
        paintSalaPreview();
        loadSales();
      } catch (err) {
        closeConfirm();
        salaSay(err.message, 'error');
      } finally {
        salaYes.disabled = false;
      }
    });

    // «Deshacer» pide un segundo clic: resta el XP de esa compra (sin bajar de 0) y la borra del registro
    salaList.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-sala-undo]');
      const li = btn?.closest('[data-id]');
      if (!btn || !li || btn.disabled) return;
      if (!btn.classList.contains('is-armed')) {
        btn.classList.add('is-armed');
        btn.textContent = '¿Seguro? Resta su XP';
        setTimeout(() => { btn.classList.remove('is-armed'); btn.textContent = 'Deshacer'; }, 4000);
        return;
      }
      btn.disabled = true;
      try {
        await api(`/api/admin/sala?id=${li.dataset.id}`, { method: 'DELETE', body: {} });
        notify('Compra deshecha: se restó su XP.', { tag: 'baja' });
        loadSales();
      } catch (err) {
        notify(err.message, { tone: 'error' });
        btn.disabled = false;
      }
    });

    return { enter: load };
  })();

  /* =====================================================================
     Buzón: fichas de encargo y suscriptores
     ===================================================================== */
  const ORDER_STATUSES = [['nuevo', 'Nuevo'], ['cotizado', 'Cotizado'], ['cerrado', 'Cerrado']];

  async function refreshInboxBadge() {
    try {
      const { counts } = await api('/api/admin/inbox?summary=1');
      setBadge('buzon', counts.ordersNew);
    } catch {
      /* el contador es solo una ayuda */
    }
  }

  modules.buzon = (() => {
    const st = { orders: [], subscribers: [], box: 'orders' };
    const orderList = $('#bz-order-list');
    const subList = $('#bz-sub-list');
    const status = $('#bz-status');

    function render() {
      const newCount = st.orders.filter((o) => o.status === 'nuevo').length;
      $('#bz-n-orders').textContent = String(st.orders.length);
      $('#bz-n-subs').textContent = String(st.subscribers.length);
      setBadge('buzon', newCount);
      $('#bz-orders').hidden = st.box !== 'orders';
      $('#bz-subs').hidden = st.box !== 'subscribers';
      $$('[data-box]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.box === st.box)));

      orderList.innerHTML = st.orders.map((o) => `
        <li class="ord" data-status="${esc(o.status)}" data-id="${esc(o._id)}">
          <div class="ord__head mono"><span>Ficha ${esc(o.code)}</span><span>${esc(fmtDate(o.createdAt))}</span></div>
          <p class="ord__piece">${esc(o.piece)}</p>
          <p class="ord__mail mono">${o.whatsapp
            ? `<a class="link" href="https://wa.me/57${esc(o.whatsapp)}?text=${encodeURIComponent(`¡Hola! Te escribimos de Dream Zone por tu encargo ${o.code}: «${o.piece}».`)}" target="_blank" rel="noopener">WhatsApp ${esc(o.whatsapp.replace(/^(\d{3})(\d{3})(\d{4})$/, '$1 $2 $3'))} ↗</a>`
            : `<a class="link" href="mailto:${esc(o.email)}?subject=${encodeURIComponent(`Tu encargo ${o.code} en Dream Zone`)}">${esc(o.email)} ↗</a>`}</p>
          <div class="ord__foot">
            <div class="chips" role="group" aria-label="Estado de la ficha ${esc(o.code)}">
              ${ORDER_STATUSES.map(([key, label]) => `<button class="chip" type="button" data-set-status="${key}" data-st="${key}" aria-pressed="${o.status === key}">${label}</button>`).join('')}
            </div>
            <button class="link mono ord__del" type="button" data-del-order>Borrar</button>
          </div>
        </li>`).join('');

      subList.innerHTML = st.subscribers.map((s) => `
        <li class="sub-row" data-id="${esc(s._id)}">
          <span class="sub-row__mail">${esc(s.email)}</span>
          <span class="mono muted">${esc(fmtDay(s.createdAt))}</span>
          <button class="link mono" type="button" data-del-sub>Quitar</button>
        </li>`).join('');

      const empty = st.box === 'orders' ? !st.orders.length : !st.subscribers.length;
      status.hidden = !empty;
      delete status.dataset.state;
      status.textContent = st.box === 'orders'
        ? '> sin fichas de encargo todavía. Llegan desde la sección Encargos de la tienda.'
        : '> nadie se ha suscrito todavía. Llegan desde la sección Correo de la tienda.';
    }

    async function load() {
      status.hidden = false;
      status.textContent = '> revisando el buzón…';
      try {
        const data = await api('/api/admin/inbox');
        st.orders = data.orders;
        st.subscribers = data.subscribers;
        render();
      } catch (err) {
        status.hidden = false;
        status.dataset.state = 'error';
        status.textContent = `> error: ${err.message}`;
      }
    }

    $$('[data-box]').forEach((btn) => btn.addEventListener('click', () => {
      st.box = btn.dataset.box;
      render();
    }));
    $('#bz-refresh').addEventListener('click', load);

    orderList.addEventListener('click', async (e) => {
      const li = e.target.closest('.ord');
      if (!li) return;
      const order = st.orders.find((o) => o._id === li.dataset.id);
      const chip = e.target.closest('[data-set-status]');
      const del = e.target.closest('[data-del-order]');
      try {
        if (chip && order.status !== chip.dataset.setStatus) {
          const res = await api(`/api/admin/inbox?kind=order&id=${order._id}`, { method: 'PUT', body: { status: chip.dataset.setStatus } });
          Object.assign(order, res.order);
          render();
        } else if (del && confirmClick(del, '¿Seguro? Clic otra vez')) {
          await api(`/api/admin/inbox?kind=order&id=${order._id}`, { method: 'DELETE', body: {} });
          st.orders = st.orders.filter((o) => o !== order);
          render();
          notify(`Ficha ${order.code} borrada.`, { tag: 'baja' });
        }
      } catch (err) {
        notify(err.message, { tone: 'error' });
      }
    });

    subList.addEventListener('click', async (e) => {
      const del = e.target.closest('[data-del-sub]');
      if (!del || !confirmClick(del, '¿Seguro?')) return;
      const id = del.closest('.sub-row').dataset.id;
      try {
        await api(`/api/admin/inbox?kind=subscriber&id=${id}`, { method: 'DELETE', body: {} });
        st.subscribers = st.subscribers.filter((s) => s._id !== id);
        render();
      } catch (err) {
        notify(err.message, { tone: 'error' });
      }
    });

    $('#bz-copy').addEventListener('click', async () => {
      if (!st.subscribers.length) return;
      try {
        await navigator.clipboard.writeText(st.subscribers.map((s) => s.email).join(', '));
        notify(`${st.subscribers.length} correos copiados.`, { tag: 'copia' });
      } catch {
        notify('El navegador no dejó copiar. Usa «Descargar CSV».', { tone: 'error' });
      }
    });
    $('#bz-csv').addEventListener('click', () => {
      const cell = (v) => `"${String(v).replace(/"/g, '""')}"`;
      const rows = [['correo', 'alta'], ...st.subscribers.map((s) => [s.email, s.createdAt])];
      const csv = `\ufeff${rows.map((r) => r.map(cell).join(',')).join('\r\n')}`;
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `suscriptores-dream-zone-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    return { enter: load };
  })();

  /* =====================================================================
     Equipo: quién puede entrar a la curaduría
     ===================================================================== */
  modules.equipo = (() => {
    const form = $('#tm-form');
    const msg = $('#tm-msg');
    const list = $('#tm-list');
    const st = { members: [], me: null };

    function sayMsg(text, kind) {
      msg.textContent = text;
      if (kind) msg.dataset.state = kind;
      else delete msg.dataset.state;
    }

    function showLink({ inviteUrl, emailed, member }) {
      const box = $('#tm-invite');
      box.hidden = !inviteUrl;
      if (!inviteUrl) return;
      $('#tm-link').value = inviteUrl;
      $('#tm-invite-label').textContent = `Enlace de activación para ${member.email}`;
      $('#tm-invite-note').textContent = emailed
        ? 'También se lo enviamos por correo. Sirve una sola vez y vence en 7 días.'
        : 'El correo de la tienda aún no está configurado: compártelo tú (WhatsApp, Discord…). Sirve una sola vez y vence en 7 días.';
    }

    function render() {
      $('#tm-count').textContent = pad(st.members.length);
      const progress = window.DZProgress;
      list.innerHTML = st.members.map((m) => {
        const mine = m._id === st.me;
        const shown = m.nickname || m.name;
        const initial = Array.from(shown.trim() || '?')[0].toUpperCase();
        const meta = m.pending
          ? 'invitación pendiente: aún no elige contraseña'
          : m.lastLoginAt ? `último acceso ${fmtDate(m.lastLoginAt)}` : 'sin accesos todavía';
        const actions = mine
          ? '<span class="mono mem__you">eres tú</span>'
          : m.pending
            ? '<button class="link mono" type="button" data-link>Nuevo enlace</button><button class="link mono mem__danger" type="button" data-cancel>Cancelar invitación</button>'
            : '<button class="link mono mem__danger" type="button" data-revoke>Quitar acceso</button>';
        return `
          <li class="mem${m.pending ? ' is-pending' : ''}${mine ? ' is-me' : ''}" data-id="${esc(m._id)}">
            <span class="avatar" aria-hidden="true">${esc(initial)}</span>
            <div class="mem__main">
              <p class="mem__name">${esc(shown)}${m.pending ? '' : ` <span class="lv mono" data-lv="${m.level}">Lv ${pad(m.level)} · ${esc(progress?.levelName(m.level) ?? '')}</span>`}</p>
              <p class="mem__meta mono">${m.nickname ? `${esc(m.name)} · ` : ''}${esc(m.email)} · ${esc(meta)}${m.invitedBy ? ` · invitación de ${esc(m.invitedBy)}` : ''}</p>
            </div>
            <div class="mem__actions">${actions}</div>
          </li>`;
      }).join('');
      // el mismo cuadro de su credencial: su color (o el de su nivel) y, en Mítico, el halo; una invitación aún no tiene
      st.members.forEach((m, i) => {
        if (m.pending || !progress) return;
        progress.paintAvatar(list.children[i].querySelector('.avatar'), { name: m.nickname || m.name, color: m.avatarColor, level: m.level });
      });
    }

    async function load() {
      try {
        const data = await api('/api/admin/team');
        st.members = data.members;
        st.me = data.me;
        render();
        $('#tm-foot').textContent = `${data.customers} ${data.customers === 1 ? 'credencial de jugador' : 'credenciales de jugador'} sin acceso a la curaduría.`;
      } catch (err) {
        $('#tm-foot').textContent = `> error: ${err.message}`;
      }
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const { email, name } = form.elements;
      email.removeAttribute('aria-invalid');
      if (!email.value.trim() || !email.checkValidity()) {
        email.setAttribute('aria-invalid', 'true');
        email.focus();
        sayMsg('Revisa el correo (ej. persona@correo.com).', 'error');
        return;
      }
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      sayMsg('> dando acceso…');
      try {
        const res = await api('/api/admin/team', { method: 'POST', body: { email: email.value, name: name.value } });
        sayMsg(res.inviteUrl
          ? `${res.created ? 'Invitación creada' : 'Invitación renovada'}: ${res.member.email} ya es admin; falta que active su credencial.`
          : `Listo: ${res.member.email} ya puede entrar a la curaduría con su contraseña.`, 'ok');
        form.reset(); // antes de mostrar el enlace: su campo también vive en este formulario
        showLink(res);
        notify(`${res.member.email} · acceso a la curaduría.`, { tag: 'admin' });
        await load();
      } catch (err) {
        sayMsg(err.message, 'error');
      } finally {
        submit.disabled = false;
      }
    });

    $('#tm-copy').addEventListener('click', async () => {
      const input = $('#tm-link');
      try {
        await navigator.clipboard.writeText(input.value);
        notify('Enlace copiado.', { tag: 'copia' });
      } catch {
        input.select();
        notify('Selecciona el enlace y cópialo con Ctrl/⌘ C.', { tone: 'error' });
      }
    });

    list.addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      const li = e.target.closest('.mem');
      if (!btn || !li) return;
      const member = st.members.find((m) => m._id === li.dataset.id);
      try {
        if (btn.hasAttribute('data-link')) {
          const res = await api(`/api/admin/team?id=${member._id}&action=link`, { method: 'POST', body: {} });
          showLink(res);
          sayMsg(`Enlace nuevo para ${member.email} (el anterior ya no sirve).`, 'ok');
          $('#tm-invite').scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else if (btn.hasAttribute('data-cancel') && confirmClick(btn, '¿Seguro? Clic otra vez')) {
          await api(`/api/admin/team?id=${member._id}`, { method: 'DELETE', body: {} });
          notify(`Invitación de ${member.email} cancelada.`, { tag: 'baja' });
          $('#tm-invite').hidden = true;
          await load();
        } else if (btn.hasAttribute('data-revoke') && confirmClick(btn, '¿Seguro? Clic otra vez')) {
          await api(`/api/admin/team?id=${member._id}`, { method: 'PUT', body: { role: 'customer' } });
          notify(`${member.email} ya no tiene acceso a la curaduría.`, { tag: 'baja' });
          await load();
        }
      } catch (err) {
        notify(err.message, { tone: 'error' });
      }
    });

    return { enter: load };
  })();

  // admin.js ya pudo haber confirmado la sesión antes de que este archivo cargara
  if (window.DZ_ADMIN_USER) start(window.DZ_ADMIN_USER);
})();