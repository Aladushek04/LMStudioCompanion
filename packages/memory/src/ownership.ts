import {createServer} from 'node:net';
import {createHash} from 'node:crypto';
import {open,rm} from 'node:fs/promises';
import {join} from 'node:path';

export async function acquireMemoryOwnership(directory:string):Promise<()=>Promise<void>> {
  const busy=()=>new Error('Хранилище памяти уже открыто другим владельцем.');
  if(process.platform!=='win32'){
    const file=join(directory,'.memory-lock');const handle=await open(file,'wx',0o600).catch(()=>{throw busy();});
    let closed=false;return async()=>{if(closed)return;closed=true;await handle.close();await rm(file,{force:true});};
  }
  const digest=createHash('sha256').update(directory.toLowerCase()).digest('hex');
  const server=createServer(socket=>socket.destroy());
  await new Promise<void>((resolve,reject)=>{server.once('error',()=>reject(busy()));server.listen('\\\\.\\pipe\\LMStudioCompanion-memory-'+digest,resolve);});
  let closed=false;return async()=>{if(closed)return;closed=true;await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));};
}
