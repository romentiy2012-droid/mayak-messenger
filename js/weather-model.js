// Чистая логика времени/темы/графиков — независимо от настроек часового пояса телефона.
export const WEATHER_WINDOWS=[30,60,180,360,720,1440];
export const WEATHER_LABELS=['30 мин','1 ч','3 ч','6 ч','12 ч','24 ч'];
const localDay=seconds=>new Date((seconds+14400)*1000).toISOString().slice(0,10);
export function stationNight(now,weather){
 const seconds=now/1000;
 for(let i=0;i<2;i++)if(Number.isFinite(weather?.sunrise?.[i])&&Number.isFinite(weather?.sunset?.[i])&&weather.sunset[i]>weather.sunrise[i]&&localDay(weather.sunrise[i])===localDay(seconds))return seconds<weather.sunrise[i]||seconds>=weather.sunset[i];
 const h=new Date(now+14400000).getUTCHours();return h<7||h>=19;
}
export function stationTime(now){
 const d=new Date(now+14400000),pad=v=>String(v).padStart(2,'0');
 return {clock:pad(d.getUTCHours())+':'+pad(d.getUTCMinutes()),date:['Вс','Пн','Вт','Ср','Чт','Пт','Сб'][d.getUTCDay()]+', '+pad(d.getUTCDate())+'.'+pad(d.getUTCMonth()+1)+'.'+d.getUTCFullYear()};
}
export function series(data,now,minutes){
 const cutoff=now-minutes*60000;
 return (Array.isArray(data)?data:[]).filter(p=>Number.isFinite(Date.parse(p.time))&&Date.parse(p.time)>=cutoff&&Date.parse(p.time)<=now+60000&&typeof p.temperature==='number'&&Number.isFinite(p.temperature)&&p.temperature>=-50&&p.temperature<=150&&typeof p.humidity==='number'&&Number.isFinite(p.humidity)&&p.humidity>=0&&p.humidity<=100).sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));
}
export function chartScale(points,key){
 const v=points.map(p=>p[key]);let low=Math.min(...v),high=Math.max(...v),range=Math.max(key==='humidity'?5:1,high-low),mid=(low+high)/2;
 low=mid-range*.65;high=mid+range*.65;
 return key==='humidity'?{low:Math.max(0,low),high:Math.min(100,high)}:{low,high};
}
export function chartPath(points,key,now,minutes,scale){
 let previous=0,path='';
 for(const p of points){let t=Date.parse(p.time),x=48+((t-(now-minutes*60000))/(minutes*60000))*544,y=151-(p[key]-scale.low)/(scale.high-scale.low)*120;
  x=Math.max(48,Math.min(592,x));y=Math.max(31,Math.min(151,y));
  path+=(previous&&t-previous<=90000?'L':'M')+x.toFixed(2)+' '+y.toFixed(2);previous=t;
 }return path;
}
export function weatherName(code){
 if(code===0)return 'Ясно';if(code===1)return 'Преимущественно ясно';if(code===2)return 'Переменная облачность';if(code===3)return 'Пасмурно';
 if(code===45||code===48)return 'Туман';if(code>=95)return 'Гроза';if((code>=71&&code<=77)||code===85||code===86)return 'Снег';if(code>=80&&code<=82)return 'Ливень';if(code>=51&&code<=67)return 'Дождь';return 'Нет описания';
}
