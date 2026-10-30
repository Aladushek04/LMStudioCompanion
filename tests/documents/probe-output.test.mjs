import {it,expect} from 'vitest';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,basename,resolve} from 'node:path';
import {persistProbeRun} from '../../scripts/documents-probe-output.mjs';

it('unsupported parsing replaces a prior success with current failure and skipped checks',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'companion-d0-output-')),path=join(dir,'result.json');
 try{
  await writeFile(path,JSON.stringify({checkedAt:'old',outcome:'complete',oldSuccess:true}));
  const report={checkedAt:'current',documents:[]};
  await persistProbeRun(path,report,async()=>{
   const running=JSON.parse(await readFile(path,'utf8'));
   expect(running).toMatchObject({checkedAt:'current',outcome:'running'});
   expect(running.oldSuccess).toBeUndefined();
   for(const name of ['harbor.txt','text.pdf','scan.pdf','broken.pdf'])report.documents.push({name,state:'error'});
   throw Error('Unsupported RPC getDocumentParsingLibrary');
  },['sameName','afterCreatorProcessExit']);
  const current=JSON.parse(await readFile(path,'utf8'));
  expect(current).toMatchObject({checkedAt:'current',outcome:'incomplete',error:'Unsupported RPC getDocumentParsingLibrary'});
  expect(current.documents).toHaveLength(4);
  expect(current.skippedChecks).toEqual(['sameName','afterCreatorProcessExit']);
  expect(current.oldSuccess).toBeUndefined();
 }finally{
  if(dirname(dir)!==resolve(tmpdir())||!basename(dir).startsWith('companion-d0-output-'))throw Error('Unexpected fixture cleanup path');
  await rm(dir,{recursive:true,force:true});
 }
});
