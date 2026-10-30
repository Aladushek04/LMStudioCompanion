import {connect} from 'node:net';
import {lstat,readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {randomBytes} from 'node:crypto';
import {z} from 'zod';
import {descriptorSchema,frames,sign,matches,candidateSchema,requestSchema} from '../../../memory/src/channel-protocol.js';
import {abortable} from '../web/cancellation.js';
export async function memoryRequest(file:string,input:z.infer<typeof requestSchema>,signal:AbortSignal):Promise<unknown>{
 signal.throwIfAborted();if(!isAbsolute(file))throw Error('Укажите файл подключения памяти из панели Companion.');
 const stat=await abortable(lstat(file),signal);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>4096)throw Error('Некорректный файл подключения памяти.');
 const d=descriptorSchema.parse(JSON.parse(await abortable(readFile(file,'utf8'),signal)));
 const socket=connect(d.pipe),io=frames(socket);const abort=()=>socket.destroy();signal.addEventListener('abort',abort,{once:true});
 try{
  const nonce=randomBytes(32).toString('hex');io.write({nonce});
  const hello=z.object({nonce:z.string().regex(/^[a-f0-9]{64}$/),proof:z.string()}).strict().parse(await abortable(io.read(),signal));
  if(!matches(hello.proof,sign(d.secret,'server:'+nonce+':'+hello.nonce)))throw Error('Владелец памяти не подтверждён.');
  const request=requestSchema.parse(input);io.write({request,proof:sign(d.secret,'client:'+hello.nonce+':'+JSON.stringify(request))});
  const reply=z.object({ok:z.boolean(),value:z.unknown().optional()}).strict().parse(await abortable(io.read(),signal));
  if(!reply.ok)throw Error('Память изменилась или подключение отклонено. Повторите запрос.');return reply.value;
 }finally{signal.removeEventListener('abort',abort);socket.destroy();}
}
export const recallReply=z.object({grant:z.string().uuid(),records:z.array(candidateSchema).max(20),omitted:z.number().int().min(0).max(20)}).strict();
