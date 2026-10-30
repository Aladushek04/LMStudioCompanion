import {useEffect,useRef} from 'react';
import type {DocumentPreviewData} from '../../../../documents/src/workspace-types.js';
import type {DocumentCitation} from '../../../../documents/src/retrieval-types.js';

export function DocumentPreview({data,onClose}:{data:DocumentPreviewData;onClose:()=>void}){
 const ref=useRef<HTMLDialogElement>(null);
 useEffect(()=>{const dialog=ref.current!;dialog.showModal();return()=>dialog.close();},[]);
 return <dialog className="document-preview" ref={ref} aria-labelledby="document-preview-heading" onClose={onClose}>
  <h2 id="document-preview-heading">{data.item.name}</h2>
  <p>Это извлечённый текст. Он ещё не отправлен модели.</p>
  <p className="document-hint">{data.item.sections.length?`В тексте найдены заголовки разделов: ${data.item.sections.length}. Ограничить поиск ими можно на экране подбора. Страницы PDF обработчик не определил.`:'Номера страниц и главы обработчик не предоставил. Распознаваемых заголовков в тексте нет; доступен весь извлечённый текст.'}</p>
  <form method="dialog"><button autoFocus className="secondary">Закрыть просмотр</button></form>
  <pre className="document-text" tabIndex={0} aria-label="Извлечённый текст">{data.document.text}</pre>
  <details><summary>Сведения об обработке</summary><p>Символов: {data.document.text?.length.toLocaleString('ru-RU')}. Обработчик: {data.document.parser?.library} {data.document.parser?.version}.</p><p className="document-hint">Версия текста: {data.document.version}</p><p className="document-hint">Отпечаток файла: {data.document.contentHash}</p></details>
 </dialog>;
}
export function FragmentPreview({data,onClose}:{data:DocumentCitation;onClose:()=>void}){
 const ref=useRef<HTMLDialogElement>(null);useEffect(()=>{const d=ref.current!;d.showModal();return()=>d.close();},[]);
 return <dialog className="document-preview" ref={ref} aria-labelledby="document-fragment-heading" onClose={onClose}><h2 id="document-fragment-heading">{data.title} · извлечённый фрагмент</h2><p>Именно этот текст вошёл в проверяемый блок источников. В чат он ещё не отправлен.</p><form method="dialog"><button className="secondary" autoFocus>Закрыть фрагмент</button></form><pre className="document-text" tabIndex={0} aria-label="Текст фрагмента">{data.chunk.text}</pre><details><summary>Источник и версия</summary><p className="document-hint">{data.chunk.locator}</p><p className="document-hint">Файл: {data.documentId}. Отпечаток: {data.contentHash}</p><p className="document-hint">Источник: {data.sourceId}. Фрагмент: {data.chunk.id}.</p></details></dialog>;
}
