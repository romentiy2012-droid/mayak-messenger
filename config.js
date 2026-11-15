// Public client settings only. Never add secret or service_role keys.
window.MAYAK_CONFIG = Object.freeze({
  supabaseURL: 'https://jqmkjwsptxhovfxngqiy.supabase.co',
  supabasePublishableKey: 'sb_publishable_TusOHNjTyq4TghCA6ZpTvg_WXLjUoak',
  // Публичный VAPID-ключ Web Push. Приватный хранится только в секретах Supabase.
  vapidPublicKey: 'BAC86tHcPhoq4UDXlrSMPGyKlP4sUC6ufrOArHxPGKWAagqwVwcuXX2PsQ_BsKnBkdGwSvF11wqcP31Jj0AOavM'
});
