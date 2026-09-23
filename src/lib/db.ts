// Мини key-value поверх IndexedDB. Работает и в окне, и в сервис-воркере.
const DB_NAME = 'fog-spb';
const STORE = 'kv';

let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }).catch((e) => {
      dbp = null;
      throw e;
    });
  }
  return dbp;
}

function wrap<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  try {
    const db = await open();
    return (await wrap(db.transaction(STORE).objectStore(STORE).get(key))) as T | undefined;
  } catch {
    return undefined;
  }
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  try {
    const db = await open();
    await wrap(db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key));
  } catch {
    // приватный режим / запрет хранилища — приложение работает и без кэша
  }
}
