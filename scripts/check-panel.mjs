import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startManagementServer } from '../dist/host/src/server.js';

const directory = await mkdtemp(join(tmpdir(), 'companion panel test '));
const state = { connected: true, slow: false, aborted: false };
const report = () => ({ lmStudioVersion: '0.4.26', checkedAt: new Date().toISOString(), features: { connection: { state: state.connected ? 'verified' : 'unknown', evidence: state.connected ? 'Локальный API отвечает.' : 'API недоступен.' }, thinking: { state: 'unsupported', evidence: 'В контрольном сценарии механизм недоступен.' } } });
const host = await startManagementServer(directory, new AbortController().signal, { probe: async signal => {
  if (state.slow) { await new Promise(resolve => signal.addEventListener('abort', () => { state.aborted = true; resolve(); }, { once: true })); signal.throwIfAborted(); }
  return report();
} });
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.COMPANION_BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(token => { if (!sessionStorage.getItem('companion-token')) history.replaceState(null, '', '#token=' + token); }, host.token);
  await page.goto(host.origin);
  await page.getByRole('heading', { name: 'LM Studio подключена', exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, '');
  await page.locator('summary').click();
  assert.equal(await page.getByText('Не поддерживается', { exact: true }).count(), 1);
  await page.locator('summary').click();
  const artifactDir = resolve('data/ui'); await mkdir(artifactDir, { recursive: true });
  await page.screenshot({ path: join(artifactDir, 'panel-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Память', exact: true }).click();
  await page.getByRole('heading', { name: 'Память', exact: true }).waitFor();
  await page.getByRole('button',{name:'Добавить запись',exact:true}).waitFor();
  assert.match(await page.locator('main').innerText(), /В чат они пока не подставляются/i);
  await page.getByRole('button', { name: 'Обзор', exact: true }).click();
  state.slow = true;
  await page.getByRole('button', { name: 'Проверить подключение', exact: true }).click();
  await page.getByRole('button', { name: 'Отменить', exact: true }).click();
  await page.getByRole('paragraph').filter({ hasText: 'Проверка отменена. Предыдущий результат сохранён.' }).waitFor();
  for (let n = 0; n < 50 && !state.aborted; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(state.aborted, true); state.slow = false; state.connected = false;
  await page.getByRole('button', { name: 'Проверить подключение', exact: true }).click();
  await page.getByRole('heading', { name: 'Нет подключения к LM Studio', exact: true }).waitFor();
  await page.screenshot({ path: join(artifactDir, 'panel-offline.png'), fullPage: true });
  await page.setViewportSize({ width: 320, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(artifactDir, 'panel-mobile.png'), fullPage: true });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  if (!await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)) {
    console.log('Overflow at 200%:', await page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 0).map(e => ({ tag: e.tagName, class: e.className, width: e.clientWidth, contentWidth: e.scrollWidth }))));
    await page.screenshot({ path: join(artifactDir, 'panel-overflow.png'), fullPage: true });
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.tagName === 'A' || document.activeElement?.tagName === 'BUTTON'), true);
  assert.deepEqual(errors, []);
  console.log('PASS panel: connected, unavailable, cancellation, offline, 320px, 200% text, keyboard, no page errors');
} finally { await browser?.close(); await host.close(); await rm(directory, { recursive: true, force: true }); }
