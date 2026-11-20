// Только синтетический тон. Воспроизводит структуру Opus/MP4 MediaRecorder,
// без использования пользовательских записей или их байтов.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
function box(type,...parts){const body=Buffer.concat(parts),out=Buffer.alloc(8+body.length);out.writeUInt32BE(out.length);out.write(type,4);body.copy(out,8);return out;}
module.exports=function syntheticOpusMP4(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mayak-opus-fixture-')),file=path.join(dir,'tone.mp4');
 try{
  cp.execFileSync(require('../video-worker/node_modules/@ffmpeg-installer/ffmpeg').path,['-y','-nostdin','-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','3','-c:a','libopus','-strict','-2','-movflags','empty_moov+frag_keyframe+default_base_moof','-frag_duration','1000000','-f','mp4',file],{windowsHide:true});
  const data=fs.readFileSync(file),packets=JSON.parse(cp.execFileSync(require('../video-worker/node_modules/@ffprobe-installer/ffprobe').path,['-v','error','-show_packets','-of','json',file],{encoding:'utf8',windowsHide:true})).packets;
  const init=[];for(let p=0;p<data.length;){const size=data.readUInt32BE(p),type=data.toString('ascii',p+4,p+8);if(type==='ftyp'||type==='moov')init.push(data.subarray(p,p+size));p+=size;}
  const make=gap=>{
   let stamp=0;const fragments=[];
   for(let start=0;start<packets.length;start+=50){
    const group=packets.slice(start,start+50),tfhd=Buffer.alloc(12),tfdt=Buffer.alloc(12),trun=Buffer.alloc(12+group.length*8),mfhd=Buffer.alloc(8);
    tfhd.writeUInt32BE(0x020020);tfhd.writeUInt32BE(1,4);tfdt[0]=1;tfdt.writeBigUInt64BE(BigInt(stamp),4);trun.writeUInt32BE(0x301);trun.writeUInt32BE(group.length,4);mfhd.writeUInt32BE(start/50+1,4);
    const payload=[];
    group.forEach((packet,i)=>{const size=Number(packet.size),duration=960+(start===0&&i===0?gap*48000:0);trun.writeUInt32BE(duration,12+i*8);trun.writeUInt32BE(size,16+i*8);payload.push(data.subarray(Number(packet.pos),Number(packet.pos)+size));stamp+=duration;});
    let moof=box('moof',box('mfhd',mfhd),box('traf',box('tfhd',tfhd),box('tfdt',tfdt),box('trun',trun)));trun.writeUInt32BE(moof.length+8,8);
    moof=box('moof',box('mfhd',mfhd),box('traf',box('tfhd',tfhd),box('tfdt',tfdt),box('trun',trun)));fragments.push(moof,box('mdat',...payload));
   }
   return Buffer.concat([...init,...fragments]);
  };
  return {normal:make(0),broken:make(84),duration:packets.length*.02};
 }finally{if(path.dirname(dir)!==os.tmpdir()||!path.basename(dir).startsWith('mayak-opus-fixture-'))throw Error('Invalid temporary path');fs.rmSync(dir,{recursive:true,force:true});}
};
