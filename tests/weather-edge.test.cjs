const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{webcrypto}=require('node:crypto'),{transformSync}=require('esbuild');
const code=transformSync(fs.readFileSync('supabase/functions/weather-ingest/index.ts','utf8'),{loader:'ts',format:'cjs',target:'node22'}).code;
function fixture(failure){let calls=[];const env={SUPABASE_URL:'https://example.supabase.co',SUPABASE_SECRET_KEYS:JSON.stringify({default:'sb_secret_SERVER_ONLY'})};
 const c={exports:{},module:{exports:{}},Deno:{env:{get:n=>env[n]},serve(){}},Request,Response,URL,AbortSignal,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,fetch:async(url,o)=>{calls.push({url,...o});return Response.json(failure||{ok:true},{status:failure?400:200});}};c.module.exports=c.exports;vm.runInNewContext(code,c);
 const payload={station_id:'astrakhan-lit',boot_id:'00000000-0000-4000-8000-000000000001',sequence:1,measured_at:new Date().toISOString(),sensor_valid:true,temperature:28.1,humidity:35,rssi:-60,firmware:'1.5.0'};
 const request=(body=payload,key='a'.repeat(64))=>new Request(env.SUPABASE_URL+'/functions/v1/weather-ingest',{method:'POST',headers:{'x-station-key':key,'content-type':'application/json'},body:JSON.stringify(body)});
 return {...c.module.exports,payload,request,calls};
}
test('weather edge: scoped device key hashed, validated body, server key never returned',async()=>{
 const f=fixture();let r=await f.handle(f.request());assert.equal(r.status,200);assert.deepEqual(await r.json(),{ok:true,duplicate:false});assert.equal(f.calls.length,1);assert.equal(f.calls[0].headers.apikey,'sb_secret_SERVER_ONLY');assert.equal(f.calls[0].headers.Authorization,undefined);
 const b=JSON.parse(f.calls[0].body);assert.match(b.p_hash,/^[a-f0-9]{64}$/);assert.notEqual(b.p_hash,'a'.repeat(64));assert.equal(b.p_payload.temperature,28.1);assert.equal(JSON.stringify(b.p_payload).includes('sb_secret'),false);
 for(const patch of [{humidity:101},{temperature:null},{sequence:1.5},{rssi:20},{measured_at:'1990-01-01T00:00:00Z'},{station_id:'other'},{weather:{code:1}},{sensor_valid:'true'}])assert.equal((await f.handle(f.request({...f.payload,...patch}))).status,400);
 assert.equal((await f.handle(f.request(f.payload,''))).status,401);assert.equal((await f.handle(f.request('x'.repeat(5000)))).status,413);
 r=await f.handle(f.request({...f.payload,sensor_valid:false,temperature:null,humidity:null}));assert.equal(r.status,200);assert.equal(JSON.parse(f.calls.at(-1).body).p_payload.temperature,null);
});
test('weather edge: rejected device key and server rate limit preserve non-success response',async()=>{
 let f=fixture({code:'28000'});assert.equal((await f.handle(f.request())).status,401);f=fixture({code:'P0001'});assert.equal((await f.handle(f.request())).status,429);
});
