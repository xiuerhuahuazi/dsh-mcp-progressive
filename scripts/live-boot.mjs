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
 *   4. drives the three `/dsh-mcp-hub/*` routes with real HTTP requests,
 *   5. kills the child and removes the temporary home.
 *
 * The user's `~/.dsh` is never read or written: `DSH_HOME` is redirected, and
 * the port is chosen by the OS (`--port 0`), so nothing collides.
 *
 * `--expect baseline` documents the 1.2.0 defects (the routes have no
 * admission); `--expect fixed` describes the repaired behaviour and is meant
 * for the next phase.
 *
 * Usage: node scripts/live-boot.mjs [--expect baseline|fixed] [--port N] [--json] [--keep]
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
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
const expectation = flag('--expect', 'baseline')
const portFlag = flag('--port', undefined)
const wantJson = argv.includes('--json')
const keepHome = argv.includes('--keep')

if (expectation !== 'baseline' && expectation !== 'fixed') {
  console.error(`live-boot: --expect must be "baseline" or "fixed", got ${JSON.stringify(expectation)}`)
  process.exit(2)
}

/** What each probe must answer under each expectation. */
const EXPECTATIONS = {
  baseline: {
    'state-unauthenticated': 200,
    'state-bad-host': 200,
    'toggle-text-plain': 404,
    'toggle-get-method': 405,
    'toggle-missing-enabled': 404,
    'toggle-enabled-string': 404,
    'state-authenticated': 200,
  },
  fixed: {
    'state-unauthenticated': 403,
    'state-bad-host': 403,
    'toggle-text-plain': 415,
    'toggle-get-method': 405,
    'toggle-missing-enabled': 400,
    'toggle-enabled-string': 400,
    'state-authenticated': 200,
  },
}

/**
 * The fallback used when the real DSH runtime is not on disk: a minimal real
 * HTTP server that mounts the plugin's own route handlers. It proves the
 * handler contract, not the platform wiring.
 */
async function fallbackServer() {
  const { createManagementEnv } = await import('../test/harness.mjs')
  const { createServer } = await import('node:http')
  const env = await createManagementEnv()
  const server = createServer((req, res) => {
    const handler = env.routes.get(req.url)
    if (handler === undefined) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      req.body = Buffer.concat(chunks)
      handler(req, res)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    mode: 'fallback-http',
    close: async () => {
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

/** One HTTP probe against a route. */
async function probe(name, origin, routePath, options = {}) {
  const headers = { ...(options.headers ?? {}) }
  if (options.cookie !== undefined) headers.cookie = options.cookie
  let body
  if (options.body !== undefined) {
    headers['content-type'] = options.contentType ?? 'application/json'
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
  }
  let response
  try {
    response = await fetch(`${origin}${routePath}`, { method: options.method ?? 'GET', headers, body, redirect: 'manual' })
  } catch (error) {
    return { name, status: 0, error: error?.message ?? String(error), expected: null, ok: false }
  }
  const text = await response.text()
  let parsed = text
  try {
    parsed = JSON.parse(text)
  } catch {
    // Keep the raw text.
  }
  return { name, status: response.status, body: parsed, expected: null, ok: false }
}

async function main() {
  const started = Date.now()
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-mcp-liveboot-'))
  let server = null
  let child = null
  const result = {
    mode: 'real-dsh-web',
    expectation,
    home,
    probes: [],
    ok: false,
  }

  try {
    if (!fs.existsSync(BIN)) {
      server = await fallbackServer()
      result.mode = 'fallback-http'
      result.fallbackReason = `the DSH runtime is not installed at ${BIN}`
    } else {
      await prepareProfile(home)
      const booted = await bootWebApp(home, portFlag ?? 0)
      child = booted.child
      result.origin = booted.origin
      result.bootOutput = booted.output.trim().split('\n').slice(-5).join('\n')
      server = { origin: booted.origin, close: async () => {} }
      result.cookie = await mintCookie(booted.origin, booted.token)
    }

    const origin = server.origin
    const cookie = result.cookie

    const probes = [
      await probe('state-unauthenticated', origin, '/dsh-mcp-hub/state'),
      await probe('state-bad-host', origin, '/dsh-mcp-hub/state', {
        headers: { host: 'evil.example' },
        cookie,
      }),
      await probe('toggle-text-plain', origin, '/dsh-mcp-hub/toggle', {
        method: 'POST',
        contentType: 'text/plain',
        body: JSON.stringify({ server: 'x', enabled: false }),
      }),
      await probe('toggle-get-method', origin, '/dsh-mcp-hub/toggle', { method: 'GET' }),
      await probe('toggle-missing-enabled', origin, '/dsh-mcp-hub/toggle', {
        method: 'POST',
        body: JSON.stringify({ server: 'x' }),
      }),
      await probe('toggle-enabled-string', origin, '/dsh-mcp-hub/toggle', {
        method: 'POST',
        body: JSON.stringify({ server: 'x', enabled: 'true' }),
      }),
      await probe('state-authenticated', origin, '/dsh-mcp-hub/state', { cookie }),
    ]

    const expected = EXPECTATIONS[expectation]
    result.probes = probes.map((entry) => {
      const want = expected[entry.name]
      return { ...entry, expected: want, ok: entry.status === want }
    })
    result.ok = result.probes.every((entry) => entry.ok)
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
    if (result.error !== undefined) console.log(`  ERROR: ${result.error}\n`)
    for (const entry of result.probes) {
      console.log(
        `  ${entry.ok ? 'ok  ' : 'FAIL'}  ${entry.name.padEnd(24)} status=${String(entry.status).padEnd(4)} expected=${entry.expected}`,
      )
    }
    console.log(`\n  ${result.ok ? 'PASS' : 'FAIL'}  (${result.durationMs} ms)\n`)
  }

  process.exit(result.ok ? 0 : 1)
}

await main()
