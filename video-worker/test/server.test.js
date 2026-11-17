import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createWorkerServer} from '../server.js';

test('HTTP entrypoint restricts routes, JSON size and unauthenticated processing',async()=>{
 const server=createWorkerServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 try{
  const health=await fetch(base+'/api/process');assert.equal(health.status,200);assert.equal((await health.json()).service,'mayak-video');
  assert.equal((await fetch(base+'/other')).status,404);
  assert.equal((await fetch(base+'/api/process',{method:'POST',body:'{}'})).status,401);
  assert.equal((await fetch(base+'/api/process',{method:'POST',body:'bad'})).status,400);
  assert.equal((await fetch(base+'/api/process',{method:'POST',body:' '.repeat(8193)})).status,413);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
