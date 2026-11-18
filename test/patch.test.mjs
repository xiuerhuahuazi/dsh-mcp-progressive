/**
 * Regression tests for the patch rewrite (review S3) and the file transaction
 * (review S4) in `lib/patch.js`.
 *
 * The 23 fixtures below are copied verbatim from
 * `probe/codex/yaml-probe.mjs` in the 2026-11-19 review — they are the inputs
 * that made the 1.2.0 string splicer emit invalid YAML. Every rewrite must now
 * either parse cleanly with the intended effective `disabled` flag, or throw;
 * silently writing a broken patch is a failure.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { parseDocument } from 'yaml'

import { withTempDir } from './harness.mjs'
import {
  PATCH_BACKUP_SUFFIX,
  applyPatchOverride,
  backupPatchFile,
  patchDeclares,
  readPatchFile,
  setPatchDisabled,
  writePatchFile,
} from '../lib/patch.js'

/** The reviewed fixtures: `[name, input, id?]`. */
const FIXTURES = [
  ['plain', '- id: demo\n  disabled: false\n'],
  ['comment', '- id: demo # target\n  disabled: false # KEEP THIS\n'],
  ['crlf', '- id: demo\r\n  disabled: false # comment\r\n'],
  ['quoted-id', '- id: "demo"\n  disabled: false\n'],
  ['duplicate-overrides', '- id: demo\n  disabled: false\n- id: demo\n  disabled: false\n'],
  ['quoted-disabled', '- id: demo\n  "disabled": false\n'],
  ['multiline-disabled', '- id: demo\n  disabled: >-\n    false\n'],
  ['indent-4', '-   id: demo\n    disabled: false\n'],
  ['indented-root', '  - id: demo\n    disabled: false\n'],
  ['empty-flow', '[]\n'],
  ['flow-sequence', '[{id: demo, disabled: false}]\n'],
  ['key-order', '- disabled: false\n  id: demo\n'],
  ['top-insert', '- insert:\n    - id: demo\n      name: "@deepseek-ai/dsh-mcp-client"\n      disabled: false\n'],
  ['insert-conflict', '- insert:\n    - id: demo\n      name: "@deepseek-ai/dsh-mcp-client"\n      group: true\n      config: []\n- id: demo\n  insert: []\n'],
  ['nested-include', '- id: wrapper\n  config:\n    patches:\n      - id: demo\n        disabled: false\n'],
  ['literal-fake-id', '- id: wrapper\n  config:\n    text: |\n      - id: demo\n        disabled: false\n'],
  ['special-space', '- id: "demo space"\n  disabled: false\n', 'demo space'],
  ['special-hash', '- id: "demo#x"\n  disabled: false\n', 'demo#x'],
  ['escaped-quote', '- id: "demo\\\"x"\n  disabled: false\n', 'demo"x'],
  ['single-quote-escape', "- id: 'demo''x'\n  disabled: false\n", "demo'x"],
  ['regex-chars', '- id: "demo.[x]+$"\n  disabled: false\n', 'demo.[x]+$'],
  ['end-marker', '- id: other\n  disabled: false\n...\n'],
  ['multiline-config', '- id: demo\n  config: |\n    disabled: false\n    other: stuff\n'],
]

/** Parse text with `yaml` and fail loudly when any parser error is present. */
function parseRows(text, label = '') {
  const document = parseDocument(text)
  assert.equal(document.errors.length, 0, `${label}: rewritten patch must parse: ${document.errors[0]?.message ?? ''}`)
  const rows = document.toJS()
  assert.ok(Array.isArray(rows), `${label}: a patch must stay a YAML sequence`)
  return rows
}

/** The effective `disabled` for a top-level override, ignoring insert groups. */
function effectiveTopLevel(rows, id) {
  const overrides = rows.filter(
    (row) => row !== null && typeof row === 'object' && !Array.isArray(row) && row.id === id && !('insert' in row),
  )
  return overrides.length === 0 ? undefined : overrides[overrides.length - 1].disabled
}

/** Top-level insert patches, as parsed. */
function insertGroups(rows) {
  return rows.filter((row) => row !== null && typeof row === 'object' && !Array.isArray(row) && 'insert' in row)
}

/** Permission bits of one path. */
function modeOf(filePath) {
  return fs.statSync(filePath).mode & 0o777
}

/** Random-suffix temporaries a completed or failed transaction must not leave. */
function tempLeftovers(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.mcp-hub.tmp'))
}

// ---------------------------------------------------------------------------
// Text rewrites.
// ---------------------------------------------------------------------------

test('setPatchDisabled keeps every reviewed fixture valid with the intended flag', async (t) => {
  for (const [name, input, id = 'demo'] of FIXTURES) {
    await t.test(name, () => {
      const inputRows = parseRows(input, `${name} (input)`)
      const output = setPatchDisabled(input, id, true)

      const rows = parseRows(output, name)
      assert.equal(effectiveTopLevel(rows, id), true, `${name}: the rewrite must set an effective "disabled: true"`)
      assert.deepEqual(insertGroups(rows), insertGroups(inputRows), `${name}: insert groups must stay untouched`)

      // A second identical call must not append another override.
      assert.equal(setPatchDisabled(output, id, true), output, `${name}: the rewrite must be idempotent`)

      const cleared = setPatchDisabled(output, id, false)
      assert.equal(effectiveTopLevel(parseRows(cleared, `${name} (false)`), id), false, `${name}: the flag must flip back`)
    })
  }
})

test('rewrites keep comments, CRLF line endings and block scalars', () => {
  const commented = '- id: demo # target\n  disabled: false # KEEP THIS\n'
  const commentedOut = setPatchDisabled(commented, 'demo', true)
  assert.ok(commentedOut.includes('- id: demo # target'), 'the entry comment survives')
  assert.ok(commentedOut.includes('disabled: true # KEEP THIS'), 'the value comment survives')

  const crlf = '- id: demo\r\n  disabled: false\r\n'
  const crlfOut = setPatchDisabled(crlf, 'demo', true)
  assert.ok(crlfOut.includes('\r\n'), 'a CRLF patch file keeps its line endings')
  assert.equal(/(^|[^\r])\n/.test(crlfOut), false, 'no lone LF is mixed into a CRLF file')

  const multiline = '- id: demo\n  config: |\n    disabled: false\n    other: stuff\n'
  const multilineOut = setPatchDisabled(multiline, 'demo', true)
  assert.ok(multilineOut.includes('  config: |'), 'the block scalar style survives')
  assert.equal(parseRows(multilineOut)[0].config, parseRows(multiline)[0].config, 'the block scalar value is untouched')
})

test('setPatchDisabled starts a patch from empty text', () => {
  const output = setPatchDisabled('', 'demo', true)
  assert.deepEqual(parseRows(output), [{ id: 'demo', disabled: true }])
  assert.deepEqual(parseRows(setPatchDisabled('   \n', 'demo', false)), [{ id: 'demo', disabled: false }])
})

test('setPatchDisabled refuses text it cannot turn into a valid sequence', () => {
  assert.throws(() => setPatchDisabled('{}', 'demo', true), /YAML sequence/)
  assert.throws(() => setPatchDisabled('just a scalar', 'demo', true), /YAML sequence/)
  assert.throws(() => setPatchDisabled('- id: demo\n  disabled: [\n', 'demo', true), /not valid YAML/)
  assert.throws(
    () => setPatchDisabled('- id: demo\n  disabled: false\n  disabled: true\n', 'demo', true),
    /not valid YAML/,
  )
})

test('a row that only lives inside an insert group gets a top-level override', () => {
  const input = '- insert:\n    - id: demo\n      name: "@deepseek-ai/dsh-mcp-client"\n      disabled: false\n'
  const output = setPatchDisabled(input, 'demo', true)
  assert.deepEqual(parseRows(output), [
    { insert: [{ id: 'demo', name: '@deepseek-ai/dsh-mcp-client', disabled: false }] },
    { id: 'demo', disabled: true },
  ])
  // The composition is already correct: no redundant override is appended.
  assert.equal(setPatchDisabled(input, 'demo', false), input)
})

test('patchDeclares reads the composition, not the raw text', () => {
  const cases = [
    ['plain override', '- id: demo\n  disabled: false\n', true],
    ['flow-sequence override', '[{id: demo, disabled: false}]\n', true],
    ['duplicate overrides', '- id: demo\n  disabled: false\n- id: demo\n  disabled: false\n', true],
    ['quoted id', '- id: "demo"\n  disabled: false\n', true],
    ['row inside insert list', '- insert:\n    - id: demo\n      name: pkg\n', true],
    ['insert row followed by an insert override', '- insert:\n    - id: demo\n      name: pkg\n- id: demo\n  insert: []\n', true],
    ['nested config is not an override', '- id: wrapper\n  config:\n    patches:\n      - id: demo\n        disabled: false\n', false],
    ['block scalar mention is not an override', '- id: wrapper\n  config:\n    text: |\n      - id: demo\n        disabled: false\n', false],
    ['empty sequence', '[]\n', false],
    ['another id only', '- id: other\n  disabled: false\n', false],
    ['empty text', '', false],
    ['invalid yaml', '- id: demo\n  disabled: [\n', false],
    ['non-sequence document', 'id: demo\n', false],
  ]
  for (const [name, text, expected] of cases) {
    assert.equal(patchDeclares(text, 'demo'), expected, `${name}: patchDeclares("demo")`)
  }
})

// ---------------------------------------------------------------------------
// File transaction.
// ---------------------------------------------------------------------------

test('readPatchFile returns null only for a missing file', async (t) => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'cordis.patch.yml')
    assert.equal(readPatchFile(file), null)

    fs.writeFileSync(file, '- id: demo\n  disabled: false\n')
    assert.equal(readPatchFile(file), '- id: demo\n  disabled: false\n')

    const asDirectory = path.join(dir, 'subdir')
    fs.mkdirSync(asDirectory)
    assert.throws(
      () => readPatchFile(asDirectory),
      (error) => error.code === 'EISDIR' || error.code === 'EPERM',
      'a read error other than ENOENT must surface',
    )
  })
})

test('backupPatchFile writes the snapshot next to the real file, mode 0600, and reports failure', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'cordis.patch.yml')
    fs.writeFileSync(file, '- id: demo\n  disabled: false\n')
    fs.chmodSync(file, 0o644)

    backupPatchFile(file, 'previous bytes')
    const backup = file + PATCH_BACKUP_SUFFIX
    assert.equal(fs.readFileSync(backup, 'utf8'), 'previous bytes')
    assert.equal(modeOf(backup), 0o600, 'the backup must not be world-readable')

    // A backup that cannot be written must throw, not be swallowed.
    const failing = path.join(dir, 'second.yml')
    fs.writeFileSync(failing, 'x')
    fs.mkdirSync(failing + PATCH_BACKUP_SUFFIX)
    assert.throws(() => backupPatchFile(failing, 'y'))
  })
})

test('writePatchFile defaults to 0600, preserves an existing mode and leaves no temp files', async () => {
  await withTempDir(async (dir) => {
    const created = path.join(dir, 'new.yml')
    writePatchFile(created, '- id: demo\n  disabled: true\n')
    assert.equal(fs.readFileSync(created, 'utf8'), '- id: demo\n  disabled: true\n')
    assert.equal(modeOf(created), 0o600, 'a new patch file must be private')
    assert.deepEqual(tempLeftovers(dir), [])

    const existing = path.join(dir, 'existing.yml')
    fs.writeFileSync(existing, 'old\n')
    fs.chmodSync(existing, 0o640)
    writePatchFile(existing, 'new\n')
    assert.equal(fs.readFileSync(existing, 'utf8'), 'new\n')
    assert.equal(modeOf(existing), 0o640, 'an existing mode must survive the replace')
    assert.deepEqual(tempLeftovers(dir), [])
  })
})

test('writePatchFile refuses to overwrite content it did not read', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'cordis.patch.yml')
    fs.writeFileSync(file, '- id: demo\n  disabled: false\n')

    assert.throws(
      () => writePatchFile(file, '- id: demo\n  disabled: true\n', '- id: other\n  disabled: false\n'),
      /changed between read and write/,
    )
    assert.equal(fs.readFileSync(file, 'utf8'), '- id: demo\n  disabled: false\n', 'a stale write must leave the file intact')
    assert.deepEqual(tempLeftovers(dir), [])

    writePatchFile(file, '- id: demo\n  disabled: true\n', '- id: demo\n  disabled: false\n')
    assert.equal(fs.readFileSync(file, 'utf8'), '- id: demo\n  disabled: true\n')
  })
})

test('applyPatchOverride edits the current file, keeps 0600 and backs up the old bytes', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'cordis.patch.yml')
    fs.writeFileSync(file, '- id: demo\n  disabled: false\n')
    fs.chmodSync(file, 0o600)

    assert.equal(applyPatchOverride(file, 'a stale snapshot that must be ignored', 'demo', true), true)
    assert.deepEqual(parseRows(fs.readFileSync(file, 'utf8')), [{ id: 'demo', disabled: true }])
    assert.equal(fs.readFileSync(file + PATCH_BACKUP_SUFFIX, 'utf8'), '- id: demo\n  disabled: false\n')
    assert.equal(modeOf(file), 0o600)
    assert.equal(modeOf(file + PATCH_BACKUP_SUFFIX), 0o600)
    assert.deepEqual(tempLeftovers(dir), [])

    assert.equal(applyPatchOverride(file, '', 'demo', true), false, 'an already-correct file is not rewritten')

    const already = path.join(dir, 'already.yml')
    fs.writeFileSync(already, '- id: demo\n  disabled: true\n')
    assert.equal(applyPatchOverride(already, '', 'demo', true), false)
    assert.equal(fs.existsSync(already + PATCH_BACKUP_SUFFIX), false, 'no backup is needed when nothing changes')
  })
})

test('two sequential edits on one file both survive', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'cordis.patch.yml')
    fs.writeFileSync(file, '- id: demo\n  disabled: false\n- id: other\n  disabled: false\n')

    assert.equal(applyPatchOverride(file, '', 'demo', true), true)
    assert.equal(applyPatchOverride(file, '', 'other', true), true)

    assert.deepEqual(parseRows(fs.readFileSync(file, 'utf8')), [
      { id: 'demo', disabled: true },
      { id: 'other', disabled: true },
    ])
    assert.deepEqual(tempLeftovers(dir), [])
  })
})

test('applyPatchOverride keeps a symlinked dotfile a symlink and backs up the real target', async () => {
  await withTempDir(async (dir) => {
    const real = path.join(dir, 'home', 'cordis.patch.yml')
    const link = path.join(dir, 'cordis.patch.yml')
    fs.mkdirSync(path.dirname(real))
    fs.writeFileSync(real, '- id: demo\n  disabled: false\n')
    fs.symlinkSync(real, link)

    assert.equal(applyPatchOverride(link, '', 'demo', true), true)
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'the write must go through the symlink, not replace it')
    assert.deepEqual(parseRows(fs.readFileSync(real, 'utf8')), [{ id: 'demo', disabled: true }])
    assert.equal(fs.existsSync(real + PATCH_BACKUP_SUFFIX), true, 'the backup sits next to the real file')
    assert.equal(fs.existsSync(link + PATCH_BACKUP_SUFFIX), false)
  })
})

test('applyPatchOverride throws and leaves the original bytes when the result cannot be validated', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'cordis.patch.yml')
    const broken = '- id: demo\n  disabled: [\n'
    fs.writeFileSync(file, broken)

    assert.throws(() => applyPatchOverride(file, '', 'demo', true), /not valid YAML/)
    assert.equal(fs.readFileSync(file, 'utf8'), broken, 'a refused rewrite must not touch the file')
    assert.equal(fs.existsSync(file + PATCH_BACKUP_SUFFIX), false)
    assert.deepEqual(tempLeftovers(dir), [])
  })
})

test('applyPatchOverride fails visibly when the backup cannot be written', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'cordis.patch.yml')
    const original = '- id: demo\n  disabled: false\n'
    fs.writeFileSync(file, original)
    fs.mkdirSync(file + PATCH_BACKUP_SUFFIX)

    assert.throws(() => applyPatchOverride(file, '', 'demo', true))
    assert.equal(fs.readFileSync(file, 'utf8'), original, 'no backup means no commit')
    assert.deepEqual(tempLeftovers(dir), [])
  })
})

test('applyPatchOverride refuses a missing patch file', async () => {
  await withTempDir(async (dir) => {
    assert.throws(() => applyPatchOverride(path.join(dir, 'missing.yml'), '', 'demo', true), /not found/)
  })
})

test('applyPatchOverride writes a top-level override for an insert-only home row', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'cordis.patch.yml')
    const input = '- insert:\n    - id: demo\n      name: "@deepseek-ai/dsh-mcp-client"\n      disabled: false\n'
    fs.writeFileSync(file, input)

    assert.equal(applyPatchOverride(file, input, 'demo', true), true)
    assert.deepEqual(parseRows(fs.readFileSync(file, 'utf8')), [
      { insert: [{ id: 'demo', name: '@deepseek-ai/dsh-mcp-client', disabled: false }] },
      { id: 'demo', disabled: true },
    ])
    assert.equal(applyPatchOverride(file, '', 'demo', true), false)
  })
})
