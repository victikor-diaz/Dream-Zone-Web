/*
 * Catálogo de prueba: 15 piezas con precios de tienda colombiana (en centavos: 6990000 = $69.900) repartidas en
 * las zonas de la tienda (las claves son fijas; sus nombres los pone la curaduría: Camisas, Gorros, Llaveros,
 * Figuras, Billeteras y Accesorios). Sin fotos todavía: se ven con su ilustración. Nada se vende en preventa.
 * El cierre del drop es relativo a la ejecución del seed.
 */

const cop = (pesos) => pesos * 100;
/** Existencias por talla; el stock de la pieza es la suma. */
const tallas = (map) => Object.entries(map).map(([size, stock]) => ({ size, stock }));

export const products = [
  // Camisas (zona «figuras»)
  {
    slug: 'camiseta-oversize-neon-ronin', sku: 'DZ-1001', name: 'Camiseta Oversize Neon Ronin', category: 'figuras',
    subtitle: 'Algodón 220 g · S a XL', icon: 'shirt', priceCents: cop(69900), rarity: 3, badge: 'nuevo', stock: 24,
    sizes: tallas({ S: 4, M: 8, L: 7, XL: 5 }),
    lore: 'Un samurái sin señor en una ciudad sin noche, estampado en la espalda. Corte amplio, para batallas largas.',
  },
  {
    slug: 'camiseta-pixel-dungeon', sku: 'DZ-1002', name: 'Camiseta Pixel Dungeon', category: 'figuras',
    subtitle: 'Algodón peinado · S a XXL', icon: 'shirt', priceCents: cop(59900), compareAtCents: cop(74900), rarity: 2,
    badge: 'oferta', stock: 18, tone: '#4ade80', sizes: tallas({ S: 3, M: 5, L: 5, XL: 3, XXL: 2 }),
    lore: 'Ocho bits, tres corazones y una mazmorra entera en el pecho.',
  },
  {
    slug: 'camisa-hawaiana-arcade', sku: 'DZ-1003', name: 'Camisa Hawaiana Arcade', category: 'figuras',
    subtitle: 'Viscosa · estampado completo', icon: 'shirt', priceCents: cop(89900), rarity: 4, badge: 'ultimas', stock: 3,
    sizes: tallas({ S: 0, M: 1, L: 2, XL: 0 }),
    tone: '#ff5c9d',
    lore: 'Palmeras, monedas y fantasmas. Para el viernes casual que merece un high score.',
  },
  // Gorros (zona «manga»)
  {
    slug: 'gorra-snapback-dream-zone', sku: 'DZ-1004', name: 'Gorra Snapback Dream Zone', category: 'manga',
    subtitle: 'Bordado 3D · talla única', icon: 'cap', priceCents: cop(64900), rarity: 3, badge: 'nuevo', stock: 15,
    lore: 'El logo con su sombra desplazada, bordado en relieve. Visera plana, como manda la tradición.',
  },
  {
    slug: 'gorra-trucker-game-over', sku: 'DZ-1005', name: 'Gorra Trucker Game Over', category: 'manga',
    subtitle: 'Malla trasera · ajustable', icon: 'cap', priceCents: cop(54900), rarity: 2, badge: null, stock: 10,
    lore: 'Insert coin to continue. Malla transpirable para jugar al sol.',
  },
  // Llaveros (zona «retro»)
  {
    slug: 'llavero-control-16-bit', sku: 'DZ-1006', name: 'Llavero Control 16-Bit', category: 'retro',
    subtitle: 'Acrílico doble cara · 6 cm', icon: 'pad', priceCents: cop(15900), rarity: 1, badge: null, stock: 40,
    lore: 'Tu memoria muscular de 1994, colgando de las llaves.',
  },
  {
    slug: 'llavero-d20-metalico', sku: 'DZ-1007', name: 'Llavero D20 Metálico', category: 'retro',
    subtitle: 'Zinc · 3 cm · numerado', icon: 'd20', priceCents: cop(19900), rarity: 2, badge: 'nuevo', stock: 30,
    lore: 'Pesa lo suficiente para que el máster se tome en serio tus críticos.',
  },
  {
    slug: 'llavero-cartucho-retro', sku: 'DZ-1008', name: 'Llavero Cartucho Retro', category: 'retro',
    subtitle: 'Resina · brilla en la oscuridad', icon: 'cart', priceCents: cop(22900), rarity: 3, badge: 'ultimas', stock: 4,
    lore: 'Sopla el conector antes de usarlo. No sirve de nada, pero es tradición.',
  },
  // Figuras (zona «tcg»)
  {
    slug: 'figura-mecha-koga-18cm', sku: 'DZ-1009', name: 'Figura Mecha Kōga 18 cm', category: 'tcg',
    subtitle: 'PVC articulado · 18 cm', icon: 'mecha', priceCents: cop(189900), rarity: 4, badge: 'nuevo', stock: 6,
    lore: 'Diseñado para pelear contra kaijus; terminó custodiando estanterías. No se queja.',
  },
  {
    slug: 'figura-chibi-aventurero', sku: 'DZ-1010', name: 'Figura Chibi Aventurero', category: 'tcg',
    subtitle: 'Vinilo · 10 cm', icon: 'meeple', priceCents: cop(89900), compareAtCents: cop(109900), rarity: 3,
    badge: 'oferta', stock: 9,
    lore: 'Cabeza grande, espada pequeña, ego enorme. Listo para su primera mazmorra.',
  },
  {
    slug: 'busto-piloto-estelar', sku: 'DZ-1011', name: 'Busto Piloto Estelar 1/6', category: 'tcg',
    subtitle: 'Resina pintada a mano · edición numerada', icon: 'helmet', priceCents: cop(349900), rarity: 5,
    badge: 'ultimas', stock: 2,
    lore: 'Homologado para estanterías, convenciones y videollamadas de trabajo aburridas.',
  },
  // Billeteras (zona «mesa»)
  {
    slug: 'billetera-pixel-heart', sku: 'DZ-1012', name: 'Billetera Pixel Heart', category: 'mesa',
    subtitle: 'Sintético · 6 bolsillos', icon: 'wallet', priceCents: cop(54900), rarity: 2, badge: null, stock: 14,
    lore: 'Tres corazones en la portada. Las monedas, por dentro.',
  },
  {
    slug: 'billetera-cuero-dz', sku: 'DZ-1013', name: 'Billetera Cuero DZ', category: 'mesa',
    subtitle: 'Cuero · grabado láser', icon: 'wallet', priceCents: cop(79900), rarity: 3, badge: 'nuevo', stock: 8,
    lore: 'El logo grabado al láser en cuero de verdad. Envejece mejor que tu partida guardada.',
  },
  // Accesorios (zona «merch»)
  {
    slug: 'tote-bag-dream-zone', sku: 'DZ-1014', name: 'Tote Bag Dream Zone', category: 'merch',
    subtitle: 'Lona 12 oz · 38 × 42 cm', icon: 'bag', priceCents: cop(39900), rarity: 1, badge: null, stock: 35,
    lore: 'Cabe un booster box, dos mangas y la merienda de la partida.',
  },
  {
    slug: 'pin-esmaltado-d20', sku: 'DZ-1015', name: 'Pin Esmaltado D20', category: 'merch',
    subtitle: 'Esmalte duro · 3 cm', icon: 'd20', priceCents: cop(14900), rarity: 2, badge: 'nuevo', stock: 50,
    lore: 'Un 20 natural para la chaqueta. Suerte permanente (no garantizada).',
  },
].map((p, i) => ({
  status: 'active',
  compareAtCents: null,
  tone: null, // null → color de su zona
  images: [],
  ...p,
  // el primero es el más nuevo (orden "Más nuevos" del índice)
  createdAt: new Date(Date.now() - i * 60 * 1000),
}));

/** Un drop es un bundle de piezas del catálogo con precio menor que la suma (aquí $74.700 → $59.900). */
export function drop() {
  return {
    code: 'drop-027',
    number: 27,
    title: 'Kit del aventurero',
    specs: 'Tote bag, pin y llavero D20 juntos · edición limitada',
    items: ['tote-bag-dream-zone', 'pin-esmaltado-d20', 'llavero-d20-metalico'],
    priceCents: cop(59900),
    active: true,
    endsAt: new Date(Date.now() + (((5 * 24 + 6) * 60) * 60) * 1000),
  };
}