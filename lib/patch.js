import fs from 'node:fs'

export const PATCH_BACKUP_SUFFIX = '.mcp-hub.bak'
export const PATCH_TMP_SUFFIX = '.mcp-hub.tmp'

/** Escape one literal for use inside a RegExp. */
export function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Whether one YAML patch text declares an entry with the given id (any depth). */
export function patchDeclares(patchText, id) {
  if (typeof patchText !== 'string' || patchText === '') return false
  const target = escapeRegExp(id)
  const pattern = new RegExp(`^\\s*-\\s+id:\\s*(?:'${target}'|"${target}"|${target})\\s*(?:#.*)?$`, 'm')
  return pattern.test(patchText)
}

/** Render a YAML scalar (ids in this deployment are plain, quoted fallback is safe). */
export function yamlScalar(value) {
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(String(value)) ? String(value) : JSON.stringify(String(value))
}

/** Indent used by one top-level patch entry (defaults to two spaces). */
export function patchItemIndent(lines, start, end) {
  for (let index = start + 1; index < end; index++) {
    const match = /^(\s+)(?:[A-Za-z_$][\w$.-]*|'[^']+'|"[^"]+")\s*:/.exec(lines[index])
    if (match !== null) return match[1].length
  }
  return 2
}

/**
 * Set one top-level patch entry's `disabled` value, appending the entry when it
 * does not exist yet. Pure string operation: the caller reads, backs up, writes.
 */
export function setPatchDisabled(patchText, id, disabled) {
  const newline = String(patchText).includes('\r\n') ? '\r\n' : '\n'
  const lines = String(patchText).split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const starts = []
  for (let index = 0; index < lines.length; index++) {
    if (/^-\s/.test(lines[index])) starts.push(index)
  }
  let blockStart = -1
  for (const start of starts) {
    const match = /^-\s+id:\s*(['"]?)([^'"\s#]+)\1\s*(?:#.*)?$/.exec(lines[start])
    if (match !== null && match[2] === id) blockStart = start
  }
  const value = disabled ? 'true' : 'false'
  if (blockStart >= 0) {
    const end = starts.find((start) => start > blockStart) ?? lines.length
    const indent = ' '.repeat(patchItemIndent(lines, blockStart, end))
    let replaced = false
    for (let index = blockStart + 1; index < end; index++) {
      const match = /^(\s+)disabled:\s*/.exec(lines[index])
      if (match !== null && match[1].length === indent.length) {
        lines[index] = `${indent}disabled: ${value}`
        replaced = true
        break
      }
    }
    if (!replaced) lines.splice(blockStart + 1, 0, `${indent}disabled: ${value}`)
  } else {
    lines.push(`- id: ${yamlScalar(id)}`, `  disabled: ${value}`)
  }
  return lines.join(newline) + newline
}

/** Read a UTF-8 file, or null when it does not exist / cannot be read. */
export function readPatchFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

/** Keep the pre-write text next to the patch so a broken edit is recoverable. */
export function backupPatchFile(filePath, text) {
  try {
    fs.writeFileSync(filePath + PATCH_BACKUP_SUFFIX, text, 'utf8')
  } catch {
    // A backup is best-effort; never block the requested toggle on it.
  }
}

/** Replace a file atomically, falling back to an in-place write on Windows locks. */
export function writePatchFile(filePath, text) {
  const temporary = filePath + PATCH_TMP_SUFFIX
  fs.writeFileSync(temporary, text, 'utf8')
  try {
    fs.renameSync(temporary, filePath)
  } catch {
    try {
      fs.unlinkSync(temporary)
    } catch {
      // The temporary file stays next to the patch; harmless and easy to remove.
    }
    fs.writeFileSync(filePath, text, 'utf8')
  }
}

/** Apply one `disabled` override to the given patch file. */
export function applyPatchOverride(filePath, patchText, id, disabled) {
  const next = setPatchDisabled(patchText, id, disabled)
  if (next === patchText) return false
  backupPatchFile(filePath, patchText)
  writePatchFile(filePath, next)
  return true
}
