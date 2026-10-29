import {openMemoryStore} from '../../packages/memory/src/store.js';
const [directory,phase]=process.argv.slice(2);
if(!directory)throw Error('Missing test directory');
const store=await openMemoryStore(directory,{beforeCommit:async()=>{
  if(phase==='before'){process.stdout.write('READY\n');await new Promise(()=>{});}
}});
const record=(await store.listMemories())[0]!;
const result=await store.updateMemory(record.id,{content:'COMMITTED_CHILD_FIXTURE'},record.revision);
if(!result.ok)throw Error(result.message);
process.stdout.write('READY\n');
