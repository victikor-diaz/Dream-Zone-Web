import { COLLECTIONS } from './catalog.js';

const CART_TTL_SECONDS = 60 * 60 * 24 * 30;

/** Crea (o confirma) los índices. Se ejecuta desde `npm run seed`, no en cada petición. */
export async function ensureIndexes(db) {
  await Promise.all([
    db.collection(COLLECTIONS.products).createIndexes([
      { key: { slug: 1 }, unique: true },
      { key: { sku: 1 }, unique: true },
      { key: { status: 1, category: 1, createdAt: -1 } },
    ]),
    db.collection(COLLECTIONS.drops).createIndexes([
      { key: { code: 1 }, unique: true },
      { key: { active: 1, endsAt: 1 } },
      { key: { items: 1, active: 1 } },
    ]),

    db.collection(COLLECTIONS.carts).createIndexes([
      { key: { updatedAt: 1 }, expireAfterSeconds: CART_TTL_SECONDS },
    ]),
    db.collection(COLLECTIONS.subscribers).createIndexes([
      { key: { email: 1 }, unique: true },
      { key: { token: 1 }, unique: true, sparse: true }, // enlace de baja de cada correo
    ]),
    db.collection(COLLECTIONS.specialOrders).createIndexes([
      { key: { code: 1 }, unique: true },
      { key: { createdAt: -1 } },
    ]),
    db.collection(COLLECTIONS.users).createIndexes([
      { key: { email: 1 }, unique: true },
    ]),
    db.collection(COLLECTIONS.storeSales).createIndexes([
      { key: { createdAt: -1 } },
      { key: { userId: 1 } },
      { key: { key: 1 }, unique: true, sparse: true }, // una compra por formulario, aunque se pulse dos veces
    ]),
    // sesiones, enlaces de recuperación y límites de intentos se borran solos al vencer
    db.collection(COLLECTIONS.sessions).createIndexes([
      { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
      { key: { userId: 1 } },
    ]),
    db.collection(COLLECTIONS.passwordResets).createIndexes([
      { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
      { key: { userId: 1 } },
    ]),
    db.collection(COLLECTIONS.rateLimits).createIndexes([
      { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
    ]),
    db.collection(COLLECTIONS.orders).createIndexes([
      { key: { reference: 1 }, unique: true },
      { key: { status: 1, createdAt: -1 } },
      { key: { userId: 1, createdAt: -1 } },
      { key: { userId: 1, status: 1, paidAt: -1 } }, // «Mis pedidos», de 5 en 5
    ]),
    db.collection(COLLECTIONS.shippingCache).createIndexes([
      { key: { expiresAt: 1 }, expireAfterSeconds: 0 }, // cotizaciones de envío y municipios de Envia
    ]),
    db.collection(COLLECTIONS.media).createIndexes([
      { key: { attached: 1, createdAt: 1 } },
    ]),
  ]);
}
