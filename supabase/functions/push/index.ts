// Edge Function `push`: рассылает Web Push о новом сообщении «Маяка».
// Вызывается триггером базы с телом {"id": <номер сообщения>}. Проверка JWT для функции должна быть выключена:
// защита — в mayak_push_claim (сообщение выдаётся один раз и только свежее).
// Приватный VAPID-ключ: секрет функции VAPID_PRIVATE_KEY или Supabase Vault (mayak_vapid_private_key).
// Без зависимостей — только WebCrypto.

const VAPID_PUBLIC_KEY = 'BAC86tHcPhoq4UDXlrSMPGyKlP4sUC6ufrOArHxPGKWAagqwVwcuXX2PsQ_BsKnBkdGwSvF11wqcP31Jj0AOavM';
const VAPID_SUBJECT = 'https://romentiy2012-droid.github.io/mayak-messenger/';

const encoder = new TextEncoder();
function fromBase64Url(value) {
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}
function toBase64Url(bytes) {
  let raw = '';
  new Uint8Array(bytes).forEach((byte) => { raw += String.fromCharCode(byte); });
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function concat(...parts) {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
async function hkdf(salt, secret, info, length) {
  const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

// RFC 8292: заголовок Authorization для push-сервиса.
async function vapidAuthorization(endpoint, privateKey, publicKey = VAPID_PUBLIC_KEY, subject = VAPID_SUBJECT, now = Date.now()) {
  const point = fromBase64Url(publicKey);
  const key = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256', d: privateKey.trim(),
    x: toBase64Url(point.slice(1, 33)), y: toBase64Url(point.slice(33, 65)),
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = toBase64Url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = toBase64Url(encoder.encode(JSON.stringify({
    aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject,
  })));
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(header + '.' + claims));
  return 'vapid t=' + header + '.' + claims + '.' + toBase64Url(signature) + ', k=' + publicKey;
}

// RFC 8291 + RFC 8188 (aes128gcm): шифрование содержимого для конкретной подписки.
async function encryptPayload(subscription, plaintext) {
  const clientPublic = fromBase64Url(subscription.p256dh);
  const authSecret = fromBase64Url(subscription.auth);
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const serverPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const clientKey = await crypto.subtle.importKey('raw', clientPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: clientKey }, pair.privateKey, 256));
  const material = await hkdf(authSecret, shared, concat(encoder.encode('WebPush: info\0'), clientPublic, serverPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const contentKey = await hkdf(salt, material, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, material, encoder.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', contentKey, 'AES-GCM', false, ['encrypt']);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(plaintext, Uint8Array.of(2))));
  return concat(salt, Uint8Array.of(0, 0, 16, 0), Uint8Array.of(serverPublic.length), serverPublic, sealed);
}

async function sendPush(subscription, payload, privateKey) {
  const body = await encryptPayload(subscription, encoder.encode(JSON.stringify(payload)));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await vapidAuthorization(subscription.endpoint, privateKey),
        'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
        TTL: '86400', Urgency: 'high',
      },
      body, signal: controller.signal,
    });
    await response.body?.cancel();
    return response.status;
  } finally { clearTimeout(timeout); }
}

async function database(name, args) {
  const url = Deno.env.get('SUPABASE_URL'), key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const response = await fetch(url + '/rest/v1/rpc/' + name, {
    method: 'POST',
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!response.ok) throw new Error(name + ': ' + response.status + ' ' + (await response.text()).slice(0, 300));
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function deliver(id) {
  const job = await database('mayak_push_claim', { p_id: id });
  if (!job) return { skipped: true };
  const privateKey = Deno.env.get('VAPID_PRIVATE_KEY') || job.vapid;
  if (!privateKey) throw new Error('Не задан приватный VAPID-ключ.');
  const payload = { id: job.id, title: job.title, body: job.body };
  const gone = [], failed = [];
  let sent = 0;
  await Promise.all(job.subscriptions.map(async (subscription) => {
    try {
      // badge — число непрочитанных именно этого получателя, для значка на иконке.
      const status = await sendPush(subscription, { ...payload, badge: subscription.badge || 0 }, privateKey);
      if (status >= 200 && status < 300) sent++;
      else if (status === 404 || status === 410) gone.push(subscription.endpoint);
      else failed.push(new URL(subscription.endpoint).hostname + ' ' + status);
    } catch (error) { failed.push(String(error && error.message || error).slice(0, 120)); }
  }));
  if (gone.length) await database('mayak_push_drop', { p_endpoints: gone });
  if (failed.length) console.error('push failed', failed);
  return { sent, removed: gone.length, failed };
}

async function handler(request) {
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  let id;
  try { id = Number((await request.json()).id); } catch (_error) { id = NaN; }
  if (!Number.isSafeInteger(id) || id < 1) return Response.json({ error: 'bad id' }, { status: 400 });
  const work = deliver(id);
  // Доставка продолжается, даже если база закрыла соединение раньше ответа.
  if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(work.catch(() => {}));
  try { return Response.json(await work); }
  catch (error) { console.error(error); return Response.json({ error: String(error && error.message || error) }, { status: 500 }); }
}

if (typeof Deno !== 'undefined') Deno.serve(handler);

export { encryptPayload, vapidAuthorization, VAPID_PUBLIC_KEY };
