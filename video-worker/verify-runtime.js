// Runs in the production container at build time. Synthetic fixtures only; no network or credentials.
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {convertVideo} from './lib/convert.js';
const directory=await mkdtemp(join(tmpdir(),'mayak-runtime-check-'));
try{
 for(const format of ['webm','mp4']){
  const file=join(directory,'input.'+format);
  execFileSync(process.env.FFMPEG_PATH||'ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc=size=320x240:rate=15','-f','lavfi','-i','sine=frequency=660:sample_rate=48000','-t','1.2','-c:v',format==='webm'?'libvpx':'libx264','-pix_fmt','yuv420p','-c:a',format==='webm'?'libopus':'aac',file],{windowsHide:true});
  const result=await convertVideo(await readFile(file));
  assert.equal(result.meta.video,'h264');assert.equal(result.meta.audio,'aac');assert.equal(result.meta.w,480);assert.equal(result.meta.h,480);
  assert.ok(result.meta.duration>=1&&result.meta.duration<1.5);assert.ok(result.data.indexOf(Buffer.from('moov'))<result.data.indexOf(Buffer.from('mdat')));
  console.log('MAYAK_RUNTIME_CHECK '+format+' -> MP4/H264/AAC/480/faststart PASS');
 }
}finally{await rm(directory,{recursive:true,force:true});}
