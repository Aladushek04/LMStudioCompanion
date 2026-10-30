import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {MemoryRecord} from '../../packages/memory/src/types.js';
import {rankMemories} from '../../packages/memory/src/retrieval.js';
import {recallPairs} from '../fixtures/memory-recall-ru.js';
const record=(identityKey:string,content:string,patch:Partial<MemoryRecord>={}):MemoryRecord=>({id:randomUUID(),identityKey,content,category:'note',scope:'global',projectId:null,sessionId:null,source:'user',createdAt:0,updatedAt:0,revision:1,pinned:false,manualPriority:true,deletedAt:null,tags:[],confidence:1,lastAccessedAt:0,accessCount:0,supersedes:null,metadata:{},...patch});
it('retrieves at least eight of ten prelabelled Russian paraphrases in top five',()=>{
  const records=recallPairs.map(([id,text])=>record(id,text));
  expect(recallPairs.filter(([id,,q])=>rankMemories(records,q).slice(0,5).some(r=>r.identityKey===id))).toHaveLength(10);
});
it('filters scopes before ranking and recalls pinned preferences for a short query',()=>{
  const records=[record('general','Отвечай кратко',{pinned:true}),record('a','секрет',{scope:'project',projectId:'A'}),record('b','секрет',{scope:'project',projectId:'B'}),record('session','секрет',{scope:'session',sessionId:'S'}),record('deleted','секрет',{deletedAt:1})];
  expect(rankMemories(records,'?').map(r=>r.identityKey)).toEqual(['general']);
  expect(rankMemories(records,'секрет',{chatScopeId:'stable',projectId:'A',sessionId:null}).map(r=>r.identityKey)).toEqual(['general','a']);
  expect(rankMemories(records,'секрет',{chatScopeId:null,projectId:'A',sessionId:'S'}).map(r=>r.identityKey)).toEqual(['general']);
});
