import {useEffect,useRef,useState} from 'react';
import {request,ApiError} from '../../api.js';
import type {OperationResult} from '../../../../core/src/contracts.js';
import type {MemoryRecord} from '../../../../memory/src/types.js';
import {MemoryEditor,type MemoryDraft} from './MemoryEditor.js';
function Confirmation({title,description,action,onConfirm,onCancel}:{title:string;description:string;action:string;onConfirm:()=>void;onCancel:()=>void}){
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const dialog=ref.current!;dialog.showModal();return()=>dialog.close();},[]);
  return <dialog ref={ref} aria-labelledby="memory-confirm-title" aria-describedby="memory-confirm-description" onClose={()=>{const choice=ref.current?.returnValue;if(ref.current)ref.current.returnValue='';if(choice==='confirm')onConfirm();else onCancel();}}>
    <h2 id="memory-confirm-title">{title}</h2><p id="memory-confirm-description">{description}</p>
    <form method="dialog" className="memory-actions"><button autoFocus className="secondary" value="cancel">Отмена</button><button className="danger" value="confirm">{action}</button></form>
  </dialog>;
}
export function Memory({token}:{token:string}){
  const [records,setRecords]=useState<MemoryRecord[]>([]);const [loaded,setLoaded]=useState(false);
  const [loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [query,setQuery]=useState(''),[scope,setScope]=useState('all'),[project,setProject]=useState(''),[limit,setLimit]=useState(50);
  const [editing,setEditing]=useState<{record:MemoryRecord|null;key:string}|null>(null);
  const [confirm,setConfirm]=useState<{kind:'delete'|'overwrite';record:MemoryRecord}|{kind:'discard'}|null>(null);
  const [conflicted,setConflicted]=useState(false);const approvedRevision=useRef<MemoryRecord|null>(null);const editorForm=useRef<HTMLFormElement>(null);
  const active=useRef(true);const alert=useRef<HTMLDivElement>(null);const operation=useRef(false);const generation=useRef(0);
  useEffect(()=>{if(error)alert.current?.focus();},[error]);
  async function reload(signal?:AbortSignal){const id=++generation.current;setLoading(true);try{const result=await request<{records:MemoryRecord[]}>(token,'/api/memory','GET',signal);if(active.current&&id===generation.current){setRecords(result.records);setLoaded(true);}}finally{if(active.current&&id===generation.current)setLoading(false);}}
  function failure(e:unknown){if(e instanceof ApiError&&e.status===409)setConflicted(!!editing?.record);setError((e instanceof ApiError?e.message:'Связь с локальным сервисом прервана. Проверьте список перед повторным сохранением.')+(e instanceof ApiError&&e.status===409?(editing?.record?' Черновик оставлен в форме. Нажмите «Разрешить конфликт», чтобы сравнить и подтвердить свою правку.':' Обновите список и подтвердите действие заново. Изменённая запись не удалена.'):''));}
  useEffect(()=>{active.current=true;const controller=new AbortController();void reload(controller.signal).catch(e=>{if(!controller.signal.aborted)failure(e);});return()=>{active.current=false;controller.abort();};},[]);
  async function mutate<T>(action:()=>Promise<OperationResult<T>>,message:string){
    if(operation.current)return;operation.current=true;setBusy(true);setConflicted(false);setError('');setNotice('');
    try{const result=await action();if(!result.ok)throw new Error(result.message);if(active.current){setEditing(null);setNotice(message);}try{await reload();}catch{if(active.current)setError('Изменение подтверждено, но обновить список не удалось. Нажмите «Обновить список».');}}
    catch(e){if(active.current)failure(e);}finally{operation.current=false;if(active.current)setBusy(false);}
  }
  async function save(draft:MemoryDraft){const record=editing?.record;const approved=approvedRevision.current;approvedRevision.current=null;await mutate(()=>request<OperationResult<MemoryRecord>>(token,record?'/api/memory/'+record.id:'/api/memory',record?'PATCH':'POST',undefined,record?{content:draft.content,category:draft.category,pinned:draft.pinned,expectedRevision:approved?.id===record.id?approved.revision:record.revision}:draft),'Запись сохранена.');}
  async function resolveConflict(){if(operation.current||!editing?.record)return;operation.current=true;setBusy(true);try{
    const latest=await request<{records:MemoryRecord[]}>(token,'/api/memory');setRecords(latest.records);const record=latest.records.find(r=>r.id===editing.record?.id);
    if(!record)setError('Запись уже удалена. Ваш черновик оставлен в форме; автоматически возвращать забытый факт нельзя.');
    else setConfirm({kind:'overwrite',record});
  }catch(e){failure(e);}finally{operation.current=false;setBusy(false);}}
  async function exportMemory(){if(operation.current)return;operation.current=true;setBusy(true);setError('');setNotice('');try{
    const snapshot=await request<unknown>(token,'/api/memory/export');const url=URL.createObjectURL(new Blob([JSON.stringify(snapshot,null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download='companion-memory.json';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);setNotice('Файл экспорта подготовлен. Храните его как личные данные.');
  }catch(e){failure(e);}finally{operation.current=false;setBusy(false);}}
  const filtered=records.filter(r=>(scope==='all'||r.scope===scope)&&(!project||r.projectId===project)&&(!query||r.content.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru'))));
  const projects=[...new Set(records.map(r=>r.projectId).filter((p):p is string=>p!==null))];
  return <section className="memory" aria-label="Управление памятью">
    <div className="notice">Здесь — собственные записи Companion. В чат они пока не подставляются. Прежняя память плагина не переносится автоматически.</div>
    <div className="memory-actions"><button className="primary" disabled={busy||loading||!loaded||!!editing} onClick={()=>{setError('');setNotice('');setEditing({record:null,key:crypto.randomUUID()});}}>Добавить запись</button><button className="secondary" disabled={busy||loading} onClick={()=>{setError('');void reload().catch(failure);}}>Обновить список</button><button className="secondary" disabled={busy||loading||!loaded} onClick={()=>void exportMemory()}>Экспортировать память</button></div>
    {error&&<div ref={alert} className="notice error" role="alert" tabIndex={-1}>{error}</div>}
    <p role="status" className="memory-status">{loading?'Загружаем память…':busy?'Выполняем операцию…':notice}</p>
    {editing&&conflicted&&<button className="secondary" disabled={busy} onClick={()=>void resolveConflict()}>Разрешить конфликт</button>}
    {editing&&<MemoryEditor formRef={editorForm} key={editing.key} record={editing.record} busy={busy} onSave={draft=>void save(draft)} onCancel={dirty=>{if(dirty)setConfirm({kind:'discard'});else{setEditing(null);setError('');}}}/>}
    <div className="memory-filters"><label>Поиск по памяти<input type="search" name="memoryQuery" autoComplete="off" value={query} onChange={e=>{setQuery(e.target.value);setLimit(50);}}/></label><label>Область записей<select name="memoryScopeFilter" value={scope} onChange={e=>{setScope(e.target.value);setLimit(50);}}><option value="all">Все записи</option><option value="global">Общая память</option><option value="project">Проекты</option></select></label><label>Фильтр проекта<select name="memoryProjectFilter" value={project} onChange={e=>{setProject(e.target.value);setLimit(50);}}><option value="">Все проекты</option>{projects.map(p=><option key={p} value={p}>{p}</option>)}</select></label></div>
    {loaded&&<p>{filtered.length?`Найдено записей: ${filtered.length}. Показано: ${Math.min(limit,filtered.length)}.`:records.length?'По выбранным условиям записей нет.':'Записей пока нет. Добавьте первую запись.'}</p>}
    <div className="memory-list">{filtered.slice(0,limit).map(r=><article key={r.id} className="memory-record">
      <div className="memory-record-meta"><span>{r.scope==='global'?'Общая память':r.scope==='session'?'Временно':'Проект: '+r.projectId}</span>{r.pinned&&<strong>Закреплено</strong>}<span>Источник: {r.source==='user'?'Добавлено вручную':r.source}</span><span>Изменено: {new Date(r.updatedAt).toLocaleString('ru-RU')}</span></div>
      <p className="memory-text">{r.content}</p><div className="memory-actions"><button className="secondary" disabled={busy||!!editing} onClick={()=>{setError('');setNotice('');setEditing({record:r,key:crypto.randomUUID()});}}>Изменить</button><button className="secondary" disabled={busy||!!editing} onClick={()=>setConfirm({kind:'delete',record:r})}>Забыть</button></div>
    </article>)}</div>
    {filtered.length>limit&&<button className="secondary" onClick={()=>setLimit(limit+50)}>Показать ещё</button>}
    <p className="memory-hint">Удаление убирает запись из активной памяти. Ранее созданные резервные копии и старые чаты могут сохранять прежний текст.</p>
    {confirm&&<Confirmation title={confirm.kind==='delete'?'Забыть запись?':confirm.kind==='overwrite'?'Заменить актуальную запись своим черновиком?':'Сбросить несохранённый черновик?'} description={confirm.kind==='delete'?'Запись исчезнет из активного списка Companion. Старые чаты и экспортированные копии не изменятся.':confirm.kind==='overwrite'?'Сейчас сохранено: «'+confirm.record.content+'». Ваша правка заменит эту версию. Если запись снова изменится, сохранение будет остановлено.':'Текст формы будет потерян; сохранённая запись останется прежней.'} action={confirm.kind==='delete'?'Забыть запись':confirm.kind==='overwrite'?'Сохранить мой черновик':'Сбросить черновик'} onCancel={()=>setConfirm(null)} onConfirm={()=>{const selected=confirm;setConfirm(null);if(selected.kind==='delete')void mutate(()=>request<OperationResult<void>>(token,'/api/memory/'+selected.record.id,'DELETE',undefined,{expectedRevision:selected.record.revision}),'Запись удалена.');else if(selected.kind==='overwrite'){approvedRevision.current=selected.record;editorForm.current?.requestSubmit();}else{setEditing(null);setError('');}}}/>}
  </section>;
}
