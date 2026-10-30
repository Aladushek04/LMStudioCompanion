import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { capabilityReportSchema, type CapabilityReport } from '../../core/src/contracts.js';
import { settingsSchema } from '../../core/src/settings.js';
import { SettingsStore } from './settings.js';
import { probeCapabilities } from './capabilities.js';
import { selectIntegration } from '../../lmstudio-plugin/src/integration.js';
import { acquireSettingsOwnership } from './ownership.js';
import {createMemoryRoutes} from './routes/memory.js';
import {createMemoryChannel} from './memory-channel.js';
import type {StoreOptions} from '../../memory/src/store.js';

export interface Asset { content: Buffer; type: string }
export interface ManagementServer { origin: string; token: string; close(): Promise<void> }
interface ServerOptions { port?: number; probe?: (signal: AbortSignal) => Promise<CapabilityReport>; assets?: Map<string, Asset>; memoryOptions?:StoreOptions }
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

async function assetsFromBuild(): Promise<Map<string, Asset>> {
  const root = fileURLToPath(new URL('../../panel/', import.meta.url));
  const assets = new Map<string, Asset>();
  assets.set('/', { content: await readFile(join(root, 'index.html')), type: 'text/html; charset=utf-8' });
  for (const file of await readdir(join(root, 'assets'))) {
    const type = extname(file) === '.js' ? 'text/javascript; charset=utf-8' : extname(file) === '.css' ? 'text/css; charset=utf-8' : null;
    if (type) assets.set('/assets/' + file, { content: await readFile(join(root, 'assets', file)), type });
  }
  return assets;
}
function bodyJson(req: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new HttpError(415, 'Ожидается JSON.');
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0; let rejected = false;
    const fail = (error: Error) => { if (!rejected) { rejected = true; reject(error); } };
    req.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 65536) fail(new HttpError(413, 'Запрос слишком большой.')); else if (!rejected) chunks.push(chunk); });
    req.once('aborted', () => fail(new HttpError(499, 'Запрос отменён.')));
    req.once('error', () => fail(new HttpError(400, 'Не удалось прочитать запрос.')));
    req.once('end', () => {
      if (rejected) return;
      try { signal.throwIfAborted(); resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { fail(new HttpError(400, 'Некорректный JSON.')); }
    });
  });
}

/** Loopback management API; токен запуска не выводится в журнал и не включается в HTML. */
export async function startManagementServer(settingsDir: string, signal: AbortSignal, options: ServerOptions = {}): Promise<ManagementServer> {
  signal.throwIfAborted(); await mkdir(settingsDir, { recursive: true });
  const release = await acquireSettingsOwnership(settingsDir);
  try {
    signal.throwIfAborted();
    try { await readFile(join(settingsDir, '../../.install-lock')); throw new Error('Дождитесь окончания установки или удаления.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const settings = new SettingsStore(settingsDir); await settings.readSettings();
    const assets = options.assets ?? await assetsFromBuild();
    const memory=createMemoryRoutes(join(settingsDir,'memory'),options.memoryOptions);
    const memoryChannel=createMemoryChannel(join(settingsDir,'memory-channel'),memory.get,memory.proposals);
    const token = randomBytes(32).toString('hex');
    const shutdown = new AbortController(); let report: CapabilityReport | null = null; let checking = false;
    const server = createServer(); server.requestTimeout = 10000; server.headersTimeout = 10000; server.timeout = 15000;
    server.listen(options.port ?? 0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Не удалось определить адрес панели.');
    const origin = `http://127.0.0.1:${address.port}`;
    await memoryChannel.restore();
    const expectedHost = `127.0.0.1:${address.port}`;
    const respond = (res: ServerResponse, code: number, value: unknown) => {
      if (!res.destroyed) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
    };
    const pending = new Set<Promise<void>>();
    const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), display-capture=()');
      const request = new AbortController();
      res.once('close', () => { if (!res.writableEnded) request.abort(); });
      const operationSignal = AbortSignal.any([request.signal, shutdown.signal, signal]);
      try {
        if (req.headers.host !== expectedHost || (req.headers.origin !== undefined && req.headers.origin !== origin)) throw new HttpError(403, 'Запрос с постороннего адреса отклонён.');
        const path = new URL(req.url ?? '/', origin).pathname;
        if (path.startsWith('/api/')) {
          const credential = req.headers.authorization ?? ''; const expected = 'Bearer ' + token;
          if (Buffer.byteLength(credential) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(credential), Buffer.from(expected))) throw new HttpError(403, 'Откройте панель через ярлык запуска.');
          if (req.method !== 'GET' && req.headers.origin !== origin) throw new HttpError(403, 'Не подтверждён источник запроса.');
          if(path==='/api/memory/connection'){
            if(req.method==='POST'||req.method==='DELETE'){
              const body=await bodyJson(req,operationSignal);if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)throw new HttpError(400,'Ожидается пустой объект.');
              if(req.method==='POST')await memoryChannel.enable();else await memoryChannel.disable();
            }else if(req.method!=='GET')throw new HttpError(404,'Операция недоступна.');
            respond(res,200,memoryChannel.status());return;
          }
          if(path==='/api/memory'||path.startsWith('/api/memory/')){
            const body=['POST','PATCH','DELETE'].includes(req.method??'')?await bodyJson(req,operationSignal):undefined;
            const result=await memory.handle(path,req.method??'GET',body,operationSignal);
            if(result.download)res.setHeader('Content-Disposition','attachment; filename="companion-memory.json"');
            respond(res,result.status,result.body);return;
          }
          if (path === '/api/status' && req.method === 'GET') { respond(res, 200, { report, checking, integration: report ? selectIntegration(report, null) : null }); return; }
          if (path === '/api/settings' && req.method === 'GET') { respond(res, 200, { settings: await settings.readSettings(), appliedToLmStudio: false }); return; }
          if (path === '/api/settings' && req.method === 'PUT') {
            const parsed = settingsSchema.safeParse(await bodyJson(req, operationSignal));
            if (!parsed.success) throw new HttpError(400, 'Настройки не соответствуют поддержанному формату.');
            await settings.writeSettings(parsed.data, operationSignal); respond(res, 200, { settings: parsed.data, appliedToLmStudio: false }); return;
          }
          if (path === '/api/diagnostics' && req.method === 'POST') {
            if (checking) throw new HttpError(409, 'Проверка уже выполняется.');
            checking = true;
            try {
              const next = capabilityReportSchema.parse(await (options.probe ?? probeCapabilities)(operationSignal));
              operationSignal.throwIfAborted(); report = next;
              respond(res, 200, { report, checking: false, integration: selectIntegration(report, null) });
            } finally { checking = false; }
            return;
          }
          throw new HttpError(404, 'Операция недоступна.');
        }
        const asset = assets.get(path);
        if (!asset || req.method !== 'GET') throw new HttpError(404, 'Страница не найдена.');
        res.writeHead(200, { 'Content-Type': asset.type }); res.end(asset.content);
      } catch (error) {
        if (operationSignal.aborted) { if (!res.destroyed) res.destroy(); return; }
        const status = error instanceof HttpError ? error.status : 500;
        if (status === 413) res.setHeader('Connection', 'close');
        respond(res, status, { message: error instanceof HttpError ? error.message : 'Не удалось выполнить операцию. Предыдущие данные сохранены.' });
      }
    };
    server.on('request', (req, res) => {
      const operation = handleRequest(req, res); pending.add(operation);
      void operation.then(() => pending.delete(operation), () => pending.delete(operation));
    });
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => {
      shutdown.abort(); signal.removeEventListener('abort', onAbort);
      const stopped = new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections();
      await stopped; await Promise.allSettled([...pending]); try{await memoryChannel.close();await memory.close();}finally{await release();}
    })();
    const onAbort = () => { void close(); }; signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) await close();
    signal.throwIfAborted(); return { origin, token, close };
  } catch (error) { await release(); throw error; }
}
