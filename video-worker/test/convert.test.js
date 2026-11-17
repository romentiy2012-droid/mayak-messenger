import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import ffmpeg from '@ffmpeg-installer/ffmpeg';
import {convertVideo} from '../lib/convert.js';
import handler,{validateJob} from '../lib/handler.js';

test('real WebM and MP4 convert to square H.264/AAC faststart MP4',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'mayak-video-test-'));
 try{
  for(const variant of ['webm','mp4','mp4-fullrange']){
   const format=variant==='webm'?'webm':'mp4',file=join(directory,variant+'.'+format);
   execFileSync(ffmpeg.path,['-nostdin','-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc=size=320x240:rate=15','-f','lavfi','-i','sine=frequency=660:sample_rate=48000','-t','1.2','-c:v',format==='webm'?'libvpx':'libx264','-pix_fmt','yuv420p',...(variant==='mp4-fullrange'?['-color_range','pc']:[]),'-c:a',format==='webm'?'libopus':'aac',file],{windowsHide:true});
   const result=await convertVideo(await readFile(file));
   assert.equal(result.meta.video,'h264');assert.equal(result.meta.audio,'aac');
   assert.equal(result.meta.pix_fmt,'yuv420p');
   // Legacy local FFprobe omits implicit limited range; production verify-runtime requires tv explicitly.
   assert.ok(!result.meta.color_range||result.meta.color_range==='tv');
   assert.equal(result.meta.w,480);assert.equal(result.meta.h,480);assert.ok(result.meta.duration>=1&&result.meta.duration<1.5);
   assert.ok(result.data.indexOf(Buffer.from('moov'))<result.data.indexOf(Buffer.from('mdat')));
  }
  await assert.rejects(convertVideo(Buffer.from('not a video')));
  await assert.rejects(convertVideo(Buffer.alloc(16*1024*1024+1)));
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('worker rejects arbitrary hosts, paths, schemes, redirects and unauthenticated processing',async()=>{
 const id='00000000-0000-4000-8000-000000000001',ticket='00000000-0000-4000-8000-000000000002';
 const base='https://cfzzxkmctwrclhphqslr.supabase.co',output=id+'/'+id+'_'+ticket+'.mp4';
 const job={id,ticket,output,source:base+'/storage/v1/object/sign/mayak-video-source/'+id+'/sample.webm?token=test',target:base+'/storage/v1/object/upload/sign/mayak-video/'+output+'?token=test'};
 assert.ok(validateJob(job,base));
 assert.throws(()=>validateJob({...job,source:'https://evil.example/video'},base));
 assert.throws(()=>validateJob({...job,target:base+'/storage/v1/object/upload/sign/mayak/other.mp4'},base));
 assert.throws(()=>validateJob({...job,source:job.source.replace('https:','http:')},base));
 const response={statusCode:0,setHeader(){},end(){}};
 await handler({method:'POST',headers:{},body:job},response);assert.equal(response.statusCode,401);
});
