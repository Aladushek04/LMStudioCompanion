import {useEffect,useRef,useState} from 'react';
import {request,uploadDocument,ApiError} from '../../api.js';
import type {DocumentItem,DocumentWorkspace,DocumentPreviewData} from '../../../../documents/src/workspace-types.js';
import {DocumentPreview} from './DocumentPreview.js';
import './documents.css';

const labels:Record<DocumentItem['status'],string>={queued:'Ожидает очереди',processing:'Обрабатывается',ready:'Готов',unreadable:'Текст не извлечён',error:'Ошибка',cancelled:'Отменено'};
const storageKey='companion-document-workspace';
export function Documents({token}:{token:string}){
 const [workspace,setWorkspace]=useState<DocumentWorkspace|null>(null),[files,setFiles]=useState<File[]>([]),[busy,setBusy]=useState(false),[uploading,setUploading]=useState(false);
 const [error,setError]=useState(''),[notice,setNotice]=useState(''),[preview,setPreview]=useState<DocumentPreviewData|null>(null);
 const [initialized,setInitialized]=useState(false);
 const active=useRef(true),operation=useRef(false),current=useRef<DocumentWorkspace|null>(null),input=useRef<HTMLInputElement>(null),upload=useRef<AbortController|null>(null),lifetime=useRef(new AbortController()),generation=useRef(0);
 const lease=useRef<{id:string;release:()=>void}|null>(null);
 async function claim(id:string){
  lease.current?.release();lease.current=null;
  if(!navigator.locks)return false;
  return new Promise<boolean>((resolve,reject)=>{
   void navigator.locks.request('companion-documents:'+id,{ifAvailable:true},async lock=>{
    if(!lock||!active.current){resolve(false);return;}
    await new Promise<void>(release=>{lease.current={id,release};resolve(true);});
   }).catch(reject);
  });
 }
 function apply(next:DocumentWorkspace){if(!active.current)return;current.current=next;setWorkspace(next);setPreview(old=>old&&next.items.some(i=>i.id===old.item.id&&i.status==='ready'&&i.version===old.document.version)?old:null);}
 function reset(){lease.current?.release();lease.current=null;sessionStorage.removeItem(storageKey);current.current=null;if(active.current){setWorkspace(null);setPreview(null);setInitialized(true);}}
 async function create(){const next=await request<DocumentWorkspace>(token,'/api/documents','POST',lifetime.current.signal,{});if(active.current){const claimed=await claim(next.id);if(navigator.locks&&!claimed)throw Error('Не удалось открыть отдельный набор.');if(claimed)sessionStorage.setItem(storageKey,next.id);else{sessionStorage.removeItem(storageKey);setNotice('Браузер не поддерживает восстановление набора: после обновления страницы файлы нужно добавить заново.');}apply(next);}return next;}
 async function refresh(){
  const seq=++generation.current,id=current.current?.id??sessionStorage.getItem(storageKey);
  if(!id){if(active.current)setInitialized(true);return;}
  if(!current.current&&lease.current?.id!==id&&!await claim(id)){reset();setNotice('Для этой вкладки открыт отдельный пустой набор.');return;}
  try{const next=await request<DocumentWorkspace>(token,'/api/documents/'+id,'GET',lifetime.current.signal);if(seq===generation.current){apply(next);if(active.current)setInitialized(true);}}
  catch(e){if(!active.current||seq!==generation.current||(current.current&&current.current.id!==id))return;if(e instanceof ApiError&&e.status===404){reset();setNotice('Прежний рабочий набор завершён. Добавьте нужные файлы заново.');}else throw e;}
 }
 function failure(e:unknown){if(active.current)setError(e instanceof ApiError?e.message:'Связь с локальным сервисом прервана. Обновите список перед повтором.');}
 useEffect(()=>{
  active.current=true;operation.current=true;
  // A fresh navigation may inherit another tab's sessionStorage. Only reload/history
  // restoration can resume its ID; a copied new navigation starts with an empty set.
  const navigation=performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming|undefined;
  if(navigation?.type==='navigate')sessionStorage.removeItem(storageKey);
  void refresh().catch(failure).finally(()=>{operation.current=false;});
  const timer=setInterval(()=>{if(!operation.current&&document.visibilityState==='visible')void refresh().catch(failure);},1000);
  return()=>{active.current=false;clearInterval(timer);lease.current?.release();lifetime.current.abort();upload.current?.abort();};
 },[]);
 async function mutate(action:()=>Promise<void>){
  if(operation.current)return;operation.current=true;++generation.current;setBusy(true);setError('');setNotice('');
  try{await action();}catch(e){failure(e);try{await refresh();}catch{/* Keep the first actionable error. */}}
  finally{operation.current=false;if(active.current)setBusy(false);}
 }
 async function add(){
  if(!files.length)return;
  const items=current.current?.items??[],used=items.reduce((sum,i)=>sum+i.sizeBytes,0);
  if(files.length+items.length>5||files.some(f=>f.size>8*1024*1024)||used+files.reduce((sum,f)=>sum+f.size,0)>20*1024*1024){setError('Допустимо до 5 файлов, до 8 MiB на файл и до 20 MiB в наборе.');return;}
  if(files.some(f=>!(/\.(txt|pdf)$/i.test(f.name)))){setError('Выберите TXT в UTF-8 или PDF.');return;}
  await mutate(async()=>{
   if(!current.current)await create();if(!active.current)return;
   const controller=new AbortController();upload.current=controller;setUploading(true);
   try{for(const file of files){const next=await uploadDocument<DocumentWorkspace>(token,current.current!.id,file,AbortSignal.any([controller.signal,lifetime.current.signal]));apply(next);}setFiles([]);if(input.current)input.current.value='';setNotice('Файлы добавлены. Состояние обработки обновляется автоматически.');}
   catch(e){if(controller.signal.aborted)setNotice('Загрузка отменена. Уже добавленные файлы остались в списке.');else throw e;}
   finally{upload.current=null;if(active.current)setUploading(false);await refresh();}
  });
 }
 function action(item:DocumentItem,kind:'select'|'cancel'|'retry'|'remove',selected?:boolean){void mutate(async()=>{apply(await request<DocumentWorkspace>(token,`/api/documents/${current.current!.id}/items/${item.id}${kind==='remove'?'':'/'+kind}`,kind==='remove'?'DELETE':'POST',lifetime.current.signal,{revision:item.revision,...(kind==='select'?{selected}: {})}));if(kind==='remove')setNotice('Файл убран из списка. Оригинал на диске сохранён.');});}
 function show(item:DocumentItem){void mutate(async()=>{const data=await request<DocumentPreviewData>(token,`/api/documents/${current.current!.id}/items/${item.id}/text`,'GET',lifetime.current.signal);if(active.current)setPreview(data);});}
 const selected=workspace?.items.filter(i=>i.selected).length??0;
 return <section className="documents" aria-label="Работа с документами">
  <div className="notice">Этот набор временный и относится только к этой вкладке. Выбор ещё не отправляется в чат. После перезапуска панели или 30 минут без обращений файлы нужно добавить заново.</div>
  <form className="document-upload" onSubmit={e=>{e.preventDefault();void add();}}>
   <label htmlFor="document-files">Файлы TXT или PDF</label>
   <p id="document-limits" className="document-hint">До 5 файлов, до 8 MiB каждый и 20 MiB вместе. TXT — в UTF-8. Для сканов нужен OCR, он пока недоступен. Оригиналы файлов не изменяются.</p>
   <input ref={input} id="document-files" name="documents" type="file" accept=".txt,.pdf,text/plain,application/pdf" multiple required disabled={busy||!initialized} aria-describedby="document-limits" onChange={e=>{setFiles(Array.from(e.target.files??[]));setError('');}}/>
   <div className="document-actions"><button className="primary" disabled={busy||!initialized}>Добавить файлы</button>{uploading&&<button type="button" className="secondary" onClick={()=>upload.current?.abort()}>Отменить загрузку</button>}</div>
  </form>
  {error&&<div className="notice error" role="alert">{error}</div>}
  <p role="status">{uploading?'Передаём выбранные файлы…':notice} {initialized?`Файлов: ${workspace?.items.length??0}. Готово: ${workspace?.items.filter(i=>i.status==='ready').length??0}. В очереди или обработке: ${workspace?.items.filter(i=>['queued','processing'].includes(i.status)).length??0}. Выбрано: ${selected}. В чат не отправлено.`:'Открываем рабочий набор…'}</p>
  <div className="document-actions"><button className="secondary" disabled={busy} onClick={()=>void mutate(async()=>{await refresh();})}>Обновить документы</button><button className="secondary" disabled={busy||!workspace} onClick={()=>void mutate(async()=>{await request(token,'/api/documents/'+current.current!.id,'DELETE',lifetime.current.signal,{});reset();setNotice('Список очищен. Оригиналы файлов сохранены.');})}>Очистить список</button></div>
  {initialized&&!workspace?.items.length&&<p>Файлов пока нет.</p>}
  <div className="document-list">{workspace?.items.map(item=><article key={item.id} className="document-card" aria-labelledby={'document-name-'+item.id}>
   <div className="document-card-top"><h2 id={'document-name-'+item.id}>{item.name}</h2><span className={'document-state '+item.status}>{labels[item.status]}</span></div>
   <p className="document-hint">{(item.sizeBytes/1024).toLocaleString('ru-RU',{maximumFractionDigits:1})} KiB · файл {item.id.slice(0,8)}</p>
   {['queued','processing'].includes(item.status)&&<progress aria-label={'Обработка '+item.name}/>}
   {item.reason&&<p className="document-reason">{item.reason}{item.code==='NO_TEXT'?' Скан можно открыть в исходной программе; извлечение текста из изображений пока недоступно.':''}</p>}
   <label className="document-selection"><input type="checkbox" name={'select-'+item.id} disabled={busy||item.status!=='ready'} checked={item.selected} onChange={e=>action(item,'select',e.target.checked)}/>Выбрать «{item.name}» в этой вкладке</label>
   <div className="document-actions">{item.status==='ready'&&<button className="secondary" disabled={busy} onClick={()=>show(item)}>Посмотреть текст</button>}{['queued','processing'].includes(item.status)&&<button className="secondary" disabled={busy} onClick={()=>action(item,'cancel')}>Отменить обработку</button>}{['error','unreadable','cancelled'].includes(item.status)&&<button className="secondary" disabled={busy} onClick={()=>action(item,'retry')}>Повторить</button>}<button className="secondary" disabled={busy} onClick={()=>action(item,'remove')}>Убрать из списка</button></div>
  </article>)}</div>
  <p className="document-hint">«Готов» означает, что текст извлечён и доступен для просмотра. Подбор фрагментов, выбор глав и ответы по документам появятся на следующих шагах.</p>
  {preview&&<DocumentPreview data={preview} onClose={()=>setPreview(null)}/>}
 </section>;
}
