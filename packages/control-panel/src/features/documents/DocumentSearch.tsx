import {useEffect,useRef,useState} from 'react';
import {request,ApiError} from '../../api.js';
import type {DocumentWorkspace,DocumentSearchResponse} from '../../../../documents/src/workspace-types.js';
import type {DocumentCitation} from '../../../../documents/src/retrieval-types.js';
import {FragmentPreview} from './DocumentPreview.js';

const labels={found:'Найдены фрагменты','no-matches':'Совпадений не найдено','budget-omitted':'Фрагменты не поместились','empty-scope':'Область пуста'};
export function DocumentSearch({workspace,token,question,onQuestion,sections,onSections,whole,onWhole}:{workspace:DocumentWorkspace;token:string;question:string;onQuestion:(value:string)=>void;sections:Record<string,string[]|null>;onSections:(value:Record<string,string[]|null>)=>void;whole:boolean;onWhole:(value:boolean)=>void}){
 const items=workspace.items.filter(i=>i.selected);
 const [result,setResult]=useState<DocumentSearchResponse|null>(null),[citation,setCitation]=useState<DocumentCitation|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const generation=useRef(0),controller=useRef<AbortController|null>(null),alive=useRef(true);
 useEffect(()=>()=>{alive.current=false;generation.current++;controller.current?.abort();},[]);
 function invalidate(){generation.current++;controller.current?.abort();controller.current=null;setBusy(false);setResult(null);setCitation(null);setError('');setNotice('');}
 async function run(){
  if(busy||!items.length)return;invalidate();const seq=generation.current,ctl=new AbortController();controller.current=ctl;setBusy(true);
  try{const next=await request<DocumentSearchResponse>(token,`/api/documents/${workspace.id}/search`,'POST',ctl.signal,{query:question,wholeDocument:whole,selection:items.map(i=>({documentId:i.id,revision:i.revision,contentHash:i.contentHash,version:i.version,sections:sections[i.id]??null}))});if(alive.current&&seq===generation.current)setResult(next);}
  catch(e){if(alive.current&&seq===generation.current&&!ctl.signal.aborted)setError(e instanceof ApiError?e.message:'Не удалось связаться с панелью. Повторите подбор.');}
  finally{if(alive.current&&seq===generation.current){setBusy(false);controller.current=null;}}
 }
 async function open(sourceId:string,chunkId:string){
  if(!result||busy)return;const seq=++generation.current,ctl=new AbortController();controller.current=ctl;setBusy(true);setError('');
  try{const opened=await request<DocumentCitation>(token,`/api/documents/${workspace.id}/searches/${result.result.searchId}/sources/${sourceId}/chunks/${chunkId}`,'GET',ctl.signal);if(alive.current&&seq===generation.current)setCitation(opened);}
  catch(e){if(alive.current&&seq===generation.current&&!ctl.signal.aborted){setCitation(null);setError(e instanceof ApiError?e.message:'Источник недоступен. Повторите подбор.');}}
  finally{if(alive.current&&seq===generation.current){setBusy(false);controller.current=null;}}
 }
 function choose(id:string,value:string[]|null){invalidate();onSections({...sections,[id]:value});}
 const found=result?.result;
 return <section className="document-search" aria-labelledby="document-search-heading">
  <h2 id="document-search-heading">Проверить подбор фрагментов</h2>
  <p className="document-hint">Проверка на уже загруженной модели, с пустой историей и резервом ответа. Результат ещё не отправляется в чат. Поиск сопоставляет слова: найденный фрагмент может не содержать ответа — проверьте источник.</p>
  {!items.length&&<p>Отметьте готовые файлы в списке, чтобы ограничить поиск.</p>}
  <form onSubmit={e=>{e.preventDefault();void run();}}>
   <label htmlFor="document-question">Вопрос к документам</label><textarea id="document-question" name="documentQuestion" rows={3} required maxLength={4096} value={question} onChange={e=>{invalidate();onQuestion(e.target.value);}}/>
   {items.map(item=><fieldset key={item.id}><legend>{item.name} · {item.id.slice(0,8)}</legend><label>Область {item.name}<select name={'scope-'+item.id} aria-label={'Область '+item.name} value={sections[item.id]===null||sections[item.id]===undefined?'whole':'sections'} onChange={e=>choose(item.id,e.target.value==='whole'?null:[])}><option value="whole">Весь извлечённый текст</option><option value="sections" disabled={!item.sections.length}>Выбрать текстовые разделы</option></select></label>
    {sections[item.id]!==null&&sections[item.id]!==undefined&&<div>{item.sections.map(section=><label className="document-selection" key={section.id}><input name={section.id} type="checkbox" checked={sections[item.id]!.includes(section.id)} onChange={e=>choose(item.id,e.target.checked?[...sections[item.id]!,section.id]:sections[item.id]!.filter(id=>id!==section.id))}/>{section.title}</label>)}</div>}
    <p className="document-hint">{item.sectionNotice??(item.sections.length?'Разделы определены по заголовкам извлечённого текста. Номера страниц PDF не определены.':'Распознаваемых заголовков нет. Доступен весь извлечённый текст; страницы PDF не определены.')}</p>
   </fieldset>)}
   <label className="document-selection"><input name="wholeDocument" type="checkbox" checked={whole} onChange={e=>{invalidate();onWhole(e.target.checked);}}/>Нужно изучить всю выбранную область</label>
   <div className="document-actions"><button className="primary" disabled={busy||!items.length}>Найти фрагменты</button>{busy&&<button className="secondary" type="button" onClick={()=>{invalidate();setNotice('Подбор отменён.');}}>Отменить подбор</button>}</div>
  </form>
  {error&&<p className="notice error" role="alert">{error}</p>}
  <p role="status">{busy?'Подбираем и измеряем фрагменты…':notice|| (found?labels[found.state]:'')}</p>
  {found&&<div className="document-search-results">
   <p className="document-hint">Найдено: {found.coverage.foundChunks}. Включено в проверяемый блок: {found.coverage.includedChunks}. Охвачено позиций текста: {found.coverage.includedChars} из {found.coverage.selectedChars}.</p>
   {found.notices.map(n=><p key={n} className="notice">{n}</p>)}
   <p className="document-hint">Модель: {result.modelIdentifier}. {found.budget.totalTokens===null?'Текстовый блок не подготовлен.':`Полный проверочный запрос: ${found.budget.totalTokens} токенов, предел с резервом: ${found.budget.limit}.`} История действующего чата здесь не учитывается.</p>
   {found.sources.flatMap(source=>source.chunks.map(chunk=>({source,chunk}))).map(({source,chunk},i)=><div className="document-fragment" key={chunk.id}><h3>{source.title} · фрагмент {i+1}</h3><p>{chunk.text.slice(0,200)}{chunk.text.length>200?'…':''}</p><button className="secondary" disabled={busy} onClick={()=>void open(source.id,chunk.id)}>Открыть фрагмент {i+1}</button></div>)}
  </div>}
  {citation&&<FragmentPreview data={citation} onClose={()=>setCitation(null)}/>}
 </section>;
}
