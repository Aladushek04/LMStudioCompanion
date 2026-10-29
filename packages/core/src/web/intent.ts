export interface WebPlan { kind: 'none'|'read-url'|'search'|'inspect-image'; urls: string[]; query: string|null; reason: string }
export type WebMode = 'off'|'auto'|'research';

export function normalizeWebUrl(raw: string): string | null {
  try {
    if (raw.length > 4096 || /[\\\x00-\x20]/.test(raw)) return null;
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port && !['80', '443'].includes(url.port)) return null;
    const host = url.hostname.toLowerCase();
    // Full DNS/IP pinning remains mandatory in the transport, not this classifier.
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[)/.test(host) || /\.(local|internal|localhost)$/.test(host)) return null;
    url.hash = ''; return url.href;
  } catch { return null; }
}
export function planWebAction(userText: string, mode: WebMode): WebPlan {
  const none = (reason: string): WebPlan => ({ kind: 'none', urls: [], query: null, reason });
  if (mode === 'off') return none('Интернет выключен.');
  if (userText.length > 65536) return none('Запрос слишком длинный для автоматического веб-планирования.');
  const text = userText.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '').replace(/`[^`]*(?:`|$)/g, '').replace(/^\s*>.*$/gm, '').trim();
  if (!text) return none('В примере кода или цитате нет отдельного поручения открыть источник.');
  // A quoted bare address is a parameter; a quoted sentence is source data.
  const actionable = text.replace(/"([^"]*)"|«([^»]*)»|“([^”]*)”/g, (_whole, a: string|undefined, b: string|undefined, c: string|undefined) => {
    const quoted = (a ?? b ?? c ?? '').trim(); return /^https?:\/\/\S+$/i.test(quoted) ? quoted : '';
  });
  const raw = actionable.match(/https?:\/\/[^\s<>"'`«»“”]+/gi) ?? [];
  const intentText = actionable.replace(/https?:\/\/[^\s<>"'`«»“”]+/gi, '');
  const urls: string[] = [];
  for (let item of raw) {
    item = item.replace(/[.,!;:?]+$/g, '');
    while (/[)\]}]$/.test(item) && (item.match(/[)\]}]/g)?.length ?? 0) > (item.match(/[(\[{]/g)?.length ?? 0)) item = item.slice(0, -1);
    const url = normalizeWebUrl(item); if (url && !urls.includes(url)) urls.push(url);
  }
  if (raw.length && !urls.length || /(?:file|ftp):\/\//i.test(text)) return none('Адрес не подходит для публичного веб-чтения.');
  if (urls.length && /(?:что\s+на\s+(?:картин|фото|изображен)|(?:посмотри|рассмотри|опиши|проанализируй).{0,35}(?:картин|фото|изображен)|inspect\s+image)/iu.test(intentText)) return { kind: 'inspect-image', urls: urls.slice(0, 12), query: text.slice(0, 1500), reason: 'Явная просьба рассмотреть изображение.' };
  if (urls.length && /(?:прочита[йт]|прочесть|почитай|посмотри|изучи|открой|проанализируй|перескажи|суммируй|read\b|summari[sz]e\b)/iu.test(intentText)) return { kind: 'read-url', urls: urls.slice(0, 12), query: null, reason: 'Явная просьба прочитать указанный источник.' };
  if (!urls.length && (mode === 'research' || /(?:найди|поищи|поиск|свеж|последни[ехй]|новост|сегодня|сейчас|latest|current|today|search\b)/iu.test(intentText))) return { kind: 'search', urls: [], query: text.slice(0, 500), reason: 'Запрошены поиск или актуальные сведения.' };
  return none('Намерение открыть источник неоднозначно; автоматического запроса нет.');
}
