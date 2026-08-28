/**
 * Unit tests for the model-facing error remediation: the remedy appended to
 * guarded-mutation failures, code preservation, and passthrough behavior.
 */

import { describe, expect, it } from 'vitest'
import { FsError } from '@deepseek-ai/dsh-fs'
import { assertFilesystemPath, remediateFsError } from '../src/error.ts'

describe('remediateFsError', () => {
  it('appends the re-read remedy to FS_STALE_VERSION, preserving the code and chaining the cause', () => {
    const original = new FsError('cannot edit "x": file changed since it was read', 'FS_STALE_VERSION')
    const remedied = remediateFsError(original) as FsError
    expect(remedied).toBeInstanceOf(FsError)
    expect(remedied.message).toBe('cannot edit "x": file changed since it was read — re-read the file, then retry')
    expect(remedied.code).toBe('FS_STALE_VERSION')
    expect(remedied.cause).toBe(original)
  })

  it('appends the read remedy to FS_NOT_OBSERVED', () => {
    const remedied = remediateFsError(new FsError('edit requires reading "x" first', 'FS_NOT_OBSERVED')) as FsError
    expect(remedied.message).toBe('edit requires reading "x" first — read the file, then retry')
    expect(remedied.code).toBe('FS_NOT_OBSERVED')
  })

  it('leaves other FsError codes untouched', () => {
    const original = new FsError('no match anywhere', 'FS_EDIT_NOT_FOUND')
    expect(remediateFsError(original)).toBe(original)
  })

  it('leaves non-FsError values untouched', () => {
    const original = new Error('boom')
    expect(remediateFsError(original)).toBe(original)
  })
})

describe('assertFilesystemPath', () => {
  it('names the web remedy for an http(s) URL', () => {
    // `path.resolve` treats a URL as a relative segment, so without this the
    // model gets `not found` for `<cwd>/https:/example.com/a.txt` -- a path it
    // never asked for, and a message that suggests no recovery.
    expect(() => { assertFilesystemPath('https://example.com/a.txt') })
      .toThrow(/is a https URL, not a filesystem path — fetch web content with a web tool such as `web_fetch`/)
    expect(() => { assertFilesystemPath('http://x/y') }).toThrow(/is a http URL/)
  })

  it('carries FS_NOT_FOUND so existing routing is unchanged', () => {
    try {
      assertFilesystemPath('https://example.com/a.txt')
      throw new Error('expected a rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(FsError)
      expect((error as FsError).code).toBe('FS_NOT_FOUND')
    }
  })

  it('rejects any other scheme with a generic remedy, not the web one', () => {
    expect(() => { assertFilesystemPath('ftp://host/f') })
      .toThrow(/is a ftp URL, not a filesystem path — supply a filesystem path instead/)
    expect(() => { assertFilesystemPath('file:///c:/t.txt') }).toThrow(/is a file URL/)
  })

  it('passes ordinary paths through, INCLUDING the Windows shapes that carry a colon', () => {
    // `C:\work.txt` contains a colon and must not read as a scheme; the
    // pattern requires `://`, which a drive letter never produces. UNC paths
    // start with separators and have no scheme at all.
    // Separators are built with fromCharCode(92) rather than written as
    // literals: a lone backslash before w or a is not a valid JS escape and
    // silently collapses to the bare letter, so a literal spelling would
    // assert on C:worka.txt and prove nothing about Windows paths at all.
    const windowsAbsolute = 'C:' + String.fromCharCode(92) + 'work' + String.fromCharCode(92) + 'a.txt'
    const uncShare = String.fromCharCode(92).repeat(2) + 'server' + String.fromCharCode(92) + 'share'
    for (const ok of ['./a.txt', 'a/b.txt', '/home/x/a.txt', windowsAbsolute, 'C:/work/a.txt', uncShare]) {
      expect(() => { assertFilesystemPath(ok) }).not.toThrow()
    }
  })
})
