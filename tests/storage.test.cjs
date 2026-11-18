const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite');

test('storage: service-only redacted inventory, protected files and durable selected cleanup',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;
   create schema auth;create table auth.users(id uuid primary key);
   create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;
   create schema storage;
   create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
   create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,version text not null default gen_random_uuid()::text,
    created_at timestamptz not null default now(),updated_at timestamptz not null default now(),metadata jsonb default '{}',unique(bucket_id,name));
   create function storage.foldername(text) returns text[] language sql as $$select array[split_part($1,'/',1)]$$;
   alter table storage.objects enable row level security;grant usage on schema storage to authenticated,anon;
   grant select,insert,update,delete on storage.objects to authenticated,anon;`);
  for(const file of fs.readdirSync('supabase/migrations').sort())await db.exec(fs.readFileSync('supabase/migrations/'+file,'utf8'));
  const [owner,alice,bob,outside]=['1','2','3','4'].map(n=>'00000000-0000-4000-8000-00000000000'+n);
  await db.query('insert into auth.users values($1),($2),($3),($4)',[owner,alice,bob,outside]);
  await db.exec("insert into mayak_private.invites(token_hash,owner) values(encode(sha256(convert_to('owner','UTF8')),'hex'),true);");
  const as=id=>db.exec(`reset role;select set_config('request.jwt.claim.sub','${id}',false);set role authenticated;`);
  const service=()=>db.exec('reset role;set role service_role;');
  const admin=()=>db.exec('reset role;');
  const one=async(sql,args)=>(await db.query(sql,args)).rows[0];
  await as(owner);await db.query("select mayak_redeem('owner','Кэп')");
  for(const [id,name] of [[alice,'Алиса'],[bob,'Боб']]){await as(owner);const token=(await one('select mayak_invite() t')).t;await as(id);await db.query('select mayak_redeem($1,$2)',[token,name]);}
  const overview=async(actor=owner,filter='all',offset=0)=>(await one('select mayak_storage_overview($1,$2,$3) result',[actor,filter,offset])).result;
  const prepare=async(items,nonce='cleanup-one',actor=owner)=>(await one('select mayak_storage_prepare($1,$2,$3) result',[actor,JSON.stringify(items),nonce])).result;
  const finish=async(op,id,success=true,actor=owner)=>(await one('select mayak_storage_finish($1,$2,$3,$4,null) result',[actor,op,id,success])).result;
  for(const id of [owner,alice,outside]){await as(id);await assert.rejects(overview(owner));await assert.rejects(prepare([], 'forged',owner));}
  await db.exec('reset role;set role anon;');await assert.rejects(overview());
  await service();await assert.rejects(overview(alice));await assert.rejects(overview(outside));

  const paths={private:alice+'/private-photo.jpg',caption:owner+'/caption-photo.jpg',usedAvatar:alice+'/'+'a'.repeat(24)+'.jpg',
   oldAvatar:alice+'/'+'b'.repeat(24)+'.jpg',fresh:alice+'/'+'c'.repeat(24)+'.mp4',busy:alice+'/'+'d'.repeat(24)+'.mp4',
   failed:alice+'/'+'e'.repeat(24)+'.mp4',recentFailed:alice+'/'+'f'.repeat(24)+'.mp4',unknown:'unrelated-secret.bin'};
  await admin();
  const upload=async(bucket,name,bytes,mime,age='2 days')=>(await one("insert into storage.objects(bucket_id,name,created_at,updated_at,metadata) values($1,$2,now()-$3::interval,now()-$3::interval,$4) returning id",[bucket,name,age,JSON.stringify(bytes===null?{}:{size:bytes,mimetype:mime})])).id;
  const ids={};
  ids.private=await upload('mayak',paths.private,100,'image/jpeg');
  ids.caption=await upload('mayak',paths.caption,200,'image/jpeg');
  ids.usedAvatar=await upload('mayak-avatars',paths.usedAvatar,50,'image/jpeg');
  ids.oldAvatar=await upload('mayak-avatars',paths.oldAvatar,60,'image/jpeg');
  ids.fresh=await upload('mayak-video-source',paths.fresh,300,'video/mp4','1 minute');
  ids.busy=await upload('mayak-video-source',paths.busy,400,'video/mp4');
  ids.failed=await upload('mayak-video-source',paths.failed,500,'video/mp4');
  ids.recentFailed=await upload('mayak-video-source',paths.recentFailed,600,'video/mp4');
  ids.unknown=await upload('external-backup',paths.unknown,null,'');
  const privateMessage=(await one("insert into mayak_messages(user_id,name,text,nonce,kind,file,file_meta,peer_a,peer_b) values($1,'Алиса','Личная подпись','private','photo',$2,'{\"caption\":true}',$1,$3) returning id",[alice,paths.private,bob])).id;
  const captionMessage=await one("insert into mayak_messages(user_id,name,text,nonce,kind,file,file_meta) values($1,'Кэп','Сохранить подпись','caption','photo',$2,'{\"caption\":true}') returning id,rev",[owner,paths.caption]);
  const reply=(await one("insert into mayak_messages(user_id,name,text,nonce,reply_to) values($1,'Кэп','Сохранить ответ','reply',$2) returning id",[owner,captionMessage.id])).id;
  await db.query('update mayak_members set avatar_file=$1 where id=$2',[paths.usedAvatar,alice]);
  const busyJob=(await one("insert into mayak_video_jobs(user_id,nonce,source,state,updated) values($1,'busy',$2,'processing',now()-interval '4 minutes') returning id",[alice,paths.busy])).id;
  const oldJob=(await one("insert into mayak_video_jobs(user_id,nonce,source,state,updated,ticket) values($1,'failed',$2,'failed',now()-interval '2 days',gen_random_uuid()) returning id",[alice,paths.failed])).id;
  await db.query("insert into mayak_video_jobs(user_id,nonce,source,state,updated) values($1,'recent-failed',$2,'failed',now()-interval '1 hour')",[alice,paths.recentFailed]);
  // Owner cannot download or remove another pair's private attachment, even knowing its path.
  await as(owner);assert.equal((await db.query("select name from storage.objects where name=$1",[paths.private])).rows.length,0);
  assert.equal((await db.query("delete from storage.objects where name=$1 returning id",[paths.private])).rows.length,0);
  await as(bob);assert.equal((await db.query("select name from storage.objects where name=$1",[paths.private])).rows.length,1);
  await as(outside);assert.equal((await db.query('select * from storage.objects')).rows.length,0);

  await service();let report=await overview();
  assert.equal(report.storage.objects_count,9);assert.equal(report.storage.used_bytes,2210);assert.equal(report.storage.unknown_size_count,1);
  const serialized=JSON.stringify(report);for(const value of Object.values(paths))assert.ok(!serialized.includes(value));
  assert.ok(!serialized.includes('Личная подпись'));assert.ok(!serialized.includes(alice));assert.ok(!serialized.includes(bob));
  let byId=new Map(report.items.map(item=>[item.id,item]));
  assert.equal(byId.get(ids.private).scope,'direct');assert.equal(byId.get(ids.private).can_delete,true);
  for(const key of ['usedAvatar','fresh','busy','recentFailed','unknown'])assert.equal(byId.get(ids[key]).can_delete,false,key);
  assert.equal(byId.get(ids.failed).can_delete,true);assert.equal((await overview(owner,'photo')).items.length,2);
  await assert.rejects(overview(owner,'bogus'));await assert.rejects(overview(owner,'all',-1));
  const selected=key=>({id:ids[key],version:byId.get(ids[key]).version});
  for(const key of ['usedAvatar','fresh','busy','recentFailed','unknown'])await assert.rejects(prepare([selected(key)],'protected-'+key));
  await assert.rejects(prepare([],'empty'));await assert.rejects(prepare(Array(21).fill(selected('caption')),'too-many'));
  await assert.rejects(prepare([selected('caption'),selected('caption')],'duplicate'));
  await assert.rejects(prepare([{...selected('caption'),version:'stale'}],'wrong-version'));

  const originalSelection=[selected('caption'),selected('failed'),selected('oldAvatar')];
  const operation=await prepare(originalSelection);
  assert.equal(operation.items.length,3);assert.ok(operation.items.every(item=>item.status==='pending'));
  const repeated=await prepare([...originalSelection].reverse());assert.equal(repeated.id,operation.id);assert.equal(repeated.items.length,3);
  await assert.rejects(prepare([selected('private')]));
  await assert.rejects(prepare(originalSelection.map((item,i)=>i?item:{...item,version:'changed'})));
  // Service-only paths are available for the exact selected objects, never arbitrary user-supplied names.
  assert.deepEqual(new Set(operation.items.map(item=>item.path)),new Set([paths.caption,paths.failed,paths.oldAvatar]));
  await admin();const after=await one('select * from mayak_messages where id=$1',[captionMessage.id]);
  assert.equal(after.file,null);assert.equal(after.text,'Сохранить подпись');assert.equal(after.deleted,null);assert.equal(after.kind,'photo');
  assert.equal(after.file_meta.caption,true);assert.equal(after.file_meta.removed,true);assert.ok(after.rev>captionMessage.rev);
  assert.equal((await one('select reply_to from mayak_messages where id=$1',[reply])).reply_to,captionMessage.id);
  assert.equal((await one('select text from mayak_messages where id=$1',[privateMessage])).text,'Личная подпись');
  assert.deepEqual(await one('select state,ticket from mayak_video_jobs where id=$1',[oldJob]),{state:'cancelled',ticket:null});
  assert.equal((await one('select state from mayak_video_jobs where id=$1',[busyJob])).state,'processing');
  // Tombstones also block clients who kept a selected path as a pending local draft.
  await assert.rejects(db.query("insert into mayak_messages(user_id,name,text,nonce,kind,file) values($1,'Кэп','x','reuse','photo',$2)",[owner,paths.caption]));
  await as(alice);await assert.rejects(db.query('select mayak_profile_avatar($1,null,$2)',['Алиса',paths.oldAvatar]));
  await admin();await assert.rejects(db.query("update mayak_video_jobs set state='queued' where id=$1",[oldJob]));
  await service();const stillPresent=await finish(operation.id,ids.caption,true);assert.equal(stillPresent.status,'failed');
  report=await overview();assert.equal(report.storage.used_bytes,2210); // selecting does not falsely free bytes
  const resumed=await prepare(originalSelection);assert.equal(resumed.id,operation.id);assert.equal(resumed.items.find(item=>item.id===ids.caption).status,'pending');
  await assert.rejects(finish(operation.id,ids.private,true));await assert.rejects(finish(operation.id,ids.caption,true,alice));
  // This DELETE emulates the physical Storage API in a synthetic test, never production SQL.
  await admin();await db.query('delete from storage.objects where id=$1',[ids.caption]);
  await service();const done=await finish(operation.id,ids.caption,true);assert.equal(done.status,'deleted');assert.equal(done.bytes,200);
  assert.deepEqual(await finish(operation.id,ids.caption,false),done);assert.ok(!JSON.stringify(done).includes(paths.caption));
  report=await overview();assert.equal(report.storage.used_bytes,2010);
  assert.equal(report.pending_operation.id,operation.id);assert.equal(report.pending_operation.nonce,'cleanup-one');
  assert.equal(report.pending_operation.items.length,3);assert.equal(report.pending_operation.items.find(item=>item.id===ids.caption).status,'deleted');
  assert.ok(!JSON.stringify(report.pending_operation).includes(paths.caption));assert.ok(!JSON.stringify(report.pending_operation).includes('bucket'));
  const recovery=await prepare(report.pending_operation.items.map(({id,version})=>({id,version})),report.pending_operation.nonce);
  assert.equal(recovery.id,operation.id);assert.equal(recovery.items.find(item=>item.id===ids.caption).status,'deleted');
  // Private attachment removal preserves its private message and never publishes its contents.
  const privateOp=await prepare([selected('private')],'private-cleanup');assert.equal(privateOp.items.length,1);
  await admin();const privateAfter=await one('select file,text,deleted,peer_a,peer_b from mayak_messages where id=$1',[privateMessage]);
  assert.equal(privateAfter.file,null);assert.equal(privateAfter.text,'Личная подпись');assert.equal(privateAfter.deleted,null);
  assert.deepEqual([privateAfter.peer_a,privateAfter.peer_b],[alice,bob]);
  // Stable largest-first pagination counts all objects, including protected unknown buckets.
  for(let i=0;i<52;i++)await upload('external-backup','opaque-'+i,1,'');
  await service();report=await overview();assert.equal(report.items.length,50);assert.equal(report.has_more,true);assert.equal(report.total_count,60);
  const next=await overview(owner,'all',50);assert.equal(next.items.length,10);assert.equal(next.has_more,false);
  assert.equal(new Set([...report.items,...next.items].map(item=>item.id)).size,60);
  // An HTTP error after the physical delete is authoritative success when Storage confirms absence.
  await admin();await db.query('delete from storage.objects where id=$1',[ids.failed]);
  await service();assert.equal((await finish(operation.id,ids.failed,false)).status,'deleted');
  await as(owner);await assert.rejects(finish(operation.id,ids.oldAvatar,true,owner));
  await service();
  // A preview becomes stale when a draft is attached, even if its physical object version is unchanged.
  await admin();const changingPath=alice+'/changing-photo.jpg',changing=await upload('mayak',changingPath,70,'image/jpeg');
  await service();const initial=(await overview(owner,'photo')).items.find(item=>item.id===changing);
  await admin();await db.query("insert into mayak_messages(user_id,name,text,nonce,kind,file,peer_a,peer_b) values($1,'Алиса','📷 Фото','changing','photo',$2,$1,$3)",[alice,changingPath,bob]);
  await service();await assert.rejects(prepare([{id:changing,version:initial.version}],'changed-reference'));
  let current=(await overview(owner,'photo')).items.find(item=>item.id===changing);assert.notEqual(current.version,initial.version);
  await admin();await db.query("update storage.objects set version=gen_random_uuid()::text,updated_at=now(),metadata='{}' where id=$1",[changing]);
  await service();await assert.rejects(prepare([{id:changing,version:current.version}],'changed-object'));
  // A previous output ticket remains protected while any attempt of that same job is processing.
  await admin();const busyOutputPath=alice+'/'+busyJob+'_00000000-0000-4000-8000-000000000099.mp4';
  const busyOutput=await upload('mayak-video',busyOutputPath,80,'video/mp4');
  await service();current=(await overview(owner,'video')).items.find(item=>item.id===busyOutput);
  assert.equal(current.can_delete,false);await assert.rejects(prepare([{id:busyOutput,version:current.version}],'busy-old-ticket'));
  // Cancellation does not stop an in-flight signed upload immediately; protect that grace window too.
  await admin();await db.query("update mayak_video_jobs set state='cancelled',updated=now() where id=$1",[busyJob]);
  await service();current=(await overview(owner,'source')).items.find(item=>item.id===ids.busy);assert.equal(current.can_delete,false);
  // Two selected paths of one old failed job validate together before its state/ticket changes.
  await admin();const pairedSourcePath=alice+'/'+'9'.repeat(24)+'.mp4',pairedSource=await upload('mayak-video-source',pairedSourcePath,90,'video/mp4');
  const pair=(await one("insert into mayak_video_jobs(user_id,nonce,source,state,updated,ticket) values($1,'paired',$2,'failed',now()-interval '2 days',gen_random_uuid()) returning id,ticket",[alice,pairedSourcePath]));
  const pairedOutputPath=alice+'/'+pair.id+'_'+pair.ticket+'.mp4',pairedOutput=await upload('mayak-video',pairedOutputPath,100,'video/mp4');
  await db.query('update mayak_video_jobs set output=$1 where id=$2',[pairedOutputPath,pair.id]);
  await service();report=await overview();
  const pairRows=[...(await overview(owner,'source')).items,...(await overview(owner,'video')).items].filter(item=>[pairedSource,pairedOutput].includes(item.id));
  assert.equal(pairRows.length,2);const pairedOperation=await prepare(pairRows.map(({id,version})=>({id,version})),'paired-cleanup');
  assert.equal(pairedOperation.items.length,2);
  await admin();assert.deepEqual(await one('select state,ticket from mayak_video_jobs where id=$1',[pair.id]),{state:'cancelled',ticket:null});
  // Normal admin deletion in the main chat still authorizes its exact physical file cleanup.
  const guestMainPath=alice+'/guest-main-photo.jpg',guestMainObject=await upload('mayak',guestMainPath,110,'image/jpeg');
  const guestMainMessage=(await one("insert into mayak_messages(user_id,name,text,nonce,kind,file) values($1,'Алиса','📷 Фото','guest-main','photo',$2) returning id",[alice,guestMainPath])).id;
  await as(owner);await db.query('select mayak_delete($1)',[guestMainMessage]);
  assert.equal((await db.query('select id from storage.objects where id=$1',[guestMainObject])).rows.length,1);
  assert.equal((await db.query('delete from storage.objects where id=$1 returning id',[guestMainObject])).rows.length,1);
  // The release authorization belongs to that object incarnation, not to all future files at its path.
  await admin();const replacement=await upload('mayak',guestMainPath,120,'image/jpeg');
  await as(owner);assert.equal((await db.query('select id from storage.objects where id=$1',[replacement])).rows.length,0);
  assert.equal((await db.query('delete from storage.objects where id=$1 returning id',[replacement])).rows.length,0);
  await assert.rejects(db.query('select mayak_delete($1)',[privateMessage]));
  await admin();assert.equal((await one('select count(*)::int n from mayak_private.media_release_authorizations where actor=$1 and path=$2',[owner,paths.private])).n,0);
  // Reserved immutable paths cannot be recreated while a delete acknowledgement may still be lost.
  // The restrictive policy supplements existing upload ownership checks without granting new access.
  await as(owner);await assert.rejects(upload('mayak',paths.caption,130,'image/jpeg'));
  const freshPath=owner+'/fresh-upload-photo.jpg',freshObject=await upload('mayak',freshPath,140,'image/jpeg');
  assert.equal((await db.query('select id from storage.objects where id=$1',[freshObject])).rows.length,1);
  await assert.rejects(upload('mayak',alice+'/forged-upload-photo.jpg',150,'image/jpeg'));
 }finally{await db.close();}
});
