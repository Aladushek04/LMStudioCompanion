import { spawn, execFile } from 'node:child_process';
import type { WebAdapter } from './orchestrator.js';
export class WebTransportError extends Error {}

export interface PythonTransportOptions { python: string; root: string; searchUrl: string; browser: string; visionModel?: string }
/** Own read-only backend, independent of user's MCP configuration. */
export function pythonTransport(options: PythonTransportOptions): WebAdapter {
  return {
    report: {lmStudioVersion:'runtime',checkedAt:new Date().toISOString(),features:{webTransport:{state:'verified',evidence:'Own subprocess transport; schema_version=2 validated by WebTurn. Not an SDK tools session.'}}},
    call: (name,args,signal) => new Promise((resolve,reject) => {
      signal.throwIfAborted();
      const child = spawn(options.python, ['-m','webtools.companion_bridge'], {cwd:options.root,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONUTF8:'1'}});
      let output = ''; let bytes = 0; let failure = false;
      const stop = () => {
        failure = true;
        if (child.exitCode === null && child.pid) {
          if (process.platform === 'win32') execFile('taskkill.exe',['/pid',String(child.pid),'/t','/f'],{windowsHide:true},()=>undefined);
          else child.kill('SIGKILL');
        }
      };
      const timeout = setTimeout(stop,65000);
      signal.addEventListener('abort',stop,{once:true});
      child.stdout.setEncoding('utf8');
      child.stdout.on('data',(part: string)=>{bytes+=Buffer.byteLength(part);if(bytes>1_048_576)stop();else output+=part;});
      let diagnostic='';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data',(part: string)=>{diagnostic=(diagnostic+part).slice(-4096);});
      child.on('error',(error: NodeJS.ErrnoException)=>{clearTimeout(timeout);signal.removeEventListener('abort',stop);reject(new WebTransportError(`Не удалось запустить Python (${error.code ?? 'unknown'}). Проверьте путь Python.`));});
      child.on('close',(code)=>{
        clearTimeout(timeout);signal.removeEventListener('abort',stop);
        if(failure||signal.aborted||code!==0)reject(new WebTransportError(diagnostic.includes('No module named')?'В окружении Python не найдены зависимости или модуль webtools.':`Веб-обработка недоступна (код ${code ?? 'signal'}).`));
        else {try{resolve(JSON.parse(output));}catch{reject(new Error('Некорректный результат веб-обработки.'));}}
      });
      child.stdin.on('error',()=>undefined);
      child.stdin.end(JSON.stringify({name,args,search_url:options.searchUrl,browser:options.browser,vision_model:options.visionModel}));
      if(signal.aborted)stop();
    }),
  };
}
