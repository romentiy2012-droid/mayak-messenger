// Owner-only inventory and selected deletion. File contents never pass through this function.
const ORIGIN='https://romentiy2012-droid.github.io';
const BASE=Deno.env.get('SUPABASE_URL')||'';
function namedKey(name:string){try{return JSON.parse(Deno.env.get(name)||'{}').default||'';}catch{return '';}}
const SERVICE=namedKey('SUPABASE_SECRET_KEYS')||Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
const PUBLIC_KEY=namedKey('SUPABASE_PUBLISHABLE_KEYS')||Deno.env.get('SUPABASE_ANON_KEY')||'';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILTERS=new Set(['all','photo','voice','video','source','avatar','unused','other']);
const BUCKETS=new Set(['mayak','mayak-video','mayak-video-source','mayak-avatars']);
const error=(message:string,status=400)=>Object.assign(new Error(message),{status});
function headers(token:string){
 const result:Record<string,string>={apikey:token===SERVICE?SERVICE:PUBLIC_KEY,'Content-Type':'application/json'};
 // Named opaque service keys are not JWTs.
 if(token!==SERVICE||token.split('.').length===3)result.Authorization='Bearer '+token;
 return result;
}
async function call(path:string,token:string,body?:unknown,method=body===undefined?'GET':'POST'){
 const response=await fetch(BASE+path,{method,headers:headers(token),body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000),redirect:'error'});
 const data=await response.json().catch(()=>null);
 if(!response.ok){
  if(response.status===401||response.status===403||data?.code==='42501')throw error('Доступ только для администратора.',403);
  if(data?.code==='P0001'||data?.code==='22023')throw error('Список файлов изменился или выбор недоступен. Обновите окно и проверьте выбор.',409);
  throw error('Операция хранилища временно недоступна. Повторите запрос.',502);
 }
 return data;
}
const rpc=(name:string,body:unknown)=>call('/rest/v1/rpc/mayak_storage_'+name,SERVICE,body);
function snapshot(data:any){
 if(!data?.storage||!Array.isArray(data.items))throw error('Не удалось получить состояние хранилища.',502);
 const used=Number(data.storage.used_bytes),unknown=Number(data.storage.unknown_size_count||0),count=Number(data.storage.objects_count);
 if(!Number.isSafeInteger(used)||used<0||!Number.isSafeInteger(count)||count<0||!Number.isSafeInteger(unknown)||unknown<0||data.items.length>50)throw error('Не удалось определить размер файлов.',502);
 // Verified Free conditions, not a claim about current billing usage or other projects.
 const quota=1000000000;
 const kinds=new Set(['photo','voice','video','source','avatar','other']);
 const labels:Record<string,string>={photo:'Фото',voice:'Голосовое',video:'Видеокружочек',source:'Исходник видео',avatar:'Аватарка',other:'Другой файл'};
 const items=data.items.map((item:any)=>{
  if(!UUID.test(item.id)||typeof item.version!=='string'||!kinds.has(item.kind))throw error('Неверный список файлов.',502);
  return {id:item.id,version:item.version,kind:item.kind,bytes:item.bytes,created_at:item.created_at,label:labels[item.kind],scope:['main','direct','unused'].includes(item.scope)?item.scope:'unused',can_delete:item.can_delete===true,reason:item.reason};
 });
 const breakdown=(data.storage.breakdown||[]).map((part:any)=>({category:part.category,bytes:part.bytes,count:part.count}));
 let pending_operation=null;
 if(data.pending_operation){
  const operation=data.pending_operation;
  if(!UUID.test(operation.id)||typeof operation.nonce!=='string'||!Array.isArray(operation.items)||operation.items.length<1||operation.items.length>20)throw error('Не удалось восстановить очистку.',502);
  pending_operation={id:operation.id,nonce:operation.nonce,items:operation.items.map((item:any)=>{
   if(!UUID.test(item.id)||typeof item.version!=='string')throw error('Не удалось восстановить выбор файлов.',502);
   return {id:item.id,version:item.version,bytes:item.bytes,status:item.status==='deleted'?'deleted':'failed'};
  })};
 }
 return {observed_at:data.observed_at,offset:data.offset,total_count:data.total_count,has_more:data.has_more===true,items,
  pending_operation,
  storage:{used_bytes:used,objects_count:count,unknown_size_count:unknown,breakdown,quota_bytes:quota,free_bytes:unknown?null:Math.max(0,quota-used),quota_scope:'organization',quota_verified_at:'2026-11-18',plan:'Free'},
  traffic:{status:'unavailable',used_bytes:null,observed_at:null,period_start:null,period_end:null,uncached_quota_bytes:5000000000,cached_quota_bytes:5000000000,
   reason:'Точный расход трафика и даты расчётного периода доступны в разделе Usage Supabase.'},
  usage_url:'https://supabase.com/dashboard/org/wqleawilymprpdyrimhd/usage'};
}
function safeOperation(operation:any){
 if(!UUID.test(operation?.id)||!Array.isArray(operation.items))throw error('Не удалось проверить результат очистки.',502);
 return {id:operation.id,items:operation.items.map((item:any)=>({id:item.id,status:item.status==='deleted'?'deleted':'failed',...(item.status==='deleted'?{}:{error:'Файл пока не удалён. Повторите очистку.'})}))};
}
export async function handle(request:Request):Promise<Response>{
 const cors={'Access-Control-Allow-Origin':ORIGIN,'Access-Control-Allow-Headers':'authorization, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Cache-Control':'no-store','Vary':'Origin'};
 const answer=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json'}});
 if(request.headers.get('origin')&&request.headers.get('origin')!==ORIGIN)return answer({error:'Чужой адрес приложения.'},403);
 if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
 if(request.method!=='POST')return answer({error:'Нужен POST.'},405);
 const token=request.headers.get('authorization')?.replace(/^Bearer\s+/i,'');
 if(!token)return answer({error:'Войдите в чат.'},401);
 try{
  if(!SERVICE||!PUBLIC_KEY||!BASE)throw error('Хранилище ещё настраивается.',503);
  const user=await call('/auth/v1/user',token);
  if(!UUID.test(user?.id))throw error('Войдите в чат.',401);
  const members=await call('/rest/v1/mayak_members?select=owner&id=eq.'+user.id,token);
  if(!Array.isArray(members)||members.length!==1||members[0].owner!==true)throw error('Доступ только для администратора.',403);
  const raw=await request.text();if(raw.length>12000)throw error('Слишком большой выбор файлов.',413);
  let body:any;try{body=JSON.parse(raw);}catch{throw error('Неверный запрос.',400);}
  if(!body||typeof body!=='object'||!['overview','delete'].includes(body.action))throw error('Неизвестное действие.',400);
  const filter=body.filter||'all',offset=body.offset??0;
  if(!FILTERS.has(filter)||!Number.isInteger(offset)||offset<0||offset>1000000)throw error('Неверная страница файлов.',400);
  const overview=async()=>snapshot(await rpc('overview',{p_actor:user.id,p_filter:filter,p_offset:offset}));
  if(body.action==='overview')return answer(await overview());
  const items=body.items;
  if(!Array.isArray(items)||items.length<1||items.length>20||new Set(items.map((item:any)=>item?.id)).size!==items.length||
   items.some((item:any)=>!UUID.test(item?.id)||typeof item.version!=='string'||item.version.length<1||item.version.length>200)||
   typeof body.nonce!=='string'||!/^[a-zA-Z0-9_-]{16,100}$/.test(body.nonce))throw error('Проверьте выбор: не больше 20 файлов.',400);
  const prepared=await rpc('prepare',{p_actor:user.id,p_items:items.map((item:any)=>({id:item.id,version:item.version})),p_nonce:body.nonce});
  if(!UUID.test(prepared?.id)||!Array.isArray(prepared.items)||prepared.items.length!==items.length||
   new Set(prepared.items.map((item:any)=>item?.id)).size!==items.length||
   prepared.items.some((item:any)=>!items.some((selected:any)=>selected.id===item?.id)))throw error('Не удалось проверить выбранные файлы.',502);
  const results=new Map<string,any>();
  // Bound parallelism avoids timing out an entire batch on slow Storage responses.
  let next=0;
  await Promise.all(Array.from({length:Math.min(4,prepared.items.length)},async()=>{
   while(next<prepared.items.length){
    const item=prepared.items[next++];
    if(item.status==='deleted'){results.set(item.id,item);continue;}
    let success=false;
    try{
     if(!UUID.test(item.id)||!BUCKETS.has(item.bucket)||typeof item.path!=='string'||!item.path||item.path.length>1024||item.path.includes('..')||item.path.startsWith('/'))throw error('Неверная цель очистки.',502);
     await call('/storage/v1/object/'+item.bucket,SERVICE,{prefixes:[item.path]},'DELETE');
     success=true;
    }catch{success=false;}
    // Finish checks Storage metadata absence even after HTTP 200, and keeps failed intents retryable.
    try{
     const result=await rpc('finish',{p_actor:user.id,p_operation:prepared.id,p_object:item.id,p_success:success,p_error:success?null:'Storage delete failed'});
     results.set(item.id,result);
    }catch{results.set(item.id,{id:item.id,status:'failed'});}
   }
  }));
  const operation=safeOperation({id:prepared.id,items:prepared.items.map((item:any)=>results.get(item.id)||{id:item.id,status:'failed'})});
  return answer({...await overview(),operation});
 }catch(cause){const e=cause as any;return answer({error:e.status?e.message:'Нет связи с хранилищем. Повторите запрос.'},e.status||502);}
}
Deno.serve(handle);
