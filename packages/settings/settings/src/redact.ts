/**
 * Structural secret redaction for settings values. `role('secret')` fields are
 * removed from a value before it crosses a wire boundary; a sidecar records
 * each schema-declared secret position and whether it currently holds a value,
 * so a configuration surface can render a write-only input without ever
 * receiving the secret itself.
 *
 * The walker is fail-closed: a node kind the walker cannot prove secret-free
 * (`transform`, `lazy`, or an unknown type) throws instead of passing its
 * value through, so a schema that hides a secret behind an unverifiable node
 * cannot be served on a wire surface at all.
 * @module @deepseek-ai/dsh-settings/redact
 */

import type z from '@deepseek-ai/schemastery'

/**
 * Minimal structural view of a live schemastery node. Only the relations the
 * redactor walks are named; everything else on the instance is ignored.
 */
interface SchemaNode {
  type?: string
  meta?: { role?: unknown; default?: unknown }
  /** `object` properties, keyed by property name. */
  dict?: Record<string, SchemaNode>
  /** `dict`/`array` element schema. */
  inner?: SchemaNode
  /** `tuple`/`union`/`intersect` member schemas. */
  list?: SchemaNode[]
}

/** One schema-declared secret position inside a redacted value. */
export interface RedactedSecret {
  /** Path from the section root to the removed field (concrete dict keys and array indexes included). */
  path: string[]
  /** Whether the field held a value before redaction. */
  set: boolean
}

/** A value with every `role('secret')` field removed, plus the removal record. */
export interface RedactedValue {
  /** Detached copy of the input with secret fields absent. */
  value: unknown
  /**
   * Every reachable secret position: object properties always (even unset, so
   * a form knows the slot exists), dict entries and array items only where the
   * value has them.
   */
  secrets: RedactedSecret[]
}

/**
 * Thrown when a schema node can hold secrets the walker cannot verify. The
 * wire surface that asked for the redacted value surfaces this error instead
 * of serving the value, refusing the namespace until the schema is
 * restructured so every secret is declared on a walked field.
 */
export class UnprovableSchemaError extends Error {
  constructor(type: string, path: string[]) {
    super(
      `redactSecrets: a ${JSON.stringify(type)} node at ${JSON.stringify(path)} can contain secrets the walker cannot verify; declare the secret on a field reached through object, dict, array, tuple, union, or intersect, or keep the namespace off the wire.`,
    )
    this.name = 'UnprovableSchemaError'
  }
}

/**
 * Node kinds with no child relation: a `role('secret')` on the node itself is
 * handled before the type switch, so nothing secret can hide underneath.
 */
const SAFE_LEAF_TYPES = new Set(['string', 'number', 'boolean', 'bitset', 'const', 'any', 'never', 'function', 'is'])

/** Whether a value is a plain data object the walker may recurse into. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function walk(node: SchemaNode | undefined, value: unknown, path: string[], secrets: RedactedSecret[]): unknown {
  if (node === undefined) return value
  if (node.meta?.role === 'secret') {
    secrets.push({ path, set: value !== undefined })
    return undefined
  }
  switch (node.type) {
    case 'object': {
      const properties = node.dict ?? {}
      const source = isRecord(value) ? value : undefined
      const rebuilt: Record<string, unknown> = {}
      if (source !== undefined) {
        for (const [key, entry] of Object.entries(source)) {
          if (key in properties) continue
          rebuilt[key] = entry
        }
      }
      for (const [key, child] of Object.entries(properties)) {
        const stripped = walk(child, source?.[key], [...path, key], secrets)
        if (stripped !== undefined) rebuilt[key] = stripped
      }
      return source === undefined && Object.keys(rebuilt).length === 0 ? value : rebuilt
    }
    case 'dict': {
      if (!isRecord(value)) return value
      const rebuilt: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(value)) {
        const stripped = walk(node.inner, entry, [...path, key], secrets)
        if (stripped !== undefined) rebuilt[key] = stripped
      }
      return rebuilt
    }
    case 'array': {
      if (!Array.isArray(value)) return value
      return value.map((entry, index) => walk(node.inner, entry, [...path, String(index)], secrets))
    }
    case 'tuple': {
      if (!Array.isArray(value)) return value
      const members = node.list ?? []
      return value.map((entry, index) => walk(members[index], entry, [...path, String(index)], secrets))
    }
    case 'union':
    case 'intersect': {
      // Pass one: enumerate every declared position against the original
      // value, so the `set` flags report what the value held before any
      // member stripped it. Pass two: re-apply every member's own walk to
      // the value; each container walk deletes exactly the positions it
      // declared, so nothing is ever resolved that is not present. A
      // safe-leaf member is the identity. A member the walker cannot
      // classify throws from its own walk.
      const found: RedactedSecret[] = []
      for (const member of node.list ?? []) walk(member, value, path, found)
      let stripped = value
      for (const member of node.list ?? []) stripped = walk(member, stripped, path, [])
      const record = new Map<string, boolean>()
      for (const position of found) {
        const key = position.path.join('\u0000')
        record.set(key, (record.get(key) ?? false) || position.set)
      }
      for (const [key, set] of record) secrets.push({ path: key.split('\u0000'), set })
      return stripped
    }
    default:
      if (SAFE_LEAF_TYPES.has(node.type ?? '')) return value
      throw new UnprovableSchemaError(node.type ?? 'unknown', path)
  }
}

/**
 * Remove every `role('secret')` field a schema declares from a value. The
 * walker follows `object`, `dict`, `array`, `tuple` containers and walks
 * every `union`/`intersect` member; a secret must be declared on a field
 * reachable through those, or on the member itself. Nodes the walker cannot
 * prove secret-free — `transform`, `lazy`, or an unknown type — throw
 * {@link UnprovableSchemaError} instead of passing their value through. The
 * input is never mutated.
 * @param schema - live schemastery schema describing the value.
 * @param value - the value to strip; `undefined` yields an empty record with
 *   object-property secret slots still enumerated.
 * @returns the stripped detached value and the ordered secret positions.
 * @throws UnprovableSchemaError when a node kind can hide a declared secret
 *   the walker cannot verify.
 */
export function redactSecrets(schema: z<never>, value: unknown): RedactedValue {
  const secrets: RedactedSecret[] = []
  const stripped = walk(schema, value, [], secrets)
  return { value: stripped, secrets }
}

/** One serialized node in a `schema.toJSON()` envelope's flat `refs` map. */
interface SerializedSchemaNode {
  meta?: { role?: unknown; default?: unknown }
}

/** The envelope shape `schema.toJSON()` returns: a root uid plus a flat refs map. */
interface SerializedSchemaEnvelope {
  refs?: Record<string, SerializedSchemaNode | undefined> | null
}

/**
 * Remove `meta.default` from every serialized node marked `role('secret')` in
 * a `schema.toJSON()` envelope, so a default set on a secret field never
 * reaches a client with the wire descriptor. The envelope is mutated in place
 * (each `describe()` call mints a fresh one) and returned.
 * @param envelope - the `schema.toJSON()` result for one schema; anything
 *   without a `refs` map is returned untouched.
 * @returns the same envelope with secret-node defaults removed.
 */
export function scrubSchemaSecrets(envelope: unknown): unknown {
  const refs = (envelope as SerializedSchemaEnvelope | null | undefined)?.refs
  if (refs === null || typeof refs !== 'object') return envelope
  for (const node of Object.values(refs)) {
    if (node?.meta?.role === 'secret') delete node.meta.default
  }
  return envelope
}
