import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { pythonTransport } from '../../packages/lmstudio-plugin/src/web/python-transport.js';

const python=resolve('.tools/web-venv/Scripts/python.exe');
const options=(root:string)=>({python,root,searchUrl:'http://127.0.0.1:8088',browser:''});
it('subprocess reads UTF8 JSON and cancellation terminates it',async()=>{
  await access(python);
  const root=await mkdtemp(join(tmpdir(),'companion-bridge-'));
  try {
    await mkdir(join(root,'webtools'));
    await writeFile(join(root,'webtools','companion_bridge.py'),`import json,sys,time
r=json.load(sys.stdin)
if r['args'].get('slow'): time.sleep(30)
print(json.dumps({'text':'проверка','name':r['name']}))
`);
    const adapter=pythonTransport(options(root));
    expect(await adapter.call('read_page',{},new AbortController().signal)).toEqual({text:'проверка',name:'read_page'});
    const controller=new AbortController();
    const pending=adapter.call('read_page',{slow:true},controller.signal);
    setTimeout(()=>controller.abort(),150);
    await expect(pending).rejects.toThrow();
  } finally {await rm(root,{recursive:true,force:true});}
},10000);
it('missing Python yields a readable error without forwarding arbitrary stderr',async()=>{
  const adapter=pythonTransport({...options(process.cwd()),python:resolve('missing-python.exe')});
  await expect(adapter.call('read_page',{},new AbortController().signal)).rejects.toThrow('Python');
});
