// Chrome MediaRecorder может записать Opus в MP4 с временем первого пакета
// от старта устройства. Исправляем только доказанный разрыв таймлайна;
// сами Opus-пакеты, включая паузы и тихую речь, остаются побайтно прежними.
export function repairVoiceMP4(input) {
  const original = {bytes:input, duration:null, repaired:false};
  try {
    const view = new DataView(input), bytes = new Uint8Array(input);
    const u32 = p => view.getUint32(p), type = p => String.fromCharCode(...bytes.subarray(p + 4, p + 8));
    const u64 = p => u32(p) * 4294967296 + u32(p + 4);
    const boxes = (from, end) => {
      const found = [];
      for(let p = from; p < end;) {
        if(p + 8 > end) throw Error();
        let size = u32(p), header = 8;
        if(size === 1) {if(p + 16 > end) throw Error(); size = u64(p + 8); header = 16;}
        if(size === 0) size = end - p;
        if(!Number.isSafeInteger(size) || size < header || size > end - p) throw Error();
        found.push({p, end:p + size, body:p + header, type:type(p)}); p += size;
      }
      return found;
    };
    const children = box => boxes(box.body, box.end);
    const one = (list, name) => {const found = list.filter(box => box.type === name); if(found.length !== 1) throw Error(); return found[0];};
    const top = boxes(0, input.byteLength), moov = children(one(top, 'moov'));
    // Узкий формат MediaRecorder: один Opus audio track, без индексов/монтажных списков.
    if(top.some(b => ['sidx','mfra'].includes(b.type))) return original;
    const trak = children(one(moov, 'trak')); if(trak.some(b => b.type === 'edts')) return original;
    const mdia = children(one(trak, 'mdia')), hdlr = one(mdia, 'hdlr');
    if(type(hdlr.body + 4) !== 'soun') return original;
    const stbl = children(one(children(one(mdia, 'minf')), 'stbl')), stsd = one(stbl, 'stsd');
    if(u32(stsd.body + 4) !== 1 || type(stsd.body + 8) !== 'Opus') return original;
    if(u32(one(stbl, 'stts').body + 4) !== 0) return original;
    const mdhd = one(mdia, 'mdhd'), mdVersion = bytes[mdhd.body];
    if(mdVersion > 1) return original;
    const scale = u32(mdhd.body + (mdVersion === 1 ? 20 : 12)); if(scale !== 48000) return original;
    const tkhd = one(trak, 'tkhd'), trackId = u32(tkhd.body + (bytes[tkhd.body] === 1 ? 20 : 12));
    const changes = [], durations = [], fragments = top.filter(b => b.type === 'moof');
    let samples = 0, oldEnd = 0, broken = false;
    const packetSamples = (p, size) => {
      if(!size) throw Error(); const toc = bytes[p], mode = (toc >> 3) & 3;
      const frame = toc & 128 ? 120 << mode : (toc & 96) === 96 ? (toc & 8 ? 960 : 480) : mode === 3 ? 2880 : 480 << mode;
      const code = toc & 3, count = code === 0 ? 1 : code < 3 ? 2 : size > 1 ? bytes[p + 1] & 63 : 0;
      if(!count || frame * count > 5760) throw Error(); return frame * count;
    };
    for(const moof of fragments) {
      const traf = children(one(children(moof), 'traf')), tfhd = one(traf, 'tfhd'), tfdt = one(traf, 'tfdt');
      const tfFlags = u32(tfhd.body) & 0xffffff;
      if(!(tfFlags & 0x020000) || (tfFlags & 1) || u32(tfhd.body + 4) !== trackId) return original;
      const version = bytes[tfdt.body]; if(version > 1) return original;
      const stamp = version === 1 ? u64(tfdt.body + 4) : u32(tfdt.body + 4);
      // Не сжимаем разрывы между фрагментами: там может быть настоящая пауза.
      if(Math.abs(stamp - oldEnd) > scale / 4) return original;
      oldEnd = stamp;
      changes.push({p:tfdt.body + 4, value:samples, wide:version === 1});
      for(const run of traf.filter(b => b.type === 'trun')) {
        const flags = u32(run.body) & 0xffffff, count = u32(run.body + 4);
        if((flags & 0x301) !== 0x301 || count > input.byteLength / 2) return original;
        let p = run.body + 8, data = moof.p + view.getInt32(p); p += 4;
        if(flags & 4) p += 4;
        const mdat = top.find(b => b.type === 'mdat' && data >= b.body && data < b.end); if(!mdat) return original;
        for(let i = 0; i < count; i++) {
          const durationAt = p, declared = u32(p), size = u32(p + 4); p += 8;
          if(flags & 0x400) p += 4;
          if(flags & 0x800) {if(u32(p) !== 0) return original; p += 4;}
          if(p > run.end || data + size > mdat.end) return original;
          const actual = packetSamples(data, size);
          if(samples === 0 && declared - actual > scale) broken = true;
          else if(Math.abs(declared - actual) > scale / 4) return original;
          changes.push({p:durationAt, value:actual}); samples += actual; oldEnd += declared; data += size;
        }
        if(p !== run.end) return original;
      }
    }
    if(!fragments.length || !samples || !broken) return original;
    const duration = samples / scale;
    // Заголовки тоже должны описывать новую шкалу времени, иначе Safari сохраняет хвост.
    const mvhd = one(moov, 'mvhd'), mvVersion = bytes[mvhd.body]; if(mvVersion > 1) return original;
    const movieScale = u32(mvhd.body + (mvVersion === 1 ? 20 : 12)); if(!movieScale) return original;
    durations.push({p:mvhd.body + (mvVersion === 1 ? 24 : 16), value:Math.round(duration * movieScale), wide:mvVersion === 1});
    durations.push({p:mdhd.body + (mdVersion === 1 ? 24 : 16), value:samples, wide:mdVersion === 1});
    const tkVersion = bytes[tkhd.body]; if(tkVersion > 1) return original;
    durations.push({p:tkhd.body + (tkVersion === 1 ? 28 : 20), value:Math.round(duration * movieScale), wide:tkVersion === 1});
    const output = input.slice(0), out = new DataView(output);
    for(const edit of [...changes, ...durations]) {
      if(!Number.isSafeInteger(edit.value) || edit.value < 0 || (!edit.wide && edit.value > 0xffffffff)) return original;
      if(edit.wide) {out.setUint32(edit.p, Math.floor(edit.value / 4294967296)); out.setUint32(edit.p + 4, edit.value >>> 0);}
      else out.setUint32(edit.p, edit.value);
    }
    return {bytes:output, duration, repaired:true};
  } catch(_error) {return original;} // незнакомый/повреждённый контейнер не переписываем
}

export async function prepareVoicePlayback(blob) {
  if(!/audio\/(mp4|x-m4a)/i.test(blob.type)) return {blob, duration:null};
  const result = repairVoiceMP4(await blob.arrayBuffer());
  return {blob:result.repaired ? new Blob([result.bytes], {type:blob.type}) : blob, duration:result.duration};
}
