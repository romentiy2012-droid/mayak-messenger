// Приём только подписанных отдельным ключом станции пакетов; ключ Supabase остаётся на сервере.
const BASE=Deno.env.get('SUPABASE_URL')||'';
function named(name:string){try{return JSON.parse(Deno.env.get(name)||'{}').default||'';}catch{return '';}}
const SERVICE=named('SUPABASE_SECRET_KEYS')||Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
const fail=(message:string,status=400)=>Object.assign(new Error(message),{status});
const number=(v:unknown,lo:number,hi:number)=>typeof v==='number'&&Number.isFinite(v)&&v>=lo&&v<=hi;
export function validate(body:any){
 if(!body||typeof body!=='object'||Array.isArray(body)||body.station_id!=='astrakhan-lit'||
 !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.boot_id)||
 !Number.isSafeInteger(body.sequence)||body.sequence<1||!Number.isInteger(body.rssi)||!number(body.rssi,-127,0)||
 typeof body.firmware!=='string'||!/^[0-9A-Za-z._-]{1,32}$/.test(body.firmware)||typeof body.sensor_valid!=='boolean')throw fail('Неверный пакет станции.');
 const time=Date.parse(body.measured_at);
 if(typeof body.measured_at!=='string'||!Number.isFinite(time)||time<Date.now()-600000||time>Date.now()+60000)throw fail('Неверное время измерения.');
 if(body.sensor_valid&&(!number(body.temperature,-50,150)||!number(body.humidity,0,100)))throw fail('Неверное измерение.');
 let weather=null;
 if(body.weather!=null){let w=body.weather;
  if(typeof w!=='object'||!number(w.temperature,-90,65)||!number(w.humidity,0,100)||!number(w.feels_like,-130,90)||!number(w.wind,0,150)||
   !Number.isInteger(w.code)||!number(w.code,0,99)||!Number.isSafeInteger(w.observed_at)||w.observed_at<1704067200||w.observed_at>Date.now()/1000+900||
   !Array.isArray(w.sunrise)||!Array.isArray(w.sunset)||w.sunrise.length!==2||w.sunset.length!==2||
   !w.sunrise.every((t:number)=>Number.isSafeInteger(t)&&t>=1704067200)||!w.sunset.every((t:number,i:number)=>Number.isSafeInteger(t)&&t>w.sunrise[i]))throw fail('Неверная погода.');
  weather={temperature:w.temperature,humidity:w.humidity,feels_like:w.feels_like,wind:w.wind,code:w.code,observed_at:w.observed_at,sunrise:w.sunrise,sunset:w.sunset};
 }
 return {station_id:body.station_id,boot_id:body.boot_id,sequence:body.sequence,measured_at:new Date(time).toISOString(),
  rssi:body.rssi,firmware:body.firmware,sensor_valid:body.sensor_valid,temperature:body.sensor_valid?body.temperature:null,humidity:body.sensor_valid?body.humidity:null,weather};
}
export async function handle(request:Request):Promise<Response>{
 const answer=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
 if(request.method!=='POST')return answer({error:'Нужен POST.'},405);
 const token=request.headers.get('x-station-key')||'';
 if(!/^[a-f0-9]{64}$/.test(token))return answer({error:'Нужен ключ станции.'},401);
 try {
  if(!BASE||!SERVICE)throw fail('Приём данных ещё настраивается.',503);
  if(Number(request.headers.get('content-length')||0)>4096)throw fail('Слишком большой пакет.',413);
  const reader=request.body?.getReader();if(!reader)throw fail('Нет пакета.');
  const chunks:Uint8Array[]=[];let size=0;
  try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4096){await reader.cancel();throw fail('Слишком большой пакет.',413);}chunks.push(value);}}
  finally {reader.releaseLock();}
  const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
  let body;try{body=JSON.parse(new TextDecoder().decode(bytes));}catch{throw fail('Неверный JSON.');}
  const payload=validate(body);
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),b=>b.toString(16).padStart(2,'0')).join('');
  const headers:Record<string,string>={apikey:SERVICE,'Content-Type':'application/json'};
  if(SERVICE.split('.').length===3)headers.Authorization='Bearer '+SERVICE;
  const response=await fetch(BASE+'/rest/v1/rpc/mayak_weather_ingest',{method:'POST',headers,body:JSON.stringify({p_hash:hash,p_payload:payload}),signal:AbortSignal.timeout(10000),redirect:'error'});
  const result=await response.json().catch(()=>null);
  if(!response.ok){
   if(result?.code==='28000')throw fail('Неверный ключ станции.',401);
   if(result?.code==='P0001')throw fail('Повторите отправку через минуту.',429);
   if(['22023','22P02','22007','23514'].includes(result?.code))throw fail('Неверные данные станции.');
   throw fail('Не удалось сохранить измерение.',502);
  }
  if(result?.ok!==true)throw fail('Нет подтверждения сохранения.',502);
  return answer({ok:true,duplicate:result.duplicate===true});
 }catch(error){const e=error as {status?:number;message?:string};return answer({error:e.status?e.message:'Приём данных временно недоступен.'},e.status||502);}
}
Deno.serve(handle);
