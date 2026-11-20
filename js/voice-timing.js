// Проверяем всю дорожку, а не тишину во время прослушивания: паузы внутри речи остаются.
export function voiceTiming(buffer) {
  const duration = buffer.duration;
  if(!Number.isFinite(duration) || duration <= 0) return null;
  let last = -1;
  for(let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    // Почти цифровой ноль (-100 dB): тихую речь и обычный фон не отсекаем.
    for(let index = samples.length - 1; index > last; index--) {
      if(Math.abs(samples[index]) > .00001) {last = index; break;}
    }
  }
  const audibleEnd = (last + 1) / buffer.sampleRate;
  // Убираем только длинный пустой хвост, оставляя четверть секунды после последнего звука.
  // Для полностью беззвучной записи сохраняем длительность: надёжной границы речи нет.
  const end = last >= 0 && duration - audibleEnd >= 3 ? Math.min(duration, audibleEnd + .25) : duration;
  return {duration, end};
}

export async function analyseVoice(blob) {
  const Context = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if(!Context) return null;
  try {
    // Низкая частота нужна только для поиска конца; воспроизводится исходный файл.
    const context = new Context(1, 1, 8000);
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    return voiceTiming(buffer);
  } catch(_error) {return null;} // неподдерживаемый декодер не мешает обычному плееру
}
