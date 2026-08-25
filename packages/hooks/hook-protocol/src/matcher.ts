/**
 * Matcher shared by both hook dialects. Claude treats alphanumeric/underscore/
 * pipe patterns as literal alternatives — matched exactly but WITHOUT regard to
 * case, because Claude's vocabulary is PascalCase and this harness registers
 * lowercase tool names — and other patterns as regex; Codex treats every
 * non-empty pattern as an unanchored regex. Regexes stay case-sensitive in both
 * dialects. Missing, empty, and `*` match all. Runtime matching contains invalid
 * regexes as non-matches; config parsers use {@link matcherDiagnostic} to reject
 * them with a diagnostic.
 * @module @deepseek-ai/dsh-hook-protocol/matcher
 */

import type { MatcherMode } from './types.ts'

/** True for an absent / empty / `'*'` pattern — the match-all sentinels. */
function isMatchAll(matcher: string | undefined): boolean {
  return matcher === undefined || matcher === '' || matcher === '*'
}

/** A Claude-literal pattern is purely word chars + `|` (the regex-vs-literal discriminator). */
const CLAUDE_LITERAL = /^[A-Za-z0-9_|]+$/

/** Compile an unanchored matcher regex; invalid patterns return `undefined`. */
function compileRegex(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern)
  } catch (_syntaxError) {
    // RegExp construction is the try's only operation, so malformed pattern
    // syntax is the only expected failure.
    return undefined
  }
}

/**
 * Validate one matcher before a bridge accepts its config group.
 * @param matcher - configured pattern; match-all sentinels are valid.
 * @param mode - dialect deciding whether a word-and-pipe pattern is literal.
 * @returns `undefined` for a valid matcher, otherwise a stable diagnostic.
 */
export function matcherDiagnostic(matcher: string | undefined, mode: MatcherMode): string | undefined {
  if (isMatchAll(matcher)) return undefined
  const pattern = matcher as string
  if (mode === 'claude-code' && CLAUDE_LITERAL.test(pattern)) return undefined
  return compileRegex(pattern) === undefined
    ? `invalid ${mode} regex matcher ${JSON.stringify(pattern)}`
    : undefined
}

/**
 * Whether `matcher` selects `query` under the given dialect. Claude literal
 * patterns exact-match pipe-separated alternatives, ignoring case, so a
 * `hooks.json` carried over from Claude Code (`Bash`, `Read`) still selects this
 * harness's `bash` / `read`; all other patterns are unanchored, case-sensitive
 * regexes. Invalid regexes return `false` rather than throwing;
 * bridge config parsers surface them through {@link matcherDiagnostic} before use.
 * @param matcher - the configured pattern; absent/empty/`'*'` are the match-all sentinels.
 * @param query - the candidate value (a tool name, a session source, …).
 * @param mode - the dialect deciding literal-vs-regex interpretation of the pattern.
 * @returns `true` when the pattern selects the query; `false` on a non-match or an invalid
 *   regex.
 */
export function matchesMatcher(matcher: string | undefined, query: string, mode: MatcherMode): boolean {
  if (isMatchAll(matcher)) return true
  // matcher is a non-empty string past the match-all guard.
  const pattern = matcher as string
  if (mode === 'claude-code' && CLAUDE_LITERAL.test(pattern)) {
    // Exact per-alternative, but case-insensitively: Claude's hooks.json
    // vocabulary is PascalCase (`Bash`, `Read`) and this harness registers
    // lowercase tool names, so a case-sensitive compare silently drops every
    // matcher migrated from Claude Code -- including a PreToolUse deny.
    const target = query.toLowerCase()
    return pattern.split('|').some(alternative => alternative.toLowerCase() === target)
  }
  return compileRegex(pattern)?.test(query) ?? false
}
