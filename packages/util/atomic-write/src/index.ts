/**
 * Zero-dependency atomic file replacement and writer coordination.
 * `writeFileAtomic` writes a random-suffix sibling with exclusive create and
 * the caller's permission bits, then renames it over the target, so readers
 * observe either the old or the new complete content and a replaced file ends
 * up with exactly the stated mode. `withFileLock` serializes cross-process
 * writers of one file through a `wx`-created `<file>.lock` sibling, so a
 * read-modify-write cycle can never resurrect a state another writer just
 * replaced; readers stay lock-free because the rename commit is atomic.
 * @module @deepseek-ai/dsh-atomic-write
 */

import { randomBytes } from 'node:crypto'
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Filesystem options for {@link writeFileAtomic}; `mode` is required so the
 * permission decision stays visible at every call site.
 */
export interface WriteFileAtomicOptions {
  /**
   * Permission bits stamped on the fresh temp inode and carried through the
   * rename (subject to the process umask, like every fresh inode).
   */
  mode: number
  /**
   * Permission bits for parent directories this call creates (subject to the
   * umask; existing directories keep their mode). Omission uses the mkdir
   * default — pass `0o700` when the tree holds user-private data.
   */
  dirMode?: number
}

/**
 * Replace `filename` with `content` in one atomic step, creating parent
 * directories. The content is first written to a random-suffix sibling opened
 * with exclusive create (`wx`): the open refuses to follow a symlink planted
 * at the temp path, and the fresh inode carries `options.mode` through the
 * rename, so replacing a wider-permission file narrows it without a chmod
 * race. The rename also replaces a symlinked target itself instead of writing
 * through to its referent, and the same-directory sibling keeps the rename on
 * one filesystem. On any failure the temp file is removed and the failure
 * rethrown. Crash durability (fsync) is out of scope.
 * @param filename - final path receiving the content.
 * @param content - complete next file content.
 * @param options - permission bits for the replacement inode.
 */
export async function writeFileAtomic(filename: string, content: string, options: WriteFileAtomicOptions): Promise<void> {
  await mkdir(dirname(filename), {
    recursive: true,
    ...options.dirMode === undefined ? {} : { mode: options.dirMode },
  })
  // TODO(settings-atomic-durability): Use a replacement that fsyncs the file
  // and parent directory and preserves owner-only permissions on Windows.
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, content, { mode: options.mode, flag: 'wx' })
    await rename(temp, filename)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/** Whether an exclusive create found an existing lock. */
async function isLockContention(error: unknown, lockPath: string): Promise<boolean> {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'EEXIST') return true
  if (code !== 'EPERM') return false
  try {
    await lstat(lockPath)
    return true
  } catch {
    // Keep the original EPERM authoritative when lock existence is unproven.
    return false
  }
}

/**
 * Retry cadence for a contended lock. These stay robustness invariants of the
 * cross-process write protocol rather than deployment tunables: they govern how
 * often a contender asks, which no caller has a reason to vary.
 */
const LOCK_RETRY_INITIAL_MS = 20
const LOCK_RETRY_MAX_MS = 200

/**
 * How long a contender waits when the caller states no limit — sized for the
 * render-and-rename cycle every call site had when this package was written.
 * Expiry fails the contender rather than guessing whether the existing lock
 * still has an owner. How long is *worth* waiting is a property of the
 * operation the lock holder runs, which is why {@link FileLockOptions.waitMs}
 * exists; the value here is the floor for an operation that does file work
 * alone.
 */
const DEFAULT_LOCK_WAIT_MS = 2_000

/** Options for one {@link withFileLock} acquisition. */
export interface FileLockOptions {
  /**
   * Maximum time to wait for the lock, in milliseconds. State one when the
   * holder's operation legitimately runs longer than file work — a credential
   * mutation that refreshes a token performs a network round trip while
   * holding the lock, and leaving the default in place would fail every other
   * writer of the same file for the duration. Waiting is productive: a
   * contender that acquires the lock afterwards re-reads the committed state.
   */
  waitMs?: number
}

/**
 * Hold the cross-process writer lock for `filename` around one operation. The
 * lock is a `wx`-created sibling (`<filename>.lock`); paired with the
 * rename-based commit of {@link writeFileAtomic}, readers stay lock-free and
 * only writers contend. `EEXIST` is contention directly; an `EPERM` is
 * contention only when a fresh `lstat` confirms the lock path exists, covering
 * Windows exclusive-create behavior without hiding an unrelated permission
 * failure. Contention backs off exponentially and fails with a timed-out error
 * after the deadline. The contender never removes an existing lock because
 * file age cannot prove that its owner stopped; orphan recovery is an operator
 * action. The parent directory must exist.
 *
 * That refusal is what makes RELEASING the lock load-bearing rather than
 * incidental: a lock outliving its holder never heals, so the release retries
 * the transient Windows refusals to unlink a file another process holds open
 * (see {@link MAX_LOCK_RELEASE_ATTEMPTS}). A release that still cannot happen
 * after a successful operation is reported rather than swallowed, because the
 * alternative is returning success while every future write to the file is
 * already doomed. When the operation itself threw, the release stays quiet and
 * that error propagates unchanged.
 * @param filename - the file whose writers this lock serializes.
 * @param operation - the read-render-commit cycle to run while holding the lock.
 * @param options - acquisition options; omitted waits {@link DEFAULT_LOCK_WAIT_MS}.
 * @returns the operation's result; the lock releases on both outcomes.
 */
export async function withFileLock<T>(
  filename: string,
  operation: () => Promise<T>,
  options?: FileLockOptions,
): Promise<T> {
  const lockPath = `${filename}.lock`
  const deadline = Date.now() + (options?.waitMs ?? DEFAULT_LOCK_WAIT_MS)
  let delay = LOCK_RETRY_INITIAL_MS
  for (;;) {
    try {
      await writeFile(lockPath, `${process.pid}\n`, { mode: 0o600, flag: 'wx' })
      break
    } catch (error) {
      if (!await isLockContention(error, lockPath)) throw error
    }
    if (Date.now() >= deadline) {
      throw new Error(`atomic-write: timed out waiting for the writer lock at ${lockPath}`)
    }
    await new Promise(resolve => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS)
  }
  try {
    const result = await operation()
    // Release on the success path is NOT best-effort. A lock that outlives its
    // holder is permanent by design -- a contender refuses to remove a lock it
    // does not own, and nothing ages one out -- so a silent failure here
    // reports success while bricking every future write to this file. Failing
    // loudly names the file to delete; the alternative is a product that stops
    // saving settings and says nothing.
    await releaseFileLock(lockPath, 'strict')
    return result
  } catch (error) {
    // The operation's own failure is the more useful one, so the release must
    // not overwrite it -- but it still gets the retries, because a leak here is
    // just as permanent.
    await releaseFileLock(lockPath, 'best-effort')
    throw error
  }
}

/**
 * How many times to reattempt a refused lock removal before giving up.
 *
 * Removing the lock is the one step that has no alternative: `force` covers a
 * lock already gone, but not a Windows refusal to unlink a file something else
 * holds open. An antivirus scanner reading the just-written file, or a watcher
 * (this repo runs chokidar over exactly these paths), takes a transient handle
 * and the unlink fails EPERM/EBUSY/EACCES for as long as it is held -- usually
 * milliseconds. POSIX unlinks a file with open handles happily, which is why
 * this is a Windows-shaped bug that survived CI on every other platform.
 */
const MAX_LOCK_RELEASE_ATTEMPTS = 5
const LOCK_RELEASE_RETRY_MS = 20

/**
 * Remove the writer lock, retrying the transient Windows sharing refusals.
 * @param lockPath - the lock created by this holder.
 * @param mode - `strict` rethrows a lock that would not go, naming it;
 *   `best-effort` returns quietly so it cannot mask a failure already in hand.
 */
async function releaseFileLock(lockPath: string, mode: 'strict' | 'best-effort'): Promise<void> {
  let delay = LOCK_RELEASE_RETRY_MS
  for (let attempt = 1; ; attempt++) {
    try {
      await rm(lockPath, { force: true })
      return
    } catch (error) {
      if (attempt >= MAX_LOCK_RELEASE_ATTEMPTS) {
        if (mode === 'best-effort') return
        throw new Error(
          `atomic-write: wrote ${lockPath.replace(/\.lock$/u, '')} but could not remove its writer lock at `
          + `${lockPath}; every later write to this file will time out until it is deleted`,
          { cause: error },
        )
      }
      await new Promise(resolve => setTimeout(resolve, delay))
      delay *= 2
    }
  }
}
