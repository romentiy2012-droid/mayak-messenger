// Встроенная панель. Личная коллекция и предпочтения разделены по аккаунту.
import {$,state,prefs,element,button,toast} from './core.js';
import {entries,addPersonalSticker,rememberPersonalSticker,changeSticker,deleteSticker,keyboardStickerField} from './stickers.js';
import {insertEmoji,sendSticker} from './composer.js';
import {adjustViewport,nearBottom,scrollBottom} from './viewport.js';

let panel,nav,search,body,footer,tab='stickers',section='mine',group='faces',data=null;
let user,room,epoch=0,revision=0,busy=false,selection=[0,0],urls=[],catalog=null,installed=[],recent=[];
const project=(window.MAYAK_CONFIG||{}).supabaseURL||location.pathname;
const key=part=>'expressions:'+project+':'+user+':'+part;
const read=part=>{try{const value=JSON.parse(prefs.get(key(part),'[]'));return Array.isArray(value)?value:[];}catch{return [];}};
const write=(part,value)=>{if(prefs.set(key(part),JSON.stringify(value))===false){toast('Не удалось сохранить на устройстве.');return false;}return true;};
const valid=ticket=>ticket===epoch&&!panel.hidden&&state.user?.id===user&&state.room===room;
const release=()=>{urls.forEach(URL.revokeObjectURL);urls=[];};
const normalize=text=>String(text||'').toLowerCase().replace(/ё/g,'е').trim();
function note(text){body.appendChild(element('p','expression-empty',text));}
function icon(label,text,action){const node=button(text,action,'expression-icon');node.setAttribute('aria-label',label);node.title=label;return node;}
function selected(node,on){node.setAttribute('aria-pressed',String(on));node.classList.toggle('selected',on);}
export function closeExpressions(focus=false){
  if(!panel||panel.hidden)return;
  epoch++;revision++;panel.hidden=true;panel.replaceChildren();release();busy=false;
  $('stickers-button').setAttribute('aria-expanded','false');$('stickers-button').setAttribute('aria-label','Стикеры и эмодзи');
  $('stickers-button').closest('.composer-area').classList.remove('expression-open');adjustViewport();
  if(focus)$('stickers-button').focus({preventScroll:true});
}
function switchTab(next){tab=next;search.value='';search.placeholder=tab==='emoji'?'Найти эмодзи':'Найти стикер';render();}
function categories(){
  const left=nav.scrollLeft;nav.replaceChildren();
  const options=tab==='emoji'?[['recent','🕘','Недавние эмодзи'],...(data||[]).map(g=>[g.id,g.icon,g.title])]:[['recent','🕘','Недавние стикеры'],['favorites','☆','Избранные стикеры'],['mine','','Мои стикеры'],...installed.map(p=>[p.id,'',p.title,p.items[0]?.url])];
  for(const [id,label,title,cover] of options){
    const node=icon(title,label,()=>{if(tab==='emoji')group=id;else section=id;search.value='';render();});
    if(cover){
      node.classList.add('expression-pack-icon');const image=element('img');image.alt='';image.decoding='async';image.loading='lazy';image.draggable=false;
      image.addEventListener('error',()=>{node.textContent=title.trim().split(/\s+/).slice(0,2).map(word=>Array.from(word)[0]).join('').toUpperCase();},{once:true});image.src=cover;node.appendChild(image);
    }else if(tab==='stickers'&&id==='mine'){
      node.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H6a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h8l7-7V6a3 3 0 0 0-3-3Z"/><path d="M14 21v-4a3 3 0 0 1 3-3h4M8 8h.01M14 8h.01M8 12c1.5 1.5 4.5 1.5 6 0"/></svg>';
    }
    selected(node,(tab==='emoji'?group:section)===id);nav.appendChild(node);
  }
  nav.scrollLeft=left;
}
function bottom(){
  footer.replaceChildren();footer.appendChild(icon('Управление стикерами','⚙',()=>{tab='stickers';section='manage';search.value='';render();}));
  const tabs=element('div','expression-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Тип содержимого');
  for(const [id,label] of [['stickers','Стикеры'],['emoji','Эмодзи']]){
    const node=button(label,()=>switchTab(id),'expression-tab');node.id='expression-tab-'+id;node.setAttribute('role','tab');node.setAttribute('aria-controls','expression-body');node.setAttribute('aria-selected',String(tab===id));node.tabIndex=tab===id?0:-1;
    node.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();switchTab(id==='emoji'?'stickers':'emoji');$('expression-tab-'+tab).focus();});tabs.appendChild(node);
  }
  footer.appendChild(tabs);footer.appendChild(tab==='emoji'?icon('Удалить последний символ','⌫',backspace):icon('Каталог наборов','＋',()=>{section='catalog';search.value='';render();}));
  body.setAttribute('aria-labelledby','expression-tab-'+tab);
}
function backspace(){
  const input=$('message-input');let [from,to]=selection;from=Math.min(from,input.value.length);to=Math.min(to,input.value.length);
  if(from===to&&from>0){
    const prefix=input.value.slice(0,from);
    if(Intl.Segmenter){const parts=[...new Intl.Segmenter('ru',{granularity:'grapheme'}).segment(prefix)];from=parts.at(-1)?.index||0;}
    else {const chars=Array.from(prefix);let last=chars.pop();while(chars.length&&(last==='\uFE0F'||/^[\u{1F3FB}-\u{1F3FF}]$/u.test(last)||chars.at(-1)==='\u200D')){if(chars.at(-1)==='\u200D')chars.pop();last=chars.pop();}from=chars.join('').length;}
  }
  const caret=insertEmoji('',from,to);if(caret!==null)selection=[caret,caret];
}
async function emojiContent(ticket){
  if(!data){note('Загружаем эмодзи…');try{data=(await import('./emoji-data.js')).emojiGroups;if(valid(ticket))render();}catch{if(valid(ticket)){body.replaceChildren();note('Не удалось загрузить эмодзи. Попробуй открыть вкладку ещё раз.');}}return;}
  const query=normalize(search.value),all=data.flatMap(g=>g.items),source=query?all:group==='recent'?recent.map(e=>all.find(row=>row[0]===e)).filter(Boolean):(data.find(g=>g.id===group)||data[0]).items;
  const items=query?source.filter(row=>normalize(row.join(' ')).includes(query)):source;
  body.appendChild(element('h3','expression-heading',query?'Результаты поиска':group==='recent'?'Недавние':data.find(g=>g.id===group)?.title));
  if(!items.length){note(query?'Ничего не найдено.':'Здесь появятся выбранные эмодзи.');return;}
  const grid=element('div','emoji-grid');
  for(const [emoji,title] of items){const node=button(emoji,()=>{
    if(!valid(ticket))return;const caret=insertEmoji(emoji,...selection);if(caret===null)return;selection=[caret,caret];recent=[emoji,...recent.filter(e=>e!==emoji)].slice(0,48);write('emoji-recent',recent);
  },'emoji-pick');node.setAttribute('aria-label',title);node.title=title;grid.appendChild(node);}
  body.appendChild(grid);
}
async function pick(blob,item,ticket){
  if(busy||!valid(ticket))return;busy=true;panel.setAttribute('aria-busy','true');
  try{
    const accepted=await sendSticker(blob,room,user);if(!accepted)return;
    try{if(item?.key)await changeSticker(item,{lastUsed:Date.now()});else await rememberPersonalSticker(blob,user,{lastUsed:Date.now()});}
    catch{if(valid(ticket))toast('Стикер отправлен, но недавние не сохранились.');}
    if(valid(ticket)&&(section==='recent'||!item))render();
  }catch(error){if(valid(ticket))toast(error.message||'Не удалось отправить стикер.');}
  finally{if(valid(ticket)){busy=false;panel.removeAttribute('aria-busy');}}
}
function tile(item,index,ticket,manage=false){
  const node=element('div','expression-sticker'),pickButton=button('',()=>pick(item.blob,item,ticket),'expression-sticker-pick');pickButton.setAttribute('aria-label','Отправить стикер '+(index+1));
  const image=element('img');image.alt='';const url=URL.createObjectURL(item.blob);urls.push(url);image.src=url;pickButton.appendChild(image);node.appendChild(pickButton);
  const favorite=icon(item.favorite?'Убрать из избранного':'В избранное',item.favorite?'★':'☆',async()=>{try{await changeSticker(item,{favorite:!item.favorite});if(valid(ticket))render();}catch{toast('Не удалось сохранить избранное.');}});favorite.classList.add('sticker-favorite');node.appendChild(favorite);
  if(manage){const remove=icon('Удалить стикер '+(index+1),'×',async()=>{try{await deleteSticker(item);if(valid(ticket))render();}catch{toast('Не удалось удалить стикер.');}});remove.classList.add('sticker-delete');node.appendChild(remove);}
  return node;
}
async function stickerContent(ticket,paint){
  if(section==='catalog'){await catalogContent(ticket,paint);return;}
  const pack=installed.find(p=>p.id===section);
  if(pack){packContent(pack,ticket);return;}
  let items;try{items=await entries(user);}catch{if(valid(ticket)&&paint===revision)note('Коллекция недоступна на этом устройстве.');return;}
  if(!valid(ticket)||paint!==revision)return;
  const query=normalize(search.value),manage=section==='manage';
  if(section==='favorites')items=items.filter(i=>i.favorite);
  if(section==='recent')items=items.filter(i=>i.lastUsed).sort((a,b)=>b.lastUsed-a.lastUsed).slice(0,32);
  if(query)items=items.filter(i=>normalize(i.title||'стикер мои').includes(query));
  body.appendChild(element('h3','expression-heading',section==='recent'?'Недавние':section==='favorites'?'Избранное':'Мои стикеры'));
  if(manage){
    const input=element('input');input.type='file';input.accept='image/*';input.hidden=true;input.setAttribute('aria-label','Добавить стикер из файла');
    const add=button('Добавить картинку',()=>input.click(),'expression-add');
    input.addEventListener('change',async()=>{const file=input.files[0];input.value='';if(!file)return;add.disabled=true;const account=user;try{const added=await addPersonalSticker(file,account);if(valid(ticket)){if(!added)toast('Этот стикер уже в коллекции');render();}}catch(error){if(valid(ticket))toast(error.message||'Не удалось добавить стикер.');}finally{add.disabled=false;}});
    body.append(add,input,element('p','expression-hint','Можно также выбрать стикер с клавиатуры iPhone:'),keyboardStickerField(blob=>pick(blob,null,ticket)));
    for(const p of installed){const remove=button('Убрать набор «'+p.title+'»',()=>{const next=installed.filter(v=>v.id!==p.id);if(write('packs',next)){installed=next;render();}},'expression-add');body.appendChild(remove);}
  }
  if(!items.length)note(query?'Ничего не найдено.':section==='recent'?'Здесь появятся отправленные стикеры.':section==='favorites'?'Нажми ☆ рядом со стикером, чтобы сохранить его здесь.':'Коллекция пока пуста. Добавить свои стикеры можно через ⚙.');
  const grid=element('div','expression-sticker-grid');items.forEach((item,i)=>grid.appendChild(tile(item,i,ticket,manage)));body.appendChild(grid);
}
function safeAsset(path){try{const url=new URL(path,new URL('../',import.meta.url));return url.origin===location.origin&&url.pathname.includes('/assets/stickers/')&&/\.png$/i.test(url.pathname)&&!url.search&&!url.hash?url.href:null;}catch{return null;}}
function packsFrom(value){return Array.isArray(value)?value.filter(p=>p&&/^[a-z0-9_-]{1,64}$/.test(p.id)&&typeof p.title==='string'&&Array.isArray(p.items)).slice(0,60).map(p=>({id:p.id,title:p.title.slice(0,80),items:p.items.slice(0,120).filter(i=>i&&safeAsset(i.url)).map(i=>({url:safeAsset(i.url),title:String(i.title||'Стикер').slice(0,100),tags:String(i.tags||'').slice(0,200)}))})).filter(p=>p.items.length):[];}
async function catalogContent(ticket,paint){
  if(catalog===null){
    note('Загружаем наборы…');const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
    try{const response=await fetch(new URL('../assets/sticker-packs.json',import.meta.url),{cache:'no-cache',signal:controller.signal,credentials:'omit'});if(!response.ok)throw Error();const json=await response.json();catalog=packsFrom(json.packs);}
    catch{if(valid(ticket)&&paint===revision){body.replaceChildren();note('Каталог сейчас недоступен. Свои стикеры и эмодзи работают без него.');}return;}finally{clearTimeout(timer);}
    if(valid(ticket)&&paint===revision)render();return;
  }
  body.appendChild(element('h3','expression-heading','Каталог наборов'));
  const query=normalize(search.value),packs=catalog.filter(p=>!query||normalize(p.title).includes(query));
  if(!packs.length){note(query?'Наборы не найдены.':'Наборов пока нет. Здесь появятся новые коллекции Маяка.');return;}
  for(const pack of packs){const card=element('div','expression-pack'),head=element('div','expression-pack-head');head.appendChild(element('strong','',pack.title));const isAdded=installed.some(p=>p.id===pack.id),add=button(isAdded?'Добавлен':'Добавить',()=>{if(!valid(ticket))return;if(write('packs',[...installed,pack])){installed.push(pack);render();}},'expression-add');add.disabled=isAdded;head.appendChild(add);card.append(head,element('small','',pack.items.length+' стикеров'));const preview=element('div','expression-pack-preview');for(const item of pack.items.slice(0,4)){const img=element('img');img.alt=item.title;img.loading='lazy';img.src=item.url;preview.appendChild(img);}card.appendChild(preview);body.appendChild(card);}
}
function packContent(pack,ticket){
  body.appendChild(element('h3','expression-heading',pack.title));const grid=element('div','expression-sticker-grid'),query=normalize(search.value);
  for(const item of pack.items.filter(i=>!query||normalize(i.title+' '+i.tags).includes(query))){const node=button('',async()=>{if(busy||!valid(ticket))return;busy=true;const control=new AbortController(),timeout=setTimeout(()=>control.abort(),15000);try{const response=await fetch(item.url,{signal:control.signal,credentials:'omit'});if(!response.ok)throw Error();const blob=await response.blob();if(blob.size>4*1024*1024)throw Error();busy=false;await pick(blob,null,ticket);}catch{if(valid(ticket))toast('Не удалось загрузить стикер.');}finally{clearTimeout(timeout);if(valid(ticket))busy=false;}},'expression-sticker-pick');node.setAttribute('aria-label',item.title);const img=element('img');img.alt='';img.loading='lazy';img.src=item.url;node.appendChild(img);grid.appendChild(node);}
  body.appendChild(grid);
}
function render(){
  if(panel.hidden)return;const ticket=epoch,paint=++revision;release();body.replaceChildren();body.scrollTop=0;categories();bottom();
  if(tab==='emoji')emojiContent(ticket);else stickerContent(ticket,paint);
}
export function initExpressions(){
  panel=$('expression-panel');const input=$('message-input'),trigger=$('stickers-button');
  trigger.addEventListener('click',()=>{
    if(!panel.hidden){closeExpressions(true);return;}
    if(!state.user||state.sending||state.editing)return;
    user=state.user.id;room=state.room;epoch++;busy=false;catalog=null;recent=read('emoji-recent').filter(e=>typeof e==='string').slice(0,48);installed=packsFrom(read('packs'));selection=[input.selectionStart,input.selectionEnd];
    document.activeElement?.blur();panel.hidden=false;trigger.setAttribute('aria-expanded','true');trigger.setAttribute('aria-label','Закрыть стикеры и эмодзи');trigger.closest('.composer-area').classList.add('expression-open');
    nav=element('div','expression-categories');nav.setAttribute('aria-label','Категории и наборы');
    const tools=element('div','expression-search-row');search=element('input','expression-search');search.type='search';search.placeholder=tab==='emoji'?'Найти эмодзи':'Найти стикер';search.setAttribute('aria-label','Поиск в панели');search.addEventListener('input',render);
    tools.append(search,icon('Вернуться к клавиатуре','⌨',()=>{closeExpressions();input.focus({preventScroll:true});}));
    body=element('div','expression-body');body.id='expression-body';body.setAttribute('role','tabpanel');footer=element('div','expression-footer');panel.append(nav,tools,body,footer);const bottom=nearBottom();render();adjustViewport();if(bottom)scrollBottom();
  });
  input.addEventListener('focus',()=>closeExpressions());
  for(const id of ['voice-button','camera-button','attach-button'])$(id).addEventListener('click',()=>closeExpressions(),{capture:true});
  document.addEventListener('mayak-expression-close',()=>closeExpressions());
  document.addEventListener('mayak-context-changed',()=>{closeExpressions();tab='stickers';section='mine';group='faces';});
  document.addEventListener('mayak-stickers-changed',()=>{if(!panel.hidden)render();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!panel.hidden){event.preventDefault();closeExpressions(true);}});
}
