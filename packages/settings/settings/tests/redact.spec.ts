import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { redactSecrets, scrubSchemaSecrets, UnprovableSchemaError } from '../src/index.ts'
import { MemorySettings } from './memory.ts'

const Profile = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref'),
  baseURL: z.string(),
})

const Adapter: z<object> = z.object({
  apiKey: z.string().role('secret'),
  providers: z.dict(Profile),
  fallbacks: z.array(Profile),
  nested: z.object({
    token: z.string().role('secret'),
  }),
})

describe('redactSecrets', () => {
  it('strips secrets from object, dict, and array containers and records each position', () => {
    const { value, secrets } = redactSecrets(Adapter as z<never>, {
      apiKey: 'top-secret',
      providers: {
        openai: { apiKey: 'sk-live', apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://x' },
        anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
      },
      fallbacks: [{ apiKey: 'fb', baseURL: 'https://y' }],
      nested: {},
    })
    expect(value).toEqual({
      providers: {
        openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://x' },
        anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
      },
      fallbacks: [{ baseURL: 'https://y' }],
      nested: {},
    })
    expect(secrets).toEqual([
      { path: ['apiKey'], set: true },
      { path: ['providers', 'openai', 'apiKey'], set: true },
      { path: ['providers', 'anthropic', 'apiKey'], set: false },
      { path: ['fallbacks', '0', 'apiKey'], set: true },
      { path: ['nested', 'token'], set: false },
    ])
  })

  it('enumerates unset object-property slots without inventing containers', () => {
    const { value, secrets } = redactSecrets(Adapter as z<never>, undefined)
    expect(value).toBeUndefined()
    expect(secrets).toEqual([
      { path: ['apiKey'], set: false },
      { path: ['nested', 'token'], set: false },
    ])
  })

  it('never mutates the input and preserves keys outside the schema', () => {
    const input = Object.freeze({
      apiKey: 'frozen',
      extra: Object.freeze({ keep: true }),
    })
    const { value } = redactSecrets(Adapter as z<never>, input)
    expect(input.apiKey).toBe('frozen')
    expect(value).toEqual({ extra: { keep: true }, nested: undefined } as never)
    expect((value as { extra: unknown }).extra).toEqual({ keep: true })
  })

  it('passes malformed container values through untouched', () => {
    const { value, secrets } = redactSecrets(Adapter as z<never>, {
      providers: 'not-a-dict',
      fallbacks: 'not-an-array',
    })
    expect(value).toEqual({ providers: 'not-a-dict', fallbacks: 'not-an-array' })
    expect(secrets).toEqual([
      { path: ['apiKey'], set: false },
      { path: ['nested', 'token'], set: false },
    ])
  })

  it('treats a secret-role container as one opaque secret leaf', () => {
    const Weird = z.object({ blob: z.object({ inner: z.string() }).role('secret') })
    const { value, secrets } = redactSecrets(Weird as z<never>, { blob: { inner: 'x' } })
    expect(value).toEqual({})
    expect(secrets).toEqual([{ path: ['blob'], set: true }])
  })

  it('drops a dict entry whose entire value is the secret', () => {
    const Tokens = z.object({ tokens: z.dict(z.string().role('secret')) })
    const { value, secrets } = redactSecrets(Tokens as z<never>, { tokens: { a: 'x', b: 'y' } })
    expect(value).toEqual({ tokens: {} })
    expect(secrets).toEqual([
      { path: ['tokens', 'a'], set: true },
      { path: ['tokens', 'b'], set: true },
    ])
  })

  it('tolerates structural nodes missing their relation maps', () => {
    expect(redactSecrets({ type: 'dict' } as never, { k: 'v' })).toEqual({ value: { k: 'v' }, secrets: [] })
    expect(redactSecrets({ type: 'object' } as never, { k: 'v' })).toEqual({ value: { k: 'v' }, secrets: [] })
    expect(redactSecrets({ type: 'array' } as never, ['v'])).toEqual({ value: ['v'], secrets: [] })
    expect(redactSecrets({ type: 'tuple' } as never, ['v'])).toEqual({ value: ['v'], secrets: [] })
    expect(redactSecrets({ type: 'tuple' } as never, 'v')).toEqual({ value: 'v', secrets: [] })
    expect(redactSecrets({ type: 'union' } as never, 'v')).toEqual({ value: 'v', secrets: [] })
  })

  it('walks const unions and other safe leaves without touching their values', () => {
    const Consts = z.object({ mode: z.union(['a', 'b'] as const).default('a'), key: z.string().role('secret') })
    const { value, secrets } = redactSecrets(Consts as z<never>, { mode: 'b', key: 'k' })
    expect(value).toEqual({ mode: 'b' })
    expect(secrets).toEqual([{ path: ['key'], set: true }])
    expect(redactSecrets({ type: 'const' } as never, 5)).toEqual({ value: 5, secrets: [] })
    expect(redactSecrets({ type: 'any' } as never, { whatever: 1 })).toEqual({ value: { whatever: 1 }, secrets: [] })
  })

  it('strips secrets declared in either object branch of a top-level union', () => {
    const Either = z.union([
      z.object({ apiKey: z.string().role('secret') }),
      z.object({ nested: z.object({ apiKey: z.string().role('secret') }) }),
    ])
    const fromBranchTwo = redactSecrets(Either as z<never>, { nested: { apiKey: 'x' } })
    expect(fromBranchTwo.value).toEqual({ nested: {} })
    expect(fromBranchTwo.secrets).toEqual([
      { path: ['apiKey'], set: false },
      { path: ['nested', 'apiKey'], set: true },
    ])
    const fromBranchOne = redactSecrets(Either as z<never>, { apiKey: 'y' })
    expect(fromBranchOne.value).toEqual({})
    expect(fromBranchOne.secrets).toEqual([
      { path: ['apiKey'], set: true },
      { path: ['nested', 'apiKey'], set: false },
    ])
  })

  it('enumerates union secret slots for an unset value', () => {
    const Either = z.union([
      z.object({ apiKey: z.string().role('secret') }),
      z.object({ nested: z.object({ apiKey: z.string().role('secret') }) }),
    ])
    const { value, secrets } = redactSecrets(Either as z<never>, undefined)
    expect(value).toBeUndefined()
    expect(secrets).toEqual([
      { path: ['apiKey'], set: false },
      { path: ['nested', 'apiKey'], set: false },
    ])
  })

  it('strips secrets declared in any member of an intersection', () => {
    const Both = z.intersect([
      z.object({ apiKey: z.string().role('secret') }),
      z.object({ plain: z.string() }),
    ])
    const { value, secrets } = redactSecrets(Both as z<never>, { apiKey: 's', plain: 'p' })
    expect(value).toEqual({ plain: 'p' })
    expect(secrets).toEqual([{ path: ['apiKey'], set: true }])
  })

  it('walks tuple members by index', () => {
    const Pair = z.tuple([z.string().role('secret'), z.string()])
    const { value, secrets } = redactSecrets(Pair as z<never>, ['s', 'p'])
    expect(value).toEqual([undefined, 'p'])
    expect(secrets).toEqual([{ path: ['0'], set: true }])
  })

  it('redacts every secret array index when a union branch is an all-secret array', () => {
    const List = z.union([z.array(z.string().role('secret')), z.string()])
    const { value, secrets } = redactSecrets(List as z<never>, ['x', 'y'])
    expect(value).toEqual([undefined, undefined])
    expect(secrets).toEqual([
      { path: ['0'], set: true },
      { path: ['1'], set: true },
    ])
  })

  it('resolves a secret declared at different depths in different union branches', () => {
    // Branch one declares `a` itself a secret leaf; branch two declares a
    // secret under `a`. The value matching branch two loses all of `a`.
    const Shallow = z.union([
      z.object({ a: z.string().role('secret') }),
      z.object({ a: z.object({ x: z.string().role('secret') }) }),
    ])
    const { value, secrets } = redactSecrets(Shallow as z<never>, { a: { x: '1' } })
    expect(value).toEqual({})
    expect(secrets).toEqual([
      { path: ['a'], set: true },
      { path: ['a', 'x'], set: true },
    ])
  })

  it('fails closed on a transform node, including one nested in a union branch', () => {
    expect(() => redactSecrets(z.object({ blob: z.transform(z.string(), v => v.trim()) }) as z<never>, { blob: ' x ' }))
      .toThrow(UnprovableSchemaError)
    expect(() => redactSecrets(z.union([z.string(), z.transform(z.string(), v => v)]) as z<never>, 'x'))
      .toThrow(UnprovableSchemaError)
  })

  it('fails closed on a lazy node and on an unknown node type', () => {
    expect(() => redactSecrets(z.lazy(() => z.string()) as z<never>, 'x')).toThrow(UnprovableSchemaError)
    expect(() => redactSecrets({ type: 'mystery' } as never, 'x')).toThrow(
      'redactSecrets: a "mystery" node at [] can contain secrets the walker cannot verify',
    )
    expect(() => redactSecrets({} as never, 'x')).toThrow(
      'redactSecrets: a "unknown" node at [] can contain secrets the walker cannot verify',
    )
  })
})

describe('scrubSchemaSecrets', () => {
  it('removes meta.default from secret-marked nodes only, in place', () => {
    const envelope = {
      uid: 1,
      refs: {
        1: { type: 'object', dict: { apiKey: 2, plain: 3 } },
        2: undefined,
        3: { type: 'string', meta: { role: 'secret', default: 'leaked' } },
        4: { type: 'string', meta: { default: 'visible' } },
      },
    }
    const out = scrubSchemaSecrets(envelope)
    expect(out).toBe(envelope)
    const refs = envelope.refs as Record<string, { meta?: { default?: unknown } } | undefined>
    expect(refs[3]).toEqual({ type: 'string', meta: { role: 'secret' } })
    expect(refs[4]).toEqual({ type: 'string', meta: { default: 'visible' } })
  })

  it('returns non-envelope inputs untouched', () => {
    expect(scrubSchemaSecrets(null)).toBeNull()
    expect(scrubSchemaSecrets('nope')).toBe('nope')
    expect(scrubSchemaSecrets({})).toEqual({})
    expect(scrubSchemaSecrets({ refs: null })).toEqual({ refs: null })
  })
})

describe('describe() layers and redaction', () => {
  const NS = 'adapter'

  async function boot(doc?: Record<string, unknown>) {
    const ctx = new Context()
    await ctx.plugin(MemorySettings, doc === undefined ? undefined : { doc })
    return ctx
  }

  it('exposes detached base and user layers beside the resolved value', async () => {
    const ctx = await boot({ adapter: { baseURL: 'https://user' } })
    const base = { apiKey: 'entry-key', baseURL: 'https://base' }
    ctx.settings.register(NS, Profile, { base })
    const [descriptor] = ctx.settings.describe()
    expect(descriptor?.base).toEqual(base)
    expect(descriptor?.base).not.toBe(base)
    expect(descriptor?.user).toEqual({ baseURL: 'https://user' })
    expect(descriptor?.value).toEqual({ apiKey: 'entry-key', baseURL: 'https://user' })
    ;(descriptor?.user as Record<string, unknown>).baseURL = 'mutated'
    expect(ctx.settings.describe()[0]?.user).toEqual({ baseURL: 'https://user' })
    expect(descriptor?.secrets).toBeUndefined()
  })

  it('omits the layers when neither a base nor a user section exists', async () => {
    const ctx = await boot()
    ctx.settings.register(NS, Profile)
    const [descriptor] = ctx.settings.describe()
    expect(descriptor).not.toHaveProperty('base')
    expect(descriptor).not.toHaveProperty('user')
  })

  it('describes a section that became malformed after registration as having no user layer', async () => {
    const ctx = await boot({ adapter: { baseURL: 'https://user' } })
    const provider = ctx.get('settings') as MemorySettings
    ctx.settings.register(NS, Profile, { base: { baseURL: 'https://base' } })
    provider.pushExternal({ adapter: 5 })
    const [descriptor] = ctx.settings.describe()
    expect(descriptor).not.toHaveProperty('user')
    // The malformed publish kept the last good resolved value.
    expect(descriptor?.value).toEqual({ baseURL: 'https://user' })
  })

  it('redacts a descriptor that has neither base nor user layer', async () => {
    const ctx = await boot()
    ctx.settings.register(NS, Profile)
    const [descriptor] = ctx.settings.describe({ redactSecrets: true })
    expect(descriptor).not.toHaveProperty('base')
    expect(descriptor).not.toHaveProperty('user')
    expect(descriptor?.secrets).toEqual([{ path: ['apiKey'], set: false }])
  })

  it('redacts every layer and enumerates secret slots under redactSecrets', async () => {
    const ctx = await boot({ adapter: { apiKey: 'user-key', baseURL: 'https://user' } })
    ctx.settings.register(NS, Profile, { base: { apiKey: 'entry-key' } })
    const [descriptor] = ctx.settings.describe({ redactSecrets: true })
    expect(descriptor?.value).toEqual({ baseURL: 'https://user' })
    expect(descriptor?.base).toEqual({})
    expect(descriptor?.user).toEqual({ baseURL: 'https://user' })
    expect(descriptor?.secrets).toEqual([{ path: ['apiKey'], set: true }])
    const [verbatim] = ctx.settings.describe()
    expect(verbatim?.value).toEqual({ apiKey: 'user-key', baseURL: 'https://user' })
  })

  it('keeps a secret field default out of the redacted schema envelope', async () => {
    const ctx = await boot()
    const WithDefault = z.object({
      apiKey: z.string().role('secret').default('leaked-default'),
      baseURL: z.string().default('https://visible'),
    })
    ctx.settings.register(NS, WithDefault)
    const redactedRefs = (ctx.settings.describe({ redactSecrets: true })[0]?.schema as {
      refs: Record<string, { meta?: { default?: unknown; role?: unknown } }>
    }).refs
    const verbatimRefs = (ctx.settings.describe()[0]?.schema as {
      refs: Record<string, { meta?: { default?: unknown; role?: unknown } }>
    }).refs
    const secretNode = Object.values(redactedRefs).find(node => node.meta?.role === 'secret')!
    const plainNode = Object.values(verbatimRefs).find(node => node.meta?.default === 'https://visible')!
    expect(secretNode.meta).not.toHaveProperty('default')
    expect(plainNode.meta?.default).toBe('https://visible')
    // The envelope is minted per describe() call, so the verbatim one still carries the default.
    const verbatimSecret = Object.values(verbatimRefs).find(node => node.meta?.role === 'secret')!
    expect(verbatimSecret.meta?.default).toBe('leaked-default')
  })

  it('refuses to describe a namespace whose schema hides a secret behind a transform', async () => {
    const ctx = await boot()
    ctx.settings.register(NS, z.object({ blob: z.transform(z.string(), v => v.trim()) }))
    expect(() => ctx.settings.describe()).not.toThrow()
    expect(() => ctx.settings.describe({ redactSecrets: true })).toThrow(UnprovableSchemaError)
  })
})
