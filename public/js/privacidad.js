/*
 * Política de privacidad: el responsable, su documento, el correo, el teléfono y el proveedor de factura electrónica
 * los edita la curaduría (Página › Política de privacidad); domicilio y dirección salen de «Visítanos». La versión y
 * la fecha van en el HTML, con el texto. Si /api/site no responde, rige el HTML.
 */
(() => {
  'use strict';

  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const UNSET = /^por definir$/i; // mientras diga eso, queda el texto del HTML (o se oculta la línea del documento)
  const fill = (key, value) => $$(`[data-p="${key}"]`).forEach((el) => { el.textContent = value; });
  const given = (value) => {
    const s = String(value ?? '').trim();
    return s && !UNSET.test(s) ? s : '';
  };

  function apply(site) {
    const p = site?.privacidad ?? {};
    const v = site?.visita ?? {};
    // sin teléfono queda «Aún no contamos con línea telefónica»; sin proveedor de factura, la frase genérica
    ['owner', 'email', 'phone', 'billing'].forEach((key) => { if (given(p[key])) fill(key, given(p[key])); });
    if (given(p.email)) $$('[data-p-href="email"]').forEach((a) => { a.href = `mailto:${given(p.email)}`; });
    if (v.address) fill('address', v.address);
    if (v.city) fill('city', v.city);
    const idDoc = given(p.idDoc);
    $$('[data-p-row="idDoc"]').forEach((row) => { row.hidden = !idDoc; });
    if (idDoc) fill('idDoc', idDoc);
  }

  fetch('/api/site', { headers: { Accept: 'application/json' } })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => { if (data?.site) apply(data.site); })
    .catch(() => { /* sin API: quedan los datos del HTML */ });

  /*
   * El índice marca la sección que se está leyendo: la última cuyo inicio ya pasó el primer tercio de la pantalla
   * (o la última de todas al llegar al final). La que se toca en el índice queda marcada aunque, por ser corta, no
   * alcance a subir hasta arriba, hasta que la persona vuelva a mover la página.
   */
  const links = $$('.legal__toc a');
  const sections = links.map((a) => document.getElementById(a.getAttribute('href').slice(1)));
  if (!links.length || sections.some((s) => !s)) return;
  let picked = null;
  let queued = false;
  function mark() {
    queued = false;
    let current = null;
    if (picked && picked.getBoundingClientRect().top < window.innerHeight) current = picked;
    else if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = sections[sections.length - 1];
    else sections.forEach((s) => { if (s.getBoundingClientRect().top <= window.innerHeight / 3) current = s; });
    links.forEach((a, i) => {
      if (sections[i] === current) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
    });
  }
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(mark); } };
  links.forEach((a, i) => a.addEventListener('click', () => { picked = sections[i]; queue(); }));
  ['wheel', 'touchstart', 'keydown'].forEach((type) => window.addEventListener(type, () => { picked = null; }, { passive: true }));
  window.addEventListener('scroll', queue, { passive: true });
  window.addEventListener('resize', queue);
  mark();
})();
