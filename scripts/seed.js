/*
 * Carga datos de ejemplo e índices en MongoDB.
 *   npm run seed        → índices + inserta lo que falte (no pisa piezas ni drops editados)
 *   npm run seed:fresh  → vacía products (y sus imágenes) / drops y los vuelve a crear;
 *                         OJO: también borra las piezas creadas en la curaduría
 * Carritos, suscriptores, pedidos especiales y cuentas nunca se borran desde aquí.
 */
import { getDb, closeDb } from '../lib/mongodb.js';
import { ensureIndexes } from '../lib/indexes.js';
import { COLLECTIONS } from '../lib/catalog.js';
import { products, drop } from './seed-data.js';

const fresh = process.argv.includes('--fresh');

async function main() {
  const db = await getDb();
  console.log(`> conectado a "${db.databaseName}"${fresh ? ' (modo --fresh)' : ''}`);

  if (fresh) {
    // las imágenes van con sus piezas: sin productos quedarían huérfanas
    for (const name of [COLLECTIONS.products, COLLECTIONS.media, COLLECTIONS.drops]) {
      await db.collection(name).deleteMany({});
    }
    console.log('> products (con sus imágenes) y drops vaciados');
  }

  await ensureIndexes(db);
  console.log('> índices listos');

  // Solo inserta las piezas que faltan: lo editado en la curaduría nunca se pisa.
  const productOps = products.map((fields) => ({
    updateOne: {
      filter: { slug: fields.slug },
      update: { $setOnInsert: { ...fields, updatedAt: new Date() } },
      upsert: true,
    },
  }));
  const p = await db.collection(COLLECTIONS.products).bulkWrite(productOps);
  console.log(`> productos: ${p.upsertedCount} nuevos (los existentes no se tocan)`);

  // solo si no existe: un drop editado en la curaduría no se pisa
  const { code, ...dropFields } = drop();
  const now = new Date();
  await db.collection(COLLECTIONS.drops).updateOne(
    { code },
    { $setOnInsert: { code, ...dropFields, createdAt: now, updatedAt: now } },
    { upsert: true },
  );
  console.log(`> drop #${dropFields.number} listo`);
}

main()
  .then(() => console.log('> seed completo'))
  .catch((err) => {
    console.error('> seed falló:', err.message);
    process.exitCode = 1;
  })
  .finally(closeDb);
