// Edge Function `reset`: меняет пароль участника по одноразовому коду владельца.
// Тело: {"token": "<код из ссылки>", "password": "<новый пароль>"}. Проверка JWT выключена:
// участник ещё не вошёл; защита — сам код (256 бит, одноразовый, действует сутки, в базе только хэш).
// Ответ: {"email": "<адрес для входа>"} — приложение сразу входит с новым паролем.

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, apikey, authorization, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};
function reply(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}
async function service(path, method, body) {
  const url = Deno.env.get('SUPABASE_URL'), key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const response = await fetch(url + path, {
    method,
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_error) { data = null; }
  return { ok: response.ok, status: response.status, data };
}

async function handler(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return reply({ error: 'Method Not Allowed' }, 405);
  let token = '', password = '';
  try { const body = await request.json(); token = String(body.token || ''); password = String(body.password || ''); } catch (_error) { /* пустое тело */ }
  if (!/^[0-9a-f]{64}$/.test(token)) return reply({ error: 'Ссылка для сброса пароля неверна.' }, 400);
  if (password.length < 8 || password.length > 128) return reply({ error: 'Пароль должен быть от 8 до 128 символов.' }, 400);
  try {
    const check = await service('/rest/v1/rpc/mayak_reset_check', 'POST', { p_token: token });
    if (!check.ok) throw new Error('reset_check ' + check.status);
    if (!check.data) return reply({ error: 'Ссылка недействительна или устарела. Попросите владельца прислать новую.' }, 400);
    const update = await service('/auth/v1/admin/users/' + check.data, 'PUT', { password });
    if (!update.ok) {
      if (update.status === 422) return reply({ error: 'Этот пароль не подходит: слишком простой или совпадает с прежним. Выберите другой.' }, 400);
      throw new Error('auth ' + update.status);
    }
    await service('/rest/v1/rpc/mayak_reset_done', 'POST', { p_token: token });
    return reply({ email: update.data && update.data.email });
  } catch (error) {
    console.error(error);
    return reply({ error: 'Не удалось сменить пароль. Попробуйте ещё раз позже.' }, 500);
  }
}

if (typeof Deno !== 'undefined') Deno.serve(handler);

export { handler };
