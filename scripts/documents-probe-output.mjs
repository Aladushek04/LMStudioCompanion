import {mkdir,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {probeError} from './documents-probe-error.mjs';

export async function persistProbeRun(path,report,operation,dependentChecks=[]){
 const persist=()=>writeFile(path,JSON.stringify(report,null,2)+'\n');
 await mkdir(dirname(path),{recursive:true});
 report.outcome='running';
 await persist(); // Invalidate an older success before any API work, even if this process is killed.
 try{await operation();report.outcome='complete';}
 catch(error){
  report.outcome='incomplete';report.error=probeError(error);
  report.skippedChecks=dependentChecks.filter(name=>!Object.hasOwn(report,name));
 }
 await persist();
 return report;
}
