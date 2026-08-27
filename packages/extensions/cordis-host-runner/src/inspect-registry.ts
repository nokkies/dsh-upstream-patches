/** Host registry for model-visible, read-only Cordis capability queries. */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import type {
  CordisInspectMethodManifest, CordisInspectPlatform, CordisInspectProviderManifest,
  CordisInspectProviderView, CordisInspectQueryRequest, CordisInspectQueryResolution,
  CordisInspectRequestId, CordisInspectResolveAck,
} from './types.ts'

/** Context supplied to a Host inspect query. */
export interface HostCordisInspectQueryContext {
  /** Tool-call cancellation. */
  signal: AbortSignal
  /** Agent whose scoped runtime is being inspected. */
  agent: Agent
}

/** Local registration paired with its serializable manifest. */
export interface HostCordisInspectProviderRegistration {
  /** Provider and explicit method directory. */
  manifest: CordisInspectProviderManifest
  /** Execute one declared method. */
  query(method: string, input: JsonValue | undefined, context: HostCordisInspectQueryContext): Promise<JsonValue>
}

interface PendingClientQuery {
  request: CordisInspectQueryRequest
  method: CordisInspectMethodManifest
  settle(resolution: CordisInspectQueryResolution): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host registry for Cordis inspect providers and Client manifest/query routing. */
    cordisInspect: CordisInspectRegistryService
  }
}

/** Registry and cross-page router behind the two model-facing inspect tools. */
export class CordisInspectRegistryService extends Service {
  private readonly providers = new Map<string, HostCordisInspectProviderRegistration>()
  /**
   * Live holders of each registered id. The serving entry in {@link providers}
   * outlives every holder but the last, so one id shared by several mounts is
   * removed exactly when the last of them disposes.
   */
  private readonly holders = new Map<string, Set<object>>()
  private readonly pending = new Map<CordisInspectRequestId, PendingClientQuery>()
  private clientManifest: readonly CordisInspectProviderManifest[] | undefined
  private nextRequest = 1

  /** Register the process-global Host registry. */
  constructor(ctx: Context) {
    super(ctx, 'cordisInspect')
  }

  /**
   * Register one Host provider.
   *
   * An id may be registered more than once, because this registry is
   * process-global while the packages that populate it mount per preset: two
   * cordis-based presets in one process each register the same first-party
   * providers, and the second mount used to fail outright. Repeat
   * registrations of the SAME contract therefore share one entry rather than
   * colliding. They are interchangeable: the catalog providers are pure
   * functions over generated constants, and the live Tool view resolves the
   * one shared tools service and filters by the REQUESTING agent, not by the
   * context that happened to mount it.
   *
   * Sharing rather than replacing is the load-bearing half. A replacing
   * registry would let the second mount's disposer drop an entry the first
   * mount is still relying on, so unmounting one preset would silently take
   * another preset's inspect providers dark — an ordering-dependent capability
   * loss, strictly worse than the loud error it removed.
   *
   * A same-id registration carrying a DIFFERENT manifest is still a real
   * collision and still throws, which is the case the error was written for.
   * @param registration - manifest and local query handler.
   * @returns idempotent disposer; the entry survives until the last holder disposes.
   */
  register(registration: HostCordisInspectProviderRegistration): () => void {
    const manifest = validateManifest(registration.manifest)
    const existing = this.providers.get(manifest.id)
    if (existing !== undefined && canonicalJson(existing.manifest) !== canonicalJson(manifest)) {
      throw new Error(`Host Cordis inspect provider "${manifest.id}" is already registered`)
    }
    if (existing === undefined) this.providers.set(manifest.id, { ...registration, manifest })
    const holders = this.holders.get(manifest.id) ?? new Set<object>()
    // Identity, not a counter: a disposer that already ran deletes nothing on a
    // second call, so idempotency costs no bookkeeping.
    const token = {}
    holders.add(token)
    this.holders.set(manifest.id, holders)
    return () => {
      const live = this.holders.get(manifest.id)
      if (live === undefined || !live.delete(token)) return
      if (live.size > 0) return
      this.holders.delete(manifest.id)
      this.providers.delete(manifest.id)
    }
  }

  /**
   * Replace the mirrored Client provider directory.
   * @param providers - complete Client manifest snapshot.
   */
  syncClientManifest(providers: readonly CordisInspectProviderManifest[]): void {
    const ids = new Set<string>()
    const validated = providers.map((provider) => {
      const manifest = validateManifest(provider)
      if (ids.has(manifest.id)) throw new Error(`Client Cordis inspect manifest repeats provider "${manifest.id}"`)
      ids.add(manifest.id)
      return manifest
    })
    this.clientManifest = Object.freeze(validated)
  }

  /**
   * Return the complete known Host and Client provider directory.
   * @returns Host providers followed by the Client providers.
   */
  list(): CordisInspectProviderView[] {
    return [
      ...[...this.providers.values()].map(provider => view('host', provider.manifest)),
      ...(this.clientManifest ?? []).map(provider => view('client', provider)),
    ]
  }

  /**
   * Execute one provider query on its owning platform.
   * @param platform - Host or Client runtime.
   * @param providerId - provider selected from {@link list}.
   * @param methodName - declared method name.
   * @param input - optional lossless JSON input.
   * @param agent - requesting Agent and scope.
   * @param signal - tool-call cancellation.
   * @returns provider JSON data.
   */
  async query(
    platform: CordisInspectPlatform,
    providerId: string,
    methodName: string,
    input: JsonValue | undefined,
    agent: Agent,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    if (platform === 'host') {
      const registration = this.providers.get(providerId)
      if (registration === undefined) throw new Error(`Host Cordis inspect provider "${providerId}" is not registered`)
      const method = findMethod(registration.manifest, methodName)
      validateInput('Host', providerId, method, input)
      signal.throwIfAborted()
      const data = await registration.query(methodName, input, { agent, signal })
      signal.throwIfAborted()
      return validateOutput('Host', providerId, method, data)
    }
    return await this.queryClient(providerId, methodName, input, agent, signal)
  }

  /**
   * Accept the first valid Client response for a pending query.
   * @param agent - Agent whose Session owns the query.
   * @param requestId - Pending Client query identity.
   * @param resolution - Client provider result or failure.
   * @returns whether this response settled the still-pending query.
   */
  resolveClientQuery(
    agent: Agent,
    requestId: CordisInspectRequestId,
    resolution: CordisInspectQueryResolution,
  ): CordisInspectResolveAck {
    const pending = this.pending.get(requestId)
    if (pending === undefined || pending.request.agentId !== agent.id) return { accepted: false }
    if (!resolution.ok) return { accepted: false }
    try {
      resolution = {
        ok: true,
        data: validateOutput('Client', pending.request.provider, pending.method, resolution.data),
      }
    } catch {
      return { accepted: false }
    }
    this.pending.delete(requestId)
    pending.settle(resolution)
    this.ctx.emit('cordis/inspect-query-resolved', { requestId })
    return { accepted: true }
  }

  private async queryClient(
    providerId: string,
    methodName: string,
    input: JsonValue | undefined,
    agent: Agent,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const provider = this.clientManifest?.find(candidate => candidate.id === providerId)
    if (provider === undefined) throw new Error(`Client Cordis inspect provider "${providerId}" is not registered`)
    const method = findMethod(provider, methodName)
    validateInput('Client', providerId, method, input)
    signal.throwIfAborted()
    const requestId = `inspect-${this.nextRequest++}` as CordisInspectRequestId
    const request: CordisInspectQueryRequest = {
      requestId,
      agentId: agent.id,
      provider: providerId,
      method: methodName,
      ...input === undefined ? {} : { input },
    }
    const result = new Promise<CordisInspectQueryResolution>((resolve) => {
      this.pending.set(requestId, { request, method, settle: resolve })
    })
    const onAbort = (): void => {
      const pending = this.pending.get(requestId)
      if (pending === undefined) return
      this.pending.delete(requestId)
      pending.settle({ ok: false, reason: 'cancelled', message: `Client inspect query ${providerId}.${methodName} was cancelled` })
      this.ctx.emit('cordis/inspect-query-resolved', { requestId })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    else this.ctx.emit('cordis/inspect-query', request)
    try {
      const resolution = await result
      if (!resolution.ok) throw new Error(`${providerId}.${methodName}: ${resolution.message}`)
      return resolution.data
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
}

function view(platform: CordisInspectPlatform, manifest: CordisInspectProviderManifest): CordisInspectProviderView {
  return { platform, ...manifest, methods: [...manifest.methods] }
}

/**
 * Serialize a validated manifest so two registrations of one id can be compared
 * for contract equality. Key order carries no meaning in a manifest, so it must
 * not decide whether a repeat mount is a duplicate or a collision.
 * @param value - any lossless-JSON fragment of a validated manifest.
 * @returns a stable string, equal exactly when the contracts are equal.
 */
function canonicalJson(value: unknown): string {
  // `undefined` is absent rather than a value, and JSON.stringify is typed as
  // always returning a string, so it has to be settled before the call.
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    // Manifest keys are unique, so the comparator never sees a tie.
    .sort(([left], [right]) => (left > right ? 1 : -1))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
}

function validateManifest(manifest: CordisInspectProviderManifest): CordisInspectProviderManifest {
  if (manifest.id.trim() === '') throw new Error('Cordis inspect provider id must not be empty')
  if (manifest.description.trim() === '') throw new Error(`Cordis inspect provider "${manifest.id}" needs a description`)
  const names = new Set<string>()
  const methods = manifest.methods.map((method) => {
    if (method.name.trim() === '') throw new Error(`Cordis inspect provider "${manifest.id}" has an empty method name`)
    if (names.has(method.name)) throw new Error(`Cordis inspect provider "${manifest.id}" repeats method "${method.name}"`)
    if (method.description.trim() === '') throw new Error(`Cordis inspect method ${manifest.id}.${method.name} needs a description`)
    assertSupportedJsonSchema(method.inputSchema)
    assertSupportedJsonSchema(method.outputSchema)
    names.add(method.name)
    return Object.freeze({ ...method })
  })
  return Object.freeze({ ...manifest, methods: Object.freeze(methods) })
}

function findMethod(manifest: CordisInspectProviderManifest, name: string): CordisInspectMethodManifest {
  const method = manifest.methods.find(candidate => candidate.name === name)
  if (method === undefined) throw new Error(`Cordis inspect provider "${manifest.id}" has no method "${name}"`)
  return method
}

function validateInput(
  platform: 'Host' | 'Client',
  provider: string,
  method: CordisInspectMethodManifest,
  input: JsonValue | undefined,
): void {
  const violations = validateJsonSchemaValue(method.inputSchema as JsonSchemaNode, input ?? {}, 'input')
  if (violations.length > 0) throw new Error(`${platform} Cordis inspect ${provider}.${method.name} rejected input: ${violations.join('; ')}`)
}

function validateOutput(
  platform: 'Host' | 'Client',
  provider: string,
  method: CordisInspectMethodManifest,
  data: JsonValue,
): JsonValue {
  const snapshot = snapshotJsonValue(data)
  if (snapshot === undefined) throw new Error(`${platform} Cordis inspect ${provider}.${method.name} returned a non-JSON value`)
  const violations = validateJsonSchemaValue(method.outputSchema as JsonSchemaNode, snapshot, 'output')
  if (violations.length > 0) throw new Error(`${platform} Cordis inspect ${provider}.${method.name} returned invalid output: ${violations.join('; ')}`)
  return snapshot
}
