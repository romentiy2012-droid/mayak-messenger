const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');

async function loadFunction(){
 const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'mayak-push-')),'push.mjs');
 fs.copyFileSync('supabase/functions/push/index.ts',file);
 return import(require('node:url').pathToFileURL(file).href);
}
function hkdf(salt,secret,info,length){return Buffer.from(crypto.hkdfSync('sha256',secret,salt,info,length));}

test('push payload is decryptable by the subscriber (RFC 8291) and VAPID is valid',async()=>{
 const push=await loadFunction();
 // Независимая расшифровка на node:crypto от имени браузера-получателя.
 const browser=crypto.createECDH('prime256v1');browser.generateKeys();
 const auth=crypto.randomBytes(16);
 const text=JSON.stringify({title:'Кэп',body:'Привет, маяк! 🌊'});
 const body=Buffer.from(await push.encryptPayload({p256dh:browser.getPublicKey().toString('base64url'),auth:auth.toString('base64url')},new TextEncoder().encode(text)));
 const salt=body.subarray(0,16),size=body.readUInt32BE(16),idLength=body[20];
 assert.equal(size,4096);assert.equal(idLength,65);
 const serverPublic=body.subarray(21,86),sealed=body.subarray(86);
 assert.ok(body.length<=4096);
 const shared=browser.computeSecret(serverPublic);
 const material=hkdf(auth,shared,Buffer.concat([Buffer.from('WebPush: info\0'),browser.getPublicKey(),serverPublic]),32);
 const key=hkdf(salt,material,Buffer.from('Content-Encoding: aes128gcm\0'),16);
 const nonce=hkdf(salt,material,Buffer.from('Content-Encoding: nonce\0'),12);
 const decipher=crypto.createDecipheriv('aes-128-gcm',key,nonce);
 decipher.setAuthTag(sealed.subarray(sealed.length-16));
 const plain=Buffer.concat([decipher.update(sealed.subarray(0,sealed.length-16)),decipher.final()]);
 assert.equal(plain[plain.length-1],2);
 assert.equal(plain.subarray(0,-1).toString('utf8'),text);

 const server=crypto.createECDH('prime256v1');server.generateKeys();
 const publicKey=server.getPublicKey().toString('base64url');
 const header=await push.vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc',server.getPrivateKey().toString('base64url'),publicKey,'https://example.org/',1_700_000_000_000);
 const match=/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
 assert.ok(match);assert.equal(match[4],publicKey);
 const claims=JSON.parse(Buffer.from(match[2],'base64url'));
 assert.deepEqual(claims,{aud:'https://fcm.googleapis.com',exp:1_700_000_000+43200,sub:'https://example.org/'});
 const point=server.getPublicKey();
 const verifyKey=crypto.createPublicKey({key:{kty:'EC',crv:'P-256',x:point.subarray(1,33).toString('base64url'),y:point.subarray(33).toString('base64url')},format:'jwk'});
 assert.ok(crypto.verify('sha256',Buffer.from(match[1]+'.'+match[2]),{key:verifyKey,dsaEncoding:'ieee-p1363'},Buffer.from(match[3],'base64url')));
 // Ключ в приложении и в функции должен совпадать.
 assert.ok(fs.readFileSync('config.js','utf8').includes(push.VAPID_PUBLIC_KEY));
});

test('push subscriptions: members only, one claim per message, sender excluded',async()=>{
 const db=new PGlite();
 await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`);
 await db.exec(fs.readFileSync('supabase/migrations/202611160001_cloud.sql','utf8'));
 await db.exec(fs.readFileSync('supabase/migrations/202611160002_push.sql','utf8'));
 const owner='00000000-0000-4000-8000-000000000001',guest='00000000-0000-4000-8000-000000000002',outsider='00000000-0000-4000-8000-000000000003';
 await db.exec(`insert into auth.users values('${owner}'),('${guest}'),('${outsider}'); insert into mayak_private.invites(token_hash,owner) values(encode(sha256(convert_to('owner-code','UTF8')),'hex'),true);`);
 async function as(id){await db.exec(`reset role; select set_config('request.jwt.claim.sub','${id}',false); set role authenticated;`)}
 const p256dh='B'+'a'.repeat(86),auth='b'.repeat(22);
 const subscribe=endpoint=>db.query('select public.mayak_push_subscribe($1,$2,$3)',[endpoint,p256dh,auth]);
 await as(outsider);
 await assert.rejects(subscribe('https://push.example/outsider'));
 await as(owner);
 await db.query("select public.mayak_redeem('owner-code','Кэп')");
 const invite=(await db.query('select public.mayak_invite() as token')).rows[0].token;
 await subscribe('https://push.example/owner');
 await subscribe('https://push.example/owner');
 await assert.rejects(subscribe('http://push.example/plain'));
 await assert.rejects(db.query('select * from mayak_private.push_subscriptions'));
 await assert.rejects(db.query('select public.mayak_push_claim(1)'));
 await as(guest);
 await db.query('select public.mayak_redeem($1,$2)',[invite,'Гость']);
 for(let i=0;i<12;i++)await subscribe('https://push.example/guest-'+i);
 await db.query("select public.mayak_push_unsubscribe('https://push.example/owner')"); // чужую подписку удалить нельзя
 // Сообщение отправляется, хотя pg_net в тесте нет: ошибка уведомления не мешает переписке.
 const message=(await db.query("select (public.mayak_send('Привет','one')).id as id")).rows[0];
 await db.exec('reset role; set role service_role;');
 const job=(await db.query('select public.mayak_push_claim($1) as job',[message.id])).rows[0].job;
 assert.equal(job.title,'Гость');assert.equal(job.body,'Привет');
 assert.deepEqual(job.subscriptions.map(item=>item.endpoint),['https://push.example/owner']);
 assert.equal((await db.query('select public.mayak_push_claim($1) as job',[message.id])).rows[0].job,null);
 await db.query('select public.mayak_push_drop($1)',[['https://push.example/owner']]);
 await db.exec('reset role;');
 const rows=(await db.query('select user_id,count(*)::int as n from mayak_private.push_subscriptions group by user_id')).rows;
 assert.deepEqual(rows,[{user_id:guest,n:10}]);
 await db.exec('set role anon;');
 await assert.rejects(db.query('select public.mayak_push_claim(1)'));
 await assert.rejects(subscribe('https://push.example/anon'));
 await db.close();
});
