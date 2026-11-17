// Высота чата и прокрутка ленты; подстройка под клавиатуру телефона.
import {$} from './core.js';

export function scrollBottom() {const node = $('messages-scroll'); node.scrollTop = node.scrollHeight;}
export function nearBottom() {const node = $('messages-scroll'); return node.scrollHeight - node.scrollTop - node.clientHeight < 130;}

// iOS при открытии клавиатуры не сжимает страницу, а сдвигает видимую область:
// сдвиг сбрасывается, а чат подгоняется под видимую область по высоте и положению,
// иначе над клавиатурой остаётся пустота.
export function adjustViewport() {
  const root = document.documentElement, view = window.visualViewport, chat = !$('chat').hidden;
  root.classList.toggle('chat-open', chat && window.innerWidth <= 760);
  if(!view || !chat || window.innerWidth > 760) {root.style.removeProperty('--app-height'); root.style.removeProperty('--app-top'); return;}
  if(window.scrollX || window.scrollY || view.offsetTop) window.scrollTo(0,0);
  const scroll = $('messages-scroll'), atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
  root.style.setProperty('--app-height', view.height + 'px');
  root.style.setProperty('--app-top', Math.max(0, view.offsetTop) + 'px');
  if(atBottom) scrollBottom();
}
// iOS не всегда присылает событие, когда клавиатура убирается сама (например, на время записи голосового):
// чат остаётся высотой «с клавиатурой», а внизу пустота. Раз в полсекунды сверяем высоту с видимой областью.
export function watchViewport() {
  setInterval(() => {
    const view = window.visualViewport;
    if(!view || document.hidden || $('chat').hidden || window.innerWidth > 760) return;
    const applied = parseFloat(document.documentElement.style.getPropertyValue('--app-height'));
    if(!(Math.abs(applied - view.height) < 2)) adjustViewport();
  }, 500);
}
// Клавиатура выезжает около полусекунды, а события iOS приходят не всегда — подстраиваемся каждый кадр.
let followUntil = 0;
export function followViewport(duration) {
  const running = followUntil > Date.now();
  followUntil = Date.now() + duration;
  if(running) return;
  (function step() {adjustViewport(); if(Date.now() < followUntil) requestAnimationFrame(step);})();
}
