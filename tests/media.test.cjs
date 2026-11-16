const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const fs=require('node:fs');
test('photo and voice messages: own files only, safe metadata, no editing, deletion drops the file',async()=>{
 const db=new PGlite();
 await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`);
 for(const file of fs.readdirSync('supabase/migrations').sort()) await db.exec(fs.readFileSync('supabase/migrations/'+file,'utf8'));
 const owner='00000000-0000-4000-8000-000000000001',guest='00000000-0000-4000-8000-000000000002',outsider='00000000-0000-4000-8000-000000000003';
 await db.exec(`insert into auth.users values('${owner}'),('${guest}'),('${outsider}'); insert into mayak_private.invites(token_hash,owner) values(encode(sha256(convert_to('owner-code','UTF8')),'hex'),true);`);
 const as=async id=>db.exec(`reset role; select set_config('request.jwt.claim.sub','${id}',false); set role authenticated;`);
 const one=async(sql,args)=>(await db.query(sql,args)).rows[0];
 const pause=()=>new Promise(resolve=>setTimeout(resolve,600));
 const attach=(kind,file,meta,text,nonce,reply=null)=>one('select (m).id::int as id,(m).kind as kind,(m).text as text,(m).file as file,(m).file_meta as meta,(m).reply_to::int as reply from public.mayak_attach($1,$2,$3,$4,$5,$6) m',[kind,file,JSON.stringify(meta),text,nonce,reply]);
 await as(owner);await db.query("select public.mayak_redeem('owner-code','Кэп')");
 const invite=(await one('select public.mayak_invite() as token')).token;
 await as(guest);await db.query('select public.mayak_redeem($1,$2)',[invite,'Гость']);
 await db.query('select public.mayak_push_subscribe($1,$2,$3)',['https://push.example/guest','B'+'a'.repeat(86),'b'.repeat(22)]);

 await as(owner);
 const photo=await attach('photo',owner+'/abcdefgh1234.jpg',{w:1600,h:1200,size:250000,mime:'image/jpeg',evil:'<script>'},'  Закат  ','p1');
 assert.equal(photo.kind,'photo');assert.equal(photo.text,'Закат');
 assert.deepEqual(photo.meta,{caption:true,w:1600,h:1200,duration:0,size:250000,mime:'image/jpeg'});
 assert.equal((await attach('photo',owner+'/abcdefgh1234.jpg',{},'','p1')).id,photo.id); // повтор с тем же nonce
 await pause();
 const bare=await attach('photo',owner+'/abcdefgh5678.webp',{w:99999,h:-5},'','p2',photo.id);
 assert.equal(bare.text,'📷 Фото');assert.equal(bare.meta.caption,false);assert.equal(bare.meta.w,10000);assert.equal(bare.meta.h,0);assert.equal(bare.reply,photo.id);
 await pause();
 const voice=await attach('voice',owner+'/voice_ABCDEFGH.m4a',{duration:12.4,size:40000,mime:'audio/mp4'},'подпись не нужна','v1');
 assert.equal(voice.text,'🎤 Голосовое сообщение');assert.equal(voice.meta.caption,false);assert.equal(Number(voice.meta.duration),12.4);
 // Чужая папка, обход пути, неизвестный вид, повтор файла.
 await pause();
 await assert.rejects(attach('photo',guest+'/abcdefgh1234.jpg',{},'','x1'));
 await assert.rejects(attach('photo',owner+'/../'+guest+'/abcdefgh.jpg',{},'','x2'));
 await assert.rejects(attach('photo',owner+'/sub/abcdefgh12.jpg',{},'','x3'));
 await assert.rejects(attach('video',owner+'/abcdefgh9999.mp4',{},'','x4'));
 await assert.rejects(attach('photo',owner+'/abcdefgh1234.jpg',{},'','x5'));
 await assert.rejects(db.query("insert into public.mayak_messages(user_id,name,text,nonce,kind,file) values($1,'x','x','n','photo','f')",[owner]));
 // Вложение не редактируется; уведомление получает понятный текст.
 await assert.rejects(db.query("select public.mayak_edit($1,'Новая подпись')",[photo.id]));
 await db.exec('reset role; set role service_role;');
 assert.equal((await one('select public.mayak_push_claim($1) as job',[voice.id])).job.body,'🎤 Голосовое сообщение');
 // Гость видит вложения, но удалить чужое не может; автор удаляет — файл из сообщения пропадает.
 await as(guest);
 assert.equal((await db.query("select 1 from public.mayak_messages where kind<>'text'")).rows.length,3);
 await assert.rejects(db.query('select public.mayak_delete($1)',[photo.id]));
 await as(owner);
 const gone=await one('select (m).file as file,(m).file_meta as meta,(m).text as text,(m).deleted as deleted,(m).kind as kind from public.mayak_delete($1) m',[photo.id]);
 assert.deepEqual({file:gone.file,meta:gone.meta,text:gone.text,kind:gone.kind},{file:null,meta:null,text:'',kind:'photo'});assert.ok(gone.deleted);
 // Обычный текст по-прежнему работает и остаётся текстом.
 await pause();
 const text=await one("select (m).kind as kind,(m).file as file from public.mayak_post('Привет','t1',null) m");
 assert.deepEqual(text,{kind:'text',file:null});
 await as(outsider);
 await assert.rejects(attach('photo',outsider+'/abcdefgh1234.jpg',{},'','o1'));
 await db.exec('reset role; set role anon;');
 await assert.rejects(db.query("select public.mayak_attach('photo','a/abcdefgh.jpg','{}','','n',null)"));
 await db.close();
});
