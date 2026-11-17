const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite');
test('video jobs: trusted conversion only, idempotency, leases, cancellation and private file access',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;
   create schema auth;create table auth.users(id uuid primary key);
   create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;
   create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
   create table storage.objects(bucket_id text,name text,primary key(bucket_id,name));
   create function storage.foldername(text) returns text[] language sql as $$select array[split_part($1,'/',1)]$$;
   alter table storage.objects enable row level security;grant usage on schema storage to authenticated,anon;
   grant select,insert,update,delete on storage.objects to authenticated,anon;`);
  for(const file of fs.readdirSync('supabase/migrations').sort())await db.exec(fs.readFileSync('supabase/migrations/'+file,'utf8'));
  const ids=['1','2','3','4'].map(n=>'00000000-0000-4000-8000-00000000000'+n),[owner,alice,bob,outside]=ids;
  await db.query('insert into auth.users values($1),($2),($3),($4)',ids);
  await db.exec("insert into mayak_private.invites(token_hash,owner) values(encode(sha256(convert_to('owner','UTF8')),'hex'),true);insert into mayak_private.video_config(worker_url,worker_key) values('https://test.vercel.app/api/process','01234567890123456789012345678901');");
  const as=id=>db.exec(`reset role;select set_config('request.jwt.claim.sub','${id}',false);set role authenticated;`);
  const service=()=>db.exec('reset role;set role service_role;');
  const one=async(sql,args)=>(await db.query(sql,args)).rows[0];
  await as(owner);await db.query("select mayak_redeem('owner','Кэп')");
  for(const [id,name] of [[alice,'Алиса'],[bob,'Боб']]){await as(owner);const token=(await one('select mayak_invite() as t')).t;await as(id);await db.query('select mayak_redeem($1,$2)',[token,name]);}
  const source=alice+'/'+'a'.repeat(24)+'.webm';
  await as(alice);await db.query("insert into storage.objects values('mayak-video-source',$1)",[source]);
  const begin=async(nonce='one',peer=bob,file=source)=>(await one('select row_to_json(j) as job from mayak_video_begin($1,$2,$3,null) j',[file,nonce,peer])).job;
  let job=await begin();assert.equal((await begin()).id,job.id);
  await assert.rejects(db.query('select mayak_video_settings()'));
  await assert.rejects(db.query('select mayak_video_claim($1)',[job.id]));
  await assert.rejects(begin('fake',bob,owner+'/'+'b'.repeat(24)+'.mp4'));
  await assert.rejects(db.query("select mayak_attach_to(null,'video',$1,'{}','','fake',null)",[source]));
  await as(owner);assert.equal((await db.query('select * from mayak_video_jobs')).rows.length,0);
  assert.equal((await db.query("select * from storage.objects where bucket_id='mayak-video-source'")).rows.length,0);
  await service();job=(await one('select row_to_json(j) as job from mayak_video_claim($1) j',[job.id])).job;
  assert.equal(job.attempt,1);assert.equal((await one('select (mayak_video_claim($1)).id as id',[job.id])).id,null);
  const meta={w:480,h:480,duration:2,size:40000,video:'h264',audio:'aac'};
  const finish=async(ticket=job.ticket,m=meta)=>(await one('select row_to_json(j) as job from mayak_video_finish($1,$2,$3,null) j',[job.id,ticket,JSON.stringify(m)])).job;
  await assert.rejects(finish(job.ticket,{...meta,video:'vp8'}));
  await assert.rejects(finish()); // готовый файл ещё не существует
  await db.exec('reset role;');await db.query("insert into storage.objects values('mayak-video',$1)",[job.output]);
  await service();const sent=await finish();assert.equal(sent.state,'sent');
  assert.equal((await finish()).message_id,sent.message_id);
  await as(alice);assert.equal((await begin()).state,'sent');
  await assert.rejects(db.query("insert into storage.objects values('mayak-video',$1)",[job.output.replace('.mp4','x.mp4')]));
  const visible=async()=> (await db.query("select * from storage.objects where bucket_id='mayak-video'")).rows;
  assert.equal((await visible()).length,1);
  await as(bob);assert.equal((await visible()).length,1);
  assert.equal((await db.query("select * from mayak_messages where kind='video'")).rows.length,1);
  await as(owner);assert.equal((await visible()).length,0); // админ не видит чужой личный файл
  await as(outside);assert.equal((await visible()).length,0);await assert.rejects(begin());
  await as(alice);await db.query('select mayak_delete($1)',[sent.message_id]);
  assert.equal((await db.query("delete from storage.objects where bucket_id='mayak-video' and name=$1 returning name",[job.output])).rows.length,1);
  // Отмена и повтор с новой арендой: старый worker не может дописать сообщение.
  const second=alice+'/'+'c'.repeat(24)+'.mp4';await db.query("insert into storage.objects values('mayak-video-source',$1)",[second]);
  const queued=await begin('two',null,second);
  await service();const first=(await one('select row_to_json(j) as job from mayak_video_claim($1) j',[queued.id])).job;
  await db.exec("reset role;update mayak_video_jobs set updated=now()-interval '4 minutes' where state='processing';");
  await service();const retry=(await one('select row_to_json(j) as job from mayak_video_claim($1) j',[queued.id])).job;assert.notEqual(retry.ticket,first.ticket);
  assert.equal((await one('select (mayak_video_finish($1,$2,null,$3)).state as s',[queued.id,first.ticket,'old failure'])).s,'processing');
  await as(alice);await db.query('select mayak_video_cancel($1)',[queued.id]);
  await service();assert.equal((await one('select (mayak_video_finish($1,$2,$3,null)).state as s',[queued.id,retry.ticket,JSON.stringify(meta)])).s,'cancelled');
  await db.exec('reset role;set role anon;');await assert.rejects(db.query('select mayak_video_settings()'));await assert.rejects(db.query('select mayak_video_begin($1,$2,null,null)',[source,'x']));
 }finally{await db.close();}
});
