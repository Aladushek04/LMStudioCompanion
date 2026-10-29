import { readFile } from 'node:fs/promises';
import { join, isAbsolute, extname } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface InstallationFacts {
  lmStudioVersion: string | null;
  sdkVersion: string | null;
  compressorVersion: string | null;
  compressorRevision: number | null;
  sdkMethods: string[];
  /** Регистрация в исходнике установленного плагина, а не его включённость в текущем чате. */
  compressorOwnsPredictionLoop: boolean;
}
const runFile = promisify(execFile);

/** Только известные файлы метаданных и деклараций. Конфигурации чатов и секреты не читаются. */
export async function inspectInstallation(signal: AbortSignal, lmStudioRoot = join(homedir(), '.lmstudio')): Promise<InstallationFacts> {
  signal.throwIfAborted();
  async function text(path: string): Promise<string> {
    try { return await readFile(path, { encoding: 'utf8', signal }); }
    catch { signal.throwIfAborted(); return ''; }
  }
  async function metadata(path: string): Promise<Record<string, unknown>> {
    try {
      const parsed: unknown = JSON.parse(await text(path));
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch { signal.throwIfAborted(); return {}; }
  }
  const plugin = join(lmStudioRoot, 'extensions/plugins/rootmonster/context-compressor');
  const sdk = join(plugin, 'node_modules/@lmstudio/sdk');
  const [pluginPackage, manifest, sdkPackage, declarations, entrypoint] = await Promise.all([
    metadata(join(plugin, 'package.json')), metadata(join(plugin, 'manifest.json')), metadata(join(sdk, 'package.json')),
    text(join(sdk, 'dist/index.d.ts')), text(join(plugin, 'src/index.ts')),
  ]);
  const methods = ['withPredictionLoopHandler', 'startToolUseSession', 'prepareFile', 'prepareFileBase64', 'parseDocument', 'retrieve', 'abortSignal'];
  const version = (value: unknown): string | null => typeof value === 'string' && /^\d+\.\d+\.\d+(?:[.+-][\w.-]+)?$/.test(value) ? value : null;
  let lmStudioVersion: string | null = null;
  if (process.platform === 'win32') {
    // Только путь установленного приложения; никаких пользовательских настроек модели.
    try {
      const location: unknown = JSON.parse(await text(join(lmStudioRoot, '.internal/app-install-location.json')));
      const path = typeof location === 'string' ? location : location !== null && typeof location === 'object' &&
        'path' in location && typeof location.path === 'string' ? location.path : null;
      if (path && isAbsolute(path) && extname(path).toLowerCase() === '.exe') {
        const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
        const result = await runFile(shell, ['-NoProfile', '-NonInteractive', '-Command', '(Get-Item -LiteralPath $env:COMPANION_VERSION_EXE -ErrorAction Stop).VersionInfo.ProductVersion'], {
          timeout: 2500, maxBuffer: 8192, windowsHide: true, signal,
          env: { ...process.env, COMPANION_VERSION_EXE: path },
        });
        // FileVersion Windows может содержать четвёртый компонент.
        const detected = result.stdout.trim();
        if (/^\d+\.\d+\.\d+(?:\.\d+)?(?:[+-][\w.-]+)?$/.test(detected)) lmStudioVersion = detected;
      }
    } catch { signal.throwIfAborted(); }
  }
  signal.throwIfAborted();
  return {
    lmStudioVersion, sdkVersion: sdkPackage.name === '@lmstudio/sdk' ? version(sdkPackage.version) : null,
    compressorVersion: pluginPackage.name === 'lms-plugin-context-compressor' ? version(pluginPackage.version) : null,
    compressorRevision: manifest.owner === 'rootmonster' && manifest.name === 'context-compressor' && Number.isSafeInteger(manifest.revision) && Number(manifest.revision) >= 0 ? Number(manifest.revision) : null,
    sdkMethods: methods.filter(method => declarations.includes(method)),
    compressorOwnsPredictionLoop: /\.withPredictionLoopHandler\s*\(/.test(entrypoint),
  };
}
