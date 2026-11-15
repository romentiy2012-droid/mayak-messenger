(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const api = (path,options) => window.MayakCloud.api(path,options);
  let generation = 0;
  const state = {user:null, csrf:'', messages:[], people:[], rev:0, older:false, online:false,
    reply:null, editing:null, readUpTo:0, again:false,
    polling:false, pollCount:0, sending:false, inviteURL:'', install:null, draft:null,
    streamController:null, lastChunk:0, retryDelay:1000};
  let invitation = new URLSearchParams(location.hash.slice(1)).get('invite') || '';
  let timer = null, toastTimer = null, previousFocus = null;
  let readTimer = null, typingSent = 0, audio = null, sheetOpened = 0, press = null, scrollQueued = false;
  const typing = new Map();
  const QUICK = ['👍','❤️','😂','😮','😢','🙏'];
  const prefs = {get(name,fallback){try{const value=localStorage.getItem('mayak.'+name);return value===null?fallback:value;}catch(_error){return fallback;}},set(name,value){try{localStorage.setItem('mayak.'+name,value);}catch(_error){}}};
  const post = (route,body) => api(route,{method:'POST',body:JSON.stringify(body)});
  const problem = error => error && error.status ? error.message : 'Нет связи. Попробуйте ещё раз.';
  const pushKey = (window.MAYAK_CONFIG || {}).vapidPublicKey || '';
  const pushFlags = {get(name){try{return localStorage.getItem('mayak.push.'+name)==='1';}catch(_error){return false;}},set(name,value){try{if(value)localStorage.setItem('mayak.push.'+name,'1');else localStorage.removeItem('mayak.push.'+name);}catch(_error){}}};

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if(className) node.className = className;
    if(text !== undefined) node.textContent = text;
    return node;
  }
  function initials(name) {
    return name.split(/\s+/).filter(Boolean).slice(0,2).map(word => Array.from(word)[0]).join('').toUpperCase();
  }
  function palette(id) {
    let value = 0; for(let i=0;i<id.length;i++) value = (value + id.charCodeAt(i)) % 6;
    return 'palette-' + value;
  }
  function avatar(user) { return element('span', 'avatar ' + palette(user.id), initials(user.name)); }
  function toast(text) {
    $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {$('toast').hidden = true;}, 3500);
  }
  function pushSupported() {return !!pushKey && window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;}
  function base64Url(buffer) {let raw='';new Uint8Array(buffer).forEach(byte=>{raw+=String.fromCharCode(byte);});return btoa(raw).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
  function pushBanner() {$('push-banner').hidden = !(state.user && pushSupported() && Notification.permission==='default' && !pushFlags.get('off') && !pushFlags.get('later'));}
  async function pushActive() {
    if(!pushSupported() || Notification.permission!=='granted' || pushFlags.get('off')) return false;
    const registration=await navigator.serviceWorker.ready;
    return !!(await registration.pushManager.getSubscription());
  }
  /* Подписывает устройство и сохраняет подписку в облаке. ask=true — только по нажатию пользователя. */
  async function pushSync(ask) {
    if(!pushSupported() || !state.user) return false;
    if(Notification.permission==='default') {if(!ask) return false; await Notification.requestPermission();}
    if(Notification.permission!=='granted') return false;
    const registration=await navigator.serviceWorker.ready;
    let subscription=await registration.pushManager.getSubscription();
    const current=subscription && subscription.options && subscription.options.applicationServerKey;
    if(current && base64Url(current)!==pushKey) {await subscription.unsubscribe();subscription=null;}
    if(!subscription) subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:Uint8Array.from(atob(pushKey.replace(/-/g,'+').replace(/_/g,'/')),char=>char.charCodeAt(0))});
    const data=subscription.toJSON();
    await api('push-subscribe',{method:'POST',body:JSON.stringify({endpoint:data.endpoint,p256dh:data.keys.p256dh,auth:data.keys.auth})});
    return true;
  }
  async function pushEnable() {
    pushFlags.set('off',false);
    try {
      const done=await pushSync(true);
      toast(done?'Уведомления включены':'Уведомления запрещены в настройках браузера или телефона.');
    } catch(error) {toast('Не удалось включить уведомления: '+(error.message||'ошибка'));}
    pushBanner();
  }
  async function pushDisable(forget) {
    if(!forget) pushFlags.set('off',true);
    if(!pushSupported()) return;
    const registration=await navigator.serviceWorker.getRegistration();
    const subscription=registration && await registration.pushManager.getSubscription();
    if(!subscription) return;
    try {await api('push-unsubscribe',{method:'POST',body:JSON.stringify({endpoint:subscription.endpoint})});} catch(_error) {}
    await subscription.unsubscribe().catch(()=>{});
  }
  function clearNotifications() {
    if(!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.getRegistration().then(registration=>registration && registration.getNotifications ? registration.getNotifications() : []).then(list=>list.forEach(item=>item.close())).catch(()=>{});
  }
  function connection(online) {
    state.online = online;
    const active = state.people.filter(person => person.online).length;
    const writers = state.people.filter(person => typing.has(person.id)).map(person => person.name);
    const idle = online ? (state.user ? active + ' в сети · облачный чат' : 'Облако на связи') : 'Нет соединения';
    [$('welcome-network'), $('connection-status')].forEach(node => {
      const busy = online && writers.length && node.id==='connection-status';
      node.classList.toggle('disconnected', !online); node.classList.toggle('typing', !!busy); node.replaceChildren(element('i'));
      node.appendChild(document.createTextNode(busy ? writers.join(', ') + (writers.length>1 ? ' печатают…' : ' печатает…') : idle));
    });
    $('offline-banner').hidden = online || !state.user;
  }
  function setTyping(id,on) {
    clearTimeout(typing.get(id));
    if(on) typing.set(id,setTimeout(()=>setTyping(id,false),6000));
    else if(!typing.delete(id)) return;
    connection(state.online);
  }
  function clearInviteFromAddress() {
    if(location.hash) history.replaceState(null, '', location.pathname + location.search);
    invitation = '';
  }
  function showChat(session) {

    state.user = session.user; state.csrf = session.csrf; state.readUpTo = Number(session.user.last_read)||0;
    $('welcome').hidden = true; $('chat').hidden = false;
    document.querySelectorAll('.room-name').forEach(node => {node.textContent = session.room || 'Наш круг';});
    $('my-name').textContent = state.user.name;
    [$('my-avatar'),$('mobile-avatar')].forEach(node => {node.textContent=initials(state.user.name);node.className='avatar '+palette(state.user.id);});
    $('invite-button').hidden = !state.user.owner;
    clearInviteFromAddress();
    adjustViewport();
    pushBanner();clearNotifications();
    if(!pushFlags.get('off')) pushSync(false).catch(()=>{});
  }
  function showJoin() {
    generation++; window.MayakCloud.stop();
    clearTimeout(timer);
    state.messages=[];state.people=[];state.rev=0;state.older=false;state.inviteURL='';state.csrf='';
    state.reply=null;state.editing=null;state.readUpTo=0;typingSent=0;typing.forEach(item=>clearTimeout(item));typing.clear();
    $('composer-context').hidden=true;$('jump-button').hidden=true;closeSheet();
    try{if(navigator.clearAppBadge)navigator.clearAppBadge().catch(()=>{});}catch(_error){}
    $('messages').replaceChildren();$('people-list').replaceChildren();
    state.user = null; $('chat').hidden = true; $('welcome').hidden = false; $('push-banner').hidden = true;
    if(invitation) {
      $('join-mode').value = 'register';
      $('join-password').autocomplete = 'new-password';
      $('join-button').textContent = 'Создать аккаунт и войти';
    }
    $('invite-field').hidden = !!invitation || $('join-mode').value !== 'register';
    adjustViewport();
  }
  function showDate(value) {
    const date = new Date(value), now = new Date();
    if(date.toDateString() === now.toDateString()) return 'Сегодня';
    const yesterday = new Date(); yesterday.setDate(now.getDate()-1);
    if(date.toDateString() === yesterday.toDateString()) return 'Вчера';
    return date.toLocaleDateString('ru-RU', {day:'numeric',month:'long',year:date.getFullYear()===now.getFullYear()?undefined:'numeric'});
  }
  function textWithLinks(node, text) {
    const pattern = /https?:\/\/[^\s<>]+/g;
    let match, last = 0;
    while((match = pattern.exec(text))) {
      node.appendChild(document.createTextNode(text.slice(last,match.index)));
      const anchor = element('a','',match[0]); anchor.href=match[0]; anchor.target='_blank'; anchor.rel='noreferrer noopener';
      node.appendChild(anchor); last=match.index+match[0].length;
    }
    node.appendChild(document.createTextNode(text.slice(last)));
  }
  function messageById(id) {return state.messages.find(message=>message.id===id);}
  function snippet(text) {const line=text.replace(/\s+/g,' ').trim();return line.length>90?line.slice(0,90)+'…':line;}
  function readByOthers(id) {return state.people.some(person=>person.id!==state.user.id && Number(person.last_read)>=id);}
  function renderMessages(mode) {
    const scroll = $('messages-scroll');
    const previousHeight=scroll.scrollHeight, previousTop=scroll.scrollTop;
    const atBottom=previousHeight-previousTop-scroll.clientHeight < 130;
    const fragment=document.createDocumentFragment(); let day='';
    const byId=new Map(state.messages.map(message=>[message.id,message]));
    state.messages.forEach(message => {
      const messageDay = new Date(message.created).toDateString();
      if(messageDay !== day) {const divider=element('div','day-divider');divider.appendChild(element('span','',showDate(message.created)));fragment.appendChild(divider);day=messageDay;}
      const own=message.user_id === state.user.id, gone=!!message.deleted;
      const row=element('article','message-row'+(own?' own':'')+(gone?' deleted':'')); row.dataset.id=message.id;
      row.appendChild(avatar({id:message.user_id,name:message.name}));
      const bubble=element('div','message-bubble');
      bubble.appendChild(element('div','message-author',message.name));
      if(!gone && message.reply_to) {
        const source=byId.get(message.reply_to);
        const quote=element('button','message-quote');quote.type='button';quote.dataset.jump=message.reply_to;
        quote.appendChild(element('strong','',source?source.name:'Сообщение'));
        quote.appendChild(element('span','',source?(source.deleted?'Сообщение удалено':snippet(source.text)):'Более раннее сообщение'));
        bubble.appendChild(quote);
      }
      const text=element('div','message-text');
      if(gone) text.textContent='Сообщение удалено'; else textWithLinks(text,message.text);
      bubble.appendChild(text);
      const groups=new Map();
      if(!gone) Object.entries(message.reactions||{}).forEach(([user,emoji])=>{const group=groups.get(emoji)||{count:0,mine:false};group.count++;if(user===state.user.id)group.mine=true;groups.set(emoji,group);});
      if(groups.size) {
        const bar=element('div','message-reactions');
        groups.forEach((group,emoji)=>{const chip=element('button','reaction'+(group.mine?' mine':''),emoji+(group.count>1?' '+group.count:''));chip.type='button';chip.dataset.react=emoji;chip.setAttribute('aria-label','Реакция '+emoji+(group.mine?', ваша':''));bar.appendChild(chip);});
        bubble.appendChild(bar);
      }
      const stamp=element('div','message-meta');
      if(message.edited && !gone) stamp.appendChild(element('span','edited-mark','изменено'));
      const time=element('time','',new Date(message.created).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}));
      time.dateTime=message.created; stamp.appendChild(time);
      if(own && !gone) {const read=readByOthers(message.id);const tick=element('span','delivery-tick'+(read?' read':''),read?'✓✓':'✓');tick.title=read?'Прочитано':'Отправлено';stamp.appendChild(tick);}
      bubble.appendChild(stamp);row.appendChild(bubble);
      if(!gone) {const more=element('button','message-more','⋯');more.type='button';more.setAttribute('aria-label','Действия с сообщением');row.appendChild(more);}
      fragment.appendChild(row);
    });
    $('messages').replaceChildren(fragment);
    $('empty-chat').hidden=state.messages.length>0;
    $('older-button').hidden=!state.older;
    if(mode==='older') scroll.scrollTop=previousTop+scroll.scrollHeight-previousHeight;
    else if(atBottom || mode==='initial' || mode==='sent') scrollBottom();
  }
  // Режимы: initial и new — ответ сервера на опрос (двигают отметку rev); sent и changed — результат своего действия; older — история.
  function mergeMessages(messages, mode) {
    if(!messages.length && mode!=='initial') return;
    const known=new Map(state.messages.map(message=>[message.id,message]));
    const oldest=state.messages.length?state.messages[0].id:0;
    let fresh=false;
    messages.forEach(message=>{
      const current=known.get(message.id);
      if(current) {if((message.rev||0)>=(current.rev||0)) known.set(message.id,message);return;}
      if(mode==='new' && state.older && oldest && message.id<oldest) return; // изменилось сообщение из ещё не загруженной истории
      known.set(message.id,message);
      if(mode==='new' && message.user_id!==state.user.id) {setTyping(message.user_id,false);if(!message.deleted) fresh=true;}
    });
    state.messages=Array.from(known.values()).sort((a,b)=>a.id-b.id);
    if(mode!=='older' && state.messages.length>500) {state.messages=state.messages.slice(-500);state.older=true;}
    if(mode==='initial' || mode==='new') messages.forEach(message=>{state.rev=Math.max(state.rev,message.rev||0);});
    renderMessages(mode);
    if(state.reply || state.editing) renderContext();
    if(fresh) {if(document.hidden) document.title='Новое сообщение · Маяк'; else ping();}
    markRead();
  }
  function nearBottom() {const node=$('messages-scroll');return node.scrollHeight-node.scrollTop-node.clientHeight<130;}
  function updateUnread() {
    const count=state.user?state.messages.filter(message=>message.id>state.readUpTo && message.user_id!==state.user.id && !message.deleted).length:0;
    $('jump-button').hidden=!state.user || nearBottom();
    $('jump-count').hidden=!count;$('jump-count').textContent=count>99?'99+':String(count);
    try {
      if(count && navigator.setAppBadge) navigator.setAppBadge(count).catch(()=>{});
      else if(!count && navigator.clearAppBadge) navigator.clearAppBadge().catch(()=>{});
    } catch(_error) {}
  }
  // Прочитанным считается всё, что на экране: чат открыт и лента прокручена вниз.
  function markRead() {
    if(state.user && !document.hidden && state.messages.length && nearBottom()) {
      const last=state.messages[state.messages.length-1].id;
      if(last>state.readUpTo) {
        state.readUpTo=last;clearTimeout(readTimer);
        readTimer=setTimeout(()=>{if(state.user) post('read',{id:state.readUpTo}).catch(()=>{});},400);
      }
    }
    updateUnread();
  }
  function memberChanged(row) {
    const index=state.people.findIndex(person=>person.id===row.id), known=state.people[index];
    if(row.id!==state.user.id) {
      if(!row.typing) setTyping(row.id,false);
      else if(known && Date.parse(row.typing)!==Date.parse(known.typing||0)) setTyping(row.id,true);
    }
    if(index<0) state.people.push(row); else state.people[index]=row;
    renderPeople();
    if(row.id!==state.user.id && (!known || Number(known.last_read)!==Number(row.last_read))) renderMessages('changed');
  }
  function unlockAudio() {
    const Context=window.AudioContext||window.webkitAudioContext;
    if(!Context) return;
    try {if(!audio) audio=new Context();if(audio.state==='suspended') audio.resume().catch(()=>{});} catch(_error) {}
  }
  function ping() {
    if(prefs.get('sound','1')!=='1') return;
    try {
      if(navigator.vibrate) navigator.vibrate(40);
      if(!audio || audio.state!=='running') return;
      const start=audio.currentTime, tone=audio.createOscillator(), gain=audio.createGain();
      tone.type='sine';tone.frequency.setValueAtTime(880,start);tone.frequency.exponentialRampToValueAtTime(1320,start+.09);
      gain.gain.setValueAtTime(.0001,start);gain.gain.exponentialRampToValueAtTime(.12,start+.02);gain.gain.exponentialRampToValueAtTime(.0001,start+.28);
      tone.connect(gain);gain.connect(audio.destination);tone.start(start);tone.stop(start+.3);
    } catch(_error) {}
  }
  function renderPeople() {
    $('people-count').textContent=state.people.length;
    const fragment=document.createDocumentFragment();
    state.people.forEach(person=>{
      const row=element('div','person'+(person.online?' online':''));row.appendChild(avatar(person));
      const name=element('span','person-name',person.name);if(person.id===state.user.id) name.appendChild(element('small','','вы'));
      row.appendChild(name);fragment.appendChild(row);
    });
    $('people-list').replaceChildren(fragment);connection(state.online);
  }
  function scrollBottom() {const node=$('messages-scroll');node.scrollTop=node.scrollHeight;}
  async function poll(initial=false) {
    if(!state.user) return;
    if(state.polling) {state.again=true;return;}
    state.polling=true;state.again=false;
    const current=generation;
    let more=false;
    try {
      const result=await api('events?rev='+state.rev);
      if(current!==generation || !state.user)return;
      const first=!state.rev;
      if(first)state.older=result.has_older;
      const before=state.people;
      state.people=result.people;
      mergeMessages(result.messages,initial||first?'initial':'new');
      if(!result.messages.length && before.some(person=>{const now=state.people.find(item=>item.id===person.id);return now && Number(now.last_read)!==Number(person.last_read);})) renderMessages('changed');
      renderPeople();connection(true);
      more=result.has_more;state.retryDelay=1000;
      window.MayakCloud.watch((kind,row)=>{
        if(!state.user) return;
        if(kind==='member') memberChanged(row);
        else if(kind!=='message' || (row.rev||0)>state.rev) poll();
      });
    } catch(error) {
      if(current!==generation)return;
      connection(false);
      if(error.status===401 || error.status===403){showJoin();$('join-error').textContent=error.message;}
    } finally {
      state.polling=false;clearTimeout(timer);
      if(state.user)timer=setTimeout(()=>poll(),more||state.again?100:15000);
    }
  }
  function dialog(title) {
    previousFocus=document.activeElement;
    const content=$('dialog-content');content.replaceChildren(element('h2','',title));content.firstChild.id='dialog-title';
    $('dialog-layer').hidden=false;$('dialog-close').focus();return content;
  }
  function closeDialog() {$('dialog-layer').hidden=true;if(previousFocus && previousFocus.focus) previousFocus.focus();}
  function button(label, action, className='quiet-button') {const node=element('button',className,label);node.type='button';node.addEventListener('click',action);return node;}
  function copyText(text) {
    if(navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    const area=element('textarea','copy-fallback');area.value=text;document.body.appendChild(area);area.select();
    const success=document.execCommand('copy');area.remove();return success?Promise.resolve():Promise.reject(new Error('Выделите ссылку и скопируйте вручную.'));
  }
  async function inviteDialog() {
    const content=dialog('Позовите своих');
    content.appendChild(element('p','','Одноразовое приглашение на 7 дней: даёт доступ ко всей истории. Новое приглашение отменяет предыдущее неиспользованное. Отправляйте только своим.'));
    try {
      state.inviteURL=(await api('invite')).url;
      content.appendChild(element('div','link-field',state.inviteURL));
      content.appendChild(button('Скопировать приглашение',()=>copyText(state.inviteURL).then(()=>toast('Приглашение скопировано')).catch(error=>toast(error.message)),'primary-button'));
      if(navigator.share) content.appendChild(button('Отправить ссылку…',()=>navigator.share({title:'Маяк — наш круг',text:'Заходи в наш чат',url:state.inviteURL}).catch(()=>{})));
    } catch(error) {content.appendChild(element('p','form-error',error.message));}
  }
  function profileDialog() {
    const content=dialog('Ваш круг');
    const active=state.people.filter(person=>person.online).length;
    content.appendChild(element('p','',state.people.length+' участников · '+active+' сейчас в сети'));
    const list=element('div','people-list');
    state.people.forEach(person=>{const row=element('div','person'+(person.online?' online':''));row.appendChild(avatar(person));row.appendChild(element('span','person-name',person.name+(person.id===state.user.id?' · вы':'')));list.appendChild(row);});
    content.appendChild(list);
    const form=element('form','profile-in-dialog');
    const label=element('label','','Ваше имя');label.htmlFor='profile-name';form.appendChild(label);
    const input=element('input');input.id='profile-name';input.value=state.user.name;input.maxLength=32;input.required=true;form.appendChild(input);
    const errorNode=element('p','form-error');form.appendChild(errorNode);
    const submit=element('button','primary-button','Сохранить имя');submit.type='submit';form.appendChild(submit);
    form.addEventListener('submit',async event=>{
      event.preventDefault();submit.disabled=true;
      try {const result=await api('profile',{method:'POST',body:JSON.stringify({name:input.value})});state.user=result.user;$('my-name').textContent=state.user.name;[$('my-avatar'),$('mobile-avatar')].forEach(node=>node.textContent=initials(state.user.name));closeDialog();toast('Имя сохранено');state.pollCount=0;poll();}
      catch(error){errorNode.textContent=error.message;}finally{submit.disabled=false;}
    });
    content.appendChild(form);
  }
  async function installApp() {
    if(state.install) {const prompt=state.install;state.install=null;await prompt.prompt();const result=await prompt.userChoice;if(result.outcome==='accepted') $('install-button').hidden=true;return;}
    const content=dialog('Маяк на главном экране');
    content.appendChild(element('p','','Открывайте чат отдельным приложением, без адресной строки браузера.'));
    const list=element('ol');
    list.appendChild(element('li','','Android: откройте меню браузера ⋮ и выберите «Установить приложение» или «Добавить на главный экран».'));
    list.appendChild(element('li','','iPhone: откройте ссылку в Safari, нажмите «Поделиться» → «На экран Домой».'));
    content.appendChild(list);
    content.appendChild(element('p','about-note','Для переписки нужен интернет. На iPhone уведомления работают только у приложения, добавленного на экран Домой.'));
  }
  function aboutDialog() {
    const content=dialog('Небольшой чат для своих');
    content.appendChild(element('p','','«Маяк» работает в облаке. Здесь одна общая переписка, а первый вход — по приглашению.'));
    content.appendChild(button('Установить приложение',installApp));
    content.appendChild(button('Участники и ваше имя',profileDialog));
    if(state.user.owner) content.appendChild(button('Пригласить друзей',inviteDialog));
    if(pushSupported()) {
      const toggle=button('Уведомления…',async()=>{
        toggle.disabled=true;
        try {if(await pushActive()){await pushDisable(false);toast('Уведомления отключены на этом устройстве');}else await pushEnable();}
        catch(error){toast(error.message||'Не удалось изменить уведомления');}
        closeDialog();
      });
      content.appendChild(toggle);
      pushActive().then(active=>{toggle.textContent=active?'Отключить уведомления':'Включить уведомления';}).catch(()=>{});
    } else content.appendChild(element('p','about-note',/iP(hone|ad|od)/.test(navigator.userAgent)?'Уведомления на iPhone: откройте чат в Safari, «Поделиться» → «На экран Домой», затем включите их в установленном приложении (нужна iOS 16.4 или новее).':'Этот браузер не поддерживает уведомления.'));
    if(window.MayakTheme) {
      const names={auto:'как в телефоне',light:'светлая',dark:'тёмная'}, order=['auto','light','dark'];
      const theme=button('',()=>{window.MayakTheme.set(order[(order.indexOf(window.MayakTheme.get())+1)%order.length]);theme.textContent='Тема: '+names[window.MayakTheme.get()];});
      theme.textContent='Тема: '+(names[window.MayakTheme.get()]||names.auto);content.appendChild(theme);
    }
    const sound=button('',()=>{const on=prefs.get('sound','1')!=='1';prefs.set('sound',on?'1':'0');sound.textContent='Звук сообщений: '+(on?'включён':'выключен');if(on){unlockAudio();ping();}});
    sound.textContent='Звук сообщений: '+(prefs.get('sound','1')==='1'?'включён':'выключен');content.appendChild(sound);
    content.appendChild(element('p','about-note','Действия с сообщением — ответ, реакция, изменение, удаление — открываются долгим нажатием на него. Чтобы ответить быстро, смахните сообщение влево.'));
    content.appendChild(element('p','about-note','История хранится в Supabase. Соединение защищено HTTPS; сквозного шифрования нет. О новых сообщениях приходят push-уведомления, если они включены на устройстве.'));
    content.appendChild(element('p','about-note','Маяк 2.2.0 · облачная версия.'));
    content.appendChild(button('Выйти на этом устройстве',async()=>{
      try {await pushDisable(true).catch(()=>{});await api('logout',{method:'POST',body:'{}'});closeDialog();$('message-input').value='';state.draft=null;showJoin();resizeComposer();}
      catch(error){toast(error.message);}
    }));
  }
  function renderContext() {
    const id=state.editing||state.reply, message=id?messageById(id):null;
    if(!message || message.deleted) {
      if(state.editing) $('message-input').value='';
      state.editing=null;state.reply=null;$('composer-context').hidden=true;return;
    }
    $('context-title').textContent=state.editing?'Изменение сообщения':'Ответ · '+message.name;
    $('context-text').textContent=snippet(message.text);
    $('composer-context').hidden=false;
  }
  function startReply(id) {
    if(state.editing) $('message-input').value='';
    state.editing=null;state.reply=id;renderContext();$('message-input').focus();resizeComposer();
  }
  function startEdit(id) {
    const message=messageById(id);if(!message) return;
    state.reply=null;state.editing=id;$('message-input').value=message.text;renderContext();$('message-input').focus();resizeComposer();
  }
  function cancelContext() {
    if(state.editing) $('message-input').value='';
    state.editing=null;state.reply=null;renderContext();resizeComposer();
  }
  async function react(id,emoji) {
    const message=messageById(id);if(!message || message.deleted) return;
    const mine=(message.reactions||{})[state.user.id];
    try {mergeMessages([(await post('react',{id,emoji:mine===emoji?null:emoji})).message],'changed');}
    catch(error) {toast(problem(error));}
  }
  async function removeMessage(id) {
    try {mergeMessages([(await post('delete',{id})).message],'changed');}
    catch(error) {toast(problem(error));}
  }
  function jumpTo(id) {
    const row=$('messages').querySelector('[data-id="'+id+'"]');
    if(!row) {toast('Это сообщение выше. Нажмите «Показать предыдущие сообщения».');return;}
    row.scrollIntoView({block:'center',behavior:'smooth'});
    row.classList.add('flash');setTimeout(()=>row.classList.remove('flash'),1400);
  }
  function closeSheet() {$('sheet-layer').hidden=true;$('sheet').replaceChildren();}
  function openSheet(id) {
    const message=messageById(id);
    if(!state.user || !message || message.deleted) return;
    const sheet=$('sheet'), mine=(message.reactions||{})[state.user.id];
    sheet.replaceChildren();
    const reactions=element('div','sheet-reactions');
    QUICK.forEach(emoji=>{const item=button(emoji,()=>{closeSheet();react(id,emoji);},'sheet-emoji'+(mine===emoji?' mine':''));item.setAttribute('aria-label','Реакция '+emoji);reactions.appendChild(item);});
    sheet.appendChild(reactions);
    sheet.appendChild(element('p','sheet-preview',message.name+': '+snippet(message.text)));
    sheet.appendChild(button('Ответить',()=>{closeSheet();startReply(id);},'sheet-action'));
    sheet.appendChild(button('Скопировать текст',()=>{closeSheet();copyText(message.text).then(()=>toast('Скопировано')).catch(error=>toast(error.message));},'sheet-action'));
    if(message.user_id===state.user.id) {
      sheet.appendChild(button('Изменить',()=>{closeSheet();startEdit(id);},'sheet-action'));
      sheet.appendChild(button('Удалить',()=>{
        sheet.replaceChildren(element('p','sheet-question','Удалить сообщение у всех?'));
        sheet.appendChild(button('Удалить',()=>{closeSheet();removeMessage(id);},'sheet-action danger'));
        sheet.appendChild(button('Отмена',closeSheet,'sheet-action quiet'));
      },'sheet-action danger'));
    }
    sheet.appendChild(button('Отмена',closeSheet,'sheet-action quiet'));
    sheetOpened=Date.now();$('sheet-layer').hidden=false;
  }
  function typingSignal() {
    if(!state.user) return;
    if($('message-input').value.trim() && !state.editing) {
      if(Date.now()-typingSent>3000) {typingSent=Date.now();post('typing',{on:true}).catch(()=>{});}
    } else if(typingSent) {typingSent=0;post('typing',{on:false}).catch(()=>{});}
  }
  function resizeComposer() {const input=$('message-input');input.style.height='auto';input.style.height=Math.min(input.scrollHeight,130)+'px';$('send-button').disabled=state.sending||!input.value.trim();}
  // iOS при открытии клавиатуры не сжимает страницу, а сдвигает видимую область:
  // сдвиг сбрасывается, а чат подгоняется под видимую область по высоте и положению,
  // иначе над клавиатурой остаётся пустота.
  function adjustViewport() {
    const root=document.documentElement, view=window.visualViewport, chat=!$('chat').hidden;
    root.classList.toggle('chat-open',chat && window.innerWidth<=760);
    if(!view || !chat || window.innerWidth>760){root.style.removeProperty('--app-height');root.style.removeProperty('--app-top');return;}
    if(window.scrollX||window.scrollY||view.offsetTop) window.scrollTo(0,0);
    const scroll=$('messages-scroll'), atBottom=scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<80;
    root.style.setProperty('--app-height',view.height+'px');
    root.style.setProperty('--app-top',Math.max(0,view.offsetTop)+'px');
    if(atBottom) scrollBottom();
  }
  // Клавиатура выезжает около полусекунды, а события iOS приходят не всегда — подстраиваемся каждый кадр.
  let viewportFollowUntil=0;
  function followViewport(duration) {
    const running=viewportFollowUntil>Date.now();
    viewportFollowUntil=Date.now()+duration;
    if(running) return;
    (function step(){adjustViewport();if(Date.now()<viewportFollowUntil) requestAnimationFrame(step);})();
  }
  $('join-form').addEventListener('submit',async event=>{
    event.preventDefault();$('join-error').textContent='';$('join-button').disabled=true;
    let invite=invitation||$('join-invite').value.trim();
    if(invite.includes('#')) {try {invite=new URLSearchParams(new URL(invite).hash.slice(1)).get('invite')||invite;}catch(_error){}}
    try {const result=await api('join',{method:'POST',body:JSON.stringify({name:$('join-name').value,register:$('join-mode').value==='register',password:$('join-password').value,invite})});$('join-password').value='';showChat(result);await poll(true);}
    catch(error){$('join-error').textContent=error.status?error.message:'Облако недоступно. Проверьте интернет и попробуйте ещё раз.';}
    finally{$('join-button').disabled=false;}
  });
  $('message-form').addEventListener('submit',async event=>{
    event.preventDefault();const input=$('message-input'),text=input.value.trim();
    if(!text||state.sending) return;
    state.sending=true;$('send-button').disabled=true;$('send-error').hidden=true;
    try {
      if(state.editing) {
        const original=messageById(state.editing);
        if(original && original.text!==text) mergeMessages([(await post('edit',{id:state.editing,text})).message],'changed');
        state.editing=null;input.value='';renderContext();
      } else {
        const reply=state.reply||null;
        if(!state.draft || state.draft.text!==text || state.draft.reply!==reply) {const random=new Uint32Array(4);crypto.getRandomValues(random);state.draft={text,reply,nonce:Array.from(random).map(value=>value.toString(16)).join('-')};}
        const result=await post('messages',state.draft);
        input.value='';state.draft=null;state.reply=null;typingSent=0;renderContext();mergeMessages([result.message],'sent');
      }
      connection(true);
    }
    catch(error){$('send-error').textContent=error.status?error.message:'Не отправлено. Текст сохранён — нажмите отправить ещё раз, когда связь вернётся.';$('send-error').hidden=false;connection(false);}
    finally{state.sending=false;resizeComposer();}
  });
  $('message-input').addEventListener('input',()=>{resizeComposer();typingSignal();});
  $('context-cancel').addEventListener('click',cancelContext);
  $('jump-button').addEventListener('click',()=>{scrollBottom();markRead();});
  $('messages-scroll').addEventListener('scroll',()=>{if(scrollQueued) return;scrollQueued=true;requestAnimationFrame(()=>{scrollQueued=false;markRead();});},{passive:true});
  $('sheet-layer').addEventListener('click',event=>{if(event.target===$('sheet-layer') && Date.now()-sheetOpened>450) closeSheet();});
  document.addEventListener('pointerdown',unlockAudio,{passive:true});
  // Сообщения: нажатие на цитату, реакцию и «⋯»; правая кнопка мыши; долгое нажатие и смахивание влево на телефоне.
  const rowId = node => Number(node.closest('.message-row').dataset.id);
  $('messages').addEventListener('click',event=>{
    const quote=event.target.closest('[data-jump]');if(quote) {jumpTo(Number(quote.dataset.jump));return;}
    const chip=event.target.closest('[data-react]');if(chip) {react(rowId(chip),chip.dataset.react);return;}
    const more=event.target.closest('.message-more');if(more) openSheet(rowId(more));
  });
  $('messages').addEventListener('contextmenu',event=>{
    const bubble=event.target.closest('.message-bubble');
    if(!bubble || event.target.closest('a')) return;
    event.preventDefault();openSheet(rowId(bubble));
  });
  $('messages').addEventListener('touchstart',event=>{
    const bubble=event.target.closest('.message-bubble');
    press=null;
    if(!bubble || event.touches.length!==1 || event.target.closest('button,a')) return;
    const row=bubble.closest('.message-row');
    if(row.classList.contains('deleted')) return;
    const touch=event.touches[0], current={id:Number(row.dataset.id),bubble,x:touch.clientX,y:touch.clientY,dx:0,fired:false,swipe:false,timer:0};
    current.timer=setTimeout(()=>{if(press===current && !current.swipe) {current.fired=true;if(navigator.vibrate) navigator.vibrate(15);openSheet(current.id);}},450);
    press=current;
  },{passive:true});
  $('messages').addEventListener('touchmove',event=>{
    if(!press || press.fired) return;
    const touch=event.touches[0], dx=touch.clientX-press.x, dy=touch.clientY-press.y;
    if(!press.swipe) {
      if(Math.abs(dy)>10 && Math.abs(dy)>=Math.abs(dx)) {clearTimeout(press.timer);press=null;return;}
      if(Math.abs(dx)<=10) return;
      clearTimeout(press.timer);press.swipe=true;
    }
    press.dx=Math.max(-90,Math.min(0,dx));
    press.bubble.style.transform='translateX('+press.dx+'px)';
  },{passive:true});
  const endPress = event => {
    if(!press) return;
    const current=press;press=null;clearTimeout(current.timer);
    if(current.swipe) {
      current.bubble.style.transition='transform .18s';current.bubble.style.transform='';
      setTimeout(()=>{current.bubble.style.transition='';},200);
      if(event.type==='touchend' && current.dx<=-56) startReply(current.id);
    }
    if(current.fired && event.cancelable) event.preventDefault(); // палец ещё на экране: не нажимать то, что под ним
  };
  $('messages').addEventListener('touchend',endPress);
  $('messages').addEventListener('touchcancel',endPress);
  $('message-input').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&window.innerWidth>760&&!event.isComposing){event.preventDefault();$('message-form').requestSubmit ? $('message-form').requestSubmit() : $('send-button').click();}});
  $('older-button').addEventListener('click',async()=>{
    if(!state.messages.length)return;$('older-button').disabled=true;
    try {const result=await api('messages?before='+state.messages[0].id);state.older=result.has_older;mergeMessages(result.messages,'older');}
    catch(error){toast(error.message);}finally{$('older-button').disabled=false;}
  });
  $('invite-button').addEventListener('click',inviteDialog);
  $('profile-button').addEventListener('click',profileDialog);
  $('mobile-profile').addEventListener('click',profileDialog);
  $('more-button').addEventListener('click',aboutDialog);
  $('install-button').addEventListener('click',installApp);
  $('push-enable').addEventListener('click',pushEnable);
  $('push-dismiss').addEventListener('click',()=>{pushFlags.set('later',true);pushBanner();});
  $('dialog-close').addEventListener('click',closeDialog);
  $('dialog-layer').addEventListener('click',event=>{if(event.target===$('dialog-layer'))closeDialog();});
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape' && !$('sheet-layer').hidden) {closeSheet();return;}
    if($('dialog-layer').hidden)return;
    if(event.key==='Escape')closeDialog();
    if(event.key==='Tab') {const nodes=$('dialog-layer').querySelectorAll('button:not([disabled]),input,a[href]');const first=nodes[0],last=nodes[nodes.length-1];if(event.shiftKey&&document.activeElement===first){last.focus();event.preventDefault();}else if(!event.shiftKey&&document.activeElement===last){first.focus();event.preventDefault();}}
  });
  window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();state.install=event;$('install-button').hidden=false;});
  window.addEventListener('appinstalled',()=>{$('install-button').hidden=true;toast('Маяк добавлен на главный экран');});
  window.addEventListener('online',()=>{if(state.user){poll();}else boot();});
  window.addEventListener('hashchange',()=>{const next=new URLSearchParams(location.hash.slice(1)).get('invite');if(next){invitation=next;if(!state.user)showJoin();}});
  window.addEventListener('offline',()=>connection(false));
  window.addEventListener('resize',adjustViewport);
  if(window.visualViewport){window.visualViewport.addEventListener('resize',adjustViewport);window.visualViewport.addEventListener('scroll',adjustViewport);}
  $('message-input').addEventListener('focus',()=>followViewport(1500));
  $('message-input').addEventListener('blur',()=>followViewport(800));
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){document.title='Маяк — свои на связи';if(state.user){clearNotifications();markRead();poll();}}});
  async function boot() {
    $('invite-field').hidden=!!invitation || $('join-mode').value !== 'register';
    try {const session=await api('session');showChat(session);await poll(true);}
    catch(error) {showJoin();if(error.status===401){try{await api('health');connection(true);}catch(_error){connection(false);}}else{connection(false);$('join-error').textContent=error.message || 'Не удалось подключиться к облаку.';}}
  }
  if('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'}).catch(()=>{});
  $('join-name').required=true;
  adjustViewport();boot();
  $('join-mode').addEventListener('change',()=>{
    const register=$('join-mode').value==='register';
    $('join-password').autocomplete=register?'new-password':'current-password';
    $('join-button').textContent=register?'Создать аккаунт и войти':'Войти в чат';
    $('invite-field').hidden = !!invitation || !register;
  });
})();