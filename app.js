(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const api = (path,options) => window.MayakCloud.api(path,options);
  let generation = 0;
  const state = {user:null, csrf:'', messages:[], people:[], last:0, older:false, online:false,
    polling:false, pollCount:0, sending:false, inviteURL:'', install:null, draft:null,
    streamController:null, lastChunk:0, retryDelay:1000};
  let invitation = new URLSearchParams(location.hash.slice(1)).get('invite') || '';
  let timer = null, toastTimer = null, previousFocus = null;
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
    [$('welcome-network'), $('connection-status')].forEach(node => {
      node.classList.toggle('disconnected', !online); node.replaceChildren(element('i'));
      node.appendChild(document.createTextNode(online ? (state.user ? active + ' в сети · облачный чат' : 'Облако на связи') : 'Нет соединения'));
    });
    $('offline-banner').hidden = online || !state.user;
  }
  function clearInviteFromAddress() {
    if(location.hash) history.replaceState(null, '', location.pathname + location.search);
    invitation = '';
  }
  function showChat(session) {

    state.user = session.user; state.csrf = session.csrf;
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
    state.messages=[];state.people=[];state.last=0;state.older=false;state.inviteURL='';state.csrf='';
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
  function renderMessages(mode) {
    const scroll = $('messages-scroll');
    const previousHeight=scroll.scrollHeight, previousTop=scroll.scrollTop;
    const atBottom=previousHeight-previousTop-scroll.clientHeight < 130;
    const fragment=document.createDocumentFragment(); let day='';
    state.messages.forEach(message => {
      const messageDay = new Date(message.created).toDateString();
      if(messageDay !== day) {const divider=element('div','day-divider');divider.appendChild(element('span','',showDate(message.created)));fragment.appendChild(divider);day=messageDay;}
      const own=message.user_id === state.user.id;
      const row=element('article','message-row'+(own?' own':'')); row.dataset.id=message.id;
      row.appendChild(avatar({id:message.user_id,name:message.name}));
      const bubble=element('div','message-bubble');
      bubble.appendChild(element('div','message-author',message.name));
      const text=element('div','message-text'); textWithLinks(text,message.text); bubble.appendChild(text);
      const stamp=element('div','message-meta');
      const time=element('time','',new Date(message.created).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}));
      time.dateTime=message.created; stamp.appendChild(time);
      if(own) {const tick=element('span','delivery-tick','✓');tick.title='Сохранено на сервере';stamp.appendChild(tick);}
      bubble.appendChild(stamp);row.appendChild(bubble);fragment.appendChild(row);
    });
    $('messages').replaceChildren(fragment);
    $('empty-chat').hidden=state.messages.length>0;
    $('older-button').hidden=!state.older;
    if(mode==='older') scroll.scrollTop=previousTop+scroll.scrollHeight-previousHeight;
    else if(atBottom || mode==='initial' || mode==='sent') scrollBottom();
  }
  function mergeMessages(messages, mode) {
    if(!messages.length && mode!=='initial') return;
    const known=new Map(state.messages.map(message=>[message.id,message]));
    messages.forEach(message=>known.set(message.id,message));
    state.messages=Array.from(known.values()).sort((a,b)=>a.id-b.id);
    if(mode!=='older' && state.messages.length>500) {state.messages=state.messages.slice(-500);state.older=true;}
    if(mode!=='sent' && mode!=='older' && messages.length) state.last=Math.max(state.last,messages[messages.length-1].id);
    renderMessages(mode);
    if(document.hidden && messages.some(message=>message.user_id!==state.user.id)) document.title='Новое сообщение · Маяк';
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
    if(!state.user || state.polling) return;
    state.polling=true;
    const current=generation;
    let more=false;
    try {
      const result=await api('events?after='+state.last);
      if(current!==generation || !state.user)return;
      if(!state.last)state.older=result.has_older;
      mergeMessages(result.messages,initial?'initial':'new');
      state.people=result.people;renderPeople();connection(true);
      more=result.has_more;state.retryDelay=1000;
      window.MayakCloud.watch(()=>poll());
    } catch(error) {
      if(current!==generation)return;
      connection(false);
      if(error.status===401 || error.status===403){showJoin();$('join-error').textContent=error.message;}
    } finally {
      state.polling=false;clearTimeout(timer);
      if(state.user)timer=setTimeout(()=>poll(),more?100:15000);
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
    content.appendChild(element('p','about-note','История хранится в Supabase. Соединение защищено HTTPS; сквозного шифрования нет. Meizu для работы не нужен. О новых сообщениях приходят push-уведомления, если они включены на устройстве.'));
    content.appendChild(element('p','about-note','Маяк 2.1.0 · облачная версия.'));
    content.appendChild(button('Выйти на этом устройстве',async()=>{
      try {await pushDisable(true).catch(()=>{});await api('logout',{method:'POST',body:'{}'});closeDialog();$('message-input').value='';state.draft=null;showJoin();}
      catch(error){toast(error.message);}
    }));
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
    if(!state.draft || state.draft.text!==text) {const random=new Uint32Array(4);crypto.getRandomValues(random);state.draft={text,nonce:Array.from(random).map(value=>value.toString(16)).join('-')};}
    state.sending=true;$('send-button').disabled=true;$('send-error').hidden=true;
    try {const result=await api('messages',{method:'POST',body:JSON.stringify(state.draft)});input.value='';state.draft=null;mergeMessages([result.message],'sent');connection(true);}
    catch(error){$('send-error').textContent=error.status?error.message:'Не отправлено. Текст сохранён — нажмите отправить ещё раз, когда связь вернётся.';$('send-error').hidden=false;connection(false);}
    finally{state.sending=false;resizeComposer();}
  });
  $('message-input').addEventListener('input',resizeComposer);
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
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){document.title='Маяк — свои на связи';if(state.user){clearNotifications();poll();}}});
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