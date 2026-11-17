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
export function installBanner() {
  const banner = $('install-banner'), ios = apple(), can = !!state.install;
  const show = !!state.user && phone() && !standalone() && !flag.get() && $('push-banner').hidden && (can || ios);
  banner.hidden = !show;
  if(!show) return;
  $('install-text').textContent = ios
    ? 'Чтобы приходили уведомления: «Поделиться» → «На экран Домой».'
    : 'Установите Маяк — он откроется как обычное приложение.';
  $('install-enable').hidden = ios;
}
export function initInstall() {
  $('install-enable').addEventListener('click', async () => {await installApp(); installBanner();});
  $('install-dismiss').addEventListener('click', () => {flag.set(); installBanner();});
  window.addEventListener('beforeinstallprompt', () => setTimeout(installBanner, 0));
  window.addEventListener('appinstalled', installBanner);
  document.addEventListener('mayak-banners', installBanner);
}
