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

export async function preprocess(ctl: PromptPreprocessorController, message: ChatMessage) {
  const signal=AbortSignal.any([ctl.abortSignal,AbortSignal.timeout(120000)]);
  const wait=<T>(work:Promise<T>)=>abortable(work,signal);
  signal.throwIfAborted();
  const config = ctl.getPluginConfig(configSchematics); const selectedMode = config.get('webMode');
  const mode = selectedMode === 'auto' || selectedMode === 'research' ? selectedMode : 'off';
  if(planWebAction(message.getText(),mode).kind==='none')return message;
  const settings = ctl.getGlobalPluginConfig(globalConfigSchematics);
  const python=settings.get('python'), root=settings.get('webRoot');
  const status=ctl.createStatus({status:'loading',text:'Companion: проверяю веб-подключение…'});
  try {
    if(!isAbsolute(python)||!isAbsolute(root))throw new Error('Укажите пути Python и веб-обработки в настройках Companion.');
    try { await wait(access(python)); } catch { signal.throwIfAborted(); throw new Error('Python не найден по указанному пути. Нужен полный путь, заканчивающийся на Scripts\\python.exe.'); }
    try { await wait(access(join(root,'webtools','companion_bridge.py'))); } catch { signal.throwIfAborted(); throw new Error('Не найдена веб-обработка. Нужна папка packages\\web-tools с файлом webtools\\companion_bridge.py.'); }
    const source=await wait(ctl.tokenSource());
    if(!('countTokens' in source)||!('getContextLength' in source)||!('applyPromptTemplate' in source))throw new Error('Нужна локальная модель с поддержанным токенизатором.');
    const visionModel='vision' in source && source.vision===true && 'identifier' in source ? source.identifier : '';
    const turn=new WebTurn({turnId:randomUUID(),chatScopeId:null,projectId:null,sessionId:null,mode:'auto',signal},{maxQueries:mode==='research'?10:1,maxPages:mode==='research'?6:3,maxRepairs:1,deadlineMs:90000},pythonTransport({python,root,searchUrl:settings.get('searchUrl'),browser:settings.get('browser'),visionModel}));
    return await preprocessWeb(message,{
      mode,showSources:config.get('showSources'),signal,contextLength:await wait(source.getContextLength()),
      read:plan=>turn.run(plan),registry:turn.registry,
      measure:async text=>{const history=await wait(ctl.pullHistory());const copy=message.asMutableCopy();copy.replaceText(text);history.append(copy);return wait(source.countTokens(await wait(source.applyPromptTemplate(history))));},
      status:(text,failed)=>status.setState({status:failed?'error':'done',text}),
    });
  } catch(error) {
    const text=ctl.abortSignal.aborted?'Веб-проверка отменена.':signal.aborted?'Истекло время веб-проверки.':error instanceof Error?error.message:'Веб-проверка не завершена.';
    status.setState({status:'error',text}); throw new Error(text);
  }
}
export async function main(context: PluginContext) {
  context.withConfigSchematics(configSchematics).withGlobalConfigSchematics(globalConfigSchematics).withPromptPreprocessor(preprocess);
}
