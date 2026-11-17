// Полоса «Установить приложение» над перепиской — как «Включить уведомления».
// Android (Chrome): кнопка запускает установку. iPhone: установки одной кнопкой нет, поэтому показываем короткую подсказку.
import {$, state} from './core.js';
import {installApp} from './dialogs.js';

const flag = {
  get() {try {return localStorage.getItem('mayak.install.later') === '1';} catch(_error) {return false;}},
  set() {try {localStorage.setItem('mayak.install.later', '1');} catch(_error) {}}
};
const standalone = () => (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
const phone = () => window.matchMedia && matchMedia('(pointer:coarse)').matches;
const apple = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// Одна полоса за раз: пока видна просьба про уведомления, установку не предлагаем.
// После нажатия «Установить» Chrome ставит приложение в фоне несколько секунд — полоса объясняет, что делать дальше.
let progress = ''; // '' — обычное состояние, 'installing' — идёт установка, 'done' — установлено
export function installBanner() {
  const banner = $('install-banner'), ios = apple(), can = !!state.install;
  const show = !!state.user && phone() && !flag.get() && (progress ? true : !standalone() && $('push-banner').hidden && (can || ios));
  banner.hidden = !show;
  if(!show) return;
  $('install-text').textContent = progress === 'installing' ? 'Устанавливаю… Через несколько секунд откройте Маяк с главного экрана.'
    : progress === 'done' ? 'Маяк установлен. Откройте его с главного экрана — уведомления включите уже там.'
    : ios ? 'Чтобы приходили уведомления: «Поделиться» → «На экран Домой».'
    : 'Установите Маяк — он откроется как обычное приложение.';
  $('install-enable').hidden = ios || !!progress;
}
export function initInstall() {
  $('install-enable').addEventListener('click', async () => {
    const outcome = await installApp();
    if(outcome === 'accepted') progress = 'installing';
    installBanner();
  });
  $('install-dismiss').addEventListener('click', () => {flag.set(); progress = ''; installBanner();});
  window.addEventListener('beforeinstallprompt', () => setTimeout(installBanner, 0));
  window.addEventListener('appinstalled', () => {progress = 'done'; installBanner();});
  document.addEventListener('mayak-banners', installBanner);
}
