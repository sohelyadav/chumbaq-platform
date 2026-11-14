import { readFile } from 'fs/promises';
import { devices, type Browser, type BrowserContext, type BrowserContextOptions, type Download, type Locator, type Page } from '@playwright/test';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { newClientIp } from './api';

/**
 * Small browser tools the specs share: reading downloads byte for byte, decoding QR
 * codes, phone-shaped contexts, the clipboard, and a fixed locale and time zone.
 */

// ---- Downloads

export interface DownloadedFile {
  /** The name the browser was told to save it as. */
  filename: string;
  bytes: Buffer;
  /** Decoded as UTF-8, exactly: a BOM stays as U+FEFF and CRLF stays as \r\n. */
  text: string;
  /** Starts with the UTF-8 byte order mark (EF BB BF). */
  hasBom: boolean;
  /** The line endings in it: all CRLF, all LF, a mix of both, or no line breaks at all. */
  lineEndings: 'crlf' | 'lf' | 'mixed' | 'none';
  /**
   * The text with the invisible made visible, for assertions and failure messages:
   * the BOM as `<BOM>`, each CR as `\r` (so CRLF reads `\r` then a real newline).
   */
  visible: string;
  /** The lines, without the BOM and without their line endings (a final empty line dropped). */
  lines: string[];
}

/** Reads a finished download (waits for it to finish). */
export async function readDownload(download: Download): Promise<DownloadedFile> {
  const filePath = await download.path();
  if (!filePath) throw new Error(`Download ${download.suggestedFilename()} failed: ${await download.failure()}`);
  const bytes = await readFile(filePath);
  return describeDownload(download.suggestedFilename(), bytes);
}

/** `readDownload` for bytes in hand (also what its own tests use). */
export function describeDownload(filename: string, bytes: Buffer): DownloadedFile {
  const text = bytes.toString('utf8');
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  const lineEndings = crlf && lf ? 'mixed' : crlf ? 'crlf' : lf ? 'lf' : 'none';
  const visible = text.replace(/﻿/g, '<BOM>').replace(/\r/g, '\\r');
  const body = hasBom ? text.slice(1) : text;
  const lines = body.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return { filename, bytes, text, hasBom, lineEndings, visible, lines };
}

/** Clicks `trigger` and reads the download it starts. */
export async function downloadFrom(page: Page, trigger: Locator): Promise<DownloadedFile> {
  const [download] = await Promise.all([page.waitForEvent('download'), trigger.click()]);
  return readDownload(download);
}

// ---- QR codes

/** The text a QR code in a PNG holds, or an error when no code can be read in it. */
export function decodeQr(png: Buffer): string {
  const image = PNG.sync.read(png);
  const found = jsQR(new Uint8ClampedArray(image.data.buffer, image.data.byteOffset, image.data.length), image.width, image.height);
  if (!found) throw new Error(`No QR code found in the ${image.width}x${image.height} image`);
  return found.data;
}

/**
 * The text of a QR code on the page (an <img>, <canvas> or <svg>), read from a
 * screenshot of the element, as a phone camera would read it off the screen.
 */
export async function decodeQrOnPage(element: Locator): Promise<string> {
  return decodeQr(await element.screenshot({ type: 'png', animations: 'disabled' }));
}

// ---- Contexts

/** What every context of the stack needs: its self-signed certificates and an address of its own. */
function stackContextOptions(baseURL: string | undefined, ip: string): BrowserContextOptions {
  return { baseURL, ignoreHTTPSErrors: true, extraHTTPHeaders: { 'X-Forwarded-For': ip } };
}

const PHONES = {
  ios: devices['iPhone 15'],
  android: devices['Pixel 7'],
} as const;

/**
 * A phone-shaped context: an iPhone (iOS Safari's user agent) or a Pixel (Android
 * Chrome's), with its screen, touch and mobile viewport. The engine is still the
 * browser's (Chromium in this suite): what changes is what the server and the page see,
 * which is what the short-link interstitial decides on.
 */
export async function mobileContext(
  browser: Browser,
  platform: 'ios' | 'android',
  options: BrowserContextOptions & { baseURL?: string } = {},
): Promise<{ context: BrowserContext; ip: string }> {
  const { defaultBrowserType: _engine, ...phone } = PHONES[platform];
  const ip = newClientIp();
  const context = await browser.newContext({ ...phone, ...stackContextOptions(options.baseURL, ip), ...options });
  return { context, ip };
}

/**
 * A context with a fixed locale and time zone (defaults: en-IN, Asia/Kolkata), so
 * dates, times and numbers the page formats are the same on every machine.
 */
export async function fixedLocaleContext(
  browser: Browser,
  options: BrowserContextOptions & { baseURL?: string; locale?: string; timezoneId?: string } = {},
): Promise<{ context: BrowserContext; ip: string }> {
  const ip = newClientIp();
  const context = await browser.newContext({
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    ...stackContextOptions(options.baseURL, ip),
    ...options,
  });
  return { context, ip };
}

// ---- Clipboard

/**
 * Lets pages on `origin` (default: the page's own) read and write the clipboard without
 * a prompt, as "Copy" buttons need.
 */
export async function allowClipboard(page: Page, origin = new URL(page.url()).origin): Promise<void> {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
}

/** What is on the clipboard now, read in the page (call `allowClipboard` first). */
export async function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}
