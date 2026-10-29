import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ChatMessage} from '@lmstudio/sdk';
import {it,expect} from 'vitest';
import {preprocess} from '../../packages/lmstudio-plugin/src/index.js';
it('native cancellation reports a Russian reason even when SDK operation never finishes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'companion-native-cancel-'));
  try {
    await mkdir(join(root,'webtools'));await writeFile(join(root,'webtools/companion_bridge.py'),'');
    const python=join(root,'python.exe');await writeFile(python,'');
    const controller=new AbortController();
    const ctl={abortSignal:controller.signal,getPluginConfig:()=>({get:()=> 'auto'}),getGlobalPluginConfig:()=>({get:(key:string)=>key==='python'?python:root}),createStatus:()=>({setState:()=>{}}),tokenSource:()=>new Promise(()=>{})};
    const pending=preprocess(ctl as never,ChatMessage.create('user','Прочитай https://example.org/'));
    setTimeout(()=>controller.abort(),30);
    await expect(pending).rejects.toThrow('Веб-проверка отменена.');
  }finally{await rm(root,{recursive:true,force:true});}
});
