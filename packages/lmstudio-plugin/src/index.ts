import { type PluginContext, type PromptPreprocessorController, type ChatMessage } from '@lmstudio/sdk';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { configSchematics, globalConfigSchematics } from './config.js';
import { planWebAction } from '../../core/src/web/intent.js';
import { WebTurn } from './web/orchestrator.js';
import { pythonTransport } from './web/python-transport.js';
import { preprocessWeb } from './web/preprocessor.js';
import { abortable } from './web/cancellation.js';
import {memoryRequest,recallReply} from './memory/client.js';
import {injectMemories,type MemoryRef,type MemoryCandidate} from './memory/inject.js';

export async function preprocess(ctl: PromptPreprocessorController, message: ChatMessage) {
  const signal=AbortSignal.any([ctl.abortSignal,AbortSignal.timeout(120000)]);
  const wait=<T>(work:Promise<T>)=>abortable(work,signal);
  signal.throwIfAborted();
  const config = ctl.getPluginConfig(configSchematics); const selectedMode = config.get('webMode');
  const mode = selectedMode === 'auto' || selectedMode === 'research' ? selectedMode : 'off';
  const plan=planWebAction(message.getText(),mode),useMemory=config.get('useMemory')===true;
  if(plan.kind==='none'&&!useMemory)return message;
  const settings = ctl.getGlobalPluginConfig(globalConfigSchematics);
  const python=settings.get('python'), root=settings.get('webRoot');
  const status=ctl.createStatus({status:'loading',text:'Companion: проверяю веб-подключение…'});
  try {
    if(plan.kind!=='none'){
    if(!isAbsolute(python)||!isAbsolute(root))throw new Error('Укажите пути Python и веб-обработки в настройках Companion.');
    try { await wait(access(python)); } catch { signal.throwIfAborted(); throw new Error('Python не найден по указанному пути. Нужен полный путь, заканчивающийся на Scripts\\python.exe.'); }
    try { await wait(access(join(root,'webtools','companion_bridge.py'))); } catch { signal.throwIfAborted(); throw new Error('Не найдена веб-обработка. Нужна папка packages\\web-tools с файлом webtools\\companion_bridge.py.'); }
    }
    const source=await wait(ctl.tokenSource());
    if(!('countTokens' in source)||!('getContextLength' in source)||!('applyPromptTemplate' in source))throw new Error('Нужна локальная модель с поддержанным токенизатором.');
    const contextLength=await wait(source.getContextLength());
    const measure=async(text:string)=>{const history=await wait(ctl.pullHistory());const copy=message.asMutableCopy();copy.replaceText(text);history.append(copy);return wait(source.countTokens(await wait(source.applyPromptTemplate(history))));};
    const count=(text:string)=>wait(source.countTokens(text));
    let current=message,records:MemoryCandidate[]=[],grant='',memoryError='',memoryTokens=0,omitted=0;const refs:MemoryRef[]=[];
    if(useMemory){try{const r=recallReply.parse(await memoryRequest(settings.get('memoryLinkFile'),{action:'recall',query:message.getText().slice(0,4096)},signal));records=r.records;grant=r.grant;omitted=r.omitted;}catch{signal.throwIfAborted();memoryError='Память недоступна: откройте Companion и проверьте файл подключения. Записи не подставлены.';}}
    const inject=async(items:MemoryCandidate[])=>{const r=await injectMemories(current,items,{signal,contextLength,maxTokens:1024-memoryTokens,maxRecords:5-refs.length,measure,count});current=r.message;refs.push(...r.refs);memoryTokens+=r.tokens;};
    // Explicit source material has the first budget claim; pinned preferences precede supplemental search.
    if(plan.kind==='search')await inject(records.filter(r=>r.pinned));
    const visionModel='vision' in source && source.vision===true && 'identifier' in source ? source.identifier : '';
    const turn=new WebTurn({turnId:randomUUID(),chatScopeId:null,projectId:null,sessionId:null,mode:'auto',signal},{maxQueries:mode==='research'?10:1,maxPages:mode==='research'?6:3,maxRepairs:1,deadlineMs:90000},pythonTransport({python,root,searchUrl:settings.get('searchUrl'),browser:settings.get('browser'),visionModel}));
    if(plan.kind!=='none')current=await preprocessWeb(current,{
      mode,plan,showSources:config.get('showSources'),signal,contextLength,
      read:plan=>turn.run(plan),registry:turn.registry,
      measure,
      status:(text,failed)=>status.setState({status:failed?'error':'done',text}),
    });
    await inject(plan.kind==='search'?records.filter(r=>!r.pinned):records);
    if(grant)await memoryRequest(settings.get('memoryLinkFile'),{action:'usage',grant,refs},signal);
    signal.throwIfAborted();
    if(useMemory){const skipped=records.length-refs.length+omitted;const state={status:memoryError?'error' as const:'done' as const,text:memoryError||`Companion: в контекст передано записей: ${refs.length} (~${memoryTokens} токенов). Только общая память.`+(skipped?` Пропущено из найденных из-за лимитов: ${skipped}.`:'')+(refs.length?'\n'+refs.map(r=>`${r.id} · редакция ${r.revision} · ${r.reason}`).join('\n'):'')};if(plan.kind==='none')status.setState(state);else ctl.createStatus(state);}
    return current;
  } catch(error) {
    const text=ctl.abortSignal.aborted?'Веб-проверка отменена.':signal.aborted?'Истекло время веб-проверки.':error instanceof Error?error.message:'Веб-проверка не завершена.';
    status.setState({status:'error',text}); throw new Error(text);
  }
}
export async function main(context: PluginContext) {
  context.withConfigSchematics(configSchematics).withGlobalConfigSchematics(globalConfigSchematics).withPromptPreprocessor(preprocess);
}
