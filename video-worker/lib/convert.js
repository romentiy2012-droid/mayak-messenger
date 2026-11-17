import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// Production uses maintained Debian packages in Dockerfile.vercel.
// Installer packages are local test fixtures, excluded from production.
const ffmpegPath=process.env.FFMPEG_PATH||(await import('@ffmpeg-installer/ffmpeg')).default.path;
const ffprobePath=process.env.FFPROBE_PATH||(await import('@ffprobe-installer/ffprobe')).default.path;

export const MAX_SOURCE=16*1024*1024, MAX_OUTPUT=8*1024*1024;
function run(binary,args,timeout=90000){
 return new Promise((resolve,reject)=>{
  const child=spawn(binary,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',settled=false;
  const timer=setTimeout(()=>{child.kill('SIGKILL');done(new Error('Обработка заняла слишком много времени.'));},timeout);
  function done(error){if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(stdout);}
  child.stdout.on('data',data=>{stdout+=data;if(stdout.length>1024*1024){child.kill('SIGKILL');done(new Error('Слишком много данных видео.'));}});
  child.stderr.on('data',data=>{stderr=(stderr+data).slice(-3000);});
  child.on('error',()=>done(new Error('Не удалось запустить обработчик видео.')));
  child.on('close',code=>done(code===0?null:new Error('Не удалось прочитать или преобразовать видео.')));
 });
}
async function probe(file){return JSON.parse(await run(ffprobePath,['-v','error','-protocol_whitelist','file','-format_whitelist','mov,matroska,webm','-show_streams','-show_format','-of','json',file],10000));}
export async function convertVideo(bytes){
 if(!bytes.length||bytes.length>MAX_SOURCE)throw new Error('Исходное видео больше 16 МБ или пустое.');
 const directory=await mkdtemp(join(tmpdir(),'mayak-video-'));
 try{
  const input=join(directory,'source'),output=join(directory,'video.mp4');
  await writeFile(input,bytes);
  const source=await probe(input),video=source.streams.find(stream=>stream.codec_type==='video'),audio=source.streams.find(stream=>stream.codec_type==='audio');
  if(!video||!audio)throw new Error('В записи должны быть видео и звук.');
  if(!video.width||!video.height||video.width>4096||video.height>4096)throw new Error('Слишком большое разрешение видео.');
  const duration=Number(source.format.duration);
  if(Number.isFinite(duration)&&duration>61.5)throw new Error('Видеокружочек должен быть не длиннее минуты.');
  await run(ffmpegPath,['-nostdin','-hide_banner','-loglevel','error','-protocol_whitelist','file','-format_whitelist','mov,matroska,webm','-threads','1',
   '-i',input,'-t','60','-map','0:v:0','-map','0:a:0','-map_metadata','-1',
   '-vf','scale=480:480:force_original_aspect_ratio=increase:out_range=tv,crop=480:480,setsar=1,fps=30,format=yuv420p',
   '-c:v','libx264','-preset','veryfast','-profile:v','baseline','-level:v','3.1',
   '-b:v','600k','-maxrate','800k','-bufsize','1600k','-g','60','-threads','1','-pix_fmt','yuv420p','-color_range','tv',
   '-c:a','aac','-ac','1','-ar','48000','-b:a','64k','-movflags','+faststart',output]);
  const result=await probe(output),v=result.streams.find(s=>s.codec_type==='video'),a=result.streams.find(s=>s.codec_type==='audio'),data=await readFile(output);
  if(!v||!a||v.codec_name!=='h264'||a.codec_name!=='aac'||v.pix_fmt!=='yuv420p'||v.width!==480||v.height!==480||data.length>MAX_OUTPUT){
   console.error('mayak video output validation failed',JSON.stringify({video:v?.codec_name,audio:a?.codec_name,pix_fmt:v?.pix_fmt,range:v?.color_range,w:v?.width,h:v?.height,size:data.length,duration:result.format.duration}));
   throw new Error('Не удалось подготовить совместимый MP4.');
  }
  return {data,meta:{w:480,h:480,duration:Number(result.format.duration),size:data.length,mime:'video/mp4',video:'h264',audio:'aac',profile:v.profile,pix_fmt:v.pix_fmt,color_range:v.color_range}};
 }finally{await rm(directory,{recursive:true,force:true});}
}
