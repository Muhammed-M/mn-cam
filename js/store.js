// Local photo queue in IndexedDB. Every photo lands here first and stays until
// the server confirms it (upload step), so nothing is lost without signal.

const DB_NAME = 'nm-cam';
const STORE = 'photos';
let dbPromise;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
  }
  return dbPromise;
}

async function run(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

export const savePhoto = (rec) => run('readwrite', (s) => s.put(rec));
export const deletePhoto = (id) => run('readwrite', (s) => s.delete(id));
export const countPhotos = () => run('readonly', (s) => s.count());
export const listIds = () => run('readonly', (s) => s.getAllKeys());
export const getPhoto = (id) => run('readonly', (s) => s.get(id));

// Ask the browser not to evict our queue under storage pressure.
export function requestPersistence() {
  try { navigator.storage?.persist?.(); } catch { /* not supported */ }
}
