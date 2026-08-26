// Minimal robots.txt support for forum captures.
//
// Scoped narrowly on purpose: fetched once per crawl at the start URL's
// origin, cached for the job's lifetime, and consulted only for the
// "*"" user-agent group (this app doesn't register a specific token with
// any site). Fails open -- an unreachable or unparseable robots.txt never
// blocks a capture, matching how browsers and most crawlers behave, and
// keeps every existing fixture/site without a robots.txt working exactly
// as before.

import { net, type Session } from 'electron';

interface RobotsRule {
  path: string;
  allow: boolean;
}

export interface RobotsRules {
  /** Rules for the "*" group only -- this app doesn't register a specific token with any site. In discovery order; matching uses longest-path-wins, not order. */
  rules: RobotsRule[];
}

const FETCH_TIMEOUT_MS = 8_000;

/** Fetch and parse robots.txt for the given origin. Never throws -- returns an empty rule set (allow everything) on any failure. */
export async function fetchRobotsRules(origin: string, session: Session): Promise<RobotsRules> {
  try {
    const body = await fetchText(`${origin}/robots.txt`, session);
    if (body === null) return { rules: [] };
    return parseRobotsTxt(body);
  } catch {
    return { rules: [] };
  }
}

/**
 * Whether `pathname` (e.g. "/forum/login") is allowed by the given rules.
 *
 * Standard robots.txt semantics: among rules whose path is a prefix of
 * `pathname`, the **longest matching path wins** (not the first or last
 * one written) -- this is what lets a site write a handful of narrow
 * `Disallow` rules followed by a blanket `Allow: /` and have the narrow
 * rules still take precedence, which is a very common real-world pattern
 * (see rangerovers.net's own robots.txt). A tie between an allow and a
 * disallow of the same length favors allow, matching Google's documented
 * algorithm.
 */
export function isAllowedByRobots(pathname: string, rules: RobotsRules): boolean {
  let best: RobotsRule | null = null;
  for (const rule of rules.rules) {
    if (rule.path === '') continue; // an empty Disallow value means "allow everything"; nothing to match
    if (!pathname.startsWith(rule.path)) continue;
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}

/**
 * Parses the `User-agent: *` group's Allow/Disallow rules. Ignores every
 * other group -- this app doesn't self-identify as any specific bot, so
 * only the wildcard group is meaningful here.
 *
 * Group boundaries follow the standard convention: a run of consecutive
 * `User-agent:` lines shares the rules that follow, up until the next
 * `User-agent:` line that comes after at least one rule line -- that one
 * starts a fresh group. A naive "are we currently in the wildcard group"
 * check gets this wrong (it never notices leaving the group), which
 * previously caused every later group's rules -- including AI-crawler-
 * specific `Disallow: /` blocks meant for very different user-agents --
 * to bleed into the wildcard group's rule set.
 */
export function parseRobotsTxt(body: string): RobotsRules {
  const lines = body.split(/\r?\n/);
  const rules: RobotsRule[] = [];
  let inWildcardGroup = false;
  let groupHasRule = false;

  for (const rawLine of lines) {
    const line = rawLine.split('#')[0]!.trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'user-agent') {
      if (groupHasRule) {
        // A rule line already appeared since the last group started, so
        // this user-agent line begins a brand new group rather than
        // extending the previous one.
        inWildcardGroup = false;
        groupHasRule = false;
      }
      if (value === '*') inWildcardGroup = true;
      continue;
    }
    if (field === 'allow' || field === 'disallow') {
      groupHasRule = true;
      if (inWildcardGroup) rules.push({ path: value, allow: field === 'allow' });
    }
  }
  return { rules };
}

function fetchText(url: string, session: Session): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), FETCH_TIMEOUT_MS);
    try {
      const request = net.request({ method: 'GET', url, session, redirect: 'follow' });
      const chunks: Buffer[] = [];
      request.on('response', (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          clearTimeout(timer);
          finish(null);
          response.on('data', () => {});
          return;
        }
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          clearTimeout(timer);
          finish(Buffer.concat(chunks).toString('utf-8'));
        });
        response.on('error', () => {
          clearTimeout(timer);
          finish(null);
        });
      });
      request.on('error', () => {
        clearTimeout(timer);
        finish(null);
      });
      request.end();
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}
