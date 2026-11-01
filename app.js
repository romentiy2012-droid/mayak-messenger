(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const configuredAPI = (window.MAYAK_CONFIG || {}).apiBaseURL || '';
  const apiURL = configuredAPI ? new URL(configuredAPI) : new URL(location.origin);
  if(configuredAPI && (apiURL.protocol !== 'https:' || apiURL.username || apiURL.password || apiURL.search || apiURL.hash || apiURL.pathname !== '/')) throw new Error('Неверный адрес сервера Маяка.');
  const remote = apiURL.origin !== location.origin;
  const storageKey = 'mayak.session:' + location.pathname + ':' + apiURL.origin;
  let sessionToken = '';
  try {if(remote) sessionToken=localStorage.getItem(storageKey)||'';} catch(_error) {}
  function rememberToken(token) {
    sessionToken=token;
    if(remote) {try {if(token) localStorage.setItem(storageKey,token);else localStorage.removeItem(storageKey);} catch(_error) {if(token) toast('Вход сохранён до закрытия приложения. Браузер запретил постоянное хранение.');}}
  }
  const state = {user:null, csrf:'', messages:[], people:[], last:0, older:false, online:false,
    polling:false, pollCount:0, sending:false, inviteURL:'', install:null, draft:null};
  let invitation = new URLSearchParams(location.hash.slice(1)).get('invite') || '';
  let timer = null, toastTimer = null, previousFocus = null;

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
  async function api(path, options = {}) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), 15000) : null;
    try {
      const headers = Object.assign({}, options.body ? {'Content-Type':'application/json','X-Mayak-CSRF':state.csrf} : {}, options.headers || {});
      if(remote) {
        headers.skip_zrok_interstitial='1';
        if(sessionToken) headers.Authorization='Bearer '+sessionToken;
      }
      const response = await fetch(apiURL.origin + '/api/' + path, Object.assign({cache:'no-store'}, options, {credentials:remote?'omit':'same-origin',headers, signal:controller ? controller.signal : undefined}));
      let value;
      try {value=await response.json();} catch(_error) {throw new Error('Сервер пока недоступен. Попробуйте ещё раз чуть позже.');}
      if(!response.ok) {
        const error = new Error(value.error || 'Не удалось выполнить запрос.'); error.status = response.status; throw error;
      }
      return value;
    } finally {if(timeout) clearTimeout(timeout);}
  }
  function connection(online) {
    state.online = online;
    const active = state.people.filter(person => person.online).length;
    [$('welcome-network'), $('connection-status')].forEach(node => {
      node.classList.toggle('disconnected', !online); node.replaceChildren(element('i'));
      node.appendChild(document.createTextNode(online ? (state.user ? active + ' в сети · телефон подключён' : 'Телефон на связи') : 'Нет соединения'));
    });
    $('offline-banner').hidden = online || !state.user;
  }
  function clearInviteFromAddress() {
    if(location.hash) history.replaceState(null, '', location.pathname + location.search);
    invitation = '';
  }
  function showChat(session) {
    if(session.token) rememberToken(session.token);
    state.user = session.user; state.csrf = session.csrf;
    $('welcome').hidden = true; $('chat').hidden = false;
    document.querySelectorAll('.room-name').forEach(node => {node.textContent = session.room || 'Наш круг';});
    $('my-name').textContent = state.user.name;
    [$('my-avatar'),$('mobile-avatar')].forEach(node => {node.textContent=initials(state.user.name);node.className='avatar '+palette(state.user.id);});
    $('invite-button').hidden = !state.user.owner;
    clearInviteFromAddress();
    adjustViewport();
  }
  function showJoin() {
    clearTimeout(timer);
    state.messages=[];state.people=[];state.last=0;state.older=false;state.inviteURL='';state.csrf='';
    $('messages').replaceChildren();$('people-list').replaceChildren();
    state.user = null; $('chat').hidden = true; $('welcome').hidden = false;
    $('invite-field').hidden = !!invitation;
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
    try {
      const suffix = initial || !state.last ? '' : '?after='+state.last;
      const result=await api('messages'+suffix);
      if(initial || !state.last) state.older=result.has_older;
      mergeMessages(result.messages, initial?'initial':'new');connection(true);
      if(initial || state.pollCount++ % 4===0) {
        const result=await api('people');state.people=result.people;renderPeople();
      }
    } catch(error) {
      connection(false);
      if(error.status===401) {rememberToken('');showJoin();$('join-error').textContent='Войдите снова с прежним именем и паролем.';}
    } finally {
      state.polling=false;clearTimeout(timer);
      if(state.user) timer=setTimeout(()=>poll(), document.hidden?10000:2000);
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
    content.appendChild(element('p','','По этой ссылке можно войти и прочитать историю чата. Отправляйте её только своим.'));
    try {
      if(!state.inviteURL) state.inviteURL=(await api('invite')).url;
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
    content.appendChild(element('p','about-note','Для переписки нужен интернет. Новые сообщения приходят, когда чат открыт.'));
  }
  function aboutDialog() {
    const content=dialog('Небольшой чат для своих');
    content.appendChild(element('p','','«Маяк» работает на телефоне владельца. Здесь одна общая переписка, а вход — по приглашению.'));
    content.appendChild(button('Установить приложение',installApp));
    content.appendChild(button('Участники и ваше имя',profileDialog));
    if(state.user.owner) content.appendChild(button('Пригласить друзей',inviteDialog));
    content.appendChild(element('p','about-note','История хранится на Meizu. Соединение защищено HTTPS, но сквозного шифрования здесь нет. Если телефон выключен или потерял интернет, чат временно недоступен.'));
    content.appendChild(element('p','about-note',remote?'Адрес приложения постоянный. Если связь с Meizu прервётся, переписка появится после восстановления соединения. Маяк 1.1.0.':'Локальная версия на телефоне владельца. Маяк 1.1.0.'));
    content.appendChild(button('Выйти на этом устройстве',async()=>{
      try {await api('logout',{method:'POST',body:'{}'});rememberToken('');closeDialog();$('message-input').value='';state.draft=null;showJoin();}
      catch(error){toast(error.message);}
    }));
  }
  function resizeComposer() {const input=$('message-input');input.style.height='auto';input.style.height=Math.min(input.scrollHeight,130)+'px';$('send-button').disabled=state.sending||!input.value.trim();}
  function adjustViewport() {
    if(window.visualViewport && window.innerWidth<=760) document.documentElement.style.setProperty('--app-height',window.visualViewport.height+'px');
    else document.documentElement.style.removeProperty('--app-height');
  }
  $('join-form').addEventListener('submit',async event=>{
    event.preventDefault();$('join-error').textContent='';$('join-button').disabled=true;
    let invite=invitation||$('join-invite').value.trim();
    if(invite.includes('#')) {try {invite=new URLSearchParams(new URL(invite).hash.slice(1)).get('invite')||invite;}catch(_error){}}
    try {const result=await api('join',{method:'POST',body:JSON.stringify({name:$('join-name').value,password:$('join-password').value,invite,auth_mode:remote?'bearer':'cookie'})});$('join-password').value='';showChat(result);await poll(true);}
    catch(error){$('join-error').textContent=error.status?error.message:'Телефон пока недоступен. Проверьте интернет и попробуйте ещё раз.';}
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
  $('dialog-close').addEventListener('click',closeDialog);
  $('dialog-layer').addEventListener('click',event=>{if(event.target===$('dialog-layer'))closeDialog();});
  document.addEventListener('keydown',event=>{
    if($('dialog-layer').hidden)return;
    if(event.key==='Escape')closeDialog();
    if(event.key==='Tab') {const nodes=$('dialog-layer').querySelectorAll('button:not([disabled]),input,a[href]');const first=nodes[0],last=nodes[nodes.length-1];if(event.shiftKey&&document.activeElement===first){last.focus();event.preventDefault();}else if(!event.shiftKey&&document.activeElement===last){first.focus();event.preventDefault();}}
  });
  window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();state.install=event;$('install-button').hidden=false;});
  window.addEventListener('appinstalled',()=>{$('install-button').hidden=true;toast('Маяк добавлен на главный экран');});
  window.addEventListener('online',()=>{if(state.user)poll();else boot();});
  window.addEventListener('hashchange',()=>{const next=new URLSearchParams(location.hash.slice(1)).get('invite');if(next){invitation=next;if(!state.user)$('invite-field').hidden=true;}});
  window.addEventListener('offline',()=>connection(false));
  window.addEventListener('resize',adjustViewport);
  if(window.visualViewport)window.visualViewport.addEventListener('resize',adjustViewport);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){document.title='Маяк — свои на связи';if(state.user)poll();}});
  async function boot() {
    $('invite-field').hidden=!!invitation;
    try {const session=await api('session');showChat(session);await poll(true);}
    catch(error) {showJoin();if(error.status===401){rememberToken('');try{await api('health');connection(true);}catch(_error){connection(false);}}else{connection(false);$('join-error').textContent='Телефон пока недоступен. Попробуйте открыть чат чуть позже.';}}
  }
  if('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('./sw.js').catch(()=>{});
  adjustViewport();boot();
})();
