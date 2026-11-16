// Короткий сигнал и вибрация при новом сообщении в открытом чате.
import {prefs} from './core.js';

let audio = null;
// Браузеры разрешают звук только после касания экрана — вызывается на первое нажатие.
export function unlockAudio() {
  const Context = window.AudioContext || window.webkitAudioContext;
  if(!Context) return;
  try {if(!audio) audio = new Context(); if(audio.state === 'suspended') audio.resume().catch(() => {});} catch(_error) {}
}
export function ping() {
  if(prefs.get('sound','1') !== '1') return;
  try {
    if(navigator.vibrate) navigator.vibrate(40);
    if(!audio || audio.state !== 'running') return;
    const start = audio.currentTime, tone = audio.createOscillator(), gain = audio.createGain();
    tone.type = 'sine'; tone.frequency.setValueAtTime(880, start); tone.frequency.exponentialRampToValueAtTime(1320, start + .09);
    gain.gain.setValueAtTime(.0001, start); gain.gain.exponentialRampToValueAtTime(.12, start + .02); gain.gain.exponentialRampToValueAtTime(.0001, start + .28);
    tone.connect(gain); gain.connect(audio.destination); tone.start(start); tone.stop(start + .3);
  } catch(_error) {}
}
