// Принимает только задание от участника. Видео не проходит через память Edge Function.
// Долгая конвертация выполняется внешним worker; здесь остаются проверка прав и финальная запись.
const ORIGIN='https://romentiy2012-droid.github.io';
const URL_BASE=Deno.env.get('SUPABASE_URL') || '';
function namedKey(name:string){try{return JSON.parse(Deno.env.get(name)||'{}').default||'';}catch{return '';}}
const SERVICE=namedKey('SUPABASE_SECRET_KEYS') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const APIKEY=namedKey('SUPABASE_PUBLISHABLE_KEYS') || Deno.env.get('SUPABASE_ANON_KEY') || SERVICE;
function headers(token:string):Record<string,string>{
 // Opaque sb_secret_ keys are API keys, never bearer JWTs. User JWTs retain user RLS.
 const result:Record<string,string>={apikey:token===SERVICE?SERVICE:APIKEY,'Content-Type':'application/json'};
 if(token!==SERVICE||token.split('.').length===3)result.Authorization='Bearer '+token;
 return result;
}
const path=(value:string)=>value.split('/').map(encodeURIComponent).join('/');
async function call(endpoint:string,token:string,body?:unknown){
 const response=await fetch(URL_BASE+endpoint,{method:body===undefined?'GET':'POST',headers:headers(token),body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
 const data=await response.json().catch(()=>({}));
 if(!response.ok){
  if(token===SERVICE){console.error('mayak video service request failed',endpoint.split('?')[0],response.status);throw Object.assign(new Error('Серверная обработка временно недоступна. Повторите отправку.'),{status:502});}
  throw Object.assign(new Error(data.message||data.error||'Не удалось обработать запись.'),{status:response.status});
 }
 return data;
}
const rpc=(name:string,body:unknown,token=SERVICE)=>call('/rest/v1/rpc/mayak_video_'+name,token,body);
async function remove(bucket:string,file:string){
 await fetch(URL_BASE+'/storage/v1/object/'+bucket,{method:'DELETE',headers:headers(SERVICE),body:JSON.stringify({prefixes:[file]}),signal:AbortSignal.timeout(12000)}).catch(()=>{});
}
async function dispatch(job:any,settings:any){
 const claim=await rpc('claim',{p_id:job.id});
 if(!claim?.id)return;
 try{
  const source=await call('/storage/v1/object/sign/mayak-video-source/'+path(claim.source),SERVICE,{expiresIn:180});
  const target=await call('/storage/v1/object/upload/sign/mayak-video/'+path(claim.output),SERVICE,{});
  const sourceURL=new URL('/storage/v1'+(source.signedURL||source.signedUrl),URL_BASE).href;
  const targetURL=new URL('/storage/v1'+target.url,URL_BASE).href;
  const response=await fetch(settings.url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','x-mayak-video-key':settings.key},
   body:JSON.stringify({id:claim.id,ticket:claim.ticket,source:sourceURL,target:targetURL,output:claim.output}),signal:AbortSignal.timeout(125000)});
  const result=await response.json();
  if(!response.ok)throw new Error(result.error||'Не удалось преобразовать видео.');
  if(result.id!==claim.id||result.ticket!==claim.ticket||result.output!==claim.output)throw Error('Неверный ответ обработки.');
  const finished=await rpc('finish',{p_id:claim.id,p_ticket:claim.ticket,p_meta:result.meta});
  if(finished?.state==='sent')await remove('mayak-video-source',claim.source);
  else await remove('mayak-video',claim.output); // отменено или устаревшая попытка
 }catch(error){
  console.error('mayak video job failed',claim.id); // без ключей, адресов подписанных файлов и содержимого
  const failed=await rpc('finish',{p_id:claim.id,p_ticket:claim.ticket,p_error:String(error.message||'Обработка прервана. Повторите отправку.').slice(0,200)}).catch(()=>null);
  // Ответ RPC мог потеряться после commit. Без подтверждения состояния готовое видео не удаляем.
  if(failed&&(failed.state!=='sent'||failed.output!==claim.output))await remove('mayak-video',claim.output);
 }
}
export async function handle(request:Request):Promise<Response>{
 const origin=request.headers.get('origin');
 const cors={'Access-Control-Allow-Origin':ORIGIN,'Access-Control-Allow-Headers':'authorization, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Vary':'Origin','Cache-Control':'no-store'};
 const answer=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json'}});
 if(origin&&origin!==ORIGIN)return answer({error:'Чужой адрес приложения.'},403);
 if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
 if(request.method!=='POST')return answer({error:'Нужен POST.'},405);
 const token=request.headers.get('authorization')?.replace(/^Bearer\s+/i,'');
 if(!token)return answer({error:'Войдите в чат.'},401);
 try{
  const body=await request.json();
  const user=await call('/auth/v1/user',token);
  if(!user.id)return answer({error:'Войдите в чат.'},401);
  const settings=await rpc('settings',{});
  if(!settings?.url||!settings?.key)return answer({error:'Обработка видео ещё настраивается.'},503);
  const worker=new URL(settings.url);
  if(worker.protocol!=='https:'||!worker.hostname.endsWith('.vercel.app')||worker.pathname!=='/api/process'||worker.search||worker.hash||worker.username||worker.password)throw Error('Неверная конфигурация обработки видео.');
  const job=await rpc('begin',{p_source:body.file,p_nonce:body.nonce,p_peer:body.peer||null,p_reply:body.reply||null},token);
  if(job.state==='cancelled')return answer({error:'Запись отменена. Запишите новый кружочек.'},409);
  if(job.state!=='sent')EdgeRuntime.waitUntil(dispatch(job,settings));
  return answer({job});
 }catch(error){return answer({error:String(error.message||'Не удалось отправить видео.').slice(0,200)},error.status||400);}
}
Deno.serve(handle);
