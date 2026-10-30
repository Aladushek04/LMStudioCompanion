import {useEffect,useState,type RefObject} from 'react';
import type {MemoryRecord} from '../../../../memory/src/types.js';
export interface MemoryDraft {content:string;category:string;pinned:boolean;scope:MemoryRecord['scope'];projectId:string|null}
export function MemoryEditor({record,busy,onSave,onCancel,formRef}:{record:MemoryRecord|null;busy:boolean;onSave:(draft:MemoryDraft)=>void;onCancel:(dirty:boolean)=>void;formRef:RefObject<HTMLFormElement|null>}){
  const initial:MemoryDraft={content:record?.content??'',category:record?.category??'note',pinned:record?.pinned??false,scope:record?.scope??'global',projectId:record?.projectId??null};
  const [draft,setDraft]=useState(initial);const dirty=JSON.stringify(draft)!==JSON.stringify(initial);
  useEffect(()=>{if(!dirty)return;const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[dirty]);
  const categories:Record<string,string>={note:'Заметка',fact:'Факт',preference:'Предпочтение',project:'О проекте'};
  return <form ref={formRef} className="memory-editor" action="/api/memory" method="post" aria-label="Запись памяти" onSubmit={e=>{e.preventDefault();if(!busy)onSave(draft);}}>
    <h2>{record?'Изменить запись':'Новая запись'}</h2>
    <fieldset disabled={busy}>
      <label htmlFor="memory-content">Текст записи</label><textarea id="memory-content" name="content" required maxLength={16000} rows={4} autoFocus value={draft.content} onChange={e=>setDraft({...draft,content:e.target.value})}/>
      <label htmlFor="memory-category">Категория</label><select id="memory-category" name="category" value={draft.category} onChange={e=>setDraft({...draft,category:e.target.value})}>{!categories[draft.category]&&<option value={draft.category}>{draft.category}</option>}{Object.entries(categories).map(([v,label])=><option key={v} value={v}>{label}</option>)}</select>
      {!record?<fieldset className="memory-scopes"><legend>Где хранить запись</legend>
        <label><input type="radio" name="scope" value="global" checked={draft.scope==='global'} onChange={()=>setDraft({...draft,scope:'global',projectId:null})}/>Общая память</label>
        <label><input type="radio" name="scope" value="project" checked={draft.scope==='project'} onChange={()=>setDraft({...draft,scope:'project',projectId:''})}/>Для проекта</label>
        {draft.scope==='project'&&<><label htmlFor="memory-project">Название проекта</label><input id="memory-project" name="projectId" required maxLength={200} value={draft.projectId??''} onChange={e=>setDraft({...draft,projectId:e.target.value})}/></>}
        <small>Временная память станет доступна после подключения к чату. Проект пока выбирается только для записей в панели.</small>
      </fieldset>:<p>Область: {record.scope==='global'?'Общая память':record.scope==='session'?'Временная память':'Проект: '+record.projectId}. При редактировании область сохраняется.</p>}
      <label className="memory-check"><input type="checkbox" name="pinned" checked={draft.pinned} onChange={e=>setDraft({...draft,pinned:e.target.checked})}/>Закрепить запись</label>
      <p className="memory-hint">Ручные изменения главнее автоматических предложений.</p>
      <div className="memory-actions"><button className="primary" type="submit">{busy?'Сохраняем…':'Сохранить запись'}</button><button className="secondary" type="button" onClick={()=>onCancel(dirty)}>Отменить редактирование</button></div>
    </fieldset>
  </form>;
}
