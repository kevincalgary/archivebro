import crypto from 'node:crypto';
import type { PermissionKind } from '../../shared/types';
import { logger } from '../util/logger';

/**
 * Pending "ask" permission requests, keyed by a server-generated id.
 *
 * A website cannot reach this: the request originates in the main process
 * from Chromium's permission handler, the id is generated here, and the
 * only way to resolve one is the validated `permission:respond` IPC
 * channel, which is reachable exclusively from the trusted chrome window.
 * An unknown or already-used id is ignored, so a reply cannot be forged or
 * replayed to grant a permission that was never asked for.
 */

export interface PendingPermissionRequest {
  requestId: string;
  permission: PermissionKind;
  /** Origin of the page asking, for display. Never a full URL. */
  origin: string;
}

type Resolver = (allow: boolean) => void;

interface PendingEntry extends PendingPermissionRequest {
  resolve: Resolver;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingEntry>();

/** Auto-deny if the user never answers, so a page can't hang on a prompt forever. */
const PROMPT_TIMEOUT_MS = 2 * 60 * 1000;

/** sourceWebContentsId identifies the tab that asked, so the caller can route the prompt to its own window. */
export type PromptEmitter = (request: PendingPermissionRequest, sourceWebContentsId: number) => void;

let emit: PromptEmitter | null = null;

export function setPermissionPromptEmitter(emitter: PromptEmitter | null): void {
  emit = emitter;
}

/**
 * Ask the user. Resolves with their answer, or `false` if nothing can
 * display a prompt or they don't respond in time -- never defaults to
 * allowing.
 */
export function requestPermissionFromUser(
  permission: PermissionKind,
  origin: string,
  sourceWebContentsId: number,
): Promise<boolean> {
  if (!emit) {
    logger.warn('permission.no_prompt_channel_denying', { permission });
    return Promise.resolve(false);
  }

  const requestId = crypto.randomUUID();
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      if (pending.delete(requestId)) {
        logger.info('permission.prompt_timed_out_denying', { permission });
        resolve(false);
      }
    }, PROMPT_TIMEOUT_MS);

    pending.set(requestId, { requestId, permission, origin, resolve, timer });
    emit?.({ requestId, permission, origin }, sourceWebContentsId);
  });
}

/**
 * Resolve a pending prompt. Returns false when the id is unknown (already
 * answered, timed out, or never issued), so a stale or forged reply is a
 * no-op rather than an error.
 */
export function resolvePermissionRequest(requestId: string, allow: boolean): boolean {
  const entry = pending.get(requestId);
  if (!entry) return false;
  pending.delete(requestId);
  clearTimeout(entry.timer);
  logger.info('permission.user_responded', { permission: entry.permission, allow });
  entry.resolve(allow);
  return true;
}

/** Deny everything outstanding, e.g. when the window is going away. */
export function denyAllPendingPermissions(): void {
  for (const [id, entry] of [...pending]) {
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(false);
  }
}

export function pendingPermissionCount(): number {
  return pending.size;
}
