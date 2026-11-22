// Видеокружочки: камера/предпросмотр и плеер. Обработку и публикацию выполняет сервер.
import {$,state,element,button,toast} from './core.js';
import {clock,stopVoice} from './media.js';

const FORMATS=['video/mp4;codecs=avc1.42E01E,mp4a.40.2','video/mp4','video/webm;codecs=vp8,opus','video/webm'];
export const canRecordVideo=()=>!!(navigator.mediaDevices?.getUserMedia&&window.MediaRecorder);
let capture=null,captureGeneration=0;
export function cancelVideoRecording(){captureGeneration++;if(capture)capture.close();}
export async function recordVideo(onSend,initialFacing='user'){
 if(capture)return;
 if(!canRecordVideo()){toast('Этот браузер не умеет записывать видео.');return;}
 stopVoice();stopVideo();
 const current=++captureGeneration,previousFocus=document.activeElement;
 previousFocus?.blur();
 const layer=element('div','video-record-layer'),panel=element('section','video-record-panel');
 panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-labelledby','video-record-title');
 const title=element('h2','','Видеокружочек');title.id='video-record-title';
 const header=element('div','video-record-header'),stage=element('div','video-record-stage');
 const screen=element('div','video-record-screen'),video=element('video','video-record-preview live');
 video.muted=true;video.playsInline=true;video.disablePictureInPicture=true;video.disableRemotePlayback=true;video.setAttribute('playsinline','');video.setAttribute('webkit-playsinline','');screen.appendChild(video);stage.appendChild(screen);
 const status=element('p','video-record-status','Запрашиваем камеру и микрофон…');status.setAttribute('role','status');
 const actions=element('div','video-record-actions');
 let stream=null,recorder=null,timer=null,blob=null,preview=null,transferred=false,started=0,finishedDuration=0,chunks=[],size=0,closed=false,loading=false,facing=initialFacing,finishFrame=null;
 let viewportWidth=0,settleUntil=Date.now()+600;
 const resizePreview=()=>{const diameter=Math.max(0,Math.floor(Math.min(300,stage.clientWidth,stage.clientHeight)));screen.style.width=screen.style.height=diameter+'px';};
 const layout=()=>{
  const view=window.visualViewport,width=view?.width||innerWidth;
  if(view?.scale&&Math.abs(view.scale-1)>.01)return;
  // Высоту фиксируем после закрытия клавиатуры; обычные тапы и панели Safari её не меняют.
  if(viewportWidth&&Math.abs(width-viewportWidth)<2&&innerWidth<=760&&Date.now()>settleUntil)return;
  viewportWidth=width;
  Object.assign(layer.style,{left:(view?.offsetLeft||0)+'px',top:(view?.offsetTop||0)+'px',width:width+'px',height:(view?.height||innerHeight)+'px'});
  resizePreview();
 };
 const resizeObserver=window.ResizeObserver?new ResizeObserver(resizePreview):null;
 const view=window.visualViewport;
 const close=()=>{
  if(closed)return;closed=true;clearInterval(timer);
  finishFrame?.();
  try{if(recorder&&recorder.state!=='inactive')recorder.stop();}catch(_error){}
  if(stream)stream.getTracks().forEach(track=>track.stop());
  video.pause();video.srcObject=null;video.removeAttribute('src');
  if(preview&&!transferred)URL.revokeObjectURL(preview);
  resizeObserver?.disconnect();window.removeEventListener('resize',layout);view?.removeEventListener('resize',layout);view?.removeEventListener('scroll',layout);
  layer.remove();document.removeEventListener('keydown',key);capture=null;
  if(previousFocus?.isConnected)previousFocus.focus({preventScroll:true});
 };
 const flip=button('',async()=>{
  if(loading||blob||!recorder||recorder.state!=='inactive')return;
  const before=facing,target=facing==='user'?'environment':'user';
  if(!await openCamera(target,true)&&!closed&&current===captureGeneration){
   const reason=status.textContent;
   if(await openCamera(before,false))status.textContent='Камера не переключилась. '+cameraName()+'. Можно записывать.';
   else status.textContent=reason;
  }
 },'video-record-flip');
 flip.setAttribute('aria-label','Переключить камеру');flip.disabled=true;
 const icon=document.createElementNS('http://www.w3.org/2000/svg','svg'),path=document.createElementNS(icon.namespaceURI,'path');icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('aria-hidden','true');path.setAttribute('d','M8 5 9.5 3h5L16 5h4v14H4V5h4ZM8 10a4 4 0 0 1 7-1l1 1M16 7v3h-3M16 14a4 4 0 0 1-7 1l-1-1M8 17v-3h3');icon.appendChild(path);flip.appendChild(icon);
 function cameraName(){return facing==='environment'?'Основная камера':'Фронтальная камера';}
 const cancel=button('Отмена',()=>{captureGeneration++;close();},'quiet-button');
 const start=button('Начать запись',()=>{
  if(!recorder||recorder.state!=='inactive'||blob)return;
  chunks=[];size=0;started=Date.now();recorder.start(500);start.hidden=true;stop.hidden=false;flip.disabled=true;
  status.textContent='0:00 / 1:00';screen.classList.add('recording');
  timer=setInterval(()=>{const seconds=(Date.now()-started)/1000;status.textContent=clock(seconds)+' / 1:00';if(seconds>=60)stopRecording();},200);
 },'primary-button');
 const stop=button('Остановить',stopRecording,'primary-button');stop.hidden=true;
 const play=button('Посмотреть',()=>{video.paused?video.play().catch(()=>toast('Нажмите ещё раз для просмотра.')):video.pause();},'quiet-button');play.hidden=true;
 const again=button('Переснять',()=>{close();recordVideo(onSend,facing);},'quiet-button');again.hidden=true;
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
 cancel.classList.add('video-record-cancel');[start,stop,send].forEach(node=>node.classList.add('video-record-main'));play.classList.add('video-record-play');again.classList.add('video-record-again');
 start.disabled=true;actions.append(cancel,start,stop,play,again,send);header.append(title,flip);panel.append(header,stage,status,actions);layer.appendChild(panel);document.body.appendChild(layer);
 layout();resizeObserver?.observe(stage);window.addEventListener('resize',layout);view?.addEventListener('resize',layout);view?.addEventListener('scroll',layout);
 layer.addEventListener('pointerdown',()=>{settleUntil=0;},{once:true});layer.addEventListener('dblclick',event=>event.preventDefault());
 cancel.focus({preventScroll:true});document.addEventListener('keydown',key);
 capture={close};
 async function openCamera(target,exact){
  if(closed||current!==captureGeneration)return false;
  loading=true;flip.disabled=true;start.disabled=true;status.textContent=stream?'Переключаем камеру…':'Запрашиваем камеру и микрофон…';
  video.pause();video.srcObject=null;if(stream)stream.getTracks().forEach(track=>track.stop());stream=null;recorder=null;
  let source=null;
  try{
   source=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:{facingMode:exact?{exact:target}:{ideal:target},width:{ideal:640},height:{ideal:640},frameRate:{ideal:24,max:30}}});
   if(closed||current!==captureGeneration){source.getTracks().forEach(track=>track.stop());return false;}
   stream=source;facing=source.getVideoTracks()[0]?.getSettings?.().facingMode||target;
   video.classList.toggle('live',facing==='user');video.srcObject=source;await video.play();
   // Play может разрешиться до первого кадра камеры: не включаем запись преждевременно.
   if(video.requestVideoFrameCallback&&!closed)await new Promise(resolve=>{
    let frame=0;const done=()=>{clearTimeout(timeout);if(frame)video.cancelVideoFrameCallback(frame);finishFrame=null;resolve();};
    const timeout=setTimeout(done,2000);finishFrame=done;frame=video.requestVideoFrameCallback(done);
   });
   if(closed||current!==captureGeneration){source.getTracks().forEach(track=>track.stop());return false;}
  const format=FORMATS.find(mime=>MediaRecorder.isTypeSupported(mime));
  if(!format)throw Error('Не найден формат записи видео.');
  const activeRecorder=new MediaRecorder(source,{mimeType:format,videoBitsPerSecond:600000,audioBitsPerSecond:64000});recorder=activeRecorder;
  activeRecorder.addEventListener('dataavailable',event=>{if(!closed&&recorder===activeRecorder&&event.data.size){chunks.push(event.data);size+=event.data.size;if(size>16*1024*1024)stopRecording();}});
  activeRecorder.addEventListener('error',()=>{if(!closed&&recorder===activeRecorder){toast('Запись прервалась. Попробуйте ещё раз.');close();}});
  activeRecorder.addEventListener('stop',()=>{
   if(closed||recorder!==activeRecorder){source.getTracks().forEach(track=>track.stop());return;}
   if(!closed&&video.readyState>=2){try{const poster=document.createElement('canvas');poster.width=poster.height=320;const side=Math.min(video.videoWidth,video.videoHeight);poster.getContext('2d').drawImage(video,(video.videoWidth-side)/2,(video.videoHeight-side)/2,side,side,0,0,320,320);video.poster=poster.toDataURL('image/jpeg',.8);}catch(_error){}}
   source.getTracks().forEach(track=>track.stop());if(closed)return;
   screen.classList.remove('recording');video.srcObject=null;video.classList.remove('live');
   const seconds=(Date.now()-started)/1000;
   finishedDuration=Math.min(60,seconds);
   if(seconds<.7||!size||size>16*1024*1024){status.textContent=size>16*1024*1024?'Видео получилось больше 16 МБ. Запишите покороче.':'Слишком короткая запись.';stop.hidden=true;again.hidden=false;again.focus({preventScroll:true});return;}
   const mime=(recorder.mimeType||format).split(';')[0];blob=new Blob(chunks,{type:mime});
   preview=URL.createObjectURL(blob);video.src=preview;video.muted=false;video.preload='metadata';
   status.textContent=clock(seconds)+' · Посмотрите запись или отправьте';stop.hidden=true;play.hidden=again.hidden=send.hidden=false;send.focus({preventScroll:true});
  });
  source.getVideoTracks().forEach(track=>track.addEventListener('ended',()=>{if(recorder===activeRecorder&&activeRecorder.state==='recording')stopRecording();}));
  start.disabled=false;start.hidden=false;again.hidden=true;flip.disabled=false;flip.title=facing==='user'?'Включить основную камеру':'Включить фронтальную камеру';status.textContent='До минуты · '+cameraName().toLowerCase()+' · со звуком';return true;
 }catch(error){source?.getTracks().forEach(track=>track.stop());if(!closed&&current===captureGeneration){status.textContent=error.name==='NotAllowedError'?'Разрешите доступ к камере и микрофону.':error.name==='OverconstrainedError'||error.name==='NotFoundError'?'Эта камера недоступна.':error.message||'Не удалось открыть камеру.';start.hidden=true;again.hidden=false;}return false;}
 finally{loading=false;}
 }
 await openCamera(initialFacing,false);
}
document.addEventListener('visibilitychange',()=>{if(document.hidden&&capture){cancelVideoRecording();toast('Запись закрыта при уходе из приложения.');}});

const urls=new Map();let playing=null,playingFile=null;
export function stopVideo(){if(playing){playing.pause();playing=null;}playingFile=null;}
export function resetVideos(){cancelVideoRecording();stopVideo();urls.forEach(p=>p.then(URL.revokeObjectURL).catch(()=>{}));urls.clear();}
export function forgetVideo(path){if(playingFile===path)stopVideo();const old=urls.get(path);if(old)old.then(URL.revokeObjectURL).catch(()=>{});urls.delete(path);}
function videoURL(path){
 if(window.MayakCloud.videoStream)return window.MayakCloud.videoStream(path);
 if(!urls.has(path)){const pending=window.MayakCloud.videoDownload(path).then(blob=>{if(urls.get(path)!==pending)throw new Error('Файл удалён из хранилища');return URL.createObjectURL(blob);});urls.set(path,pending);pending.catch(()=>{if(urls.get(path)===pending)urls.delete(path);});}
 return urls.get(path);
}
export function videoNode(message){
 const box=element('div','message-video'),toggle=element('button','video-note');toggle.type='button';toggle.setAttribute('aria-label','Смотреть видеокружочек');
 const video=element('video');video.playsInline=true;video.setAttribute('playsinline','');video.preload='none';
 const current=()=>toggle.isConnected&&state.messages.some(item=>item.id===message.id&&item.file===message.file&&!item.deleted);
 const discard=()=>{video.pause();video.removeAttribute('src');video.load();};
 const icon=element('span','video-note-icon','▶'),time=element('span','video-note-time',clock(message.file_meta?.duration));
 toggle.append(video,icon,time);box.appendChild(toggle);
 video.addEventListener('play',()=>{if(!current()){discard();return;}stopVoice();if(playing&&playing!==video)playing.pause();playing=video;playingFile=message.file;toggle.classList.add('playing');toggle.setAttribute('aria-label','Приостановить видеокружочек');});
 const paint=()=>{toggle.classList.remove('playing');toggle.setAttribute('aria-label','Смотреть видеокружочек');};
 video.addEventListener('pause',paint);video.addEventListener('ended',()=>{paint();video.currentTime=0;time.textContent=clock(message.file_meta?.duration);});
 video.addEventListener('timeupdate',()=>{if(!video.paused)time.textContent=clock(Math.max(0,(video.duration||message.file_meta?.duration||0)-video.currentTime));});
 video.addEventListener('error',()=>{icon.textContent='↻';paint();toggle.classList.remove('loading');video.removeAttribute('src');forgetVideo(message.file);});
 let loading=false;
 toggle.addEventListener('click',async()=>{
  if(loading||!current())return;if(!video.paused){video.pause();return;}
  try{
   if(!video.src){loading=true;toggle.classList.add('loading');icon.textContent='…';video.src=await videoURL(message.file);icon.textContent='▶';}
   if(!current()){discard();return;}
   await video.play();if(!current())discard();
  }catch(error){if(!current()){discard();return;}if(error.name==='NotAllowedError')toast('Видео загружено. Нажмите кружочек для просмотра.');else{video.removeAttribute('src');forgetVideo(message.file);toast('Не удалось загрузить видео. Нажмите ещё раз.');}}
  finally{loading=false;toggle.classList.remove('loading');}
 });
 return box;
}
document.addEventListener('mayak-audio-start',stopVideo);
