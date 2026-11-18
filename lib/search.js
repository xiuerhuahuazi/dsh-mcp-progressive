/** Collapse whitespace and clip one description line without splitting a word. */
export function oneLine(text, maxChars) {
  const collapsed = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (collapsed.length <= maxChars) return collapsed
  const head = collapsed.slice(0, Math.max(0, maxChars - 1))
  const boundary = head.lastIndexOf(' ')
  const cut = boundary > maxChars * 0.6 ? head.slice(0, boundary) : head
  return `${cut}…`
}

/**
 * Compile allow patterns: an entry ending in `*` is a prefix match, otherwise
 * the exact tool name matches. Returns a predicate.
 */
export function compileAllowlist(entries) {
  const exact = new Set()
  const prefixes = []
  for (const raw of entries ?? []) {
    const entry = String(raw ?? '').trim()
    if (!entry) continue
    if (entry.endsWith('*')) prefixes.push(entry.slice(0, -1))
    else exact.add(entry)
  }
  if (exact.size === 0 && prefixes.length === 0) return () => false
  return (toolName) => exact.has(toolName) || prefixes.some((prefix) => toolName.startsWith(prefix))
}

/** Resolve a local JSON Pointer (`#/$defs/x`, `#/definitions/x`) against one tool's schema root. */
export function resolveRef(node, root, depth = 0) {
  if (node === null || typeof node !== 'object' || depth > 8) return node
  const ref = node.$ref
  if (typeof ref !== 'string') return node
  let target
  if (ref.startsWith('#/$defs/')) target = root?.$defs?.[ref.slice(8)]
  else if (ref.startsWith('#/definitions/')) target = root?.definitions?.[ref.slice(14)]
  if (target === undefined) return node
  return resolveRef(target, root, depth + 1)
}

/** Render one JSON Schema parameter node as a short type signature. */
export function typeLabel(node, root) {
  const resolved = resolveRef(node, root)
  if (resolved === null || typeof resolved !== 'object') return 'any'
  if (typeof resolved.const !== 'undefined') return JSON.stringify(resolved.const)
  if (Array.isArray(resolved.enum)) return resolved.enum.map((value) => JSON.stringify(value)).join('|')
  if (Array.isArray(resolved.oneOf)) {
    const labels = [...new Set(resolved.oneOf.map((branch) => typeLabel(branch, root)))]
    return labels.length > 0 && labels.length <= 3 ? labels.join('|') : 'any'
  }
  switch (resolved.type) {
    case 'array':
      return resolved.items === undefined ? 'any[]' : `${typeLabel(resolved.items, root)}[]`
    case 'object':
      return 'object'
    case 'integer':
      return 'integer'
    default:
      return typeof resolved.type === 'string' ? resolved.type : 'any'
  }
}

/** Render `name: type` pairs for one tool's object parameters. */
export function signatureOf(parameters) {
  const properties = resolveRef(parameters, parameters)?.properties
  if (properties === null || typeof properties !== 'object') return ''
  const required = new Set(Array.isArray(parameters?.required) ? parameters.required : [])
  const parts = []
  for (const [key, node] of Object.entries(properties)) {
    const optional = required.has(key) ? '' : '?'
    parts.push(`${key}${optional}: ${typeLabel(node, parameters)}`)
  }
  return parts.join(', ')
}

/** Format a byte-ish char budget for JSON: drop `description` fields to fit. */
export function fitSchema(schema, budget) {
  let text = JSON.stringify(schema)
  if (text.length <= budget) return { text, truncated: false }
  const clone = JSON.parse(text)
  const strip = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) strip(item)
      return
    }
    delete node.description
    delete node.title
    delete node.examples
    delete node.default
    for (const value of Object.values(node)) strip(value)
  }
  strip(clone)
  text = JSON.stringify(clone)
  if (text.length <= budget) return { text, truncated: true }
  return { text: `${text.slice(0, Math.max(0, budget - 1))}…`, truncated: true }
}

/** Hard cap on the JSON Schema bytes a `detail: 'full'` result may print per tool. */
export const MAX_DETAIL_CHARS = 4000
