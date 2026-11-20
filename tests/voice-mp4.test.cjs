const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const modulePromise=import('data:text/javascript;base64,'+fs.readFileSync('js/voice-mp4.js').toString('base64'));
function box(type,...parts){const body=Buffer.concat(parts),out=Buffer.alloc(8+body.length);out.writeUInt32BE(out.length);out.write(type,4);body.copy(out,8);return out;}
function full(type,size,version=0){const data=Buffer.alloc(size);data[0]=version;return {data,box:()=>box(type,data)};}
function fixture({gap=84,gapAt=0,version=1,codec='Opus',samples=[Buffer.from([0x98,0]),Buffer.from([0x98,0]),Buffer.from([0x98,0])]}={}){
 const mv=full('mvhd',version?112:100,version),md=full('mdhd',version?36:24,version),tk=full('tkhd',version?96:84,version);
 mv.data.writeUInt32BE(1000,version?20:12);md.data.writeUInt32BE(48000,version?20:12);tk.data.writeUInt32BE(1,version?20:12);
 const hd=full('hdlr',24);hd.data.write('soun',8);const sd=full('stsd',8);sd.data.writeUInt32BE(1,4);
 const moov=box('moov',mv.box(),box('trak',tk.box(),box('mdia',md.box(),hd.box(),box('minf',box('stbl',box('stsd',sd.data,box(codec,Buffer.alloc(28))),box('stts',Buffer.alloc(8)))))));
 const fragments=[];let oldTime=0;
 for(let i=0;i<samples.length;i++){
  const tfhd=full('tfhd',12);tfhd.data.writeUInt32BE(0x020020);tfhd.data.writeUInt32BE(1,4);
  const tfdt=full('tfdt',version?12:8,version);if(version)tfdt.data.writeBigUInt64BE(BigInt(oldTime),4);else tfdt.data.writeUInt32BE(oldTime,4);
  const trun=full('trun',20);trun.data.writeUInt32BE(0x301);trun.data.writeUInt32BE(1,4);
  trun.data.writeUInt32BE(i===gapAt&&gap?gap*48000:960,12);trun.data.writeUInt32BE(samples[i].length,16);
  let moof=box('moof',box('traf',tfhd.box(),tfdt.box(),trun.box()));trun.data.writeUInt32BE(moof.length+8,8);moof=box('moof',box('traf',tfhd.box(),tfdt.box(),trun.box()));
  fragments.push(moof,box('mdat',samples[i]));oldTime+=i===gapAt&&gap?gap*48000:960;
 }
 return Buffer.concat([box('ftyp',Buffer.from('isom0000')),moov,...fragments]);
}
function array(bytes){return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);}
test('Opus MP4: repair first-packet gap with both time versions, keep payload, idempotence',async()=>{
 const {repairVoiceMP4}=await modulePromise;
 for(const version of [0,1]){
  const source=fixture({version}),result=repairVoiceMP4(array(source));assert.equal(result.repaired,true);assert.equal(result.duration,.06);
  const repaired=Buffer.from(result.bytes);assert.equal(repaired.length,source.length);
  // Only time fields change; Opus packets and their placement stay untouched.
  for(let p=0;p<source.length-8;p++)if(source.toString('ascii',p+4,p+8)==='mdat')assert.deepEqual(repaired.subarray(p,p+source.readUInt32BE(p)),source.subarray(p,p+source.readUInt32BE(p)));
  assert.equal(repairVoiceMP4(result.bytes).repaired,false,'second pass is unchanged');
 }
});
test('Opus MP4: leave valid AAC, ordinary Opus and unsupported/broken containers intact',async()=>{
 const {repairVoiceMP4}=await modulePromise;
 for(const data of [fixture({gap:0}),fixture({gapAt:1}),fixture({codec:'mp4a'}),Buffer.from('not MP4'),fixture().subarray(0,100),fixture({samples:[Buffer.from([0x9b,0])]})]){
  const input=array(data),result=repairVoiceMP4(input);assert.equal(result.repaired,false);assert.equal(result.bytes,input);
 }
});
