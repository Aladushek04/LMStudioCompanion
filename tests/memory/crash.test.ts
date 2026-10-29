import {it,expect} from 'vitest';
import {build} from 'esbuild';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {openMemoryStore} from '../../packages/memory/src/store.js';

it.skipIf(process.platform!=='win32')('OS releases crashed owner; kill before commit keeps old data and after commit keeps new data',async()=>{
  const root=await mkdtemp(join(tmpdir(),'companion-memory-crash-'));const directory=join(root,'data');await mkdir(directory);
  const childFile=join(root,'child.mjs');
  try{
    await build({entryPoints:[resolve('tests/memory/child-owner.ts')],bundle:true,platform:'node',format:'esm',target:'node22',outfile:childFile});
    const initial=await openMemoryStore(directory);
    expect((await initial.saveMemory({identityKey:'fixture',content:'INITIAL_FIXTURE',scope:'global',projectId:null,sessionId:null,source:'user'})).ok).toBe(true);await initial.close();
    for(const phase of ['before','after']){
      const child=spawn(process.execPath,[childFile,directory,phase],{windowsHide:true,stdio:['ignore','pipe','pipe']});
      const exited=once(child,'exit');
      try{
        await new Promise<void>((resolve,reject)=>{
          const timeout=setTimeout(()=>reject(Error('Child did not reach commit checkpoint')),5000);
          child.stdout.setEncoding('utf8');child.stdout.on('data',(s:string)=>{if(s.includes('READY')){clearTimeout(timeout);resolve();}});
          child.once('error',e=>{clearTimeout(timeout);reject(e);});child.once('exit',()=>{clearTimeout(timeout);reject(Error('Child exited before checkpoint'));});
        });
        await expect(openMemoryStore(directory)).rejects.toThrow();
      }finally{if(child.exitCode===null)child.kill('SIGKILL');await exited;}
      const recovered=await openMemoryStore(directory);
      try{expect((await recovered.listMemories())[0]?.content).toBe(phase==='before'?'INITIAL_FIXTURE':'COMMITTED_CHILD_FIXTURE');}finally{await recovered.close();}
    }
  }finally{await rm(root,{recursive:true,force:true});}
},15000);
