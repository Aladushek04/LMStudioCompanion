import {isAbsolute,win32,dirname,join,parse} from 'node:path';
import {mkdir,lstat,realpath} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
/** Directory syntax is checked before touching the filesystem. */
export function assertLocalDirectorySyntax(directory:string):void {
  if(!isAbsolute(directory)||(process.platform==='win32'&&!/^[a-z]:\\/i.test(win32.normalize(directory))))throw new Error('Нужен отдельный абсолютный локальный каталог памяти.');
}
export function assertLocalWindowsDriveType(type:number):void {
  // System.IO.DriveType: Removable=2, Fixed=3, RAM=6; network/unknown fail closed.
  if(![2,3,6].includes(type))throw new Error('Хранилище памяти требует подтверждённый локальный диск. Сетевые диски не поддерживаются.');
}
const run=promisify(execFile);
export async function prepareMemoryDirectory(directory:string):Promise<string>{
  assertLocalDirectorySyntax(directory);
  const verified=new Set<string>();
  const verify=async(path:string)=>{
    assertLocalDirectorySyntax(path);
    if(process.platform==='win32'){
      const root=parse(path).root.toUpperCase();if(verified.has(root))return;
      const shell=join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
      const result=await run(shell,['-NoProfile','-NonInteractive','-Command',"[int]([System.IO.DriveInfo]::new($env:COMPANION_MEMORY_DRIVE_ROOT).DriveType)"],{windowsHide:true,timeout:5000,maxBuffer:1024,env:{...process.env,COMPANION_MEMORY_DRIVE_ROOT:root}});
      assertLocalWindowsDriveType(Number(result.stdout.trim()));verified.add(root);
    }
  };
  await verify(directory);
  // Resolve the nearest existing ancestor before mkdir, catching remote junctions.
  let ancestor=directory;
  while(true){try{await lstat(ancestor);break;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const parent=dirname(ancestor);if(parent===ancestor)throw error;ancestor=parent;}}
  await verify(await realpath(ancestor));
  await mkdir(directory,{recursive:true});
  const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Каталог памяти не должен быть ссылкой.');
  const canonical=await realpath(directory);await verify(canonical);return canonical;
}
