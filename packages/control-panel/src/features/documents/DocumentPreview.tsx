import {useEffect,useRef} from 'react';
import type {DocumentPreviewData} from '../../../../documents/src/workspace-types.js';

export function DocumentPreview({data,onClose}:{data:DocumentPreviewData;onClose:()=>void}){
 const ref=useRef<HTMLDialogElement>(null);
 useEffect(()=>{const dialog=ref.current!;dialog.showModal();return()=>dialog.close();},[]);
 return <dialog className="document-preview" ref={ref} aria-labelledby="document-preview-heading" onClose={onClose}>
  <h2 id="document-preview-heading">{data.item.name}</h2>
  <p>Это извлечённый текст. Он ещё не отправлен модели.</p>
  <p className="document-hint">Номера страниц и главы обработчик не предоставил. Сейчас доступен весь извлечённый текст; выбор отдельных разделов появится позже.</p>
  <form method="dialog"><button autoFocus className="secondary">Закрыть просмотр</button></form>
  <pre className="document-text" tabIndex={0} aria-label="Извлечённый текст">{data.document.text}</pre>
  <details><summary>Сведения об обработке</summary><p>Символов: {data.document.text?.length.toLocaleString('ru-RU')}. Обработчик: {data.document.parser?.library} {data.document.parser?.version}.</p><p className="document-hint">Версия текста: {data.document.version}</p><p className="document-hint">Отпечаток файла: {data.document.contentHash}</p></details>
 </dialog>;
}
