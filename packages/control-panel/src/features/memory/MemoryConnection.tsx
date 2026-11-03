import { useEffect, useRef, useState } from 'react';
import { request } from '../../api.js';

interface Connection {
  enabled: boolean;
  file: string;
  error: string;
  usage: { at: number; refs: { id: string; revision: number; reason: string }[] } | null;
}
export function MemoryConnection({ token }: { token: string }) {
  const [state, setState] = useState<Connection | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const operation = useRef(false);
  useEffect(() => {
    const c = new AbortController();
    void request<Connection>(token, '/api/memory/connection', 'GET', c.signal)
      .then(setState)
      .catch(() => {
        if (!c.signal.aborted) setError('Не удалось проверить подключение памяти.');
      });
    return () => c.abort();
  }, [token]);
  async function action(method: 'GET' | 'POST' | 'DELETE') {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError('');
    try {
      setState(
        await request<Connection>(
          token,
          '/api/memory/connection',
          method,
          undefined,
          method === 'GET' ? undefined : {},
        ),
      );
    } catch {
      setError('Не удалось изменить или проверить подключение. Попробуйте ещё раз.');
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }
  return (
    <details className="notice">
      <summary>
        Память в чате: {state?.enabled ? 'подключение включено' : 'подключение выключено'}
      </summary>
      <p>
        Подстановка в чат включается отдельно в companion-web. Общие записи доступны в подключённых
        чатах, пока Companion работает.
      </p>
      <div className="memory-actions">
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void action(state?.enabled ? 'DELETE' : 'POST')}
        >
          {state?.enabled ? 'Выключить подключение к чату' : 'Включить подключение к чату'}
        </button>
        <button className="secondary" disabled={busy} onClick={() => void action('GET')}>
          Проверить подключение и подстановку
        </button>
      </div>
      {state?.enabled && (
        <>
          <label>
            Файл подключения памяти
            <input
              readOnly
              value={state.file}
              spellCheck={false}
              onFocus={e => e.currentTarget.select()}
            />
          </label>
          <p>
            Скопируйте этот путь в одноимённое поле настроек companion-web в LM Studio, затем в
            нужном чате включите «Использовать общую память Companion».
          </p>
        </>
      )}
      <p role="status">{busy ? 'Проверяем подключение…' : error || state?.error || ''}</p>
      {state?.usage && (
        <p>
          Передано в чат: {state.usage.refs.length} записей ·{' '}
          {new Date(state.usage.at).toLocaleTimeString('ru-RU')}.
        </p>
      )}
      <details>
        <summary>Подробности подстановки</summary>
        <p>
          Сейчас к чату подключается общая память. Проектная память и карточки для отдельных чатов
          запланированы отдельно. Здесь показаны переданные записи; их использование в ответе
          зависит от модели.
        </p>
        {state?.usage && (
          <ul>
            {state.usage.refs.map(r => (
              <li key={r.id}>
                {r.id} · редакция {r.revision} · {r.reason}
              </li>
            ))}
          </ul>
        )}
      </details>
    </details>
  );
}
