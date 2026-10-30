import {it,expect,afterEach} from 'vitest';
import {createDocumentWorkspaces,type DocumentsOptions} from '../../packages/host/src/document-workspaces.js';
const owners:ReturnType<typeof createDocumentWorkspaces>[]=[];
function start(options:DocumentsOptions={}){const owner=createDocumentWorkspaces({createSession:()=>({backend:{async parse(){return {text:'synthetic',parser:{library:'builtIn',version:'1'}};}},async close(){}}),...options});owners.push(owner);return owner;}
afterEach(async()=>{for(const owner of owners.splice(0))await owner.close();});
it('reserves slots and bytes before uploads, releases failed uploads and cannot commit twice',()=>{
 const o=start(),id=o.create().id,reservations=Array.from({length:5},()=>o.reserve(id,'x.txt',1));
 expect(()=>o.reserve(id,'x.txt',1)).toThrow('до 5 файлов');
 reservations[0]!.release();const r=o.reserve(id,'x.txt',1);expect(()=>r.commit(new Uint8Array(2))).toThrow('не завершена');r.release();
 for(const reservation of reservations)reservation.release();
 const first=o.reserve(id,'x.txt',1);first.commit(new Uint8Array([65]));expect(()=>first.commit(new Uint8Array([65]))).toThrow('изменился');
 const a=o.reserve(id,'a.pdf',8*1024*1024),b=o.reserve(id,'b.pdf',8*1024*1024);
 expect(()=>o.reserve(id,'c.pdf',4*1024*1024)).toThrow('20 MiB');a.release();b.release();
 expect(()=>o.reserve(id,'huge.pdf',8*1024*1024+1)).toThrow('8 MiB');
});
it('expired/deleted workspaces invalidate reservations and do not reappear',()=>{
 let now=0;const o=start({now:()=>now,idleMs:100}),id=o.create().id,r=o.reserve(id,'x.txt',1);
 now=101;expect(()=>o.snapshot(id)).toThrow('завершён');expect(()=>r.commit(new Uint8Array([65]))).toThrow('изменился');r.release();
 const next=o.create().id,late=o.reserve(next,'x.txt',1);o.remove(next);expect(()=>late.commit(new Uint8Array([65]))).toThrow('изменился');late.release();
});
it('cancelling queued work never calls parser; deleting active work never publishes late data',async()=>{
 let finish:(v:unknown)=>void=()=>{},calls=0;
 const o=start({createSession:()=>({backend:{parse(){calls++;return new Promise(r=>{finish=r;});}},async close(){}})}),id=o.create().id;
 o.reserve(id,'a.txt',1).commit(new Uint8Array([65]));o.reserve(id,'b.txt',1).commit(new Uint8Array([66]));
 await new Promise(r=>setTimeout(r,0));const [a,b]=o.snapshot(id).items;
 o.action(id,b!.id,'cancel',{revision:b!.revision});o.action(id,a!.id,'remove',{revision:a!.revision});
 finish({text:'late',parser:{library:'builtIn',version:'1'}});await new Promise(r=>setTimeout(r,10));
 expect(calls).toBe(1);expect(o.snapshot(id).items.map(i=>i.status)).toEqual(['cancelled']);expect(()=>o.preview(id,a!.id)).toThrow('убран');
});
it('publishes ready only after dedicated session teardown succeeds',async()=>{
 let rejectClose:(error:Error)=>void=()=>{};
 const o=start({createSession:()=>({backend:{async parse(){return {text:'synthetic',parser:{library:'builtIn',version:'1'}};}},close(){return new Promise((_,reject)=>{rejectClose=reject;});}})}),id=o.create().id;
 o.reserve(id,'a.txt',1).commit(new Uint8Array([65]));
 await new Promise(r=>setTimeout(r,10));const interim=o.snapshot(id).items[0]!.status;
 rejectClose(Error('private teardown failure'));await new Promise(r=>setTimeout(r,10));
 const item=o.snapshot(id).items[0]!;expect(interim).toBe('processing');expect(item.status).toBe('error');expect(item.version).toBe(null);expect(()=>o.preview(id,item.id)).toThrow('пока нет');
});
it('shows timeout before a non-cooperative raw call settles, but keeps the next attempt queued',async()=>{
 let finish:(v:unknown)=>void=()=>{},calls=0;
 const o=start({limits:{perFileTimeoutMs:10},createSession:()=>({backend:{parse(){calls++;return new Promise(r=>{finish=r;});}},async close(){}})}),id=o.create().id;
 o.reserve(id,'a.txt',1).commit(new Uint8Array([65]));await new Promise(r=>setTimeout(r,35));
 const timed=o.snapshot(id).items[0]!;const before=timed.status,code=timed.code;
 // Release even on the RED path, so teardown never hangs the test runner.
 if(before==='error')o.action(id,timed.id,'retry',{revision:timed.revision});
 const next=o.snapshot(id).items[0]!.status;finish({text:'late',parser:{library:'builtIn',version:'1'}});
 await new Promise(r=>setTimeout(r,0));if(calls>1)finish({text:'new',parser:{library:'builtIn',version:'1'}});
 expect(before).toBe('error');expect(code).toBe('TIMEOUT');expect(next).toBe('queued');
});
