// Личная коллекция хранится на этом устройстве отдельно для каждой учётной записи.
import {state, element, toast} from './core.js';
import {prepareSticker, mediaBlob} from './media.js';

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
export async function entries(user){return (await transaction('readonly',store=>store.getAll())).filter(item=>item.user===user).sort((a,b)=>b.created-a.created);}
async function put(blob,user){
  const bytes=await blob.arrayBuffer(),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  const key=user+':'+hash, existing=await transaction('readonly',store=>store.get(key));
  if(existing)return false;
  if((await entries(user)).length>=LIMIT)throw new Error('В коллекции уже 120 стикеров. Удали ненужный, чтобы добавить новый.');
  await transaction('readwrite',store=>store.put({key,user,blob,created:Date.now()}));return true;
}
export async function addPersonalSticker(file,user){
  const item=await prepareSticker(file);if(currentUser()!==user)return false;
  return put(item.blob,user);
}
export async function rememberPersonalSticker(file,user,changes){
  const prepared=await prepareSticker(file);if(currentUser()!==user)return;
  await put(prepared.blob,user);
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await prepared.blob.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('');
  const item=await transaction('readonly',store=>store.get(user+':'+hash));
  if(item)await changeSticker(item,changes);
}
export async function changeSticker(item,changes){
  if(item.user!==currentUser())return;
  await transaction('readwrite',store=>{const request=store.get(item.key);request.addEventListener('success',()=>{const saved=request.result;if(saved&&saved.user===currentUser())store.put({...saved,...changes});});return request;});
}
export async function deleteSticker(item){
  if(item.user!==currentUser())return;
  await transaction('readwrite',store=>store.delete(item.key));
}
export async function saveStickerFromMessage(message){
  const user=currentUser();if(!user||!message?.file||message.deleted)return;
  try{
    const blob=await mediaBlob(message.file),item=await prepareSticker(blob);
    if(currentUser()!==user)return;
    const added=await put(item.blob,user);if(currentUser()===user){toast(added?'Стикер сохранён':'Этот стикер уже в коллекции');document.dispatchEvent(new Event('mayak-stickers-changed'));}
  }catch(_error){if(currentUser()===user)toast('Не удалось сохранить стикер на устройстве.');}
}
// Изолированное поле для вставки изображения системной клавиатурой iOS.
export function keyboardStickerField(onFile){
  const keyboard=element('div','sticker-keyboard');keyboard.contentEditable='true';keyboard.setAttribute('role','textbox');keyboard.setAttribute('aria-label','Вставить стикер с клавиатуры');keyboard.setAttribute('data-placeholder','Выбрать стикер с клавиатуры');let busy=false;
  async function accept(file){if(busy||!keyboard.isConnected)return;busy=true;try{await onFile(file);}catch{if(keyboard.isConnected)toast('Не удалось получить стикер.');}finally{busy=false;if(keyboard.isConnected)keyboard.replaceChildren();}}
  keyboard.addEventListener('paste',event=>{event.preventDefault();const file=[...(event.clipboardData?.items||[])].filter(i=>i.kind==='file'&&i.type.startsWith('image/')).map(i=>i.getAsFile()).find(Boolean);if(file)accept(file);else toast('Выбери изображение стикера.');});
  keyboard.addEventListener('input',()=>{
    const img=keyboard.querySelector('img'),src=img?.getAttribute('src')||'';
    if(!img||!(/^(data:image\/(png|webp|jpeg|gif);base64,|blob:)/i.test(src))){keyboard.replaceChildren();return;}
    const capture=async()=>{try{if(!keyboard.isConnected||!img.naturalWidth||img.naturalWidth*img.naturalHeight>40000000)return;const scale=Math.min(1,512/Math.max(img.naturalWidth,img.naturalHeight)),c=document.createElement('canvas');c.width=Math.max(1,Math.round(img.naturalWidth*scale));c.height=Math.max(1,Math.round(img.naturalHeight*scale));c.getContext('2d').drawImage(img,0,0,c.width,c.height);const blob=await new Promise(r=>c.toBlob(r,'image/png'));if(blob)await accept(blob);}catch{if(keyboard.isConnected){keyboard.replaceChildren();toast('Не удалось получить стикер.');}}};
    if(img.complete)capture();else{img.onload=capture;img.onerror=()=>keyboard.replaceChildren();}
  });return keyboard;
}
