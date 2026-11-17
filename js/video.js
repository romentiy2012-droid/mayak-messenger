// Видеокружочки: камера/предпросмотр и плеер. Обработку и публикацию выполняет сервер.
import {$,state,element,button,toast} from './core.js';
import {clock,stopVoice} from './media.js';

const FORMATS=['video/mp4;codecs=avc1.42E01E,mp4a.40.2','video/mp4','video/webm;codecs=vp8,opus','video/webm'];
export const canRecordVideo=()=>!!(navigator.mediaDevices?.getUserMedia&&window.MediaRecorder);
let capture=null,captureGeneration=0;
export function cancelVideoRecording(){captureGeneration++;if(capture)capture.close();}
export async function recordVideo(onSend){
 if(capture)return;
 if(!canRecordVideo()){toast('Этот браузер не умеет записывать видео.');return;}
 stopVoice();stopVideo();
 const current=++captureGeneration,previousFocus=document.activeElement;
 const layer=element('div','video-record-layer'),panel=element('section','video-record-panel');
 panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-labelledby','video-record-title');
 const title=element('h2','','Видеокружочек');title.id='video-record-title';
 const screen=element('div','video-record-screen'),video=element('video','video-record-preview live');
 video.muted=true;video.playsInline=true;video.setAttribute('playsinline','');screen.appendChild(video);
 const status=element('p','video-record-status','Запрашиваем камеру и микрофон…');status.setAttribute('role','status');
 const actions=element('div','video-record-actions');
 let stream=null,recorder=null,timer=null,blob=null,preview=null,transferred=false,started=0,finishedDuration=0,chunks=[],size=0,closed=false;
 const close=()=>{
  if(closed)return;closed=true;clearInterval(timer);
  try{if(recorder&&recorder.state!=='inactive')recorder.stop();}catch(_error){}
  if(stream)stream.getTracks().forEach(track=>track.stop());
  video.pause();video.srcObject=null;video.removeAttribute('src');
  if(preview&&!transferred)URL.revokeObjectURL(preview);
  layer.remove();document.removeEventListener('keydown',key);capture=null;
  if(previousFocus?.isConnected)previousFocus.focus();
 };
 const cancel=button('Отмена',()=>{captureGeneration++;close();},'quiet-button');
 const start=button('Начать запись',()=>{
  if(!recorder||recorder.state!=='inactive'||blob)return;
  chunks=[];size=0;started=Date.now();recorder.start(500);start.hidden=true;stop.hidden=false;
  status.textContent='0:00 / 1:00';screen.classList.add('recording');
  timer=setInterval(()=>{const seconds=(Date.now()-started)/1000;status.textContent=clock(seconds)+' / 1:00';if(seconds>=60)stopRecording();},200);
 },'primary-button');
 const stop=button('Остановить',stopRecording,'primary-button');stop.hidden=true;
 const play=button('Посмотреть',()=>{video.paused?video.play().catch(()=>toast('Нажмите ещё раз для просмотра.')):video.pause();},'quiet-button');play.hidden=true;
 const again=button('Переснять',()=>{close();recordVideo(onSend);},'quiet-button');again.hidden=true;
 const send=button('Отправить',()=>{
  if(!blob)return;video.pause();transferred=true;
  const item={kind:'video',blob,extension:blob.type==='video/mp4'?'mp4':'webm',preview,meta:{duration:finishedDuration,size:blob.size,mime:blob.type}};
  close();onSend(item);
 },'primary-button');send.hidden=true;
 function stopRecording(){
  if(!recorder||recorder.state==='inactive')return;
  clearInterval(timer);stop.disabled=true;status.textContent='Готовим предпросмотр…';recorder.stop();
 }
 function key(event){
  if(event.key==='Escape'){event.preventDefault();captureGeneration++;close();}
  if(event.key==='Tab'){
   const nodes=Array.from(panel.querySelectorAll('button')).filter(node=>!node.hidden&&!node.disabled),first=nodes[0],last=nodes[nodes.length-1];
   if(event.shiftKey&&document.activeElement===first){last.focus();event.preventDefault();}
   else if(!event.shiftKey&&document.activeElement===last){first.focus();event.preventDefault();}
  }
 }
 start.disabled=true;actions.append(cancel,start,stop,play,again,send);panel.append(title,screen,status,actions);layer.appendChild(panel);document.body.appendChild(layer);cancel.focus();document.addEventListener('keydown',key);
 capture={close};
 try{
  stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:{facingMode:'user',width:{ideal:640},height:{ideal:640},frameRate:{ideal:24,max:30}}});
  if(closed||current!==captureGeneration){stream.getTracks().forEach(track=>track.stop());return;}
  video.srcObject=stream;await video.play();
  const format=FORMATS.find(mime=>MediaRecorder.isTypeSupported(mime));
  if(!format)throw Error('Не найден формат записи видео.');
  recorder=new MediaRecorder(stream,{mimeType:format,videoBitsPerSecond:600000,audioBitsPerSecond:64000});
  recorder.addEventListener('dataavailable',event=>{if(event.data.size){chunks.push(event.data);size+=event.data.size;if(size>16*1024*1024)stopRecording();}});
  recorder.addEventListener('error',()=>{toast('Запись прервалась. Попробуйте ещё раз.');close();});
  recorder.addEventListener('stop',()=>{
   if(!closed&&video.readyState>=2){try{const poster=document.createElement('canvas');poster.width=poster.height=320;const side=Math.min(video.videoWidth,video.videoHeight);poster.getContext('2d').drawImage(video,(video.videoWidth-side)/2,(video.videoHeight-side)/2,side,side,0,0,320,320);video.poster=poster.toDataURL('image/jpeg',.8);}catch(_error){}}
   stream.getTracks().forEach(track=>track.stop());if(closed)return;
   screen.classList.remove('recording');video.srcObject=null;video.classList.remove('live');
   const seconds=(Date.now()-started)/1000;
   finishedDuration=Math.min(60,seconds);
   if(seconds<.7||!size||size>16*1024*1024){status.textContent=size>16*1024*1024?'Видео получилось больше 16 МБ. Запишите покороче.':'Слишком короткая запись.';stop.hidden=true;again.hidden=false;again.focus();return;}
   const mime=(recorder.mimeType||format).split(';')[0];blob=new Blob(chunks,{type:mime});
   preview=URL.createObjectURL(blob);video.src=preview;video.muted=false;video.preload='metadata';
   status.textContent=clock(seconds)+' · Посмотрите запись или отправьте';stop.hidden=true;play.hidden=again.hidden=send.hidden=false;send.focus();
  });
  stream.getVideoTracks().forEach(track=>track.addEventListener('ended',()=>{if(recorder?.state==='recording')stopRecording();}));
  start.disabled=false;status.textContent='До минуты · фронтальная камера · со звуком';
 }catch(error){if(!closed){status.textContent=error.name==='NotAllowedError'?'Разрешите доступ к камере и микрофону.':error.message||'Не удалось открыть камеру.';if(stream)stream.getTracks().forEach(track=>track.stop());start.hidden=true;again.hidden=false;}}
}
document.addEventListener('visibilitychange',()=>{if(document.hidden&&capture){cancelVideoRecording();toast('Запись закрыта при уходе из приложения.');}});

const urls=new Map();let playing=null;
export function stopVideo(){if(playing){playing.pause();playing=null;}}
export function resetVideos(){cancelVideoRecording();stopVideo();urls.forEach(p=>p.then(URL.revokeObjectURL).catch(()=>{}));urls.clear();}
export function forgetVideo(path){const old=urls.get(path);if(old)old.then(URL.revokeObjectURL).catch(()=>{});urls.delete(path);}
function videoURL(path){
 if(!urls.has(path)){const pending=window.MayakCloud.videoDownload(path).then(blob=>URL.createObjectURL(blob));urls.set(path,pending);pending.catch(()=>urls.delete(path));}
 return urls.get(path);
}
export function videoNode(message){
 const box=element('div','message-video'),toggle=element('button','video-note');toggle.type='button';toggle.setAttribute('aria-label','Смотреть видеокружочек');
 const video=element('video');video.playsInline=true;video.setAttribute('playsinline','');video.preload='none';
 const icon=element('span','video-note-icon','▶'),time=element('span','video-note-time',clock(message.file_meta?.duration));
 toggle.append(video,icon,time);box.appendChild(toggle);
 video.addEventListener('play',()=>{stopVoice();if(playing&&playing!==video)playing.pause();playing=video;toggle.classList.add('playing');toggle.setAttribute('aria-label','Приостановить видеокружочек');});
 const paint=()=>{toggle.classList.remove('playing');toggle.setAttribute('aria-label','Смотреть видеокружочек');};
 video.addEventListener('pause',paint);video.addEventListener('ended',()=>{paint();video.currentTime=0;time.textContent=clock(message.file_meta?.duration);});
 video.addEventListener('timeupdate',()=>{if(!video.paused)time.textContent=clock(Math.max(0,(video.duration||message.file_meta?.duration||0)-video.currentTime));});
 video.addEventListener('error',()=>{icon.textContent='↻';paint();toggle.classList.remove('loading');});
 let loading=false;
 toggle.addEventListener('click',async()=>{
  if(loading)return;if(!video.paused){video.pause();return;}
  try{
   if(!video.src){loading=true;toggle.classList.add('loading');icon.textContent='…';video.src=await videoURL(message.file);icon.textContent='▶';}
   await video.play();
  }catch(error){if(error.name==='NotAllowedError')toast('Видео загружено. Нажмите кружочек для просмотра.');else{video.removeAttribute('src');forgetVideo(message.file);toast('Не удалось загрузить видео. Нажмите ещё раз.');}}
  finally{loading=false;toggle.classList.remove('loading');}
 });
 return box;
}
document.addEventListener('mayak-audio-start',stopVideo);
