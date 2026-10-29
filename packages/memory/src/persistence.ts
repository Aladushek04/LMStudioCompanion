import {createHash,randomUUID} from 'node:crypto';
import {lstat,open,readFile,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {snapshotSchema,type Snapshot} from './types.js';
export const MAX_BYTES=8*1024*1024;
const envelope=z.object({payload:snapshotSchema,checksum:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export function encodeSnapshot(snapshot:Snapshot):string{
  const payload=snapshotSchema.parse(snapshot);const encoded=JSON.stringify({payload,checksum:hash(JSON.stringify(payload))});
  if(Buffer.byteLength(encoded)>MAX_BYTES)throw new Error('Превышен размер хранилища памяти.');return encoded;
}
export function decodeSnapshot(encoded:string):Snapshot{
  if(Buffer.byteLength(encoded)>MAX_BYTES)throw new Error('Превышен размер снимка.');
  const parsed=envelope.parse(JSON.parse(encoded));
  if(hash(JSON.stringify(parsed.payload))!==parsed.checksum)throw new Error('Нарушена целостность снимка памяти.');return parsed.payload;
}
export async function readSnapshot(file:string):Promise<Snapshot>{
  const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>MAX_BYTES)throw new Error('Снимок памяти должен быть обычным ограниченным файлом без ссылок.');
  return decodeSnapshot(await readFile(file,'utf8'));
}
export async function writeSnapshot(directory:string,snapshot:Snapshot,beforeCommit?:()=>Promise<void>):Promise<void>{
  const content=encodeSnapshot(snapshot);const temporary=join(directory,`.memory-${randomUUID()}.tmp`);
  try{
    const handle=await open(temporary,'wx',0o600);
    try{await handle.writeFile(content,'utf8');await handle.sync();}finally{await handle.close();}
    await beforeCommit?.();
    await rename(temporary,join(directory,'memory.json'));
  }finally{await rm(temporary,{force:true}).catch(()=>undefined);}
}
export async function writeRollback(directory:string,snapshot:Snapshot):Promise<void>{
  const file=join(directory,`before-restore-${randomUUID()}.json`);const handle=await open(file,'wx',0o600);
  try{await handle.writeFile(encodeSnapshot(snapshot),'utf8');await handle.sync();}finally{await handle.close();}
}
