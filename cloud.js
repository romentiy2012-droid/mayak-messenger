/* Supabase adapter: only the public/publishable key belongs in config.js. */
(() => {
  'use strict';
  const config = window.MAYAK_CONFIG || {};
  let client, channel, pendingCallback, lastHeartbeat = 0, skew = 0; // skew — на сколько часы сервера впереди часов телефона
  const pendingKey = 'mayak.cloud.pending:' + location.pathname;
  const storage = {get(){try{return JSON.parse(localStorage.getItem(pendingKey)||'null');}catch{return null;}},set(value){try{if(value)localStorage.setItem(pendingKey,JSON.stringify(value));else localStorage.removeItem(pendingKey);}catch{}}};
  const transfers=new Set();
  async function timedFetch(input,init={},limit=25000){
    const controller=new AbortController();transfers.add(controller);
    const abort=()=>controller.abort();if(init.signal?.aborted)abort();else init.signal?.addEventListener('abort',abort,{once:true});
    const timeout=setTimeout(abort,limit);
    try{
      const response=await fetch(input,{...init,signal:controller.signal});
      // fetch resolves at headers; keep the deadline through the response body too.
      const bytes=await response.arrayBuffer();
      return new Response([204,205,304].includes(response.status)?null:bytes,{status:response.status,statusText:response.statusText,headers:response.headers});
    }finally{clearTimeout(timeout);transfers.delete(controller);init.signal?.removeEventListener('abort',abort);}
  }
  function cachedUserId(){try{return JSON.parse(localStorage.getItem('mayak.cloud.auth:'+new URL(config.supabaseURL).hostname)||'null')?.user?.id||null;}catch{return null;}}
  function fail(message,status=400){return Object.assign(new Error(message),{status});}
  function nameToEmail(raw) {
    const clean = (raw || '').trim();
    if(!clean) throw fail('Введите ваше имя.');
    if(clean.includes('@')) return clean.toLowerCase();
    const bytes = new TextEncoder().encode(clean.toLowerCase());
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return 'u_' + hex + '@mayak.app';
  }
  // Обратно: технический адрес → имя, с которым участник регистрировался (им он и входит).
  function emailToName(email) {
    const match = /^u_((?:[0-9a-f]{2})+)@mayak\.app$/.exec(email || '');
    if(!match) return email || '';
    try {return new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(match[1].match(/../g), pair => parseInt(pair,16)));}
    catch {return email;}
  }
  // Запрос мимо клиента Supabase (служебные функции, проверка связи) с ограничением по времени.
  async function plain(path,options={},limit=15000) {
    db();
    return timedFetch(new URL(path,config.supabaseURL),options,limit);
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
      // Файлам даём больше времени: фото по мобильной сети может грузиться дольше обычного запроса.
      const limit=String(typeof input==='string'?input:input.url||'').includes('/storage/v1/')?90000:25000;
      return timedFetch(input,init,limit);
    }}});
    return client;
  }
  function unwrap(result) {
    if(result.error){
      const e=result.error;
      if(result.status===0 || e.name==='AuthRetryableFetchError' || /^(TypeError:|AbortError:|TimeoutError:)|Failed to fetch|NetworkError|Load failed|fetch failed/i.test(e.message||''))throw Object.assign(new Error('Нет связи. Отправка продолжится после подключения.'),{status:0});
      const messages={'Invalid login credentials':'Неверное имя или пароль.','Email not confirmed':'Владельцу нужно отключить подтверждение почты (Confirm email) в Supabase.','User already registered':'Такое имя уже зарегистрировано. Выберите «Вход».','Email rate limit exceeded':'Слишком много попыток. Попробуйте позже.'};
      throw Object.assign(fail(messages[e.message]||e.message,e.status||(['42501','PGRST301'].includes(e.code)?403:400)),{code:e.code});
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
  const COLUMNS='id,user_id,name,text,nonce,created,reply_to,edited,deleted,reactions,rev,kind,file,file_meta,peer_a,peer_b,heard';
  // Три вида запроса:
  //   rev=N — всё новое и изменённое после отметки (по всем чатам сразу);
  //   before=ID и чат (main=1 либо a,b — пара участников личного чата) — страница истории одного чата;
  //   без параметров — первая загрузка: последние сообщения общего чата и последние личные.
  const page=rows=>({messages:rows.slice(0,100).reverse(),full:rows.length>100});
  const recent=query=>query.order('id',{ascending:false}).limit(101);
  async function messages(params) {
    const table=()=>db().from('mayak_messages').select(COLUMNS);
    const before=Number(params.get('before')||0),rev=Number(params.get('rev')||0);
    if(rev&&!before){
      const rows=unwrap(await table().gt('rev',rev).order('rev',{ascending:true}).limit(101));
      return {messages:rows.slice(0,100),has_older:false,has_more:rows.length>100};
    }
    if(before){
      const a=params.get('a'),b=params.get('b');
      const scoped=a&&b?table().eq('peer_a',a).eq('peer_b',b):table().is('peer_a',null);
      const result=page(unwrap(await recent(scoped.lt('id',before))));
      return {messages:result.messages,has_older:result.full,has_more:false};
    }
    const [main,direct]=await Promise.all([recent(table().is('peer_a',null)),recent(table().not('peer_a','is',null))]);
    const common=page(unwrap(main)),personal=page(unwrap(direct));
    return {messages:common.messages.concat(personal.messages).sort((x,y)=>x.id-y.id),has_older:common.full,direct_full:personal.full,has_more:false};
  }
  // «В сети» — по времени сервера: часы телефона могут спешить или отставать, и тогда «в сети» не был бы никто.
  function person(row){return {...row,online:Date.now()+skew-Date.parse(row.last_seen)<90000};}
  async function api(path,options={}) {
    const [route,query='']=path.split('?');const params=new URLSearchParams(query);
    const body=options.body?JSON.parse(options.body):{};
    if(body._user){const auth=unwrap(await db().auth.getSession());if(auth.session?.user.id!==body._user)throw fail('Вход изменился. Отправка остановлена.',401);}
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
    // Любой ответ сервера означает, что облако на связи (таблицы невошедшему недоступны, поэтому их не трогаем).
    if(route==='health'){await plain('/auth/v1/health',{headers:{apikey:config.supabasePublishableKey}});return {ok:true};}
    if(route==='reset'){
      const response=await plain('/functions/v1/reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:body.token,password:body.password})});
      const data=await response.json().catch(()=>({}));
      if(!response.ok||!data.email) throw fail(data.error||'Не удалось сменить пароль. Попробуйте ещё раз позже.',response.ok?500:response.status);
      unwrap(await db().auth.signInWithPassword({email:data.email,password:body.password}));
      return {...await session(),login:emailToName(data.email)};
    }
    if(route==='reset-link'){
      const token=await rpc('reset_issue',{p_user:body.id});const url=new URL(location.pathname,location.origin);url.hash=new URLSearchParams({reset:token}).toString();return {url:url.href};
    }
    if(route==='logout'){stop();unwrap(await db().auth.signOut({scope:'local'}));storage.set(null);return {};}
    if(route==='push-subscribe'){await rpc('push_subscribe',{p_endpoint:body.endpoint,p_p256dh:body.p256dh,p_auth:body.auth});return {};}
    if(route==='push-unsubscribe'){await rpc('push_unsubscribe',{p_endpoint:body.endpoint});return {};}
    if(route==='profile')return {user:await ('avatar_icon' in body
      ? rpc('profile_avatar',{p_name:body.name,p_icon:body.avatar_icon,p_file:body.avatar_file})
      : rpc('profile',{p_name:body.name}))};
    if(route==='invite'){
      const token=await rpc('invite');const url=new URL(location.pathname,location.origin);url.hash=new URLSearchParams({invite:token}).toString();return {url:url.href};
    }
    if(route==='messages' && options.method==='POST')return {message:await rpc('post_to',{p_peer:body.peer||null,p_text:body.text,p_nonce:body.nonce,p_reply:body.reply||null})};
    if(route==='attach')return {message:await rpc('attach_to',{p_peer:body.peer||null,p_kind:body.kind,p_file:body.file,p_meta:body.meta||{},p_text:body.text||'',p_nonce:body.nonce,p_reply:body.reply||null})};
    if(route==='poll-create')return rpc('poll_create',{p_question:body.question,p_options:body.options,p_multiple:body.multiple,p_anonymous:body.anonymous,p_nonce:body.nonce,p_peer:body.peer||null,p_reply:body.reply||null});
    if(route==='poll-get')return rpc('poll_get',{p_id:body.id,p_voters:body.voters===true});
    if(route==='poll-vote')return rpc('poll_vote',{p_id:body.id,p_choices:body.choices,p_nonce:body.nonce});
    if(route==='poll-close')return rpc('poll_close',{p_id:body.id});
    if(route==='video-start'){
      const auth=unwrap(await db().auth.getSession());if(!auth.session)throw fail('Войдите в чат.',401);
      const response=await plain('/functions/v1/video',{method:'POST',headers:{'Content-Type':'application/json',apikey:config.supabasePublishableKey,Authorization:'Bearer '+auth.session.access_token},body:JSON.stringify(body)});
      const result=await response.json().catch(()=>({}));if(!response.ok)throw fail(result.error||'Не удалось начать обработку видео.',response.status);return result;
    }
    if(route==='video-status'){
      const job=unwrap(await db().from('mayak_video_jobs').select('*').eq('id',body.id).single());
      const message=job.state==='sent'?unwrap(await db().from('mayak_messages').select(COLUMNS).eq('id',job.message_id).single()):null;
      return {job,message};
    }
    if(route==='video-cancel')return {job:await rpc('video_cancel',{p_id:body.id})};
    if(route==='storage'){
      const auth=unwrap(await db().auth.getSession());if(!auth.session)throw fail('Войдите в чат.',401);
      const response=await plain('/functions/v1/storage-admin',{method:'POST',headers:{'Content-Type':'application/json',apikey:config.supabasePublishableKey,Authorization:'Bearer '+auth.session.access_token},body:JSON.stringify(body)},body.action==='delete'?90000:15000);
      const result=await response.json().catch(()=>({}));if(!response.ok)throw fail(result.error||'Не удалось получить состояние хранилища.',response.status);return result;
    }
    if(route==='edit')return {message:await rpc('edit',{p_id:body.id,p_text:body.text})};
    if(route==='delete')return {message:await rpc('delete',{p_id:body.id})};
    if(route==='react')return {message:await rpc('react',{p_id:body.id,p_emoji:body.emoji||null})};
    if(route==='kick'){await rpc('kick',{p_user:body.id});return {};}
    if(route==='read'){await rpc('read_to',{p_peer:body.peer||null,p_id:body.id});return {};}
    if(route==='typing'){await rpc('typing_to',{p_peer:body.peer||null,p_on:!!body.on});return {};}
    if(route==='heard')return {message:await rpc('heard',{p_id:body.id})};
    if(route==='messages')return messages(params);
    if(route==='events')return messages(params);
    if(route==='presence'){
      const jobs=[db().from('mayak_members').select('id,name,owner,last_seen,last_read,typing,avatar_icon,avatar_file'),db().from('mayak_reads').select('user_id,peer,last_read,typing')];
      if(Date.now()-lastHeartbeat>25000){
        const sent=Date.now();jobs.push(rpc('profile').then(me=>{lastHeartbeat=Date.now();const server=Date.parse(me&&me.last_seen);if(server)skew=server-(sent+lastHeartbeat)/2;}));
      }
      const settled=await Promise.allSettled(jobs),result={};
      if(settled[0].status==='fulfilled'&&!settled[0].value.error)result.people=settled[0].value.data.map(person);
      if(settled[1].status==='fulfilled'&&!settled[1].value.error)result.reads=settled[1].value.data;
      return result;
    }
    throw fail('Неизвестный запрос.');
  }
  // callback('message',строка) — новое или изменённое сообщение; callback('member',участник) — «прочитано», «печатает», имя;
  // callback('read',строка) — то же для личного чата.
  function watch(callback){
    pendingCallback=callback;if(channel)return;
    channel=db().channel('mayak-messages')
      .on('postgres_changes',{event:'*',schema:'public',table:'mayak_messages'},payload=>{if(payload.new&&payload.new.id)pendingCallback?.('message',payload.new);})
      .on('postgres_changes',{event:'*',schema:'public',table:'mayak_members'},payload=>{
        if(payload.eventType==='DELETE')pendingCallback?.('ready'); // участника удалили — обновить список
        else if(payload.new&&payload.new.id)pendingCallback?.('member',person(payload.new));
      })
      .on('postgres_changes',{event:'*',schema:'public',table:'mayak_reads'},payload=>{if(payload.new&&payload.new.user_id)pendingCallback?.('read',payload.new);})
      .subscribe(status=>{if(status==='SUBSCRIBED')pendingCallback?.('ready');});
  }
  // Файлы вложений: закрытый бакет, у каждого участника своя папка.
  const BUCKET='mayak';
  async function upload(blob,extension,bucket=BUCKET,prefix=''){
    const auth=unwrap(await db().auth.getSession());
    if(!auth.session) throw fail('Войдите в чат.',401);
    const random=new Uint8Array(12);crypto.getRandomValues(random);
    if(prefix && prefix!=='sticker-')throw fail('Неверный тип вложения.');
    const path=auth.session.user.id+'/'+prefix+Array.from(random,b=>b.toString(16).padStart(2,'0')).join('')+'.'+extension;
    const result=await db().storage.from(bucket).upload(path,blob,{contentType:blob.type,cacheControl:bucket===BUCKET?'31536000':'0',upsert:false});
    if(result.error){
      const status=Number(result.error.statusCode||result.error.status)||0;
      if(!status) throw new Error('upload failed'); // нет связи — без status, приложение предложит повторить
      throw fail(status===413?'Файл слишком большой.':status===403||status===401?'Нет доступа к хранилищу файлов.':'Не удалось загрузить файл.',status);
    }
    return path;
  }
  async function download(path,bucket=BUCKET){
    const result=await db().storage.from(bucket).download(path);
    if(result.error){const status=Number(result.error.statusCode||result.error.status)||0;throw Object.assign(new Error(status===404?'Файл удалён.':status===401||status===403?'Нет доступа к файлу.':'Не удалось загрузить. Нажмите, чтобы повторить.'),{status});}
    return result.data;
  }
  async function uploadQueued(item,persist,progress){
    const auth=unwrap(await db().auth.getSession());
    if(auth.session?.user.id!==item.user)throw fail('Вход изменился.',401);
    if(!item.blob)throw fail('Запись не сохранилась. Выбери файл ещё раз.',422);
    const bucket=item.kind==='video'?'mayak-video-source':BUCKET;
    if(!item.uploadPath){const bytes=new Uint8Array(12);crypto.getRandomValues(bytes);item.uploadPath=item.user+'/'+(item.sticker?'sticker-':'')+Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('')+'.'+item.extension;await persist();}
    if(!item.uploadPath.startsWith(item.user+'/'))throw fail('Неверный владелец файла.',403);
    if(item.blob.size<1024*1024){
      const result=await db().storage.from(bucket).upload(item.uploadPath,item.blob,{contentType:item.blob.type,upsert:false,cacheControl:bucket===BUCKET?'31536000':'0'});
      // Path was durably generated before upload. A lost success response is safe to retry.
      if(result.error&&![409].includes(Number(result.error.statusCode||result.error.status)))throw Object.assign(new Error('Не удалось загрузить файл.'),{status:Number(result.error.statusCode||result.error.status)||0});
      progress(100);return item.uploadPath;
    }
    const origin=new URL(config.supabaseURL).origin,endpoint=origin+'/storage/v1/upload/resumable';
    const headers={'Tus-Resumable':'1.0.0',apikey:config.supabasePublishableKey,Authorization:'Bearer '+auth.session.access_token};
    const checked=url=>{const value=new URL(url,endpoint);if(value.origin!==origin||!value.pathname.startsWith('/storage/v1/upload/resumable/'))throw fail('Неверный адрес загрузки.',400);return value.href;};
    const check=response=>{if(!response.ok)throw fail(response.status===413?'Файл слишком большой.':'Загрузка прервана.',response.status);return response;};
    let offset=0;
    if(item.uploadURL){
      const response=await timedFetch(checked(item.uploadURL),{method:'HEAD',headers},25000);
      if(response.status===404||response.status===410){item.uploadURL=null;await persist();}
      else {check(response);offset=Number(response.headers.get('Upload-Offset'));if(!response.headers.has('Upload-Offset')||!Number.isSafeInteger(offset)||offset<0||offset>item.blob.size)throw fail('Не удалось продолжить загрузку.',502);}
    }
    if(!item.uploadURL){
      const metadata={bucketName:bucket,objectName:item.uploadPath,contentType:item.blob.type,cacheControl:bucket===BUCKET?'31536000':'0'};
      const response=await timedFetch(endpoint,{method:'POST',headers:{...headers,'Upload-Length':String(item.blob.size),'Upload-Metadata':Object.entries(metadata).map(([key,value])=>key+' '+btoa(value)).join(',')}},25000);
      if(response.status===409){const info=await db().storage.from(bucket).info(item.uploadPath);if(!info.error&&Number(info.data.size)===item.blob.size)return item.uploadPath;}
      check(response);if(!response.headers.get('Location'))throw fail('Нет адреса продолжения загрузки.',502);item.uploadURL=checked(response.headers.get('Location'));await persist();
    }
    while(offset<item.blob.size){
      if(cachedUserId()!==item.user)throw fail('Вход изменился.',401);
      const end=Math.min(item.blob.size,offset+6*1024*1024);
      const response=check(await timedFetch(checked(item.uploadURL),{method:'PATCH',headers:{...headers,'Content-Type':'application/offset+octet-stream','Upload-Offset':String(offset)},body:item.blob.slice(offset,end)},300000));
      const next=Number(response.headers.get('Upload-Offset'));if(!response.headers.has('Upload-Offset')||next!==end)throw fail('Не удалось подтвердить загрузку.',502);
      offset=next;progress(Math.round(offset/item.blob.size*100));
    }
    return item.uploadPath;
  }
  async function removeFile(path){await db().storage.from(BUCKET).remove([path]);}
  function stop(){for(const transfer of transfers)transfer.abort();pendingCallback=null;if(channel){db().removeChannel(channel).catch(()=>{});channel=null;}lastHeartbeat=0;}
  window.MayakCloud={api,watch,stop,upload,uploadQueued,download,removeFile,cachedUserId,presence:()=>api('presence'),
    avatarUpload:blob=>upload(blob,'jpg','mayak-avatars'),
    avatarDownload:path=>download(path,'mayak-avatars'),
    avatarRemove:path=>db().storage.from('mayak-avatars').remove([path])};
  Object.assign(window.MayakCloud,{
    videoUpload:(blob,extension)=>upload(blob,extension,'mayak-video-source'),
    videoDownload:path=>download(path,'mayak-video'),
    videoRemove:path=>db().storage.from('mayak-video').remove([path]),
    videoSourceRemove:path=>db().storage.from('mayak-video-source').remove([path]),
    videoStream:async path=>{const result=await db().storage.from('mayak-video').createSignedUrl(path,300);if(result.error)throw result.error;return result.data.signedUrl;}
  });
})();
