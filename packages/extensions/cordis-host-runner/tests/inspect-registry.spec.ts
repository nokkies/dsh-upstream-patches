/**
 * The Host inspect registry is process-global, but the packages that populate
 * it mount per preset: two cordis-based presets alive in one process each
 * register the same first-party providers. These suites pin that a repeat
 * registration of the SAME contract shares the entry instead of failing the
 * second mount, that the entry outlives every holder but the last, and that a
 * genuinely different contract under a taken id still fails loudly.
 *
 * The disposal cases are the load-bearing ones. A registry that REPLACED on
 * duplicate would satisfy the coexistence case and still be broken: the second
 * mount's disposer would drop an entry the first mount still depends on, so
 * unmounting one preset would take another preset's providers dark with no
 * error at all.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue, SessionId } from '@deepseek-ai/dsh-session/types'
import { CordisInspectRegistryService } from '../src/inspect-registry.ts'
import type { HostCordisInspectProviderRegistration } from '../src/inspect-registry.ts'

const AGENT = { id: 'S-a' as SessionId, steer() {}, inject() {} } as unknown as Agent

/** A provider whose answer identifies WHICH registration is serving. */
function provider(answer: string, description = 'Shared first-party provider.'): HostCordisInspectProviderRegistration {
  return {
    manifest: {
      id: 'Service',
      description,
      methods: [{
        name: 'listService',
        description: 'Return the compact Service directory.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: { description: 'JSON data owned by this inspect provider.' },
      }],
    },
    query: () => Promise.resolve({ from: answer } as unknown as JsonValue),
  }
}

function registry(): CordisInspectRegistryService {
  return new CordisInspectRegistryService(new Context())
}

async function ask(subject: CordisInspectRegistryService): Promise<JsonValue> {
  return subject.query('host', 'Service', 'listService', undefined, AGENT, new AbortController().signal)
}

describe('duplicate Host inspect registration', () => {
  it('lets a second preset mount the same provider instead of failing', () => {
    const subject = registry()
    subject.register(provider('first'))

    expect(() => subject.register(provider('second'))).not.toThrow()
    // Shared, not doubled: the directory the model sees stays one row per id.
    expect(subject.list().filter(entry => entry.id === 'Service')).toHaveLength(1)
  })

  it('keeps the first registration serving rather than replacing it', async () => {
    const subject = registry()
    subject.register(provider('first'))
    subject.register(provider('second'))

    await expect(ask(subject)).resolves.toEqual({ from: 'first' })
  })

  it('survives one holder disposing while another is still mounted', async () => {
    const subject = registry()
    subject.register(provider('first'))
    const disposeSecond = subject.register(provider('second'))

    disposeSecond()

    // The exact regression a replacing registry would ship: the first preset is
    // still mounted, so its provider must still answer.
    expect(subject.list().filter(entry => entry.id === 'Service')).toHaveLength(1)
    await expect(ask(subject)).resolves.toEqual({ from: 'first' })
  })

  it('removes the entry only when the last holder disposes', () => {
    const subject = registry()
    const disposeFirst = subject.register(provider('first'))
    const disposeSecond = subject.register(provider('second'))

    disposeFirst()
    expect(subject.list().filter(entry => entry.id === 'Service')).toHaveLength(1)

    disposeSecond()
    expect(subject.list().filter(entry => entry.id === 'Service')).toHaveLength(0)
  })

  it('ignores a repeated disposer instead of dropping a live holder', async () => {
    const subject = registry()
    subject.register(provider('first'))
    const disposeSecond = subject.register(provider('second'))

    disposeSecond()
    disposeSecond()

    // A refcount would have decremented twice here and evicted the survivor.
    await expect(ask(subject)).resolves.toEqual({ from: 'first' })
  })

  it('still rejects a different contract under a taken id', () => {
    const subject = registry()
    subject.register(provider('first'))

    expect(() => subject.register(provider('second', 'A different provider wearing a taken id.')))
      .toThrow(/already registered/u)
  })
})
