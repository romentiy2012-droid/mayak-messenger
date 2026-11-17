import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import handler from './lib/handler.js';

export function createWorkerServer(){
 const server=createServer(async(req,res)=>{
  if(req.url!=='/api/process'){res.writeHead(404);res.end();return;}
  if(req.method==='POST'){
   try{
    const chunks=[];let size=0;
    for await(const chunk of req){size+=chunk.length;if(size>8192){res.writeHead(413);res.end();return;}chunks.push(chunk);}
    req.body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   }catch{res.writeHead(400);res.end();return;}
  }
  try{await handler(req,res);}catch{if(!res.headersSent)res.writeHead(500);res.end();}
 });
 server.requestTimeout=150000;server.headersTimeout=15000;
 return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const server=createWorkerServer();server.listen(Number(process.env.PORT||8080),'0.0.0.0');
 process.on('SIGTERM',()=>server.close());
}
