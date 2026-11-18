/**
 * Comment-preserving patch-file edits and the file transaction around them.
 *
 * `dsh-app-boot` parses these patches with `yaml` and throws on an invalid
 * file, so one bad rewrite can break the next Harness start. Every rewrite is
 * therefore done on the YAML AST, re-parsed and checked semantically before a
 * byte reaches the disk (review item S3), and the write is a realpath- and
 * mode-preserving atomic replace with a real backup (review item S4).
 */

import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'

export const PATCH_BACKUP_SUFFIX = '.mcp-hub.bak'
export const PATCH_TMP_SUFFIX = '.mcp-hub.tmp'

/** How often a stale compare-and-swap is retried before the write fails. */
const WRITE_ATTEMPTS = 3

/** Error code for "the file changed between our read and our commit". */
const STALE_WRITE_CODE = 'PATCH_STALE'

/** Escape one literal for use inside a RegExp. */
export function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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

// ---------------------------------------------------------------------------
// AST helpers.
// ---------------------------------------------------------------------------

/** The plain value of a scalar node, or undefined for any other node. */
function scalarValue(node) {
  return isScalar(node) ? node.value : undefined
}

/** Snapshot one node's composed value, so verification can compare groups. */
function jsonOf(node, document) {
  return JSON.stringify(node?.toJS?.(document) ?? null)
}

/**
 * Parse patch text into a document whose contents are guaranteed to be a
 * sequence (an empty file is treated as an empty sequence, like the platform's
 * own `writePluginEnabled` does for a missing profile patch).
 */
function parsePatchDocument(text) {
  let document
  try {
    document = parseDocument(text)
  } catch (error) {
    throw new Error(`patch is not valid YAML: ${error.message}`)
  }
  const [error] = document.errors
  if (error !== undefined) throw new Error(`patch is not valid YAML: ${error.message}`)
  if (document.contents === null) document.contents = document.createNode([])
  else if (!isSeq(document.contents)) throw new Error('patch must be a YAML sequence: expected a top-level list of entries')
  return document
}

/** Whether the source file used CRLF line endings throughout. */
function usesCrlf(text) {
  return /\r\n/.test(text) && !/(^|[^\r])\n/.test(text)
}

/**
 * Render the edited document. `yaml` emits LF, so a CRLF patch file would come
 * back fully rewritten; restore its line-ending style to keep the diff small.
 */
function renderPatch(document, originalText) {
  const output = String(document)
  return usesCrlf(originalText) ? output.replace(/\n/g, '\r\n') : output
}

/** The last top-level override for `id` that the composer would apply. */
function lastOverride(document, id) {
  const items = document.contents.items
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]
    if (!isMap(item) || item.has('insert')) continue
    if (scalarValue(item.get('id', true)) === id) return item
  }
  return undefined
}

/** Flatten inserted rows the way the composer's id index walks them. */
function flattenInsertRows(rows) {
  const flattened = []
  for (const row of rows) {
    flattened.push(row)
    if (isMap(row) && scalarValue(row.get('group', true)) === true) {
      const config = row.get('config', true)
      if (isSeq(config)) flattened.push(...flattenInsertRows(config.items))
    }
  }
  return flattened
}

/**
 * The `disabled` value the composition would end up with for `id`, modelled on
 * `applyEntryPatches` in `cordis-plugin-include`: insert patches contribute
 * entries but never an override, and later entries win.
 */
function effectiveDisabled(document, id) {
  let found = false
  let disabled
  for (const item of document.contents.items) {
    if (!isMap(item)) continue
    if (item.has('insert')) {
      const insert = item.get('insert', true)
      if (!isSeq(insert)) continue
      for (const row of flattenInsertRows(insert.items)) {
        if (!isMap(row) || scalarValue(row.get('id', true)) !== id) continue
        found = true
        disabled = scalarValue(row.get('disabled', true))
      }
      continue
    }
    if (scalarValue(item.get('id', true)) !== id) continue
    found = true
    disabled = scalarValue(item.get('disabled', true))
  }
  return { found, disabled }
}

/** The parts of a patch that a rewrite must never change. */
function snapshotOf(document) {
  const topLevelIds = []
  const insertGroups = []
  for (const item of document.contents.items) {
    if (!isMap(item)) continue
    if (item.has('insert')) {
      insertGroups.push(jsonOf(item, document))
      continue
    }
    const id = scalarValue(item.get('id', true))
    if (id !== undefined) topLevelIds.push(id)
  }
  return { topLevelIds, insertGroups }
}

/**
 * Re-parse the rewritten text and prove it is a valid sequence that keeps the
 * old entries and gives `id` the requested effective flag. On any mismatch the
 * rewrite is refused: a broken patch must never reach the disk.
 */
function verifyRewrite(text, id, requested, before) {
  const document = parsePatchDocument(text)
  const after = snapshotOf(document)
  const idsPreserved =
    after.topLevelIds.length >= before.topLevelIds.length &&
    before.topLevelIds.every((value, index) => after.topLevelIds[index] === value)
  if (!idsPreserved) throw new Error('patch rewrite would drop a top-level entry; refusing to write')
  const groupsPreserved =
    after.insertGroups.length === before.insertGroups.length &&
    before.insertGroups.every((group, index) => after.insertGroups[index] === group)
  if (!groupsPreserved) throw new Error('patch rewrite would change an insert group; refusing to write')
  const effective = effectiveDisabled(document, id)
  if (!effective.found || effective.disabled !== requested) {
    throw new Error(`patch rewrite would not set disabled: ${requested} for "${id}"; refusing to write`)
  }
}

// ---------------------------------------------------------------------------
// Patch text edits.
// ---------------------------------------------------------------------------

/** Whether one YAML patch text declares an entry with the given id. */
export function patchDeclares(patchText, id) {
  if (typeof patchText !== 'string' || patchText.trim() === '') return false
  let document
  try {
    document = parseDocument(patchText)
  } catch {
    return false
  }
  if (document.errors.length > 0 || !isSeq(document.contents)) return false
  for (const item of document.contents.items) {
    if (!isMap(item)) continue
    // A plain top-level override is the entry the composer applies directly.
    if (!item.has('insert') && scalarValue(item.get('id', true)) === id) return true
    // Rows inside an `insert` list become real entries of the composition.
    if (item.has('insert')) {
      const insert = item.get('insert', true)
      if (!isSeq(insert)) continue
      if (flattenInsertRows(insert.items).some((row) => isMap(row) && scalarValue(row.get('id', true)) === id)) return true
    }
  }
  return false
}

/**
 * Set one top-level patch entry's `disabled` value, appending a top-level
 * override when the row only lives inside an `insert` group. Pure string→string:
 * the caller reads, backs up, writes.
 */
export function setPatchDisabled(patchText, id, disabled) {
  const text = typeof patchText === 'string' ? patchText : ''
  const requested = Boolean(disabled)
  const document = parsePatchDocument(text)
  const before = snapshotOf(document)
  const current = effectiveDisabled(document, id)
  if (current.found && current.disabled === requested) return text

  const override = lastOverride(document, id)
  if (override !== undefined) {
    override.set('disabled', requested)
    const edited = renderPatch(document, text)
    try {
      verifyRewrite(edited, id, requested, before)
      return edited
    } catch {
      // A later insert of the same id can outrank the override; append below.
    }
  }

  const appended = parsePatchDocument(text)
  appended.add({ id, disabled: requested })
  const appendedText = renderPatch(appended, text)
  verifyRewrite(appendedText, id, requested, before)
  return appendedText
}

// ---------------------------------------------------------------------------
// File transaction.
// ---------------------------------------------------------------------------

/** Read a UTF-8 file; null only when it does not exist. */
export function readPatchFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/**
 * The real path a write must land on. Resolving symlinks keeps a symlinked
 * dotfile a symlink; a dangling symlink is refused rather than replaced.
 */
function resolveWritePath(filePath) {
  try {
    return fs.realpathSync(filePath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    let stats
    try {
      stats = fs.lstatSync(filePath)
    } catch (lstatError) {
      if (lstatError.code === 'ENOENT') return filePath
      throw lstatError
    }
    if (stats.isSymbolicLink()) throw new Error(`refusing to replace a dangling symlink: ${filePath}`)
    return filePath
  }
}

/** Permission bits of an existing file, or undefined when it is new. */
function existingMode(filePath) {
  try {
    return fs.statSync(filePath).mode & 0o777
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Write through an exclusive random-suffix sibling and rename it over the
 * target, so readers see the old or new content and never a truncated file.
 */
function writeAtomically(targetPath, text, mode) {
  const temporary = `${targetPath}.${randomBytes(6).toString('hex')}${PATCH_TMP_SUFFIX}`
  try {
    fs.writeFileSync(temporary, text, { encoding: 'utf8', mode, flag: 'wx' })
    // `mode` is filtered by the umask on create; restore the exact bits.
    fs.chmodSync(temporary, mode)
    fs.renameSync(temporary, targetPath)
  } catch (error) {
    try {
      fs.unlinkSync(temporary)
    } catch {
      // The temp never appeared, or the rename already consumed it.
    }
    throw error
  }
}

/** The error thrown when the target content no longer matches our snapshot. */
function staleWriteError(filePath) {
  const error = new Error(`patch file changed between read and write: ${filePath}`)
  error.code = STALE_WRITE_CODE
  return error
}

/**
 * Keep the pre-write text next to the real patch file so a broken edit is
 * recoverable. Unlike 1.2.0 this is not best-effort: a caller that needs a
 * backup must not commit without one.
 */
export function backupPatchFile(filePath, text) {
  const target = resolveWritePath(filePath)
  const backupPath = target + PATCH_BACKUP_SUFFIX
  fs.writeFileSync(backupPath, text, { encoding: 'utf8', mode: 0o600 })
  // A pre-existing backup keeps its old bits unless they are forced.
  fs.chmodSync(backupPath, 0o600)
}

/**
 * Replace a patch file atomically. `expected` turns the call into a
 * compare-and-swap: it must equal the current file text or the write is not
 * committed, so a concurrent edit is never overwritten silently.
 */
export function writePatchFile(filePath, text, expected = undefined) {
  const target = resolveWritePath(filePath)
  const mode = existingMode(target) ?? 0o600
  let stale = null
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
    if (expected !== undefined) {
      const current = readPatchFile(target)
      if (current !== expected) {
        stale = staleWriteError(target)
        continue
      }
    }
    writeAtomically(target, text, mode)
    return
  }
  throw stale
}

/**
 * Apply one `disabled` override to the given patch file. The disk is read
 * again inside the transaction (`patchText` is kept only for call-site
 * compatibility) so a snapshot taken before the control queue ran cannot
 * resurrect stale content.
 */
export function applyPatchOverride(filePath, patchText, id, disabled) {
  void patchText
  const target = resolveWritePath(filePath)
  let stale = null
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
    const current = readPatchFile(target)
    if (current === null) throw new Error(`patch file not found: ${filePath}`)
    const next = setPatchDisabled(current, id, disabled)
    if (next === current) return false
    backupPatchFile(target, current)
    try {
      writePatchFile(target, next, current)
      return true
    } catch (error) {
      if (error.code !== STALE_WRITE_CODE) throw error
      stale = error
    }
  }
  throw stale
}
