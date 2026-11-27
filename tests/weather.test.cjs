const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{PGlite}=require('@electric-sql/pglite');
test('weather database: member-only reads, isolated writer, idempotency, stale packets and real gaps',async()=>{
 const db=new PGlite();try{
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
  for(const n of ['202611160001_cloud.sql','20261127091526_meteostation.sql'])await db.exec(fs.readFileSync('supabase/migrations/'+n,'utf8'));
  const member='00000000-0000-4000-8000-000000000001',outsider='00000000-0000-4000-8000-000000000002',hash='a'.repeat(64),boot='00000000-0000-4000-8000-000000000003';
  await db.query('insert into auth.users values($1),($2)',[member,outsider]);await db.query("insert into mayak_members(id,name) values($1,'Тестовый участник')",[member]);
  await db.query("insert into mayak_private.weather_keys values('astrakhan-lit',$1,true)",[hash]);
  const role=async(name,id='')=>db.exec(`reset role;select set_config('request.jwt.claim.sub','${id}',false);set role ${name};`);
  const one=async(s,args)=>(await db.query(s,args)).rows[0];
  const payload=(seq,seconds=0,valid=true)=>({station_id:'astrakhan-lit',boot_id:boot,sequence:seq,measured_at:new Date(Date.now()+seconds*1000).toISOString(),sensor_valid:valid,temperature:valid?28.1:null,humidity:valid?35:null,rssi:-55,firmware:'1.5.0',weather:null});
  const put=async(p,h=hash)=>(await one('select mayak_weather_ingest($1,$2) r',[h,JSON.stringify(p)])).r;
  const get=async(m=720)=>(await one('select mayak_weather_get($1) r',[m])).r;
  await role('anon');await assert.rejects(get());await assert.rejects(put(payload(1)));await assert.rejects(db.query('select * from mayak_weather_state'));
  await role('authenticated',outsider);await assert.rejects(get());assert.equal((await db.query('select * from mayak_weather_samples')).rows.length,0);
  await role('authenticated',member);assert.equal((await get()).latest,null);await assert.rejects(get(13));await assert.rejects(put(payload(1)));await assert.rejects(db.query('select * from mayak_private.weather_keys'));
  await role('service_role');await assert.rejects(put(payload(1),'b'.repeat(64)));await assert.rejects(put({...payload(1),humidity:101}));
  const first=payload(1,-120);assert.equal((await put(first)).ok,true);assert.equal((await put(first)).duplicate,true);
  await role('authenticated',member);let s=await get();assert.equal(s.latest.temperature,28.1);assert.equal(s.history.length,1);assert.equal('boot_id' in s.latest,false);assert.equal('token_hash' in s.latest,false);
  await assert.rejects(db.query("insert into mayak_weather_samples values('astrakhan-lit',now(),now(),1,1)"));
  await role('service_role');assert.equal((await put({...payload(1,-119),temperature:99})).duplicate,true);await assert.rejects(put(payload(2,-60))); // rate limit
  await role('authenticated',member);s=await get();assert.equal(s.latest.temperature,28.1);
  await db.exec('reset role;');await db.exec("update mayak_weather_state set received_at=now()-interval '1 minute'");
  await role('service_role');await put(payload(2,-60,false));
  await role('authenticated',member);s=await get();assert.equal(s.latest.sensor_valid,false);assert.equal(s.latest.temperature,null);assert.equal(s.history.length,1);assert.ok(s.latest.last_good_at);
  await db.exec('reset role;');await db.exec("update mayak_weather_state set received_at=now()-interval '1 minute'");
  await role('service_role');await put(payload(3,0));
  await role('authenticated',member);s=await get();assert.equal(s.latest.sensor_valid,true);assert.equal(s.history.length,2);assert.ok(Date.parse(s.history[1].time)-Date.parse(s.history[0].time)>90000);
  await db.exec('reset role;');await db.query('delete from mayak_members where id=$1',[member]);await role('authenticated',member);await assert.rejects(get());assert.equal((await db.query('select * from mayak_weather_state')).rows.length,0);
 }finally{await db.close();}
});
test('weather model: Astrakhan solar day, phone timezone independence, missing and interrupted history',async()=>{
 const src=fs.readFileSync('js/weather-model.js','utf8'),m=await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64'));
 const day=Date.parse('2026-11-27T08:00:00Z'),sunrise=Date.parse('2026-11-27T04:00:00Z')/1000,sunset=Date.parse('2026-11-27T13:00:00Z')/1000,w={sunrise:[sunrise,sunrise+86400],sunset:[sunset,sunset+86400]};
 assert.equal(m.stationTime(day).clock,'12:00');assert.equal(m.stationNight(day,w),false);assert.equal(m.stationNight(sunset*1000,w),true);assert.equal(m.stationNight(sunrise*1000,w),false);assert.equal(m.stationNight(Date.parse('2026-11-27T01:00:00Z'),null),true);
 const points=m.series([{time:new Date(day-120000).toISOString(),temperature:-10,humidity:0},{time:new Date(day).toISOString(),temperature:-9,humidity:100},{time:new Date(day-180000).toISOString(),temperature:null,humidity:3}],day,30);
 assert.equal(points.length,2);let scale=m.chartScale(points,'temperature'),p=m.chartPath(points,'temperature',day,30,scale);assert.equal((p.match(/M/g)||[]).length,2);assert.equal((p.match(/L/g)||[]).length,0);assert.deepEqual(m.chartScale(points,'humidity'),{low:0,high:100});
});
