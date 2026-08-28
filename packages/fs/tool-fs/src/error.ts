/**
 * Model-facing remediation for guarded-mutation failures. The provider's
 * `FS_STALE_VERSION` and `FS_NOT_OBSERVED` messages state the condition but
 * not the only correct recovery (re-read / read the file), so this package
 * appends the remedy at the model boundary; provider messages stay
 * machine-oriented and unchanged.
 * @module @deepseek-ai/dsh-tool-fs/src/error
 */

import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsErrorCode } from '@deepseek-ai/dsh-fs'

/** The remedy appended to each remediable failure code's message. */
const REMEDIES: Partial<Record<FsErrorCode, string>> = {
  FS_STALE_VERSION: 're-read the file, then retry',
  FS_NOT_OBSERVED: 'read the file, then retry',
}

/**
 * Append the correct recovery instruction to a guarded-mutation failure's
 * message. `FS_STALE_VERSION` (the file changed since this session's last
 * observation, including a missing target) recovers only by re-reading;
 * `FS_NOT_OBSERVED` (no prior read by this session) by reading. The `FsError`
 * code is preserved so retry/permission/UI layers keep routing on it, and the
 * original error chains as `cause`. Anything else passes through untouched.
 * @param error - the caught value from a write/edit execution.
 * @returns a remediated `FsError` for the two guarded-mutation codes, else the original value.
 */
export function remediateFsError(error: unknown): unknown {
  if (!(error instanceof FsError)) return error
  const remedy = REMEDIES[error.code]
  if (!remedy) return error
  return new FsError(`${error.message} — ${remedy}`, error.code, { cause: error })
}

/**
 * A URI scheme followed by an authority, e.g. `https://`. Deliberately not
 * anchored to http alone: any scheme reaching a path parameter is the same
 * mistake.
 */
const URI_SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i

/**
 * Reject a URL supplied where a filesystem path belongs, with the remedy.
 *
 * `path.resolve` treats a URL as a relative segment, so
 * `https://example.com/a.txt` becomes `<cwd>/https:/example.com/a.txt` and the
 * model receives `not found` for a path it never asked for. The condition is
 * stated but the recovery is not, which is the same gap `remediateFsError`
 * closes for guarded mutations -- so it is closed here in the same place, at
 * the model boundary, before the call reaches the filesystem at all.
 * @param requestedPath - the raw path supplied to the tool.
 */
export function assertFilesystemPath(requestedPath: string): void {
  const scheme = URI_SCHEME.exec(requestedPath)?.[1]?.toLowerCase()
  if (scheme === undefined) return
  const remedy = scheme === 'http' || scheme === 'https'
    ? 'fetch web content with a web tool such as `web_fetch`'
    : 'supply a filesystem path instead'
  throw new FsError(
    `"${requestedPath}" is a ${scheme} URL, not a filesystem path — ${remedy}`,
    'FS_NOT_FOUND',
  )
}
