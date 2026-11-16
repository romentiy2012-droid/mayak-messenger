/* Тема оформления: «как в телефоне», светлая или тёмная. Подключается до стилей, чтобы экран не мигал. */
(() => {
  'use strict';
  const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function get() {
    try {const value = localStorage.getItem('mayak.theme'); return value === 'light' || value === 'dark' ? value : 'auto';}
    catch(_error) {return 'auto';}
  }
  function apply() {
    const choice = get(), dark = choice === 'dark' || (choice === 'auto' && !!media && media.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    const meta = document.querySelector('meta[name="theme-color"]');
    if(meta) meta.content = dark ? '#003535' : '#008080';
  }
  function set(value) {
    try {if(value === 'auto') localStorage.removeItem('mayak.theme'); else localStorage.setItem('mayak.theme', value);} catch(_error) {}
    apply();
  }
  if(media) {if(media.addEventListener) media.addEventListener('change', apply); else if(media.addListener) media.addListener(apply);}
  window.MayakTheme = {get, set, apply};
  apply();
})();
