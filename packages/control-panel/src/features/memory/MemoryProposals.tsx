import {useEffect,useRef,useState,useId} from 'react';
import {request,ApiError} from '../../api.js';
import type {Proposal,Acceptance} from '../../../../memory/src/proposals.js';
import type {OperationResult} from '../../../../core/src/contracts.js';

function ProposalCard({proposal:p,busy,onAccept,onReject,onRefresh}:{proposal:Proposal;busy:boolean;onAccept:(body:Acceptance)=>void;onReject:()=>void;onRefresh:()=>void}){
 const [text,setText]=useState(p.content),[choice,setChoice]=useState(p.kind==='save'?'save':p.targets[0]?.id??''),[confirm,setConfirm]=useState<Acceptance|null>(null);
 const dialog=useRef<HTMLDialogElement>(null),uid=useId(),target=p.targets.find(t=>t.id===choice);
 const initial=useRef(p.content);useEffect(()=>{if(text===initial.current)return;const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[text]);
 useEffect(()=>{if(!confirm)return;const d=dialog.current!;d.showModal();return()=>d.close();},[confirm]);
 function submit(){if(busy)return;const body:Acceptance|undefined=choice==='save'?{choice:'save',content:text,baseRevision:p.baseRevision}:target?p.kind==='delete'?{choice:'delete',targetId:target.id,expectedRevision:target.revision}:{choice:'replace',targetId:target.id,expectedRevision:target.revision,content:text}:undefined;if(!body)return;if(body.choice==='save')onAccept(body);else setConfirm(body);}
 return <article className="memory-record memory-proposal" aria-label="Предложение памяти">
  <h3>{p.kind==='save'?'Сохранить запись':p.kind==='edit'?'Исправить запись':'Забыть запись'}</h3>
  <p className="memory-hint">{p.origin==='explicit'?'По явной команде из чата':'Предложено из прямого сообщения пользователя'} · Общая память · {new Date(p.createdAt).toLocaleTimeString('ru-RU')}. Пока не применено.</p>
  <form action={'/api/memory/proposals/'+p.id+'/accept'} method="post" onSubmit={e=>{e.preventDefault();submit();}}>
   <fieldset disabled={busy}>
    {p.kind==='save'&&<fieldset className="memory-scopes"><legend>Как применить предложение</legend>
     <label><input type="radio" name={'choice-'+p.id} checked={choice==='save'} onChange={()=>setChoice('save')}/>Сохранить отдельной записью</label>
     {p.targets.map(t=><label key={t.id}><input type="radio" name={'choice-'+p.id} checked={choice===t.id} onChange={()=>setChoice(t.id)}/>Исправить существующую запись: {t.content.slice(0,100)}{t.content.length>100?'…':''}</label>)}
     {p.targets.length>0&&<p className="memory-hint">Найдены похожие слова. Это не доказательство противоречия: сравните записи сами.</p>}
    </fieldset>}
    {target&&<><p>Текущий сохранённый текст · редакция {target.revision}</p><blockquote className="memory-text">{target.content}</blockquote></>}
    {p.kind!=='delete'&&<><label htmlFor={uid+'-text'}>Предлагаемый текст</label><textarea id={uid+'-text'} name="content" required maxLength={16000} rows={3} value={text} onChange={e=>setText(e.target.value)}/></>}
    <div className="memory-actions"><button className={p.kind==='delete'?'danger':'primary'} type="submit" disabled={choice!=='save'&&!target}>{p.kind==='delete'?'Забыть запись':choice==='save'?'Сохранить':'Применить исправление'}</button><button className="secondary" type="button" onClick={onReject}>{p.kind==='save'?'Не сохранять':'Отклонить'}</button><button className="secondary" type="button" onClick={onRefresh}>Обновить предложение</button></div>
   </fieldset>
  </form>
  {confirm&&<dialog ref={dialog} aria-labelledby={uid+'-title'} aria-describedby={uid+'-description'} onClose={()=>{const accepted=dialog.current?.returnValue==='apply';if(dialog.current)dialog.current.returnValue='';const body=confirm;setConfirm(null);if(accepted)onAccept(body);}}>
   <h3 id={uid+'-title'}>{confirm.choice==='delete'?'Забыть эту запись?':'Подтвердить исправление?'}</h3>
   <div id={uid+'-description'}><p>Сейчас сохранено · редакция {target?.revision}</p><p className="memory-text">{target?.content}</p>{confirm.choice==='replace'?<><p>Будет сохранено:</p><p className="memory-text">{confirm.content}</p></>:<p>Запись перестанет подставляться в новые запросы. Старые чаты и резервные копии могут содержать прежний текст.</p>}</div>
   <form method="dialog" className="memory-actions"><button autoFocus className="secondary" value="cancel">Отмена</button><button className={confirm.choice==='delete'?'danger':'primary'} value="apply">{confirm.choice==='delete'?'Подтвердить забывание':'Подтвердить исправление'}</button></form>
  </dialog>}
 </article>;
}

export function MemoryProposals({token,onApplied}:{token:string;onApplied:()=>Promise<void>}){
 const [proposals,setProposals]=useState<Proposal[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');const operation=useRef(false),active=useRef(true),alert=useRef<HTMLDivElement>(null),generation=useRef(0);
 useEffect(()=>{if(error)alert.current?.focus();},[error]);
 useEffect(()=>{active.current=true;const c=new AbortController(),id=++generation.current;void request<{proposals:Proposal[]}>(token,'/api/memory/proposals','GET',c.signal).then(r=>{if(active.current&&id===generation.current)setProposals(r.proposals);}).catch(()=>{if(!c.signal.aborted&&active.current&&id===generation.current)setError('Не удалось загрузить предложения памяти.');});return()=>{active.current=false;c.abort();};},[token]);
 async function run(action:()=>Promise<void>){if(operation.current)return;operation.current=true;++generation.current;setBusy(true);setError('');setNotice('');try{await action();}catch(e){if(active.current)setError((e instanceof ApiError?e.message:'Связь прервана. Состояние операции неизвестно: обновите предложения и список памяти перед повтором.')+(e instanceof ApiError&&e.status===409?' Обновите предложение, проверьте актуальный текст и подтвердите заново.':''));}finally{operation.current=false;if(active.current)setBusy(false);}}
 async function load(){await run(async()=>{const r=await request<{proposals:Proposal[]}>(token,'/api/memory/proposals');if(active.current)setProposals(r.proposals);});}
 async function act(p:Proposal,action:'accept'|'reject'|'refresh',body:Acceptance|Record<string,never>){await run(async()=>{
  const result=await request<OperationResult<Proposal>>(token,'/api/memory/proposals/'+p.id+'/'+action,'POST',undefined,body);if(!result.ok)throw Error(result.message);
  if(active.current){setProposals(list=>action==='refresh'?list.map(v=>v.id===p.id?result.value:v):list.filter(v=>v.id!==p.id));setNotice(action==='refresh'?'Предложение обновлено. Проверьте актуальную запись перед подтверждением.':action==='reject'?'Предложение отклонено. Записи не изменены.':'Предложение применено.');}
  if(action==='accept')try{await onApplied();}catch{if(active.current)setError('Предложение применено, но список записей не обновился. Нажмите «Обновить список».');}
 });}
 return <section aria-label="Предложения памяти"><h2>Предложения из чата</h2>
  <p className="memory-hint">Изменения применяются только вашей кнопкой. Очередь хранится до часа в работающем Companion и очищается при перезапуске. Автоматическая генерация для извлечения не запускается.</p>
  <button className="secondary" disabled={busy} onClick={()=>void load()}>Обновить предложения</button>
  <p role="status">{busy?'Проверяем предложение…':notice||(!proposals.length?'Ожидающих предложений нет.':'Предложений: '+proposals.length)}</p>
  {error&&<div ref={alert} className="notice error" role="alert" tabIndex={-1}>{error}</div>}
  {proposals.map(p=><ProposalCard key={p.id} proposal={p} busy={busy} onAccept={body=>void act(p,'accept',body)} onReject={()=>void act(p,'reject',{})} onRefresh={()=>void act(p,'refresh',{})}/>)}
 </section>;
}
