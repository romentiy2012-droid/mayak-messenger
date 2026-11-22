// Локальные данные разделены по облачному проекту и аккаунту. Здесь нет токенов.
const project = (window.MAYAK_CONFIG || {}).supabaseURL || location.pathname;
const blocked = new Set();
const key = user => project + ':' + user;
function open() {return new Promise((resolve, reject) => {
  const request = indexedDB.open('mayak-offline', 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('history', {keyPath:'key'});
    request.result.createObjectStore('outbox', {keyPath:'key'}).createIndex('account', 'account');
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});}
async function run(store, mode, action) {
  const db = await open();
  try {return await new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode), request = action(tx.objectStore(store)); let value;
    if(request) request.onsuccess = () => {value = request.result;};
    tx.oncomplete = () => resolve(value); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('Сохранение отменено'));
  });} finally {db.close();}
}
export const activateAccount = user => blocked.delete(key(user));
export const loadHistory = user => run('history', 'readonly', store => store.get(key(user))).then(row => row?.data || null);
export function saveHistory(user, data) {
  if(blocked.has(key(user))) return Promise.resolve();
  return run('history', 'readwrite', store => blocked.has(key(user)) ? null : store.put({key:key(user), data}));
}
export const queuedMessages = user => run('outbox', 'readonly', store => store.index('account').getAll(key(user)));
export function saveQueued(item) {
  if(blocked.has(key(item.user))) return Promise.reject(new Error('Вход изменился.'));
  return run('outbox', 'readwrite', store => {
    if(blocked.has(key(item.user))) throw new Error('Вход изменился.');
    return store.put({...item, key:key(item.user) + ':' + item.nonce, account:key(item.user)});
  });
}
export const removeQueued = item => run('outbox', 'readwrite', store => store.delete(key(item.user) + ':' + item.nonce));
export async function forgetAccount(user) {
  if(!user) return;
  blocked.add(key(user));
  await Promise.all([
    run('history', 'readwrite', store => store.delete(key(user))),
    run('outbox', 'readwrite', store => {
      const request = store.index('account').openCursor(IDBKeyRange.only(key(user)));
      request.onsuccess = () => {const cursor = request.result; if(cursor) {cursor.delete(); cursor.continue();}};
      return null;
    })
  ]);
}
