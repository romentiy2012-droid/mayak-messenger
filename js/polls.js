// Опросы: публичные итоги в сообщении, личный бюллетень получает только его участник.
import {state,post,prefs,element,button,problem} from './core.js';
const nonce=()=>crypto.randomUUID(),cache=new Map(),drafts=new Map();let epoch=0;
export function resetPolls(){epoch++;cache.clear();drafts.clear();}
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const rejected=error=>!!error.code&&(/^(22|23)/.test(error.code)||['P0001','42501','PGRST301'].includes(error.code));
const parse=key=>{try{return JSON.parse(prefs.get(key,'null'));}catch{return null;}};
function save(key,value){prefs.set(key,value?JSON.stringify(value):null);}

export function pollEditor(content,{room,peer,reply,onSent,onBusy,onDone}){
 const user=state.user.id,key='poll-draft:'+user+':'+room;
 let draft=parse(key)||{question:'',options:['',''],multiple:false,anonymous:true},disposed=false,busy=false;
 if(!Array.isArray(draft.options)||draft.options.length<2||draft.options.length>10)draft={question:'',options:['',''],multiple:false,anonymous:true};
 const form=element('form','poll-editor'),question=element('textarea'),options=element('div','poll-editor-options');
 question.rows=2;question.maxLength=300;question.required=true;question.value=draft.question;question.setAttribute('aria-label','Вопрос опроса');question.placeholder='О чём спросим?';
 const hint=element('p','about-note','От 2 до 10 разных вариантов. После отправки вопрос и настройки фиксируются.');
 const multiple=element('input');multiple.type='checkbox';multiple.checked=draft.multiple;
 const anonymous=element('input');anonymous.type='checkbox';anonymous.checked=draft.anonymous;
 const check=(input,text)=>{const label=element('label','poll-setting');label.append(input,element('span','',text));return label;};
 const add=button('＋ Вариант ответа',()=>{draft.options.push('');changed();drawOptions();});
 const error=element('p','form-error');error.setAttribute('role','alert');
 const submit=element('button','primary-button','Отправить опрос');submit.type='submit';
 const status=element('p','poll-editor-status');status.setAttribute('role','status');
 form.append(question,hint,options,add,check(multiple,'Можно выбрать несколько ответов'),check(anonymous,'Анонимный — участникам видны только итоги'),status,error,submit);content.appendChild(form);
 const active=()=>!disposed&&state.user?.id===user;
 function controls(){form.querySelectorAll('input,textarea,.poll-option-remove').forEach(node=>node.disabled=busy||!!draft.pending);add.disabled=busy||!!draft.pending||draft.options.length>=10;submit.disabled=busy;submit.textContent=busy?'Отправляем…':draft.pending?'Повторить отправку':'Отправить опрос';status.textContent=draft.pending?'Отправка ещё не подтверждена. Повтор сохранит тот же вопрос и не создаст дубль.':'';}
 function changed(){if(busy||draft.pending)return;draft.question=question.value;draft.multiple=multiple.checked;draft.anonymous=anonymous.checked;delete draft.nonce;save(key,draft);controls();}
 function drawOptions(){
  options.replaceChildren();draft.options.forEach((value,index)=>{const row=element('div','poll-editor-option'),input=element('input');input.type='text';input.maxLength=100;input.required=true;input.value=value;input.placeholder='Вариант '+(index+1);input.setAttribute('aria-label','Вариант '+(index+1));
   input.addEventListener('input',()=>{draft.options[index]=input.value;changed();});const remove=button('×',()=>{draft.options.splice(index,1);changed();drawOptions();},'quiet-button poll-option-remove');remove.setAttribute('aria-label','Убрать вариант '+(index+1));remove.hidden=draft.options.length<=2;row.append(input,remove);options.appendChild(row);});controls();
 }
 [question,multiple,anonymous].forEach(node=>node.addEventListener('input',changed));drawOptions();
 form.addEventListener('submit',async event=>{
  event.preventDefault();if(!active()||busy)return;error.textContent='';
  const questionText=question.value.trim(),labels=draft.options.map(value=>value.trim());
  if(!questionText||labels.some(value=>!value)||new Set(labels.map(value=>value.toLowerCase())).size!==labels.length){error.textContent='Напиши вопрос и разные непустые варианты.';return;}
  if(!draft.pending){draft={question:questionText,options:labels,multiple:multiple.checked,anonymous:anonymous.checked,nonce:nonce(),pending:true,peer,reply};save(key,draft);}
  const body={question:draft.question,options:draft.options,multiple:draft.multiple,anonymous:draft.anonymous,nonce:draft.nonce,peer:draft.peer??null,reply:draft.reply??null};
  busy=true;onBusy(true);controls();
  try{const result=await post('poll-create',body);if(!active())return;save(key,null);onBusy(false);onSent(result.message);onDone();}
  catch(cause){if(active()){if(rejected(cause)){draft.pending=false;delete draft.nonce;save(key,draft);}error.textContent=problem(cause);}}
  finally{busy=false;onBusy(false);if(active())controls();}
 });
 return ()=>{disposed=true;};
}

export function pollNode(message,onUpdate){
 const user=state.user.id,currentEpoch=epoch,id=message.id,key='poll-vote:'+user+':'+id,root=element('section','poll-card');
 root.setAttribute('aria-label','Опрос');
 let data=null,selection=[],busy=false,voters=null,confirming=false,errorText='',pending=parse(key),model=message;
 const active=()=>state.user?.id===user&&epoch===currentEpoch;
 const visible=()=>active()&&root.isConnected&&state.messages.some(item=>item.id===id&&!item.deleted&&item.kind==='poll');
 function remember(result){
  if(!active())return;
  const known=state.messages.find(item=>item.id===id);
  if(!known||known.deleted||known.kind!=='poll')return;
  if(Number(result.message.rev)<Number(known.rev))return;
  cache.set(user+':'+id+':'+result.message.rev,result);if(cache.size>200)cache.delete(cache.keys().next().value);
  if(Number(result.message.rev)>Number(known.rev))onUpdate(result.message);
 }
 function apply(result){data=result;model=result.message;selection=[...(model.file_meta?.multiple&&!model.file_meta.closed_at&&drafts.has(key)?drafts.get(key):result.mine)];remember(result);if(visible())render();}
 async function refresh(){
  if(!visible()||busy)return;busy=true;errorText='';render();
  try{const cached=cache.get(user+':'+id+':'+model.rev);apply(cached||await post('poll-get',{id}));}
  catch(cause){if(visible())errorText=problem(cause);}
  finally{busy=false;if(visible())render();}
 }
 async function vote(choices){
  if(!visible()||busy)return;
  if(!pending){pending={nonce:nonce(),choices:[...choices].sort((a,b)=>a-b)};save(key,pending);}
  const request=pending;busy=true;errorText='';render();
  try{const result=await post('poll-vote',{id,nonce:request.nonce,choices:request.choices});if(!active())return;if(parse(key)?.nonce===request.nonce)save(key,null);pending=null;drafts.delete(key);voters=null;apply(result);}
  catch(cause){if(active()){if(rejected(cause)){pending=null;save(key,null);}if(visible())errorText=problem(cause);}}
  finally{busy=false;if(visible())render();}
 }
 async function close(){
  if(!visible()||busy)return;busy=true;errorText='';render();
  try{const result=await post('poll-close',{id});if(active()){confirming=false;apply(result);}}
  catch(cause){if(visible())errorText=problem(cause);}
  finally{busy=false;if(visible())render();}
 }
 async function showVoters(){
  if(!visible()||busy)return;if(voters){voters=null;render();return;}busy=true;errorText='';render();
  try{const result=await post('poll-get',{id,voters:true});if(visible()){voters=result.voters;apply(result);}}
  catch(cause){if(visible())errorText=problem(cause);}
  finally{busy=false;if(visible())render();}
 }
 function render(){
  const meta=model.file_meta||{},closed=!!meta.closed_at,mine=data?.mine||[],choices=meta.options||[],total=Number(meta.total)||0;
  root.replaceChildren(element('h3','poll-question',meta.question||model.text));
  root.appendChild(element('p','poll-kind',(meta.anonymous?'Анонимный опрос':'Открытый опрос')+' · '+(meta.multiple?'Несколько ответов':'Один ответ')));
  const list=element('div','poll-options');
  for(const option of choices){
   const percent=total?Math.round(Number(option.count)*100/total):0,chosen=selection.includes(option.id);
   const item=button('',()=>{if(meta.multiple){selection=chosen?selection.filter(value=>value!==option.id):[...selection,option.id].sort((a,b)=>a-b);drafts.set(key,selection);if(drafts.size>200)drafts.delete(drafts.keys().next().value);render();}else if(!mine.includes(option.id))vote([option.id]);},'poll-option'+(chosen?' selected':''));
   item.disabled=busy||closed||!data||!!pending;item.setAttribute('aria-pressed',String(chosen));
   const bar=element('span','poll-option-bar');bar.style.width=percent+'%';bar.setAttribute('aria-hidden','true');
   item.append(bar,element('span','poll-option-label',(chosen?'✓ ':'')+option.text),element('span','poll-option-count',percent+'% · '+option.count));list.appendChild(item);
  }
  root.append(list,element('p','poll-total',(closed?'Голосование завершено · ':'')+'Проголосовали: '+total));
  if(meta.multiple)root.appendChild(element('p','poll-note','Процент от числа проголосовавших. Можно выбрать несколько вариантов.'));
  const actions=element('div','poll-actions');
  if(pending){const retry=button('Повторить голосование',()=>vote(pending.choices));retry.disabled=busy;actions.appendChild(retry);root.appendChild(element('p','poll-note','Голос ещё не подтверждён. Повтор не добавит лишний голос.'));}
  else if(!closed&&data){
   if(meta.multiple){const send=button(mine.length?'Сохранить выбор':'Голосовать',()=>vote(selection),'quiet-button poll-submit');send.disabled=busy||!selection.length||same(selection,mine);actions.appendChild(send);}
   if(mine.length){const undo=button('Отменить голос',()=>vote([]));undo.disabled=busy;actions.appendChild(undo);}
  }
  if(!meta.anonymous&&total){const people=button(voters?'Скрыть участников':'Кто голосовал',showVoters);people.disabled=busy;actions.appendChild(people);}
  const canClose=data?.can_close??(message.user_id===user||(!message.peer_a&&state.user?.owner));
  if(canClose&&!closed){const finish=button('Завершить опрос',()=>{confirming=true;render();});finish.disabled=busy||!!pending;actions.appendChild(finish);}
  root.appendChild(actions);
  if(confirming&&!closed){const confirmation=element('div','poll-confirm');confirmation.appendChild(element('p','','Завершить голосование? Изменять голоса после этого нельзя.'));const yes=button('Да, завершить',close),no=button('Не завершать',()=>{confirming=false;render();});yes.disabled=no.disabled=busy;confirmation.append(yes,no);root.appendChild(confirmation);}
  if(voters){const names=element('ul','poll-voters');for(const person of voters){const labels=choices.filter(option=>person.choices.includes(option.id)).map(option=>option.text);names.appendChild(element('li','',person.name+' — '+labels.join(', ')));}root.appendChild(names);}
  if(busy){const status=element('p','poll-note','Обновляем…');status.setAttribute('role','status');root.appendChild(status);}
  if(errorText){const error=element('p','form-error',errorText);error.setAttribute('role','alert');root.appendChild(error);}
  if(!data&&!busy){const retry=button('Обновить опрос',refresh);root.appendChild(retry);}
 }
 render();
 // Не загружаем личные бюллетени всей истории: только карточек, появившихся на экране.
 if(typeof IntersectionObserver==='function'){const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){observer.disconnect();refresh();}});observer.observe(root);setTimeout(()=>{if(!root.isConnected)observer.disconnect();},30000);}
 else queueMicrotask(refresh);
 return root;
}
