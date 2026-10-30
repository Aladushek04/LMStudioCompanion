import {createServer,type Server,type Socket} from 'node:net';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile,writeFile,rm,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {once} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {z} from 'zod';
import type {MemoryStore} from '../../memory/src/store.js';
import {prepareMemoryDirectory} from '../../memory/src/local-directory.js';
import {descriptorSchema,frames,sign,matches,requestSchema} from '../../memory/src/channel-protocol.js';
import {rankMemories} from '../../memory/src/retrieval.js';
import {UsageLog} from '../../memory/src/usage.js';
import type {ProposalQueue} from '../../memory/src/proposals.js';
const run=promisify(execFile);
async function protect(directory:string){
 await prepareMemoryDirectory(directory);
 if(process.platform!=='win32')throw Error('Подключение памяти C3 поддерживает Windows.');
 const shell=join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
 const script="$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=[System.Security.AccessControl.DirectorySecurity]::new(); $acl.SetAccessRuleProtection($true,$false); $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); [System.IO.Directory]::SetAccessControl($env:COMPANION_LINK_DIRECTORY,$acl); $actual=[System.IO.Directory]::GetAccessControl($env:COMPANION_LINK_DIRECTORY); if(-not $actual.AreAccessRulesProtected){throw 'ACL not protected'}; foreach($r in $actual.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){if($r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'Unexpected ACL'}}";
 await run(shell,['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:5000,maxBuffer:1024,env:{...process.env,COMPANION_LINK_DIRECTORY:directory}});
}
export function createMemoryChannel(directory:string,get:()=>Promise<MemoryStore>,proposals?:ProposalQueue){
 const file=join(directory,'connection.json'),marker=join(directory,'enabled.json');
 let server:Server|null=null,tail=Promise.resolve(),error='';const sockets=new Set<Socket>(),usage=new UsageLog();
 const grants=new Map<string,{at:number;records:Map<string,{revision:number;reason:string}>}>();
 const serial=(fn:()=>Promise<void>)=>{const op=tail.then(fn);tail=op.catch(()=>{});return op;};
 const close=async()=>{const s=server;server=null;for(const socket of sockets)socket.destroy();grants.clear();if(s)await new Promise<void>(resolve=>s.close(()=>resolve()));await rm(file,{force:true});};
 const enable=async()=>{
  if(server)return;await protect(directory);const secret=randomBytes(32).toString('hex'),pipe='\\\\.\\pipe\\companion-memory-'+randomBytes(16).toString('hex');
  const next=createServer(socket=>{
   if(sockets.size>=16){socket.destroy();return;}sockets.add(socket);socket.once('close',()=>sockets.delete(socket));const io=frames(socket);
   void(async()=>{try{
    const hello=z.object({nonce:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(await io.read());const nonce=randomBytes(32).toString('hex');
    io.write({nonce,proof:sign(secret,'server:'+hello.nonce+':'+nonce)});
    const envelope=z.object({request:requestSchema,proof:z.string()}).strict().parse(await io.read());
    if(!matches(envelope.proof,sign(secret,'client:'+nonce+':'+JSON.stringify(envelope.request))))throw Error('Authentication');
    const request=envelope.request;if(socket.destroyed)return;
    if(request.action==='capture'){if(!proposals)throw Error('Capture unavailable');const value=await proposals.capture(request.text,request.mode);if(!socket.destroyed){io.write({ok:true,value});socket.end();}return;}
    const store=await get();if(socket.destroyed)return;
    if(request.action==='recall'){
     const ranked=rankMemories(await store.listMemories({scope:'global'}),request.query).map(({id,revision,content,pinned,reason})=>({id,revision,content,pinned,reason}));
     let bytes=0;const records=ranked.filter(r=>{const size=Buffer.byteLength(JSON.stringify(r))+1;if(bytes+size>256000)return false;bytes+=size;return true;});
     for(const [key,g] of grants)if(Date.now()-g.at>150000)grants.delete(key);while(grants.size>=128)grants.delete(grants.keys().next().value!);
     const grant=randomUUID();grants.set(grant,{at:Date.now(),records:new Map(records.map(r=>[r.id,{revision:r.revision,reason:r.reason}]))});io.write({ok:true,value:{grant,records,omitted:ranked.length-records.length}});
    }else{
     const g=grants.get(request.grant);grants.delete(request.grant);if(!g||Date.now()-g.at>150000||new Set(request.refs.map(r=>r.id)).size!==request.refs.length)throw Error('Stale');
     const current=new Map((await store.listMemories({scope:'global'})).map(r=>[r.id,r]));
     for(const ref of request.refs)if(g.records.get(ref.id)?.revision!==ref.revision||g.records.get(ref.id)?.reason!==ref.reason||current.get(ref.id)?.revision!==ref.revision)throw Error('Stale');
     usage.record(request.refs);io.write({ok:true,value:null});
    }
    socket.end();
   }catch{if(!socket.destroyed){io.write({ok:false});socket.end();}}})();
  });
  try{
   next.listen({path:pipe,readableAll:false,writableAll:false});await once(next,'listening');server=next;
   for(const path of [file,marker]){try{const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)throw Error('Некорректный файл подключения.');await rm(path);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
   await writeFile(file,JSON.stringify(descriptorSchema.parse({version:1,pipe,secret})),{flag:'wx',mode:0o600});await writeFile(marker,'{"version":1}',{flag:'wx',mode:0o600});error='';
  }catch(e){await close();throw e;}
 };
 return {
  enable:()=>serial(enable),
  restore:()=>serial(async()=>{try{const s=await lstat(marker);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>100)throw Error('Некорректная настройка подключения.');if((await readFile(marker,'utf8'))!=='{"version":1}')throw Error('Некорректная настройка подключения.');await enable();}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')error='Подключение памяти не восстановлено. Включите его заново.';}}),
  disable:()=>serial(async()=>{await close();await rm(marker,{force:true});error='';}),close:()=>serial(close),
  status:()=>({enabled:server!==null,file,globalOnly:true,error,usage:usage.get()}),
 };
}
