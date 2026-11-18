#!/usr/bin/env node
/**
 * End-to-end verification of the management routes against a REAL DSH web
 * instance — isolated from the user's setup.
 *
 * The script
 *   1. creates a throw-away `DSH_HOME` (mkdtemp),
 *   2. creates a `test` profile in it and installs the plugin source into
 *      `<home>/profiles/test/node_modules/dsh-mcp-progressive`,
 *   3. boots `dsh --profile test --port <free> --no-open` as a child process
 *      with `DSH_HOME` pointing at the throw-away home,
 *   4. mints the browser session cookie from the launch token the app prints,
 *   5. drives the three `/dsh-mcp-hub/*` routes with real `node:http`
 *      requests (so an explicit `Host:` header really reaches the server),
 *   6. kills the child, shuts the listener down and removes the temporary home.
 *
 * The user's `~/.dsh` is never read or written: `DSH_HOME` is redirected, and
 * the port is chosen by the OS (`--port 0`), so nothing collides.
 *
 * Modes
 * -----
 * `--expect fixed` (default) is the regression gate. It asserts the repaired
 * admission semantics that the 1.2.1 fixes introduced and that the platform
 * already applies to `/api`: a connection admission fence (Host trusted, then
 * an authenticated peer), a JSON content type on the write routes, a strict
 * method check (405 + `Allow`), and strict request bodies (400).
 *
 * `--expect baseline` documents the 1.2.0 behaviour and ONLY matches a v1.2.0
 * checkout: there the routes had no admission, accepted any media type and
 * coerced an invalid `enabled` to "stop". It exits 1 on this checkout, by
 * design; that is not a regression.
 *
 * Usage: node scripts/live-boot.mjs [--expect fixed|baseline] [--port N] [--json] [--keep]
 *
 * Exit code: 0 only when every probe matched.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME = process.env.DSH_RUNTIME ?? '/tmp/dsh-asar/dsh/node_modules/@deepseek-ai'
const BIN = path.join(RUNTIME, 'dsh', 'lib', 'bin.js')

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const expectation = flag('--expect', 'fixed')
const portFlag = flag('--port', undefined)
const wantJson = argv.includes('--json')
const keepHome = argv.includes('--keep')

if (expectation !== 'baseline' && expectation !== 'fixed') {
  console.error(`live-boot: --expect must be "baseline" or "fixed", got ${JSON.stringify(expectation)}`)
  process.exit(2)
}

/**
 * What each probe must answer under each expectation.
 *
 * `status` is the single accepted status; `accept` accepts one of several
 * (the connection admission may answer 401 — no authenticated peer — or 403 —
 * a fenced request — depending on which check rejects first, so the probe
 * records the observed one instead of hard-coding it).
 * `allow` lists the methods the answer must advertise in `Allow`.
 * `jsonError` requires a JSON `{ok:false,error}` body instead of a body-less
 * reset, which is what a browser panel and the model both need.
 */
const EXPECTATIONS = {
  baseline: {
    'state-unauthenticated': { status: 200 },
    'state-bad-host': { status: 200 },
    'toggle-text-plain': { status: 404 },
    'toggle-get-method': { status: 405 },
    'toggle-missing-enabled': { status: 404 },
    'toggle-enabled-string': { status: 404 },
    'toggle-no-content-type': { status: 404 },
    'state-wrong-method': { status: 200 },
    'state-authenticated': { status: 200 },
  },
  fixed: {
    'state-unauthenticated': { status: 403, accept: [401, 403], jsonError: true },
    'state-bad-host': { status: 403, jsonError: true },
    'toggle-text-plain': { status: 415, jsonError: true },
    'toggle-get-method': { status: 405, allow: ['POST'], jsonError: true },
    'toggle-missing-enabled': { status: 400, jsonError: true },
    'toggle-enabled-string': { status: 400, jsonError: true },
    'toggle-no-content-type': { status: 415, jsonError: true },
    'state-wrong-method': { status: 405, allow: ['GET', 'HEAD'], jsonError: true },
    'state-authenticated': { status: 200 },
  },
}

/** The fallback cookie used when the real runtime does not mint one. */
const FALLBACK_COOKIE = 'dsh-auth-fallback=1'
const PROBE_TIMEOUT_MS = 15_000

/**
 * Mirror of the platform's trust fence, used only by the fallback server.
 * Untrusted Host (or cross-origin marker) → 403, trusted Host without a
 * session cookie → 401, else no rejection. The real platform authority is the
 * real boot; this stub exists so the handler contract stays testable without
 * the DSH runtime on disk.
 */
function fallbackFence(req) {
  const host = String(req.headers?.host ?? '')
  const hostname = host.replace(/:\d+$/, '').toLowerCase()
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') return 403
  if (String(req.headers?.['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return 403
  const origin = req.headers?.origin
  if (origin !== undefined) {
    try {
      if (new URL(origin).host !== host) return 403
    } catch {
      return 403
    }
  }
  return typeof req.headers?.cookie === 'string' && req.headers.cookie !== '' ? undefined : 401
}

/**
 * The fallback used when the real DSH runtime is not on disk: a minimal real
 * HTTP server that mounts the plugin's own route handlers behind the stub
 * fence above. It proves the handler contract, not the platform wiring.
 */
async function fallbackServer() {
  const { createManagementEnv } = await import('../test/harness.mjs')
  const { createServer } = await import('node:http')
  const env = await createManagementEnv({ rejection: fallbackFence })
  const server = createServer((req, res) => {
    const handler = env.routes.get(req.url ?? '')
    if (handler === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    // Let the handler read the request stream itself: buffering it here would
    // fire `end` before `readJsonBody()` could subscribe.
    Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('internal error')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const url = `http://127.0.0.1:${port}`
  return {
    url,
    origin: url,
    mode: 'fallback-http',
    patchPaths: [env.patchPath],
    cookie: FALLBACK_COOKIE,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
      await env.dispose()
    },
  }
}

/** Install the plugin source into the throw-away profile. */
async function installPlugin(profileDir) {
  const target = path.join(profileDir, 'node_modules', 'dsh-mcp-progressive')
  await fsp.mkdir(target, { recursive: true })
  for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'package.json']) {
    await fsp.copyFile(path.join(REPO_ROOT, file), path.join(target, file))
  }
  await fsp.cp(path.join(REPO_ROOT, 'locale'), path.join(target, 'locale'), { recursive: true })
  const libDir = path.join(REPO_ROOT, 'lib')
  if (fs.existsSync(libDir)) {
    await fsp.cp(libDir, path.join(target, 'lib'), { recursive: true })
  }
  // The plugin declares `yaml` as its only dependency; link the repo's copy
  // instead of running an install inside the throw-away profile.
  const yamlSource = path.join(REPO_ROOT, 'node_modules', 'yaml')
  if (fs.existsSync(yamlSource)) {
    await fsp.mkdir(path.join(target, 'node_modules'), { recursive: true })
    await fsp.symlink(yamlSource, path.join(target, 'node_modules', 'yaml'), 'dir')
  }
  return target
}

/** Create the `test` profile inside the throw-away home. */
async function prepareProfile(home) {
  const profileDir = path.join(home, 'profiles', 'test')
  await fsp.mkdir(profileDir, { recursive: true })
  const manifest = {
    name: 'dsh-profile-test',
    private: true,
    dependencies: { 'dsh-mcp-progressive': '1.2.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-mcp-progressive'] } },
  }
  await fsp.writeFile(path.join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await fsp.writeFile(path.join(profileDir, 'cordis.yml'), '# dsh profile root — an empty entry list.\n[]\n', 'utf8')
  // The profile's own user layer: the row the plugin's bundle patch inserts.
  await fsp.writeFile(
    path.join(profileDir, 'cordis.patch.yml'),
    '# profile user patch layer\n- id: mcp-progressive\n  config: {}\n',
    'utf8',
  )
  await fsp.writeFile(
    path.join(profileDir, 'pnpm-workspace.yaml'),
    'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
    'utf8',
  )
  await installPlugin(profileDir)
  return profileDir
}

/** Boot the real DSH web app and wait until it prints its URL. */
function bootWebApp(home, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, '--profile', 'test', '--port', String(port), '--no-open'], {
      cwd: home,
      env: { ...process.env, DSH_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`live-boot: the DSH web app did not report a URL within 90 s\n${output}`))
    }, 90_000)
    const onData = (chunk) => {
      output += chunk
      const match = /http:\/\/([0-9.]+):(\d+)\/\?token=([A-Za-z0-9_-]+)/.exec(output)
      if (match === null || settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        child,
        output,
        origin: `http://${match[1]}:${match[2]}`,
        token: match[3],
      })
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`live-boot: the DSH web app exited with code ${code}\n${output}`))
    })
  })
}

/** Exchange the launch token for the browser session cookie. */
async function mintCookie(origin, token) {
  const response = await fetch(`${origin}/?token=${token}`, { redirect: 'manual' })
  const header = response.headers.get('set-cookie')
  if (header === null) throw new Error('live-boot: the launch token did not mint a session cookie')
  return header.split(';')[0]
}

/**
 * One HTTP probe using `node:http`.
 *
 * `fetch` is deliberately not used here: it treats `Host` as a forbidden
 * header and silently drops it, which made the bad-Host probe verify nothing.
 */
function httpProbe(name, origin, routePath, options = {}) {
  const url = new URL(routePath, origin)
  const headers = { ...(options.headers ?? {}) }
  if (options.cookie !== undefined) headers.cookie = options.cookie
  let payload
  if (options.body !== undefined) {
    payload = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
    headers['content-length'] = Buffer.byteLength(payload)
    // A body-carrying probe declares a media type unless it explicitly opts
    // out: the missing-content-type probe must reach the server without one.
    if (options.contentType !== false) headers['content-type'] = options.contentType ?? 'application/json'
  }
  const sent = {
    method: options.method ?? 'GET',
    path: routePath,
    host: headers.host ?? `${url.host}`,
    cookie: headers.cookie !== undefined,
    contentType: headers['content-type'] ?? null,
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = (record) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ name, sent, ...record })
    }
    const timer = setTimeout(() => {
      request.destroy(new Error(`probe timed out after ${PROBE_TIMEOUT_MS} ms`))
    }, PROBE_TIMEOUT_MS)
    const request = http.request(
      {
        host: url.hostname,
        port: url.port === '' ? 80 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: sent.method,
        headers,
        // One socket per probe: no lingering keep-alive handle after the run.
        agent: false,
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let body = text
          try {
            body = JSON.parse(text)
          } catch {
            // Keep the raw text.
          }
          finish({ status: response.statusCode ?? 0, headers: response.headers, body, text })
        })
        response.on('error', (error) => finish({ status: 0, error: error?.message ?? String(error) }))
      },
    )
    request.on('error', (error) => finish({ status: 0, error: error?.message ?? String(error) }))
    if (payload !== undefined) request.write(payload)
    request.end()
  })
}

/** Read the patch files a mutation would rewrite; `null` means "absent". */
function snapshotPatches(paths) {
  const snapshot = new Map()
  for (const file of paths) {
    try {
      snapshot.set(file, fs.readFileSync(file))
    } catch {
      snapshot.set(file, null)
    }
  }
  return snapshot
}

/** Whether the snapshots are byte-identical (absent files included). */
function patchesUnchanged(before, after) {
  for (const [file, bytes] of before) {
    const next = after.get(file)
    if (bytes === null) {
      if (next !== null) return false
    } else if (next === null || !bytes.equals(next)) {
      return false
    }
  }
  return true
}

/** Normalize one answer's `Allow` header to uppercase tokens. */
function allowTokens(headers) {
  const raw = headers?.allow
  if (typeof raw !== 'string') return []
  return raw
    .split(',')
    .map((token) => token.trim().toUpperCase())
    .filter((token) => token !== '')
}

/** Compare one probe with its expectation; returns `{ ok, reasons }`. */
function evaluate(entry, spec) {
  const reasons = []
  const accepted = spec.accept ?? [spec.status]
  if (!accepted.includes(entry.status)) {
    reasons.push(`status ${entry.status} not in ${accepted.join('/')}`)
  }
  if (spec.allow !== undefined) {
    const observed = allowTokens(entry.headers)
    const missing = spec.allow.filter((method) => !observed.includes(method.toUpperCase()))
    if (missing.length > 0) reasons.push(`Allow header is missing ${missing.join(', ')} (got ${JSON.stringify(entry.headers?.allow ?? null)})`)
  }
  if (spec.jsonError === true) {
    const body = entry.body
    if (body === null || typeof body !== 'object' || body.ok !== false || typeof body.error !== 'string') {
      reasons.push('body is not the JSON {ok:false,error} refusal')
    }
  }
  return { ok: reasons.length === 0, reasons }
}

/** A compact label for an expectation's status. */
function expectedLabel(spec) {
  return (spec.accept ?? [spec.status]).join('|')
}

async function main() {
  const started = Date.now()
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-mcp-liveboot-'))
  let server = null
  let child = null
  let patchPaths = []
  const result = {
    mode: 'real-dsh-web',
    platformAuthority: true,
    expectation,
    home,
    probes: [],
    patchFiles: [],
    patchesUnchanged: null,
    ok: false,
  }

  try {
    if (!fs.existsSync(BIN)) {
      server = await fallbackServer()
      result.mode = 'fallback-http'
      result.platformAuthority = false
      result.fallbackReason = `the DSH runtime is not installed at ${BIN}`
      result.cookie = server.cookie
      patchPaths = server.patchPaths
    } else {
      await prepareProfile(home)
      const booted = await bootWebApp(home, portFlag ?? 0)
      child = booted.child
      result.origin = booted.origin
      result.bootOutput = booted.output.trim().split('\n').slice(-5).join('\n')
      server = { origin: booted.origin, close: async () => {} }
      result.cookie = await mintCookie(booted.origin, booted.token)
      // Both layers the toggle route may rewrite: the home patch and the
      // profile patch.
      patchPaths = [path.join(home, 'cordis.patch.yml'), path.join(home, 'profiles', 'test', 'cordis.patch.yml')]
    }

    const origin = server.origin
    const cookie = result.cookie
    const state = '/dsh-mcp-hub/state'
    const toggle = '/dsh-mcp-hub/toggle'

    const before = snapshotPatches(patchPaths)
    const answers = [
      await httpProbe('state-unauthenticated', origin, state),
      await httpProbe('state-bad-host', origin, state, { headers: { host: 'evil.example' }, cookie }),
      await httpProbe('toggle-text-plain', origin, toggle, {
        method: 'POST',
        cookie,
        contentType: 'text/plain',
        body: JSON.stringify({ server: 'x', enabled: false }),
      }),
      await httpProbe('toggle-get-method', origin, toggle, { cookie }),
      await httpProbe('toggle-missing-enabled', origin, toggle, {
        method: 'POST',
        cookie,
        body: JSON.stringify({ entryId: 'include:x' }),
      }),
      await httpProbe('toggle-enabled-string', origin, toggle, {
        method: 'POST',
        cookie,
        body: JSON.stringify({ entryId: 'include:x', enabled: 'true' }),
      }),
      await httpProbe('toggle-no-content-type', origin, toggle, {
        method: 'POST',
        cookie,
        contentType: false,
        body: JSON.stringify({ entryId: 'include:x', enabled: true }),
      }),
      await httpProbe('state-wrong-method', origin, state, { method: 'POST', cookie }),
      await httpProbe('state-authenticated', origin, state, { cookie }),
    ]
    const after = snapshotPatches(patchPaths)

    result.patchFiles = patchPaths
    result.patchesUnchanged = patchesUnchanged(before, after)

    const expected = EXPECTATIONS[expectation]
    result.probes = answers.map((entry) => {
      const spec = expected[entry.name]
      const verdict = evaluate(entry, spec)
      return {
        name: entry.name,
        sent: entry.sent,
        status: entry.status,
        headers: { allow: entry.headers?.allow ?? null, 'content-type': entry.headers?.['content-type'] ?? null },
        body: entry.body,
        error: entry.error,
        expected: expectedLabel(spec),
        accepted: spec.accept !== undefined && spec.accept.includes(entry.status) ? entry.status : undefined,
        ok: verdict.ok,
        reasons: verdict.reasons,
      }
    })
    result.ok = result.probes.every((entry) => entry.ok) && result.patchesUnchanged
  } catch (error) {
    result.error = error?.message ?? String(error)
    result.stack = error?.stack
  } finally {
    if (child !== null) {
      child.kill('SIGTERM')
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          resolve()
        }, 5000)
        child.on('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    if (server !== null) await server.close()
    if (!keepHome) await fsp.rm(home, { recursive: true, force: true })
    else result.homeKept = home
  }

  result.durationMs = Date.now() - started

  if (wantJson) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(`\ndsh-mcp-progressive — live boot (${result.mode}, expect ${expectation})\n`)
    if (result.fallbackReason !== undefined) {
      console.log(`  note: ${result.fallbackReason}`)
      console.log('  note: fallback mode mounts the handlers behind a stub fence; only a real boot proves the platform fence.\n')
    }
    if (result.error !== undefined) console.log(`  ERROR: ${result.error}\n`)
    for (const entry of result.probes) {
      const accepted = entry.accepted !== undefined ? ` (admitted by ${entry.accepted})` : ''
      console.log(
        `  ${entry.ok ? 'ok  ' : 'FAIL'}  ${entry.name.padEnd(24)} status=${String(entry.status).padEnd(4)} expected=${entry.expected}${accepted}`,
      )
      for (const reason of entry.ok ? [] : entry.reasons) console.log(`        ${reason}`)
      if (!entry.ok) {
        console.log(
          `        sent: ${entry.sent.method} ${entry.sent.path} host=${entry.sent.host} cookie=${entry.sent.cookie ? 'yes' : 'no'} content-type=${entry.sent.contentType ?? '-'}`,
        )
        console.log(`        got: allow=${entry.headers.allow ?? '-'} content-type=${entry.headers['content-type'] ?? '-'}`)
        const body = typeof entry.body === 'string' ? entry.body : JSON.stringify(entry.body)
        console.log(`        body: ${String(body ?? '').slice(0, 240)}`)
        if (entry.error !== undefined) console.log(`        error: ${entry.error}`)
      }
    }
    if (result.patchesUnchanged === false) {
      console.log('\n  FAIL  a rejected toggle mutated a patch file (snapshot differs)')
      console.log(`        files: ${result.patchFiles.join(', ')}`)
    }
    console.log(`\n  ${result.ok ? 'PASS' : 'FAIL'}  (${result.durationMs} ms)\n`)
  }

  process.exit(result.ok ? 0 : 1)
}

await main()
