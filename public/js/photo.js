/*
 * Fotos de producto con el mismo encuadre. Al subirlas, la curaduría las recorta al contorno de la pieza (quita el
 * margen transparente de un recorte o el fondo liso de una foto de estudio), les deja el mismo aire alrededor y las
 * lleva al mismo tamaño máximo. Así una billetera que venía con mucho margen y otra que venía justa ocupan lo mismo
 * en el visor, en los drops y en las miniaturas. Una foto con escenario (fondo que no es liso) no se recorta.
 *
 * window.DZPhoto.prepare(file) → { blob, cutout, width, height, mode }   (mode: 'recorte' · 'fondo' · 'escena')
 * window.DZPhoto.trimmed(url)  → Promise<url>: para mostrar una foto ya subida recortada a su contorno
 * La usan admin.js al subir, el visor de la tienda (main.js) y la vista previa de la curaduría.
 */
(() => {
  'use strict';

  const SIDE = 1600; // lado mayor de la foto final; una foto más chica no se agranda (el aire es proporcional)
  const AIR = 0.05; // aire alrededor de la pieza, como fracción del lado mayor de la foto final
  const PROBE = 800; // lado mayor del mapa en el que se mide el contorno
  const ALPHA_MIN = 24; // menos opacidad que esto es fondo (deja dentro sombras suaves y bordes)
  const CUTOUT_SHARE = 0.02; // más de 2 % de píxeles transparentes → es un recorte (lleva el eco de color)
  const BG_TOLERANCE = 30; // distancia de color hasta la que un píxel aún es el fondo liso
  const BG_SHARE = 0.9; // el borde tiene que ser al menos 90 % fondo para que la foto cuente como de estudio
  const MIN_HITS = 2; // una fila o columna con menos píxeles de pieza que esto es ruido
  const MAX_BYTES = 2.4 * 1024 * 1024;
  const VIEW_SIDE = 1600; // al mostrar: el tamaño de subida, para que el zoom del visor tenga todo el detalle
  const VIEW_SLACK = 0.01; // si sobra menos de 1 % por lado, la foto ya viene justa y se usa tal cual

  const encode = (canvas, type, quality) => new Promise((resolve) => { canvas.toBlob(resolve, type, quality); });
  const distance = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

  function canvasOf(w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    return canvas;
  }

  /** Color de fondo de una foto opaca: el que domina en el marco de 2 px del borde, o null si el borde es variado. */
  function flatBackground(data, w, h) {
    const ring = [];
    const push = (x, y) => { const i = (y * w + x) * 4; ring.push([data[i], data[i + 1], data[i + 2]]); };
    for (let y = 0; y < h; y += 1) {
      if (y < 2 || y >= h - 2) for (let x = 0; x < w; x += 1) push(x, y);
      else [0, 1, w - 2, w - 1].forEach((x) => { if (x >= 0 && x < w) push(x, y); });
    }
    const median = [0, 1, 2].map((c) => ring.map((px) => px[c]).sort((a, b) => a - b)[ring.length >> 1]);
    const near = ring.filter((px) => distance(px, median) <= BG_TOLERANCE).length;
    return near / ring.length >= BG_SHARE ? median : null;
  }

  /** Caja que encierra la pieza en el mapa: filas y columnas con al menos MIN_HITS píxeles que no son fondo. */
  function contentBox(w, h, isPiece) {
    const rows = new Uint32Array(h);
    const cols = new Uint32Array(w);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (isPiece((y * w + x) * 4)) { rows[y] += 1; cols[x] += 1; }
      }
    }
    const first = (arr) => arr.findIndex((n) => n >= MIN_HITS);
    const last = (arr) => arr.findLastIndex((n) => n >= MIN_HITS);
    const top = first(rows);
    const left = first(cols);
    if (top < 0 || left < 0) return null;
    return { x: left, y: top, w: last(cols) - left + 1, h: last(rows) - top + 1 };
  }

  /** Mide la foto: qué tipo es, si es un recorte y dónde está la pieza (en píxeles de la foto original). */
  function measure(bitmap) {
    const k = Math.min(1, PROBE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * k));
    const h = Math.max(1, Math.round(bitmap.height * k));
    const ctx = canvasOf(w, h).getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);

    let clear = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] < 200) clear += 1;
    const cutout = clear / (w * h) > CUTOUT_SHARE;

    let mode = 'escena';
    let background = null;
    let box = null;
    if (cutout) {
      mode = 'recorte';
      box = contentBox(w, h, (i) => data[i + 3] >= ALPHA_MIN);
    } else {
      background = flatBackground(data, w, h);
      if (background) {
        mode = 'fondo';
        box = contentBox(w, h, (i) => distance([data[i], data[i + 1], data[i + 2]], background) > BG_TOLERANCE);
      }
    }
    if (!box) {
      // sin pieza que encontrar (todo transparente o todo fondo): se deja la foto entera
      return { mode: cutout ? 'recorte' : 'escena', cutout, background: null, crop: { x: 0, y: 0, w: bitmap.width, h: bitmap.height } };
    }
    // a la escala original, con un píxel del mapa de margen para no comerse el borde de la pieza
    const sx = Math.max(0, Math.floor((box.x - 1) / k));
    const sy = Math.max(0, Math.floor((box.y - 1) / k));
    const ex = Math.min(bitmap.width, Math.ceil((box.x + box.w + 1) / k));
    const ey = Math.min(bitmap.height, Math.ceil((box.y + box.h + 1) / k));
    return { mode, cutout, background, crop: { x: sx, y: sy, w: ex - sx, h: ey - sy } };
  }

  /** Lienzo final: la pieza centrada, con el mismo aire en los cuatro lados y el lado mayor en `side` (o menos). */
  function frame(bitmap, { mode, background, crop }, { air: wanted = AIR, side = SIDE } = {}) {
    const air = mode === 'escena' ? 0 : wanted;
    const scale = Math.min(1, (side * (1 - 2 * air)) / Math.max(crop.w, crop.h));
    const cw = Math.max(1, Math.round(crop.w * scale));
    const ch = Math.max(1, Math.round(crop.h * scale));
    const long = Math.max(cw, ch);
    const pad = Math.round((long / (1 - 2 * air) - long) / 2);
    const canvas = canvasOf(cw + 2 * pad, ch + 2 * pad);
    const ctx = canvas.getContext('2d');
    if (background) {
      ctx.fillStyle = `rgb(${background.join(',')})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, crop.x, crop.y, crop.w, crop.h, pad, pad, cw, ch);
    return canvas;
  }

  async function prepare(file) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new Error('no se pudo leer la imagen');
    }
    const shape = measure(bitmap);
    const canvas = frame(bitmap, shape);
    bitmap.close?.();
    let { cutout } = shape;

    let blob = await encode(canvas, 'image/webp', 0.86);
    if (!blob || blob.type !== 'image/webp') blob = await encode(canvas, cutout ? 'image/png' : 'image/jpeg', 0.88);
    for (const q of [0.74, 0.6, 0.45]) {
      if (blob && blob.size <= MAX_BYTES) break;
      const type = blob?.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
      if (type === 'image/jpeg') cutout = false; // el JPG no guarda transparencia
      blob = await encode(canvas, type, q);
    }
    if (!blob || blob.size > MAX_BYTES) throw new Error('pesa demasiado incluso optimizada');
    return { blob, cutout, width: canvas.width, height: canvas.height, mode: shape.mode, crop: shape.crop };
  }

  /*
   * Al mostrar: la foto recortada al contorno de la pieza (sin margen transparente ni fondo liso y sin aire: el
   * marco del visor pone el suyo), como blob local. Así también las fotos subidas antes de encuadrar al subir
   * ocupan todo su marco. Si no hay nada que recortar, es una foto con escenario o algo falla, devuelve la misma
   * url. Se calcula una sola vez por url.
   */
  const views = new Map();
  async function trim(url) {
    const res = await fetch(url);
    if (!res.ok) return url;
    const bitmap = await createImageBitmap(await res.blob());
    try {
      const shape = measure(bitmap);
      const { crop } = shape;
      const slack = Math.max(bitmap.width, bitmap.height) * VIEW_SLACK;
      const tight = crop.x <= slack && crop.y <= slack
        && bitmap.width - crop.x - crop.w <= slack && bitmap.height - crop.y - crop.h <= slack;
      if (shape.mode === 'escena' || tight) return url;
      const canvas = frame(bitmap, shape, { air: 0, side: VIEW_SIDE });
      const blob = await encode(canvas, 'image/webp', 0.9);
      return blob ? URL.createObjectURL(blob) : url;
    } finally {
      bitmap.close?.();
    }
  }
  function trimmed(url) {
    if (!url) return Promise.resolve(url);
    if (!views.has(url)) views.set(url, trim(url).catch(() => url));
    return views.get(url);
  }

  window.DZPhoto = { prepare, trimmed };
})();