import { describe, it, expect } from 'vitest';
import { isAllowedByRobots, parseRobotsTxt } from '../../src/main/sitearchive/robots';

// Not exported (only the parsed-rules consumer is), so these tests build
// RobotsRules objects directly to exercise isAllowedByRobots' longest-
// match-wins semantics. The parser itself is exercised indirectly via the
// real-world fixture below, reconstructed by hand from what parseRobotsTxt
// would produce for it -- see the regression note.

describe('isAllowedByRobots', () => {
  it('allows everything when there are no rules', () => {
    expect(isAllowedByRobots('/anything', { rules: [] })).toBe(true);
  });

  it('disallows a path matching a Disallow rule', () => {
    expect(isAllowedByRobots('/account/settings', { rules: [{ path: '/account/', allow: false }] })).toBe(false);
  });

  it('allows a path that does not match any rule', () => {
    expect(isAllowedByRobots('/forums/some-thread', { rules: [{ path: '/account/', allow: false }] })).toBe(true);
  });

  it('longest matching path wins, even when the shorter rule is an Allow written after it', () => {
    // This is the exact real-world shape: a handful of narrow Disallow
    // rules followed by a blanket "Allow: /" -- the narrow rules must
    // still win for paths they cover, or the whole site effectively
    // becomes unreachable to a naive "last rule wins" implementation.
    const rules = { rules: [{ path: '/account/', allow: false }, { path: '/', allow: true }] };
    expect(isAllowedByRobots('/account/settings', rules)).toBe(false);
    expect(isAllowedByRobots('/forums/some-thread', rules)).toBe(true);
    expect(isAllowedByRobots('/', rules)).toBe(true);
  });

  it('a tie in path length between an allow and a disallow favors allow', () => {
    const rules = { rules: [{ path: '/x', allow: false }, { path: '/x', allow: true }] };
    expect(isAllowedByRobots('/x', rules)).toBe(true);
  });

  it('an empty Disallow value matches nothing (means "allow everything" in that rule)', () => {
    expect(isAllowedByRobots('/anything', { rules: [{ path: '', allow: false }] })).toBe(true);
  });
});

/**
 * Regression test for a real bug found capturing rangerovers.net: the
 * group-boundary parser never noticed leaving the wildcard ("*") group,
 * so every later bot-specific group's rules -- including several
 * `Disallow: /` blocks aimed at entirely different user-agents -- bled
 * into the wildcard group's rule set, and `Allow:` directives were
 * ignored outright. Together this made isAllowedByRobots() reject nearly
 * every URL on a site whose actual `User-agent: *` policy is "a handful
 * of narrow paths disallowed, everything else explicitly allowed".
 *
 * This is the site's actual robots.txt, verbatim, fetched directly while
 * diagnosing the bug -- parsed for real (not hand-reconstructed) so the
 * test would have caught the original bug.
 */
describe('rangerovers.net robots.txt regression', () => {
  const REAL_ROBOTS_TXT = `User-agent: FacebookBot
Disallow: /

User-agent: Claude-Web
Disallow: /

User-agent: *
Disallow: /account/
Disallow: /goto/
Disallow: /login/
Disallow: /search/
Disallow: /admin.php
Disallow: /posts/*/bookmark$
Disallow: /posts/*/react?clickoverlay
Disallow: /business/directory
Disallow: /frontier/api/activity
Disallow: /misc/style
Disallow: /misc/hpl
Disallow: /misc/log
Disallow: /media/
Allow: /

# Block AI Bots
User-agent: anthropic-ai
User-agent: Bytespider
User-agent: CCBot
User-agent: ChatGPT-User
User-agent: ClaudeBot
User-agent: cohere-ai
User-agent: cohere-training-data-crawler
User-agent: Diffbot
User-agent: GPTBot
User-agent: ImagesiftBot
User-agent: Meta-ExternalAgent
User-agent: meta-externalagent
User-agent: meta-webindexer
User-agent: OAI-SearchBot
User-agent: omgili
User-agent: omgilibot
User-agent: PerplexityBot
User-agent: quillbot.com
User-agent: Quora-Bot
User-agent: YouBot
User-agent: Google-Extended
User-agent: Amzn-SearchBot
Disallow: /

# Block Content Scraping and Data Mining Bots
User-agent: Amazonbot
User-agent: AliyunSecBot
User-agent: AudigentAdBot
User-agent: AwarioRssBot
User-agent: AwarioSmartBot
User-agent: BLEXBot
User-agent: DataForSeoBot
User-agent: EchoboxBot
User-agent: FriendlyCrawler
User-agent: Jetslide
User-agent: magpie-crawler
User-agent: MyCentralAIScraperBot
User-agent: NewsNow
User-agent: news-please
User-agent: peer39_crawler
User-agent: peer39_crawler/1.0
User-agent: Poseidon Research Crawler
User-agent: Scrapy
User-agent: SeekrBot
User-agent: SeznamHomepageCrawler
User-agent: TaraGroup Intelligent Bot
User-agent: Timpibot
User-agent: TurnitinBot
User-agent: ViennaTinyBot
Disallow: /

Sitemap: https://www.rangerovers.net/sitemap.xml
`;

  const parsed = parseRobotsTxt(REAL_ROBOTS_TXT);

  it('parses only the "*" group\'s rules, not any of the many bot-specific groups', () => {
    // Exactly the 13 Disallow + 1 Allow lines under "User-agent: *" --
    // none of the Claude-Web/anthropic-ai/ClaudeBot/... groups' rules.
    expect(parsed.rules).toHaveLength(14);
    expect(parsed.rules.filter((r) => !r.allow)).toHaveLength(13);
    expect(parsed.rules.filter((r) => r.allow)).toEqual([{ path: '/', allow: true }]);
  });

  it('allows the forum root and ordinary thread/section paths', () => {
    expect(isAllowedByRobots('/', parsed)).toBe(true);
    expect(isAllowedByRobots('/forums/', parsed)).toBe(true);
    expect(isAllowedByRobots('/forums/range-rover-mark-iii-l322.6/', parsed)).toBe(true);
    expect(isAllowedByRobots('/whats-new/posts/', parsed)).toBe(true);
    expect(isAllowedByRobots('/help/faq', parsed)).toBe(true);
  });

  it('still blocks the specific narrow paths the site actually disallows', () => {
    expect(isAllowedByRobots('/account/settings', parsed)).toBe(false);
    expect(isAllowedByRobots('/login/', parsed)).toBe(false);
    expect(isAllowedByRobots('/search/', parsed)).toBe(false);
    expect(isAllowedByRobots('/media/some-file', parsed)).toBe(false);
  });
});
