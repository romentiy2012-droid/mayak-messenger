// Личная коллекция хранится на этом устройстве отдельно для каждой учётной записи.
import {$, state, element, button, toast} from './core.js';
import {prepareSticker, mediaBlob} from './media.js';
import {attachSticker} from './composer.js';

const DB='mayak-stickers', STORE='stickers', LIMIT=120;
function openDB(){return new Promise((resolve,reject)=>{
  const request=indexedDB.open(DB,1);
  request.onupgradeneeded=()=>request.result.createObjectStore(STORE,{keyPath:'key'});
  request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
});}
async function transaction(mode,action){
  const db=await openDB();
  try{return await new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,mode),request=action(tx.objectStore(STORE));let value;
    request.onsuccess=()=>{value=request.result;};request.onerror=()=>reject(request.error);
    tx.oncomplete=()=>resolve(value);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error || new Error('Операция отменена'));
  });}finally{db.close();}
}
const currentUser=()=>state.user?.id;
async function entries(user){return (await transaction('readonly',store=>store.getAll())).filter(item=>item.user===user).sort((a,b)=>b.created-a.created);}
async function put(blob,user){
  const bytes=await blob.arrayBuffer(),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  const key=user+':'+hash, existing=await transaction('readonly',store=>store.get(key));
  if(existing)return false;
  if((await entries(user)).length>=LIMIT)throw new Error('В коллекции уже 120 стикеров. Удали ненужный, чтобы добавить новый.');
  await transaction('readwrite',store=>store.put({key,user,blob,created:Date.now()}));return true;
}
export async function saveStickerFromMessage(message){
  const user=currentUser();if(!user||!message?.file||message.deleted)return;
  try{
    const blob=await mediaBlob(message.file),item=await prepareSticker(blob);
    if(currentUser()!==user)return;
    const added=await put(item.blob,user);if(currentUser()===user)toast(added?'Стикер сохранён':'Этот стикер уже в коллекции');
  }catch(_error){if(currentUser()===user)toast('Не удалось сохранить стикер на устройстве.');}
}
export function stickerCollection(content,onClose){
  const user=currentUser(),room=state.room,urls=[];let active=true,revision=0;
  const hint=element('p','sticker-hint','Твои стикеры на этом устройстве. Нажми на картинку, чтобы добавить её в сообщение.');
  const keyboardLabel=element('p','sticker-hint','Стикер с клавиатуры: нажми сюда и выбери его на клавиатуре.');
  const keyboard=element('div','sticker-keyboard');keyboard.contentEditable='true';keyboard.setAttribute('role','textbox');keyboard.setAttribute('aria-label','Вставить стикер с клавиатуры');keyboard.setAttribute('data-placeholder','Выбрать стикер с клавиатуры');
  const input=element('input');input.type='file';input.accept='image/*';input.hidden=true;
  const add=button('Добавить картинку',()=>input.click(),'primary-button');
  const status=element('p','sticker-status','Загружаем…');status.setAttribute('role','status');
  const grid=element('div','sticker-grid');content.append(hint,keyboardLabel,keyboard,add,input,status,grid);
  let capturing=false;
  async function acceptKeyboard(blob){
    if(capturing || !active || currentUser()!==user || state.room!==room)return;
    capturing=true;
    try {const selected=await attachSticker(blob);if(selected && active && currentUser()===user && state.room===room)onClose();}
    finally {capturing=false;if(active)keyboard.replaceChildren();}
  }
  keyboard.addEventListener('paste',event=>{
    const file=[...(event.clipboardData?.items||[])].filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).find(Boolean);
    event.preventDefault();if(file)acceptKeyboard(file);else toast('Выбери или вставь изображение стикера.');
  });
  keyboard.addEventListener('input',()=>{
    const img=keyboard.querySelector('img');
    if(!img){keyboard.replaceChildren();return;}
    const src=img.getAttribute('src')||'';
    if(!/^(data:image\/(png|webp|jpeg|gif);base64,|blob:)/i.test(src)){keyboard.replaceChildren();toast('Не удалось получить картинку с клавиатуры.');return;}
    const capture=async()=>{try{
      if(!active || !img.naturalWidth || img.naturalWidth*img.naturalHeight>40000000)throw new Error();
      const scale=Math.min(1,512/Math.max(img.naturalWidth,img.naturalHeight)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
      canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw new Error();await acceptKeyboard(blob);
    }catch(_error){if(active){keyboard.replaceChildren();toast('Не удалось получить картинку с клавиатуры.');}}};
    if(img.complete)capture();else {img.onload=capture;img.onerror=()=>{if(active){keyboard.replaceChildren();toast('Не удалось получить картинку с клавиатуры.');}};}
  });
  const release=()=>{while(urls.length)URL.revokeObjectURL(urls.pop());};
  async function render(){
    const generation=++revision;
    try{
      const items=await entries(user);if(!active||currentUser()!==user||generation!==revision)return;
      grid.replaceChildren();release();status.textContent=items.length?'Стикеров: '+items.length:'Пока нет стикеров. Добавь картинку или сохрани стикер из чата.';
      items.forEach((item,index)=>{
        const tile=element('div','sticker-tile'),pick=button('',async()=>{
          if(!active||currentUser()!==user||state.room!==room)return;
          const selected=await attachSticker(item.blob);if(selected && active && currentUser()===user && state.room===room)onClose();
        },'sticker-pick');
        pick.setAttribute('aria-label','Выбрать стикер '+(index+1));const image=element('img');image.alt='';const url=URL.createObjectURL(item.blob);urls.push(url);image.src=url;pick.appendChild(image);
        const remove=button('×',async()=>{
          if(!active||currentUser()!==user)return;
          try{await transaction('readwrite',store=>store.delete(item.key));await render();}catch(_error){toast('Не удалось удалить стикер.');}
        },'sticker-remove');remove.setAttribute('aria-label','Удалить стикер '+(index+1));tile.append(pick,remove);grid.appendChild(tile);
      });
    }catch(_error){if(active)status.textContent='Коллекция недоступна на этом устройстве.';}
  }
  input.addEventListener('change',async()=>{
    const file=input.files[0];input.value='';if(!file)return;add.disabled=true;
    try{const item=await prepareSticker(file);if(!active||currentUser()!==user)return;const added=await put(item.blob,user);if(active){if(!added)toast('Этот стикер уже в коллекции');await render();}}
    catch(error){if(active)toast(error.message || 'Не удалось добавить стикер.');}finally{add.disabled=false;}
  });
  const contextChanged=()=>{if(active && (currentUser()!==user || state.room!==room))onClose();};
  document.addEventListener('mayak-context-changed',contextChanged);
  render();return ()=>{active=false;revision++;document.removeEventListener('mayak-context-changed',contextChanged);release();};
}
