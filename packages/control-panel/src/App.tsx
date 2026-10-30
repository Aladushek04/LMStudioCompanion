import { useEffect, useRef, useState } from 'react';
import { getSessionToken, request, type Snapshot } from './api.js';
import {Memory} from './features/memory/Memory.js';

const sections = [
  { name: 'Обзор', icon: '◫' }, { name: 'Модель', icon: '◇' }, { name: 'Ответы', icon: '≋' }, { name: 'Память', icon: '◎' }, { name: 'Документы', icon: '▤' },
];
const future: Record<string, { title: string; description: string; reason: string; next: string }> = {
  Модель: { title: 'Настройки под ваш компьютер', description: 'Подбор контекста, оценка памяти и проверенные профили модели.', reason: 'Применение и возврат профилей пока недоступно. Отдельный советник уже умеет оценивать расход памяти.', next: 'Советник можно открыть через Start-Advisor.cmd в папке проекта.' },
  Ответы: { title: 'Режимы ответа', description: 'Быстро, автоматически или с подробным рассуждением.', reason: 'Управление рассуждениями пока недоступно: реальное переключение на вашей модели ещё не подтверждено.', next: 'Пока используйте штатные настройки LM Studio.' },
  Память: { title: 'Память под вашим контролем', description: 'Просмотр, исправление и удаление сохранённых фактов.', reason: 'Управление памятью пока недоступно: безопасное подключение к владельцу хранилища ещё не реализовано.', next: 'Ваши ручные правки будут главнее автоматических предложений.' },
  Документы: { title: 'Ответы с опорой на документы', description: 'Автоматический подбор фрагментов или выбранные вами главы и разделы.', reason: 'Управление документами через Companion пока недоступно: адаптер и проверяемые ссылки на фрагменты ещё не реализованы.', next: 'Существующие прикрепления в LM Studio можно использовать как раньше.' },
};
const labels: Record<string, string> = { sdkSurface: 'Интерфейсы установленного SDK', installedCompressor: 'Установка context-compressor', compressorCompatible: 'Совместимость управления ответами', stableChatScopeId: 'Привязка проекта к чату', persistentFileHandle: 'Постоянные библиотеки файлов', thinking: 'Переключение рассуждений' };

export function App() {
  const [token] = useState(getSessionToken); const [selected, setSelected] = useState('Обзор');
  const [memoryOpened,setMemoryOpened]=useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null); const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(''); const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null); const sectionHeading = useRef<HTMLHeadingElement | null>(null);
  async function diagnose() {
    if (!token || controller.current) return;
    const operation = new AbortController(); controller.current = operation; setBusy(true); setNotice(''); setError('');
    try { setSnapshot(await request<Snapshot>(token, '/api/diagnostics', 'POST', operation.signal)); setNotice('Проверка завершена.'); }
    catch (e) { if (operation.signal.aborted) setNotice('Проверка отменена. Предыдущий результат сохранён.'); else setError(e instanceof Error ? e.message : 'Проверка не удалась.'); }
    finally { controller.current = null; setBusy(false); }
  }
  useEffect(() => { void diagnose(); return () => controller.current?.abort(); }, []);
  const report = snapshot?.report; const connected = report?.features.connection?.state === 'verified';
  const time = report ? new Date(report.checkedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : 'ещё не проверялось';
  function navigate(name: string) { if(name==='Память')setMemoryOpened(true);setSelected(name); requestAnimationFrame(() => sectionHeading.current?.focus()); }
  return <div className="app-shell">
    <a className="skip-link" href="#main">К содержимому</a>
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark" aria-hidden="true">C<span>•</span></div><div><strong>Companion</strong><small>для LM Studio</small></div></div>
      <div className="nav-caption">РАБОЧЕЕ ПРОСТРАНСТВО</div>
      <nav aria-label="Разделы панели">{sections.map(section => <button key={section.name} className={selected === section.name ? 'nav-item active' : 'nav-item'} onClick={() => navigate(section.name)} aria-current={selected === section.name ? 'page' : undefined}><span aria-hidden="true">{section.icon}</span>{section.name}</button>)}</nav>
      <div className="sidebar-bottom"><span className="local-dot" />Локально на компьютере<small>Общение остаётся в LM Studio</small></div>
    </aside>
    <div className="workspace">
      <header className="topbar"><div>LM Studio Companion <span className="divider">/</span> {selected}</div><span className="local-label">Локальная панель</span></header>
      <main id="main" tabIndex={-1}>
        <div className="page-heading"><div><p className="eyebrow">ВАШЕ РАБОЧЕЕ ПРОСТРАНСТВО</p><h1 tabIndex={-1} ref={sectionHeading}>{selected}</h1><p className="lead">{selected === 'Обзор' ? 'Подключение, возможности и следующий шаг — в одном месте.' : selected === 'Память' ? 'Просмотр, сохранение и исправление ваших записей.' : 'Возможности Companion и их текущая доступность.'}</p></div><span className="release-label">Первый выпуск</span></div>
        {!token && <div className="notice error" role="alert">Откройте панель через Start-Companion.cmd в папке проекта. Для этого окна не найден ключ сеанса.</div>}
        {error && <div className="notice error" role="alert">{error}</div>}
        <div className="sr-only" role="status">{busy ? 'Проверяем подключение' : notice}</div>
        {selected === 'Обзор' ? <>
          <section className={'connection-card ' + (connected ? 'connected' : 'offline')} aria-labelledby="connection-heading">
            <div className="connection-icon" aria-hidden="true">{busy ? '⋯' : connected ? '✓' : '↗'}</div>
            <div className="connection-copy"><span className="status-pill">{busy ? 'Проверяем' : connected ? 'Подключено' : report ? 'Нет подключения' : 'Ожидает проверки'}</span><h2 id="connection-heading">{connected ? 'LM Studio подключена' : report ? 'Нет подключения к LM Studio' : 'Проверим ваше подключение'}</h2><p>{connected ? 'Локальный сервер отвечает. Можно посмотреть, какие возможности уже подтверждены.' : 'Запустите локальный сервер в LM Studio, затем повторите проверку.'}</p><div className="connection-actions"><button className="primary" disabled={!token || busy} onClick={() => void diagnose()}>Проверить подключение</button>{busy && <button className="secondary" onClick={() => controller.current?.abort()}>Отменить</button>}</div></div>
            <div className="connection-detail"><span className="detail-label">АДРЕС СЕРВЕРА</span><code>127.0.0.1:1234</code><span>Только чтение состояния</span></div>
          </section>
          {notice && <p className="inline-notice">{notice}</p>}
          <div className="metrics"><div><span>Версия LM Studio</span><strong>{report?.lmStudioVersion && report.lmStudioVersion !== 'unknown' ? report.lmStudioVersion : 'Не определена'}</strong></div><div><span>Управление генерацией</span><strong>Остаётся в LM Studio</strong></div><div><span>Последняя проверка</span><strong>{time}</strong></div></div>
          <section aria-labelledby="modules-heading"><div className="section-heading"><h2 id="modules-heading">Возможности Companion</h2><span>Доступность показана честно</span></div><div className="module-grid">{sections.slice(1).map(section => <button className="module-card" key={section.name} onClick={() => navigate(section.name)}><span className="module-icon" aria-hidden="true">{section.icon}</span><span className="module-title">{section.name}<span aria-hidden="true">↗</span></span><span>{future[section.name]?.description}</span><span className="module-badge">{section.name === 'Модель' ? 'Советник доступен отдельно' : section.name === 'Память' ? 'Управление записями' : 'В разработке'}</span></button>)}</div></section>
          <section className="details-panel"><details><summary>Подробности проверки<span>Версии и подтверждения</span></summary><dl>{Object.entries(labels).map(([key, label]) => <div key={key}><dt>{label}</dt><dd><span className={'check-state ' + (report?.features[key]?.state === 'verified' ? 'verified' : '')}>{report?.features[key]?.state === 'verified' ? 'Подтверждено' : report?.features[key]?.state === 'unsupported' ? 'Не поддерживается' : 'Не проверено'}</span><p>{report?.features[key]?.evidence ?? 'Сначала выполните проверку подключения.'}</p></dd></div>)}</dl></details></section>
        </> : selected === 'Память' ? null : <section className="future-panel"><div className="large-icon" aria-hidden="true">{sections.find(s => s.name === selected)?.icon}</div><span className="module-badge">В разработке</span><h2>{future[selected]?.title}</h2><p>{future[selected]?.description}</p><div className="notice">{future[selected]?.reason}</div><p>{future[selected]?.next}</p><button className="secondary" onClick={() => navigate('Обзор')}>Вернуться к обзору</button></section>}
        {memoryOpened&&token&&<div hidden={selected!=='Память'}><Memory token={token}/></div>}
        <footer className="page-footer"><span>Панель управляет собственными записями памяти. Настройки модели и чаты остаются в LM Studio.</span><span>Companion · 0.1</span></footer>
      </main>
    </div>
  </div>;
}
