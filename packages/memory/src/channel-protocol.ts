import {createHmac,timingSafeEqual} from 'node:crypto';
import type {Socket} from 'node:net';
import {z} from 'zod';
export const descriptorSchema=z.object({version:z.literal(1),pipe:z.string().regex(/^\\\\\.\\pipe\\companion-memory-[a-f0-9]{32}$/),secret:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type Descriptor=z.infer<typeof descriptorSchema>;
export const candidateSchema=z.object({id:z.string().uuid(),revision:z.number().int().positive(),content:z.string().max(16000),pinned:z.boolean(),reason:z.string().max(100)}).strict();
export const refSchema=candidateSchema.pick({id:true,revision:true,reason:true});
export const requestSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('recall'),query:z.string().max(4096)}).strict(),
 z.object({action:z.literal('usage'),grant:z.string().uuid(),refs:z.array(refSchema).max(5)}).strict(),
]);
export const sign=(secret:string,text:string)=>createHmac('sha256',secret).update(text).digest('hex');
export function matches(a:string,b:string):boolean{return /^[a-f0-9]{64}$/.test(a)&&/^[a-f0-9]{64}$/.test(b)&&timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));}
// One bounded JSON frame at a time. Keep surplus bytes so fragmentation/coalescing is safe.
export function frames(socket:Socket){
 let buffer='';let waiting:{resolve:(v:unknown)=>void;reject:(e:Error)=>void}|null=null;let error:Error|null=null;
 const flush=()=>{if(!waiting)return;if(error){const w=waiting;waiting=null;w.reject(error);return;}const i=buffer.indexOf('\n');if(i<0)return;const line=buffer.slice(0,i);buffer=buffer.slice(i+1);const w=waiting;waiting=null;try{w.resolve(JSON.parse(line));}catch{w.reject(Error('Некорректный ответ канала памяти.'));}};
 socket.setEncoding('utf8');socket.on('data',chunk=>{buffer+=chunk;if(Buffer.byteLength(buffer)>400000){error=Error('Превышен размер сообщения памяти.');socket.destroy();}flush();});
 const fail=()=>{error=Error('Канал памяти недоступен. Откройте Companion и проверьте подключение.');flush();};socket.on('error',fail);socket.on('close',fail);socket.setTimeout(5000,()=>socket.destroy());
 return {read:()=>new Promise<unknown>((resolve,reject)=>{if(waiting){reject(Error('Параллельное чтение запрещено.'));return;}waiting={resolve,reject};flush();}),write:(v:unknown)=>socket.write(JSON.stringify(v)+'\n')};
}
