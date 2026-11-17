import {timingSafeEqual} from 'node:crypto';
import {convertVideo,MAX_SOURCE} from './convert.js';

function authorized(value,secret){
 const a=Buffer.from(value||''),b=Buffer.from(secret||'');
 return b.length>=32&&a.length===b.length&&timingSafeEqual(a,b);
}
export function validateJob(job,supabaseURL){
 if(!job||!(/^[a-f0-9-]{36}$/.test(job.id))||!(/^[a-f0-9-]{36}$/.test(job.ticket)))throw Error('Неверное задание.');
 const base=new URL(supabaseURL);
 if(base.protocol!=='https:'||!base.hostname.endsWith('.supabase.co'))throw Error('Неверная конфигурация.');
 const source=new URL(job.source),target=new URL(job.target);
 if(source.origin!==base.origin||target.origin!==base.origin||source.username||target.username||source.hash||target.hash)throw Error('Неверное хранилище.');
 const output=job.output;
 if(!/^[a-f0-9-]{36}\/[a-f0-9-]{36}_[a-f0-9-]{36}\.mp4$/.test(output))throw Error('Неверный путь результата.');
 if(!source.pathname.startsWith('/storage/v1/object/sign/mayak-video-source/')||target.pathname!=='/storage/v1/object/upload/sign/mayak-video/'+output)throw Error('Неверный адрес файла.');
 return {source:source.href,target:target.href};
}
async function boundedDownload(url){
 const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(20000)});
 if(!response.ok||Number(response.headers.get('content-length'))>MAX_SOURCE)throw Error('Исходное видео недоступно или слишком большое.');
 const chunks=[];let size=0;
 for await(const chunk of response.body){size+=chunk.length;if(size>MAX_SOURCE){await response.body.cancel().catch(()=>{});throw Error('Исходное видео больше 16 МБ.');}chunks.push(Buffer.from(chunk));}
 return Buffer.concat(chunks);
}
// Только маленькое задание с временными ссылками; сами файлы идут напрямую через закрытый Storage.
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 if(req.method==='GET'){res.statusCode=200;res.end(JSON.stringify({ok:true,service:'mayak-video',version:1}));return;}
 if(req.method!=='POST'){res.statusCode=405;res.end();return;}
 if(!authorized(req.headers['x-mayak-video-key'],process.env.MAYAK_VIDEO_KEY)){res.statusCode=401;res.end();return;}
 try{
  const job=typeof req.body==='string'?JSON.parse(req.body):req.body;
  const urls=validateJob(job,process.env.SUPABASE_URL);
  const result=await convertVideo(await boundedDownload(urls.source));
  const upload=await fetch(urls.target,{method:'PUT',redirect:'error',headers:{'Content-Type':'video/mp4','x-upsert':'false'},body:result.data,signal:AbortSignal.timeout(20000)});
  if(!upload.ok)throw Error('Не удалось сохранить готовый кружочек.');
  res.setHeader('Content-Type','application/json');res.statusCode=200;res.end(JSON.stringify({id:job.id,ticket:job.ticket,output:job.output,meta:result.meta}));
 }catch(error){
  console.error('mayak video conversion failed'); // без токенов, временных ссылок и содержимого записи
  res.setHeader('Content-Type','application/json');res.statusCode=422;res.end(JSON.stringify({error:String(error.message).slice(0,200)}));
 }
}
