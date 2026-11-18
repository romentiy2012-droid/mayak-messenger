// Админское окно: только метаданные. Файлы и предпросмотры здесь не загружаются.
import {state,post,element,button,problem} from './core.js';
const PAGE=50,MAX_SELECTION=20;
const names={all:'Все файлы',photo:'Фото',voice:'Голосовые',video:'Видеокружочки',source:'Исходные записи',avatar:'Аватарки',unused:'Неиспользуемые',other:'Прочее'};
const categories={...names,photos:'Фото',voices:'Голосовые',videos:'Видеокружочки',sources:'Исходные записи',avatars:'Аватарки'};
const bytes=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
function size(value){
 if(!bytes(value))return 'неизвестно';
 const units=['Б','КБ','МБ','ГБ','ТБ'];let index=0,n=value;
 while(n>=1000&&index<units.length-1){n/=1000;index++;}
 return new Intl.NumberFormat('ru-RU',{maximumFractionDigits:index?1:0}).format(n)+' '+units[index];
}
function date(value){const dayOnly=typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value),timestamp=Date.parse(dayOnly?value+'T12:00:00':value);return Number.isFinite(timestamp)?new Intl.DateTimeFormat('ru-RU',dayOnly?{dateStyle:'short'}:{dateStyle:'short',timeStyle:'short'}).format(timestamp):'не указано';}
function usageURL(value){try{const url=new URL(value);return url.protocol==='https:'&&url.hostname==='supabase.com'&&!url.username&&!url.password&&/^\/dashboard\/org\/[a-zA-Z0-9_-]+\/usage\/?$/.test(url.pathname)?url.origin+url.pathname:null;}catch{return null;}}
function nonce(){const values=new Uint8Array(16);crypto.getRandomValues(values);return Array.from(values,value=>value.toString(16).padStart(2,'0')).join('');}

export function storageWindow(content){
 const owner=state.user?.id;
 if(!owner||!state.user.owner){content.appendChild(element('p','form-error','Это окно доступно только владельцу.'));return ()=>{};}
 let disposed=false,generation=0,busy=false,filter='all',offset=0,snapshot=null,pending=null;
 const selected=new Map(),root=element('section','storage-window'),status=element('p','storage-status','Получаем сведения…'),error=element('p','form-error storage-error'),panel=content.closest('.dialog-card');
 if(panel)panel.classList.add('storage-dialog');
 status.setAttribute('role','status');error.setAttribute('role','alert');error.hidden=true;
 const overview=element('div','storage-overview'),details=element('div','storage-details');
 const toolbar=element('div','storage-toolbar'),filterLabel=element('label','storage-filter','Показать'),filterSelect=element('select');filterSelect.setAttribute('aria-label','Вид файлов');
 Object.entries(names).forEach(([value,label])=>{const option=element('option','',label);option.value=value;filterSelect.appendChild(option);});filterLabel.appendChild(filterSelect);
 const refresh=button('Обновить',()=>load(),'quiet-button');toolbar.append(filterLabel,refresh);
 const selection=element('div','storage-selection'),selectionText=element('p','storage-selection-count'),selectionNote=element('p','about-note storage-selection-note');
 const selectPage=button('Выбрать на странице',()=>{let slots=MAX_SELECTION-selected.size;for(const item of snapshot?.items||[]){if(slots<=0)break;if(item.can_delete&&!selected.has(item.id)){selected.set(item.id,{...item});slots--;}}renderFiles();renderSelection();},'quiet-button');
 const clear=button('Снять выбор',()=>{selected.clear();renderFiles();renderSelection();},'quiet-button');
 const remove=button('Удалить выбранные',()=>confirmDelete(),'quiet-button danger');
 const retry=button('Повторить удаление',()=>deleteSelected(),'quiet-button danger');retry.hidden=true;
 const selectionButtons=element('div','storage-selection-buttons');selectionButtons.append(selectPage,clear,remove,retry);selection.append(selectionText,selectionButtons,selectionNote);
 const confirm=element('section','storage-confirm');confirm.hidden=true;confirm.setAttribute('aria-label','Подтверждение удаления файлов');
 const files=element('ul','storage-files'),empty=element('p','storage-empty','Файлов в этом разделе нет.');empty.hidden=true;
 const pagination=element('nav','storage-pagination');pagination.setAttribute('aria-label','Страницы файлов');
 const previous=button('Назад',()=>{offset=Math.max(0,offset-PAGE);load();},'quiet-button'),pageText=element('span'),next=button('Далее',()=>{offset+=PAGE;load();},'quiet-button');pagination.append(previous,pageText,next);
 root.append(status,error,overview,details,toolbar,selection,confirm,empty,files,pagination);content.appendChild(root);
 const active=()=>!disposed&&state.user?.id===owner&&state.user.owner;
 function fail(message){error.textContent=message;error.hidden=!message;}
 function selectionSize(){let total=0,unknown=0;selected.forEach(item=>{if(bytes(item.bytes))total+=item.bytes;else unknown++;});return (unknown?'не менее ':'')+size(total)+(unknown?' · размер '+unknown+' неизвестен':'');}
 function controls(){
  filterSelect.disabled=refresh.disabled=busy;previous.disabled=busy||!snapshot||offset===0;next.disabled=busy||!snapshot?.has_more;
  selectPage.disabled=busy||!!pending||selected.size>=MAX_SELECTION||!(snapshot?.items||[]).some(item=>item.can_delete&&!selected.has(item.id));
  clear.disabled=busy||!!pending||!selected.size;remove.disabled=busy||!selected.size;remove.hidden=!!pending;
  retry.hidden=!pending;retry.disabled=busy;retry.textContent=busy?'Удаляем…':'Повторить удаление';
  files.querySelectorAll('input').forEach(input=>{input.disabled=busy||!!pending||input.dataset.protected==='true'||(!input.checked&&selected.size>=MAX_SELECTION);});
 }
 function renderSelection(){selectionText.textContent=selected.size?'Выбрано: '+selected.size+' · '+selectionSize():'Выбери файлы для удаления';selectionNote.textContent=pending?'Результат удаления ещё не подтверждён для всех файлов. Повтори операцию тем же набором.':'Можно выбрать до '+MAX_SELECTION+' файлов за один раз. Предпросмотр содержимого недоступен.';controls();}
 function card(title){const node=element('section','storage-card');node.appendChild(element('h3','',title));overview.appendChild(node);return node;}
 function renderOverview(){
  overview.replaceChildren();details.replaceChildren();
  const usage=snapshot.storage||{},traffic=snapshot.traffic||{},storage=card('Файлы сейчас');
  storage.appendChild(element('p','storage-number',(usage.unknown_size_count?'Известный объём: ':'Занято: ')+size(usage.used_bytes)));
  storage.appendChild(element('p','storage-free','Запас до лимита по файлам Маяка: '+size(usage.free_bytes)+(bytes(usage.quota_bytes)?' из '+size(usage.quota_bytes):'')));
  if(bytes(usage.used_bytes)&&bytes(usage.quota_bytes)&&usage.quota_bytes>0){
   const ratio=usage.used_bytes/usage.quota_bytes,percent=Math.floor(ratio*100);
   if(ratio>=.8){const level=ratio>=1?'full':ratio>=.9?'high':'near',text=ratio>=1?'По файлам Маяка лимит достигнут или превышен ('+percent+'%). Новые загрузки могут остановиться.':'По файлам Маяка занято '+percent+'% лимита.'+(ratio>=.9?' Освободи место перед новыми загрузками.':'');storage.appendChild(element('p','storage-limit-note storage-limit-'+level,text));}
  }
  if(usage.unknown_size_count)storage.appendChild(element('p','about-note','У '+usage.unknown_size_count+' файлов размер неизвестен; свободное место пока не рассчитано.'));
  if(!bytes(usage.quota_bytes))storage.appendChild(element('p','about-note','Лимит хранилища не подтверждён.'));
  storage.appendChild(element('p','about-note','Размер файлов сейчас — не среднемесячный показатель для расчёта лимита.'));
  if(usage.quota_scope==='organization')storage.appendChild(element('p','about-note','Лимит общий для организации: его расходуют и другие проекты.'));
  if(usage.quota_verified_at)storage.appendChild(element('p','about-note','Лимит проверен: '+date(usage.quota_verified_at)));
  const transfer=card('Трафик за месяц'),known=traffic.status==='known'&&bytes(traffic.used_bytes),stale=traffic.status==='stale';
  transfer.appendChild(element('p','storage-number',known?'Использовано: '+size(traffic.used_bytes):stale?'Устаревший снимок':'Точный расход недоступен'));
  if(stale&&bytes(traffic.used_bytes))transfer.appendChild(element('p','','Последний известный расход: '+size(traffic.used_bytes)));
  if(traffic.reason)transfer.appendChild(element('p','about-note',String(traffic.reason)));
  if(bytes(traffic.uncached_quota_bytes))transfer.appendChild(element('p','storage-quota','Без кэша: до '+size(traffic.uncached_quota_bytes)));
  if(bytes(traffic.cached_quota_bytes))transfer.appendChild(element('p','storage-quota','Из кэша: до '+size(traffic.cached_quota_bytes)));
  if(traffic.observed_at)transfer.appendChild(element('p','about-note','Снимок трафика: '+date(traffic.observed_at)));
  const url=usageURL(snapshot.usage_url);
  if(url){const link=element('a','storage-usage-link','Открыть точный расход в Supabase');link.href=url;link.target='_blank';link.rel='noopener noreferrer';transfer.appendChild(link);}
  const breakdown=element('dl','storage-breakdown');
  for(const item of usage.breakdown||[]){const row=element('div');row.append(element('dt','',(categories[item.category]||'Прочее')+' · '+item.count),element('dd','',size(item.bytes)));breakdown.appendChild(row);}
  details.appendChild(breakdown);details.appendChild(element('p','about-note storage-observed','Снимок хранилища: '+date(snapshot.observed_at)));
 }
 function renderFiles(){
  files.replaceChildren();const items=snapshot?.items||[];empty.hidden=!!items.length;
  for(const item of items){
   const row=element('li','storage-file'),label=element('label','storage-file-label'),input=element('input');input.type='checkbox';input.checked=selected.has(item.id);input.dataset.protected=String(!item.can_delete);input.setAttribute('aria-label','Выбрать: '+(item.label||names[item.kind]||'Файл'));
   input.addEventListener('change',()=>{if(busy||pending)return;if(input.checked){if(selected.size>=MAX_SELECTION){input.checked=false;return;}selected.set(item.id,{...item});}else selected.delete(item.id);confirm.hidden=true;renderSelection();});
   const info=element('span','storage-file-info');info.appendChild(element('strong','',item.label||names[item.kind]||'Файл'));
   const scope={main:'Общий чат',direct:'Личный чат',unused:'Неиспользуемый файл'}[item.scope]||'Файл';
   info.appendChild(element('span','storage-file-meta',size(item.bytes)+' · '+date(item.created_at)+' · '+scope));
   if(!item.can_delete)info.appendChild(element('span','storage-file-reason',item.reason||'Сейчас удалить нельзя.'));
   label.append(input,info);row.appendChild(label);files.appendChild(row);
  }
  const total=snapshot?.total_count;pageText.textContent=items.length?(offset+1)+'–'+(offset+items.length)+(typeof total==='number'?' из '+total:''):'';controls();
 }
 function accept(data){
  snapshot=data;offset=Number.isFinite(data.offset)?data.offset:offset;
  const recovery=data.pending_operation;
  if(!pending&&recovery&&typeof recovery.nonce==='string'&&Array.isArray(recovery.items)&&recovery.items.length&&recovery.items.length<=MAX_SELECTION){
   pending={nonce:recovery.nonce,items:Object.freeze(recovery.items.map(item=>Object.freeze({id:item.id,version:item.version})))};
   selected.clear();
   for(const item of recovery.items)if(item.status!=='deleted')selected.set(item.id,{label:'Неудалённый файл',...(data.items||[]).find(file=>file.id===item.id),id:item.id,version:item.version,bytes:item.bytes});
  }
  renderOverview();renderFiles();renderSelection();status.textContent='Файлов в хранилище: '+(data.storage?.objects_count??'неизвестно');
 }
 async function load(){
  if(!active()||busy)return;const current=++generation;busy=true;confirm.hidden=true;fail('');status.textContent='Обновляем сведения…';controls();
  try{const data=await post('storage',{action:'overview',filter,offset});if(active()&&current===generation)accept(data);}
  catch(error){if(active()&&current===generation){fail(problem(error));status.textContent=snapshot?'Показан предыдущий снимок.':'Сведения не получены.';}}
  finally{if(active()&&current===generation){busy=false;controls();}}
 }
 function confirmDelete(){
  if(!active()||busy||pending||!selected.size)return;
  confirm.replaceChildren(element('h3','','Удалить '+selected.size+' файлов безвозвратно?'),element('p','','Выбрано: '+selectionSize()+'. Файлы будут удалены из облака для всех участников, в том числе из личных чатов. Текст сообщений останется. Отменить удаление нельзя.'));
  const actions=element('div','storage-confirm-actions'),cancel=button('Не удалять',()=>{confirm.hidden=true;remove.focus();},'quiet-button'),yes=button('Удалить безвозвратно',()=>deleteSelected(),'primary-button danger-button');actions.append(cancel,yes);confirm.appendChild(actions);confirm.hidden=false;cancel.focus();
 }
 async function deleteSelected(){
  if(!active()||busy)return;
  if(!pending){if(!selected.size)return;pending={nonce:nonce(),items:Object.freeze(Array.from(selected.values(),item=>Object.freeze({id:item.id,version:item.version})))};}
  const operation=pending,current=++generation;busy=true;confirm.hidden=true;fail('');status.textContent='Удаляем выбранные файлы…';controls();
  try{
   const result=await post('storage',{action:'delete',items:operation.items,nonce:operation.nonce,filter,offset});if(!active()||current!==generation)return;
   const results=new Map((result.operation?.items||[]).map(item=>[item.id,item]));let failed=0;const errors=[];
   for(const item of operation.items){const outcome=results.get(item.id);if(outcome?.status==='deleted')selected.delete(item.id);else{failed++;if(outcome?.error)errors.push(String(outcome.error));}}
   if(!failed)pending=null;accept(result);
   if(failed)fail('Не удалено файлов: '+failed+'. '+(errors[0]||'Результат не подтверждён. Можно повторить удаление.'));else status.textContent=pending?'Операция завершена. Осталось другое незавершённое удаление.':'Удаление завершено. Счётчики обновлены по данным сервера.';
  }catch(error){
   if(active()&&current===generation){
    if(error.status===409){
     try{
      const fresh=await post('storage',{action:'overview',filter,offset});
      if(!active()||current!==generation)return;
      pending=null;selected.clear();accept(fresh);
      fail(pending?'Список изменился. Восстановлено незавершённое удаление — повтори его.':'Список изменился. Выбери файлы снова.');
      status.textContent=pending?'Нужно закончить ранее начатое удаление.':'Список обновлён; файлы можно выбрать заново.';
     }catch(_refreshError){if(active()&&current===generation){fail('Список изменился, но обновить его не удалось. Повтори проверку удаления.');status.textContent='Результат ещё не подтверждён; прежний набор сохранён.';}}
    }else{fail(error.status?problem(error):'Не удалось получить результат удаления. Повтори операцию — уже удалённые файлы не будут учтены повторно.');status.textContent='Удаление требует проверки; счётчики не изменены.';}
   }
  }
  finally{if(active()&&current===generation){busy=false;renderSelection();}}
 }
 filterSelect.addEventListener('change',()=>{filter=filterSelect.value;offset=0;load();});renderSelection();load();
 return ()=>{disposed=true;generation++;selected.clear();pending=null;if(panel)panel.classList.remove('storage-dialog');};
}
