/**
 * Silent unlock on the web (docs/E2EE.md §3).
 *
 * The device key is a **non-extractable** WebCrypto AES-GCM key living in
 * IndexedDB: script can ask it to decrypt but cannot read its bytes, so an XSS
 * bug can use the key while the tab is open but cannot exfiltrate it to be
 * replayed later. That is why this one wrapping uses WebCrypto instead of the
 * XChaCha envelope everywhere else — the raw key never exists in JS.
 *
 * The passphrase-wrapped copy on the server stays the anchor; this is only a
 * convenience so the passphrase isn't retyped every visit.
 */
const DB_NAME = "munshi-vault";
const STORE = "device";
const RECORD_ID = "master";

interface DeviceRecord {
  id: string;
  key: CryptoKey;      // non-extractable
  iv: Uint8Array;
  wrapped: ArrayBuffer; // masterKey under `key`
  userId: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = run(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}

/** Remember this browser: wrap the masterKey under a fresh non-extractable key. */
export async function rememberDevice(userId: string, masterKey: Uint8Array): Promise<void> {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    masterKey as unknown as BufferSource
  );
  const record: DeviceRecord = { id: RECORD_ID, key, iv, wrapped, userId };
  await tx("readwrite", (s) => s.put(record));
}

/**
 * Try to open without a passphrase. Returns null whenever anything is off —
 * no record, a different user, storage cleared, or a key the browser evicted.
 * A null here is never an error the user should see; it just means "ask".
 */
export async function unwrapWithDevice(userId: string): Promise<Uint8Array | null> {
  try {
    const record = (await tx<DeviceRecord | undefined>("readonly", (s) => s.get(RECORD_ID))) ?? null;
    if (!record || record.userId !== userId) return null;
    const raw = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: record.iv as unknown as BufferSource },
      record.key,
      record.wrapped
    );
    return new Uint8Array(raw);
  } catch {
    return null;
  }
}

/** "Forget this device" — the next visit asks for the passphrase again. */
export async function forgetDevice(): Promise<void> {
  try {
    await tx("readwrite", (s) => s.delete(RECORD_ID));
  } catch {
    // nothing stored, nothing to forget
  }
}

export async function isDeviceRemembered(userId: string): Promise<boolean> {
  try {
    const record = (await tx<DeviceRecord | undefined>("readonly", (s) => s.get(RECORD_ID))) ?? null;
    return !!record && record.userId === userId;
  } catch {
    return false;
  }
}
