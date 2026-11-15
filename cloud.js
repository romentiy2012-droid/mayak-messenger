/* Supabase adapter: only the public/publishable key belongs in config.js. */
(() => {
  'use strict';
  const config = window.MAYAK_CONFIG || {};
  let client, channel, pendingCallback, lastHeartbeat = 0;
  const pendingKey = 'mayak.cloud.pending:' + location.pathname;
  const storage = {get(){try{return JSON.parse(localStorage.getItem(pendingKey)||'null');}catch{return null;}},set(value){try{if(value)localStorage.setItem(pendingKey,JSON.stringify(value));else localStorage.removeItem(pendingKey);}catch{}}};
  function fail(message,status=400){return Object.assign(new Error(message),{status});}
  function nameToEmail(raw) {
    const clean = (raw || '').trim();
    if(!clean) throw fail('Введите ваше имя.');
    if(clean.includes('@')) return clean.toLowerCase();
    const bytes = new TextEncoder().encode(clean.toLowerCase());
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return 'u_' + hex + '@mayak.app';
  }
  function db() {
    if(client) return client;
    if(!config.supabaseURL || !config.supabasePublishableKey) throw fail('Облачный чат ещё настраивается. Владелец должен подключить Supabase.',503);
    const url = new URL(config.supabaseURL);
    if(url.protocol!=='https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) || url.pathname!=='/' || url.search || url.hash || url.username || url.password) throw fail('Неверный адрес облачного проекта.',503);
    const key=config.supabasePublishableKey;
    let legacyAnon=false;
    try{legacyAnon=JSON.parse(atob(key.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).role==='anon';}catch{}
    if(!key.startsWith('sb_publishable_') && !legacyAnon) throw fail('Нужен публичный ключ Supabase. Секретный ключ в приложении запрещён.',503);
    client=window.MayakSupabase.createClient(url.origin,key,{auth:{storageKey:'mayak.cloud.auth:'+url.hostname,persistSession:true,autoRefreshToken:true,detectSessionInUrl:true},global:{fetch:async (input,init={})=>{
      const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),15000);
      const abort=()=>controller.abort();if(init.signal?.aborted)abort();else init.signal?.addEventListener('abort',abort,{once:true});
      try{return await fetch(input,{...init,signal:controller.signal});}finally{clearTimeout(timeout);init.signal?.removeEventListener('abort',abort);}
    }}});
    return client;
  }
  function unwrap(result) {
    if(result.error){
      const e=result.error;
      const messages={'Invalid login credentials':'Неверное имя или пароль.','Email not confirmed':'Владельцу нужно отключить подтверждение почты (Confirm email) в Supabase.','User already registered':'Такое имя уже зарегистрировано. Выберите «Вход».','Email rate limit exceeded':'Слишком много попыток. Попробуйте позже.'};
      throw fail(messages[e.message]||e.message,e.status||(['42501','PGRST301'].includes(e.code)?403:400));
    }
    return result.data;
  }
  async function rpc(name,args={}){return unwrap(await db().rpc('mayak_'+name,args));}
  async function session() {
    const auth=unwrap(await db().auth.getSession());
    if(!auth.session) throw fail('Войдите в чат.',401);
    let member=unwrap(await db().from('mayak_members').select('*').eq('id',auth.session.user.id).maybeSingle());
    if(!member){
      const pending=storage.get();
      if(!pending?.invite) throw fail('Для первого входа нужно приглашение владельца. Введите его и войдите снова.',403);
      await rpc('redeem',{p_token:pending.invite,p_name:pending.name});
      member=unwrap(await db().from('mayak_members').select('*').eq('id',auth.session.user.id).single());
    }
    storage.set(null);
    return {user:member,room:'Наш круг',csrf:''};
  }
  const COLUMNS='id,user_id,name,text,nonce,created,reply_to,edited,deleted,reactions,rev';
  // before — страница старых сообщений; rev — всё новое и изменённое после этой отметки; иначе — последние сообщения.
  async function messages(params) {
    const q=db().from('mayak_messages').select(COLUMNS);
    const before=Number(params.get('before')||0),rev=Number(params.get('rev')||0);
    if(rev&&!before){
      const rows=unwrap(await q.gt('rev',rev).order('rev',{ascending:true}).limit(101));
      return {messages:rows.slice(0,100),has_older:false,has_more:rows.length>100};
    }
    const rows=unwrap(await (before?q.lt('id',before):q).order('id',{ascending:false}).limit(101));
    return {messages:rows.slice(0,100).reverse(),has_older:rows.length>100,has_more:false};
  }
  function person(row){return {...row,online:Date.now()-Date.parse(row.last_seen)<90000};}
  async function api(path,options={}) {
    const [route,query='']=path.split('?');const params=new URLSearchParams(query);
    const body=options.body?JSON.parse(options.body):{};
    if(route==='join'){
      const name=(body.name||'').trim();
      const email=nameToEmail(body.email||name);
      const pending={invite:body.invite,name};
      if(body.register && (!pending.invite || !pending.name)) throw fail('Для регистрации нужны имя и приглашение.');
      if(pending.invite)storage.set(pending);
      if(body.register){
        const result=unwrap(await db().auth.signUp({email,password:body.password,options:{emailRedirectTo:location.origin+location.pathname}}));
        if(!result.session)throw fail('В настройках Supabase ещё включено подтверждение почты (Confirm email).');
      } else unwrap(await db().auth.signInWithPassword({email,password:body.password}));
      return session();
    }
    if(route==='session')return session();
    if(route==='health'){unwrap(await db().from('mayak_messages').select('id').limit(0));return {ok:true};}
    if(route==='logout'){stop();unwrap(await db().auth.signOut({scope:'local'}));storage.set(null);return {};}
    if(route==='push-subscribe'){await rpc('push_subscribe',{p_endpoint:body.endpoint,p_p256dh:body.p256dh,p_auth:body.auth});return {};}
    if(route==='push-unsubscribe'){await rpc('push_unsubscribe',{p_endpoint:body.endpoint});return {};}
    if(route==='profile')return {user:await rpc('profile',{p_name:body.name})};
    if(route==='invite'){
      const token=await rpc('invite');const url=new URL(location.pathname,location.origin);url.hash=new URLSearchParams({invite:token}).toString();return {url:url.href};
    }
    if(route==='messages' && options.method==='POST')return {message:await rpc('post',{p_text:body.text,p_nonce:body.nonce,p_reply:body.reply||null})};
    if(route==='edit')return {message:await rpc('edit',{p_id:body.id,p_text:body.text})};
    if(route==='delete')return {message:await rpc('delete',{p_id:body.id})};
    if(route==='react')return {message:await rpc('react',{p_id:body.id,p_emoji:body.emoji||null})};
    if(route==='read'){await rpc('read',{p_id:body.id});return {};}
    if(route==='typing'){await rpc('typing',{p_on:!!body.on});return {};}
    if(route==='messages')return messages(params);
    if(route==='events'){
      if(Date.now()-lastHeartbeat>25000){await rpc('profile');lastHeartbeat=Date.now();}
      const result=await messages(params);
      const people=unwrap(await db().from('mayak_members').select('id,name,owner,last_seen,last_read,typing'));
      return {...result,people:people.map(person)};
    }
    throw fail('Неизвестный запрос.');
  }
  // callback('message',строка) — новое или изменённое сообщение; callback('member',участник) — «прочитано», «печатает», имя.
  function watch(callback){
    pendingCallback=callback;if(channel)return;
    channel=db().channel('mayak-messages')
      .on('postgres_changes',{event:'*',schema:'public',table:'mayak_messages'},payload=>{if(payload.new&&payload.new.id)pendingCallback?.('message',payload.new);})
      .on('postgres_changes',{event:'*',schema:'public',table:'mayak_members'},payload=>{if(payload.new&&payload.new.id)pendingCallback?.('member',person(payload.new));})
      .subscribe(status=>{if(status==='SUBSCRIBED')pendingCallback?.('ready');});
  }
  function stop(){pendingCallback=null;if(channel){db().removeChannel(channel).catch(()=>{});channel=null;}lastHeartbeat=0;}
  window.MayakCloud={api,watch,stop};
})();