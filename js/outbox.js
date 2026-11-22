import {$, state, post, element, button, MAIN} from './core.js';
import {mergeMessages, connection} from './messages.js';
import {rememberMedia} from './media.js';
import {queuedMessages, saveQueued, removeQueued} from './offline.js';

let items = [], epoch = 0, timer = null, running = new Set(), retry = 0;
const temporary = error => !error.status || [408,409,425,429].includes(error.status) || error.status >= 500;
const valid = (user, generation) => state.user?.id === user && epoch === generation;
export function resetOutbox() {epoch++; items = []; running = new Set(); clearTimeout(timer); paint();}
export async function restoreOutbox() {
  const user=state.user?.id, generation=epoch;if(!user)return;
  try {const loaded=await queuedMessages(user);if(!valid(user,generation))return;items=loaded.sort((a,b)=>a.created-b.created);paint();flushOutbox();} catch(_error) {}
}
export async function enqueue(item) {
  const user=state.user?.id,generation=epoch;if(!user)throw new Error('Войдите в чат.');
  const queued={...item,user,created:Date.now(),status:'queued',error:''};
  try {await saveQueued(queued);} catch(_error) {throw new Error('Не удалось сохранить отправку на устройстве. Освободи место и повтори — сообщение осталось в поле.');}
  if(!valid(user,generation))return false;
  const existing=items.findIndex(row=>row.nonce===queued.nonce);if(existing<0)items.push(queued);else items[existing]=queued;
  paint();flushOutbox();return true;
}
function paint() {
  const list=$('outbox-list');if(!list)return;list.replaceChildren();
  if(!state.user)return;
  items.filter(item=>item.user===state.user.id&&item.room===state.room).forEach(item=>{
    const row=element('div','outbox-row');row.dataset.nonce=item.nonce;
    const title=item.kind==='text'?item.text:item.sticker?'Стикер':item.kind==='photo'?'Фото':item.kind==='voice'?'Голосовое':'Видеокружочек';
    row.appendChild(element('span','outbox-title',title));
    const busy=running.has(item.nonce);
    row.appendChild(element('span','outbox-status',busy?(item.progress || 'Отправляем…'):item.status==='failed'?item.error:'Ждёт отправки'));
    if(!busy){
      row.appendChild(button('Повторить',()=>{item.status='queued';item.error='';saveQueued(item).then(()=>flushOutbox()).catch(()=>{});},'outbox-action'));
      row.appendChild(button('Убрать',async()=>{await removeQueued(item);items=items.filter(row=>row!==item);paint();},'outbox-action'));
    }
    list.appendChild(row);
  });
}
function schedule() {clearTimeout(timer);if(state.user&&items.some(item=>item.status!=='failed'))timer=setTimeout(flushOutbox,Math.min(30000,2000*2**Math.min(retry++,4)));}
export function flushOutbox() {
  clearTimeout(timer);
  if(!state.user||!state.verified||!navigator.onLine){schedule();return;}
  // Текст не ждёт большой файл. В каждой полосе только одна отправка.
  for(const media of [false,true]) {
    if(items.some(item=>running.has(item.nonce)&&(item.kind!=='text')===media))continue;
    const item=items.find(item=>item.status!=='failed'&&(item.kind!=='text')===media&&!running.has(item.nonce));
    if(item)deliver(item);
  }
}
async function deliver(item) {
  const user=item.user,generation=epoch;running.add(item.nonce);paint();
  const persist=async()=>{if(!valid(user,generation))throw new Error('Вход изменился.');await saveQueued(item);};
  try {
    const body={text:item.text||'',nonce:item.nonce,reply:item.reply||null,peer:item.peer||null,_user:user};let result;
    if(item.kind==='text')result=await post('messages',body);
    else {
      if(!item.path){
        item.progress='Загружаем…';paint();
        if(window.MayakCloud.uploadQueued) item.path=await window.MayakCloud.uploadQueued(item,async()=>persist(),percent=>{if(valid(user,generation)){item.progress='Загрузка '+percent+'%';paint();}});
        else item.path=await (item.kind==='video'?window.MayakCloud.videoUpload(item.blob,item.extension):window.MayakCloud.upload(item.blob,item.extension,undefined,item.sticker?'sticker-':''));
        await persist();
      }
      if(!valid(user,generation))return;
      if(item.kind==='video'){
        // Серверное задание и nonce сохраняются: потеря ответа не создаёт второе видео.
        const started=await post('video-start',{...body,file:item.path,room:item.room});item.job=started.job.id;await persist();
        const response=await post('video-status',{id:item.job,_user:user});
        if(response.job.state==='sent')result=response;
        else if(['failed','cancelled'].includes(response.job.state))throw Object.assign(new Error(response.job.error||'Не удалось обработать видео. Нажми «Повторить».'),{status:422});
        else {item.progress='Видео обрабатывается…';await persist();return;}
      }else{
        result=await post('attach',{...body,kind:item.kind,file:item.path,meta:item.meta});
        if(valid(user,generation)&&item.blob)rememberMedia(item.path,item.blob);
      }
    }
    if(!valid(user,generation))return;
    // Сначала сохраняем получение в интерфейсе; повтор после сбоя удаления безопасен по nonce.
    mergeMessages([result.message],'sent');connection(true);await removeQueued(item);
    if(!valid(user,generation))return;
    items=items.filter(row=>row.nonce!==item.nonce);retry=0;
  }catch(error){
    if(!valid(user,generation))return;
    item.progress='';item.status=temporary(error)?'queued':'failed';item.error=error.status?error.message:'Ждёт соединения';
    if(!error.status)connection(false);
    if(error.status===401||error.status===403)document.dispatchEvent(new CustomEvent('mayak-auth-required',{detail:error}));
    await persist().catch(()=>{});
  }finally{
    if(valid(user,generation)){running.delete(item.nonce);paint();schedule();}
  }
}
document.addEventListener('mayak-context-changed',paint);
window.addEventListener('online',()=>{retry=0;flushOutbox();});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)flushOutbox();});
