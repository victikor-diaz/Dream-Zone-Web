import { MongoClient } from 'mongodb';
import { attachDatabasePool } from '@vercel/functions';

const DEFAULT_DB = 'dreamzone';

/*
 * Un solo MongoClient por instancia de función. En Vercel (Fluid compute) varias
 * invocaciones comparten instancia, así que el cliente se guarda en globalThis y
 * se reutiliza; attachDatabasePool mantiene viva la instancia lo justo para cerrar
 * conexiones ociosas sin dejarlas colgadas en Atlas.
 */
const cache = globalThis.__dzMongo ?? (globalThis.__dzMongo = { client: null, db: null, connecting: null });

export async function getDb() {
  if (cache.db) return cache.db;
  if (cache.connecting) return cache.connecting;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    const err = new Error('MONGODB_URI no está configurada');
    err.code = 'DZ_CONFIG';
    throw err;
  }

  const client = new MongoClient(uri, {
    appName: 'dream-zone-web',
    maxPoolSize: 10,
    maxIdleTimeMS: 5000,
    serverSelectionTimeoutMS: 8000,
  });
  attachDatabasePool(client);

  cache.connecting = client
    .connect()
    .then(() => {
      cache.client = client;
      cache.db = client.db(process.env.MONGODB_DB || DEFAULT_DB);
      return cache.db;
    })
    .catch((err) => {
      cache.connecting = null; // permite reintentar en la siguiente invocación
      throw err;
    });

  return cache.connecting;
}

/** Cierra la conexión (solo para scripts de consola, no para las funciones). */
export async function closeDb() {
  if (cache.client) await cache.client.close();
  cache.client = null;
  cache.db = null;
  cache.connecting = null;
}
