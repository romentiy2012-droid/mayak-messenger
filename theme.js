/* Оформление: «терминал» (зелёный экран) — только на устройстве владельца чата — или обычное; у обычного — тема «как в телефоне», светлая или тёмная.
   Подключается до стилей, чтобы экран не мигал. */
(() => {
  'use strict';
  const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function get() {
    try {const value = localStorage.getItem('mayak.theme'); return value === 'light' || value === 'dark' ? value : 'auto';}
    catch(_error) {return 'auto';}
  }
  function skin() {
    // Терминал доступен только владельцу: отметку mayak.owner ставит приложение после входа.
    try {return localStorage.getItem('mayak.owner') === '1' && localStorage.getItem('mayak.skin') !== 'classic' ? 'terminal' : 'classic';}
    catch(_error) {return 'classic';}
  }
  function apply() {
    // Терминал всегда тёмный: он строится поверх тёмной темы.
    const terminal = skin() === 'terminal', choice = get(), dark = terminal || choice === 'dark' || (choice === 'auto' && !!media && media.matches);
    document.documentElement.dataset.skin = terminal ? 'terminal' : 'classic';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    const meta = document.querySelector('meta[name="theme-color"]');
    if(meta) meta.content = terminal ? '#040704' : dark ? '#131a17' : '#176d5d';
  }
  function setSkin(value) {
    try {localStorage.setItem('mayak.skin', value === 'classic' ? 'classic' : 'terminal');} catch(_error) {}
    apply();
  }
  function set(value) {
    try {if(value === 'auto') localStorage.removeItem('mayak.theme'); else localStorage.setItem('mayak.theme', value);} catch(_error) {}
    apply();
  }
  if(media) {if(media.addEventListener) media.addEventListener('change', apply); else if(media.addListener) media.addListener(apply);}
  window.MayakTheme = {get, set, apply, skin, setSkin};
  apply();
})();
