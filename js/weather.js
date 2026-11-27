import {$,api,state} from './core.js';
import {stationNight,stationTime,series,chartScale,chartPath,weatherName,WEATHER_WINDOWS,WEATHER_LABELS} from './weather-model.js';

let root=null,selected=60,snapshot=null,owner=null,timer=null,clockTimer=null,renderTimer=null,epoch=0,active=false,networkError='',skew=0,previousScroll=0,previousFocus=null;
const NS='http://www.w3.org/2000/svg';
const node=(tag,cls,text)=>{let e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
const svg=(tag,attrs={})=>{const e=document.createElementNS(NS,tag);for(const [k,v]of Object.entries(attrs))e.setAttribute(k,String(v));return e;};
const num=(v,digits=1)=>typeof v==='number'&&Number.isFinite(v)?new Intl.NumberFormat('ru-RU',{minimumFractionDigits:digits,maximumFractionDigits:digits}).format(v):'—';
const now=()=>Date.now()+skew;
function icon(night,code){
 const s=svg('svg',{viewBox:'0 0 64 64','aria-hidden':'true'});
 if(code==null)return s;
 if(code<=2){
  if(night){s.append(svg('path',{d:'M34 8a19 19 0 1 0 21 26A18 18 0 0 1 34 8',class:'weather-moon'}));}
  else {s.append(svg('circle',{cx:29,cy:26,r:12,class:'weather-sun'}));for(let i=0;i<8;i++){let a=i*Math.PI/4;s.append(svg('line',{x1:29+17*Math.cos(a),y1:26+17*Math.sin(a),x2:29+21*Math.cos(a),y2:26+21*Math.sin(a),class:'weather-ray'}));}}
 }
 if(code!==0)s.append(svg('path',{d:'M17 48a10 10 0 0 1-1-20 14 14 0 0 1 26-3 12 12 0 1 1 4 23Z',class:'weather-cloud'}));
 if(code>=95)s.append(svg('path',{d:'m35 42-9 12h8l-4 9 14-14h-9l5-7',class:'weather-lightning'}));
 else if((code>=71&&code<=77)||code===85||code===86){for(const x of [21,34,47])s.append(svg('path',{d:`M${x-3} 54l6 6m-6 0 6-6`,class:'weather-snow'}));}
 else if(code>=51&&code<=82){for(const x of [21,34,47])s.append(svg('path',{d:`m${x} 53-3 7`,class:'weather-rain'}));}
 if(code===45||code===48)s.append(svg('path',{d:'M13 54h37M18 60h27',class:'weather-fog'}));return s;
}
function make(){
 root=node('section','meteo-screen');root.id='meteo-screen';root.hidden=true;root.setAttribute('role','dialog');root.setAttribute('aria-modal','true');root.setAttribute('aria-labelledby','meteo-title');
 root.innerHTML=`<div class="meteo-wrap"><header class="meteo-topbar"><button type="button" id="meteo-back" class="meteo-back"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6M8 12h12"/></svg>Назад в чат</button><span class="meteo-brand">МАЯК <b>/</b> МЕТЕО</span><button type="button" id="meteo-refresh" class="meteo-refresh" aria-label="Обновить показания"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M19.5 12a7.5 7.5 0 1 0-2 5M20 12l-2-5"/></svg>Обновить</button></header>
 <main class="meteo-main"><header class="meteo-heading"><div><p class="meteo-eyebrow">ВАША МЕТЕОСТАНЦИЯ</p><h1 id="meteo-title"><svg class="meteo-location-pin" viewBox="0 0 24 30" aria-hidden="true"><path d="M12 0A12 12 0 0 0 0 12c0 8 12 18 12 18s12-10 12-18A12 12 0 0 0 12 0Zm0 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10Z" fill-rule="evenodd"/></svg>Астрахань</h1><p class="meteo-location">5-я Литейная</p><p id="meteo-date" class="meteo-date"></p></div><div class="meteo-clock-wrap"><span id="meteo-dayphase"></span><time id="meteo-clock"><span id="meteo-hours">--</span><span class="meteo-clock-separator" aria-hidden="true">:</span><span id="meteo-minutes">--</span><span class="meteo-clock-separator" aria-hidden="true">:</span><span id="meteo-seconds">--</span></time><span>Время Астрахани</span></div></header>
 <p id="meteo-alert" class="meteo-alert" role="status" hidden></p>
 <section class="meteo-card meteo-sensor" aria-label="Показания уличного датчика"><div class="meteo-card-top"><h2>Улица / датчик</h2><span id="meteo-status" class="meteo-status">Подключаемся…</span></div>
 <div class="meteo-measures"><div class="meteo-measure"><div class="meteo-number meteo-temperature"><span id="meteo-temp">—</span><small>°C</small></div><p><svg viewBox="0 0 16 24" aria-hidden="true"><path d="M5 14V5a3 3 0 0 1 6 0v9a5 5 0 1 1-6 0ZM8 8v10"/></svg>Температура</p></div><div class="meteo-measure"><div class="meteo-number meteo-humidity"><span id="meteo-rh">—</span><small>%</small></div><p><svg viewBox="0 0 20 24" aria-hidden="true"><path d="M10 2S3 10 3 15a7 7 0 0 0 14 0C17 10 10 2 10 2ZM6 15a4 4 0 0 0 4 4"/></svg>Влажность</p></div></div>
 <div class="meteo-sample-line"><span id="meteo-sampled">Ждём первое измерение</span><span id="meteo-device"></span></div>
 <div class="meteo-chart-heading"><h3>История датчика</h3><div class="meteo-legend"><span>Температура, °C</span><span>Влажность, %</span></div></div>
 <div id="meteo-windows" class="meteo-windows" role="group" aria-label="Период графика"></div><div id="meteo-chart" class="meteo-chart"></div>
 <p class="meteo-chart-note">Шкалы независимые: °C слева, % справа. Пропуски связи показаны разрывами.</p></section>
 <section class="meteo-card meteo-city" aria-label="Интернет-погода по Астрахани"><div class="meteo-card-top"><h2>Интернет / город</h2><span id="meteo-weather-age"></span></div><div class="meteo-city-row"><div><h3 id="meteo-weather-name">Ждём погоду</h3><p id="meteo-city-values" class="meteo-city-values">—</p><p id="meteo-city-extra"></p></div><div id="meteo-icon" class="meteo-weather-icon"></div></div><p class="meteo-source">Open-Meteo · расчётная погода по городу</p></section>
 <footer class="meteo-footnote"><span>Измерения поступают раз в минуту. История на сервере — 30 дней.</span><span id="meteo-sync" aria-live="polite"></span></footer></main></div>`;
 document.body.append(root);
 for(let i=0;i<WEATHER_WINDOWS.length;i++){let b=node('button','',WEATHER_LABELS[i]);b.type='button';b.dataset.minutes=String(WEATHER_WINDOWS[i]);b.setAttribute('aria-pressed',String(selected===WEATHER_WINDOWS[i]));b.addEventListener('click',()=>{selected=WEATHER_WINDOWS[i];for(const button of $('meteo-windows').children)button.setAttribute('aria-pressed',String(Number(button.dataset.minutes)===selected));render();load();});$('meteo-windows').append(b);}
 $('meteo-back').addEventListener('click',()=>closeWeather());$('meteo-refresh').addEventListener('click',()=>load());
 root.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();closeWeather();}if(event.key==='Tab'){const all=[...root.querySelectorAll('button:not(:disabled),a[href]')].filter(e=>e.getClientRects().length),first=all[0],last=all.at(-1);if(event.shiftKey&&document.activeElement===first){last.focus();event.preventDefault();}else if(!event.shiftKey&&document.activeElement===last){first.focus();event.preventDefault();}}});
}
function drawChart(points){
 const area=$('meteo-chart');area.replaceChildren();
 if(!points.length){const p=node('p','meteo-chart-empty',snapshot?.latest?'За выбранный период нет измерений':'История появится после подключения ESP32');area.append(p);return;}
 const chart=svg('svg',{viewBox:'0 0 640 190',role:'img','aria-label':'История температуры и влажности за '+WEATHER_LABELS[WEATHER_WINDOWS.indexOf(selected)]});
 const tScale=chartScale(points,'temperature'),hScale=chartScale(points,'humidity');
 const defs=svg('defs');
 for(const [id,color] of [['meteo-temp-fill','#43e6e6'],['meteo-rh-fill','#ffe278']]){const g=svg('linearGradient',{id,x1:0,y1:0,x2:0,y2:1});g.append(svg('stop',{offset:'0%','stop-color':color,'stop-opacity':.25}),svg('stop',{offset:'100%','stop-color':color,'stop-opacity':0}));defs.append(g);}
 chart.append(defs);
 for(let i=0;i<5;i++){let x=48+i*136;chart.append(svg('line',{x1:x,y1:31,x2:x,y2:151,class:'meteo-grid'}));}
 for(let i=0;i<3;i++){let y=31+i*60;chart.append(svg('line',{x1:48,y1:y,x2:592,y2:y,class:'meteo-grid'}));
  let t=svg('text',{x:39,y:y+4,'text-anchor':'end',class:'meteo-axis meteo-t-axis'});t.textContent=num(tScale.high-i*(tScale.high-tScale.low)/2,1);chart.append(t);
  let h=svg('text',{x:602,y:y+4,class:'meteo-axis meteo-h-axis'});h.textContent=num(hScale.high-i*(hScale.high-hScale.low)/2,0);chart.append(h);
 }
 for(let i=0;i<5;i++){let m=selected*(4-i)/4,label=i===4?'сейчас':m<60?'−'+num(m,0)+'м':'−'+num(m/60,m%60?1:0)+'ч';let text=svg('text',{x:48+i*136,y:178,'text-anchor':'middle',class:'meteo-axis'});text.textContent=label;chart.append(text);}
 for(const [key,scale,cls] of [['temperature',tScale,'meteo-t-line'],['humidity',hScale,'meteo-h-line']]){
  const path=chartPath(points,key,now(),selected,scale);
  // Замыкаем заливку каждого непрерывного участка отдельно: паузы связи остаются пустыми.
  for(const segment of path.match(/M[^M]+/g)||[]){const pairs=segment.slice(1).split('L');if(pairs.length<2)continue;const first=pairs[0].split(' ')[0],last=pairs.at(-1).split(' ')[0];chart.append(svg('path',{d:segment+`L${last} 151L${first} 151Z`,fill:`url(#${key==='temperature'?'meteo-temp-fill':'meteo-rh-fill'})`,class:'meteo-chart-fill'}));}
  chart.append(svg('path',{d:path,class:cls}));
  // Отдельная точка остаётся видимой, даже когда непрерывной линии ещё нет.
  let last=0;for(const p of points){let time=Date.parse(p.time);if(!last||time-last>90000){let x=Math.max(48,Math.min(592,48+(time-(now()-selected*60000))/(selected*60000)*544)),y=151-(p[key]-scale.low)/(scale.high-scale.low)*120;chart.append(svg('circle',{cx:x,cy:y,r:2.4,class:cls+' meteo-point'}));}last=time;}
 }
 area.append(chart);
 const summary=node('p','meteo-chart-summary');summary.textContent=`${points.length} измерений · температура ${num(Math.min(...points.map(p=>p.temperature)))}…${num(Math.max(...points.map(p=>p.temperature)))} °C · влажность ${num(Math.min(...points.map(p=>p.humidity)),0)}…${num(Math.max(...points.map(p=>p.humidity)),0)}%`;area.append(summary);
}
function tick(){
 if(!active)return;const date=stationTime(now()),night=stationNight(now(),snapshot?.latest?.weather);
 root.dataset.theme=night?'dark':'light';$('meteo-hours').textContent=date.hours;$('meteo-minutes').textContent=date.minutes;$('meteo-seconds').textContent=date.seconds;
 $('meteo-clock').setAttribute('aria-label',date.clockSeconds);$('meteo-clock').dateTime=new Date(now()).toISOString();$('meteo-date').textContent=date.date;$('meteo-dayphase').textContent=night?'Ночь':'День';
}
function scheduleClock(){
 clearTimeout(clockTimer);if(!active)return;if(!document.hidden)tick();
 clockTimer=setTimeout(scheduleClock,1000-now()%1000+5);
}
function render(){
 if(!active)return;tick();const d=snapshot?.latest,w=d?.weather;
 const received=Date.parse(d?.received_at),fresh=Number.isFinite(received)&&now()-received<=180000;
 const status=!snapshot?'Подключаемся…':!d?'Станция ещё не подключена':!fresh?'Станция не на связи':!d.sensor_valid?'Ошибка датчика':'Станция на связи';
 $('meteo-status').textContent=status;$('meteo-status').dataset.state=d&&fresh&&d.sensor_valid?'online':'waiting';
 $('meteo-temp').textContent=d?.sensor_valid?(d.temperature>0?'+':'')+num(d.temperature):'—';$('meteo-rh').textContent=d?.sensor_valid?num(d.humidity):'—';
 $('meteo-sampled').textContent=d?(fresh?'Измерение: ':'Последнее измерение: ')+new Date(d.measured_at).toLocaleString('ru-RU',{timeZone:'Europe/Astrakhan',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'Ждём первое измерение';
 $('meteo-device').textContent=d?'ESP32 · '+d.firmware:'';
 const note=networkError||(d&&!fresh?'Показаны последние полученные данные. Новых пакетов от станции пока нет.':d&&!d.sensor_valid?'Станция подключена, но датчик не дал проверенного измерения.':'');
 $('meteo-alert').textContent=note;$('meteo-alert').hidden=!note;
 $('meteo-sync').textContent=networkError?'Нет связи с сервером':snapshot?'Данные обновляются автоматически':'Получаем показания…';
 drawChart(series(snapshot?.history,now(),selected));
 if(w){const age=now()/1000-w.observed_at;$('meteo-weather-age').textContent=(age>7200?'Архив · ':'')+stationTime(w.observed_at*1000).clock;
  $('meteo-weather-name').textContent=weatherName(w.code);$('meteo-city-values').textContent=(w.temperature>0?'+':'')+num(w.temperature)+' °C / '+num(w.humidity,0)+'%';
  $('meteo-city-extra').textContent='Ощущается '+num(w.feels_like,0)+' °C · ветер '+num(w.wind)+' м/с';
 }else{$('meteo-weather-age').textContent='Нет данных';$('meteo-weather-name').textContent='Ждём интернет-погоду';$('meteo-city-values').textContent='—';$('meteo-city-extra').textContent='Появится после первого пакета станции.';}
 $('meteo-icon').replaceChildren(icon(root.dataset.theme==='dark',w?.code));
}
async function load(){
 if(!active||document.hidden||!state.user)return;const current=++epoch,id=state.user.id,minutes=selected;
 $('meteo-refresh').disabled=true;
 try {
  const data=await api('weather?minutes='+minutes);
  if(!active||current!==epoch||state.user?.id!==id||selected!==minutes)return;
  if(!data?.station||!Array.isArray(data.history)||!Number.isFinite(Date.parse(data.server_time)))throw Error('Неверный ответ сервера');
  snapshot=data;skew=Date.parse(data.server_time)-Date.now();networkError='';
 }catch(error){if(current!==epoch||!active)return;networkError=error.status===401||error.status===403?'Нет доступа к метеостанции. Войдите в Маяк.':'Не удалось обновить данные. Повторим после восстановления связи.';}
 finally {if(current===epoch&&active){$('meteo-refresh').disabled=false;render();scheduleClock();}}
}
export function openWeather(push=true){
 if(!state.user||active)return;if(!root)make();
 selected=60;for(const button of $('meteo-windows').children)button.setAttribute('aria-pressed',String(Number(button.dataset.minutes)===selected));
 if(owner!==state.user.id){snapshot=null;skew=0;owner=state.user.id;}
 previousFocus=document.activeElement;previousScroll=$('messages-scroll').scrollTop;
 document.dispatchEvent(new Event('mayak-expression-close'));
 if(document.activeElement?.matches('textarea,input'))document.activeElement.blur();
 active=true;root.hidden=false;$('chat').inert=true;document.body.dataset.meteoOpen='true';
 if(push)history.pushState({...history.state,mayakWeather:true},'',location.pathname+location.search+'#weather');
 networkError='';render();$('meteo-back').focus({preventScroll:true});load();timer=setInterval(load,30000);scheduleClock();renderTimer=setInterval(()=>{if(!document.hidden)render();},10000);
}
export function closeWeather(back=true){
 if(!active)return;active=false;++epoch;clearInterval(timer);clearTimeout(clockTimer);clearInterval(renderTimer);root.hidden=true;$('chat').inert=false;delete document.body.dataset.meteoOpen;
 $('messages-scroll').scrollTop=previousScroll;if(state.user&&previousFocus?.isConnected)previousFocus.focus({preventScroll:true});
 if(back&&history.state?.mayakWeather)history.back();
}
export function initWeather(){
 $('weather-button').addEventListener('click',()=>openWeather());
 window.addEventListener('popstate',()=>{if(location.hash==='#weather'&&state.user)openWeather(false);else closeWeather(false);});
 window.addEventListener('online',()=>{if(active)load();});
 document.addEventListener('visibilitychange',()=>{if(active&&!document.hidden){render();load();}});
 document.addEventListener('mayak-context-changed',()=>{if(!state.user||owner&&owner!==state.user.id){closeWeather(false);snapshot=null;owner=null;if(location.hash==='#weather')history.replaceState(null,'',location.pathname+location.search);}});
}
