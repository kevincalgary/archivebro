import type { CaptureScopeKind } from '../../../shared/sitearchiveTypes';

/** Shared between CaptureProgressDialog and RecoveryDialog so the two can't drift. */
export const SCOPE_LABEL: Record<CaptureScopeKind, string> = {
  'current-page': 'Current page only',
  'entire-site': 'Entire website',
  custom: 'Custom scope',
  'forum-thread': 'This forum thread',
  'forum-section': 'This forum section',
  'forum-whole': 'Entire forum',
};

export function scopeLabel(kind: string): string {
  return SCOPE_LABEL[kind as CaptureScopeKind] ?? kind;
}
