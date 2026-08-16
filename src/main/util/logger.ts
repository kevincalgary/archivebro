import { app } from 'electron';
import { createWriteStream, existsSync, mkdirSync, type WriteStream } from 'node:fs';
import path from 'node:path';

// Structured logs, one JSON object per line. Deliberately never given raw
// page content, credentials, or full URLs unless diagnosticLogging is on
// (see settingsStore) -- callers pass a `redactedUrl` (domain only) by
// default and must opt in explicitly to log a full URL.

type Level = 'debug' | 'info' | 'warn' | 'error';

interface LogFields {
  [key: string]: string | number | boolean | null | undefined;
}

let stream: WriteStream | null = null;
let diagnosticLoggingEnabled = false;

export function initLogger(): void {
  const dir = path.join(app.getPath('userData'), 'logs');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `archive-browser-${new Date().toISOString().slice(0, 10)}.log`);
  stream = createWriteStream(file, { flags: 'a' });
}

export function setDiagnosticLogging(enabled: boolean): void {
  diagnosticLoggingEnabled = enabled;
}

export function isDiagnosticLoggingEnabled(): boolean {
  return diagnosticLoggingEnabled;
}

function write(level: Level, message: string, fields?: LogFields): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (stream) stream.write(line + '\n');
  const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  consoleFn(`[${level}] ${message}`, fields ?? '');
}

export const logger = {
  debug: (message: string, fields?: LogFields) => write('debug', message, fields),
  info: (message: string, fields?: LogFields) => write('info', message, fields),
  warn: (message: string, fields?: LogFields) => write('warn', message, fields),
  error: (message: string, fields?: LogFields) => write('error', message, fields),
};

/** Reduce a URL to just its origin/domain for safe-by-default logging. */
export function redactUrl(url: string): string {
  if (diagnosticLoggingEnabled) return url;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '[unparsable-url]';
  }
}
