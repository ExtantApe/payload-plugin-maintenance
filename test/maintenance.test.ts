import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { maintenance, maintenanceGlobal, renderPage } from '../src/index.js'
import { envOverride, maintenanceGate, type MaintenanceState } from '../src/gate.js'

const ORIGIN = 'https://site.example'
const req = (path: string, init: { cookie?: string; method?: string } = {}) => ({
  url: `${ORIGIN}${path}`,
  method: init.method ?? 'GET',
  headers: new Headers(init.cookie ? { cookie: init.cookie } : {}),
})
const reader = (state: MaintenanceState | null | Error) => vi.fn(async () => {
  if (state instanceof Error) throw state
  return state
})

afterEach(() => vi.useRealTimers())

describe('the page', () => {
  it('escapes everything it is given and never renders HTML from the admin', () => {
    const html = renderPage({ brand: 'A & B', heading: '<script>x</script>', message: 'One\n\nTwo "quoted"', backAround: 'Monday' })
    expect(html).toContain('A &amp; B')
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).toContain('<p>One</p>')
    expect(html).toContain('<p>Two &quot;quoted&quot;</p>')
    expect(html).toContain('Expected back: Monday')
  })

  it('falls back to plain default words and refuses colours that could break out of the style', () => {
    const html = renderPage({}, { light: { background: 'red;}</style><script>' } })
    expect(html).toContain('We’re getting things ready')
    expect(html).not.toContain('</style><script>')
    expect(html).toContain('lang="en"')
  })
})

describe('the global', () => {
  it('is readable by anyone and editable only through the access you pass', async () => {
    const g = maintenanceGlobal({ access: ({ req }) => (req.user as { admin?: boolean } | null)?.admin === true })
    expect(await (g.access!.read as () => boolean)()).toBe(true)
    const update = g.access!.update as (a: { req: { user: unknown } }) => boolean
    expect(update({ req: { user: { admin: false } } })).toBe(false)
    expect(update({ req: { user: { admin: true } } })).toBe(true)
  })

  it('lets only users of the admin collection close the site by default; members and unclear configs are refused (2026-11-11)', async () => {
    const d = maintenanceGlobal().access!.update as (a: { req: unknown }) => unknown
    const as = (user: unknown, adminUser: unknown = 'users') => ({ req: { user, payload: { config: { admin: { user: adminUser } } } } })
    // A member signed in through a second auth collection: no.
    expect(await d(as({ id: 'm1', collection: 'members' }))).toBe(false)
    // An admin-collection user: yes, and exactly true.
    expect(await d(as({ id: 'a1', collection: 'users' }))).toBe(true)
    // A site whose admin collection is named otherwise: its users pass, `users` doesn't.
    expect(await d(as({ id: 'a2', collection: 'staff' }, 'staff'))).toBe(true)
    expect(await d(as({ id: 'a3', collection: 'users' }, 'staff'))).toBe(false)
    // Not signed in, a user with no collection, or no admin collection to compare with: no.
    expect(await d(as(null))).toBe(false)
    expect(await d(as({ id: 'x' }))).toBe(false)
    expect(await d(as({ id: 'a1', collection: 'users' }, null))).toBe(false)
    expect(await d({ req: { user: { id: 'a1', collection: 'users' } } })).toBe(false)
    // The plugin's own global uses the same default.
    const plugged = maintenance()({ globals: [] } as never).globals![0]!.access!.update as (a: { req: unknown }) => unknown
    expect(await plugged(as({ id: 'm1', collection: 'members' }))).toBe(false)
    expect(await plugged(as({ id: 'a1', collection: 'users' }))).toBe(true)
  })

  it('adds itself once, and refuses a slug that is already taken', () => {
    const out = maintenance()({ globals: [] } as never)
    expect(out.globals!.map((g) => g.slug)).toEqual(['maintenance'])
    expect(() => maintenance()({ globals: [{ slug: 'maintenance', fields: [] }] } as never)).toThrow(/already exists/)
  })
})

describe('the gate', () => {
  it('reads only clear on/off values from the environment', () => {
    for (const v of ['on', 'TRUE', ' 1 ', 'yes']) expect(envOverride(v)).toBe(true)
    for (const v of ['off', 'false', '0', 'no']) expect(envOverride(v)).toBe(false)
    for (const v of [undefined, '', 'maybe']) expect(envOverride(v)).toBeNull()
  })

  it('closes site pages with a 503 while the switch is on, and keeps the admin and API open', async () => {
    const read = reader({ enabled: true, heading: 'Back soon', message: 'Painting the walls.' })
    const gate = maintenanceGate({ read, env: {}, brand: 'Example' })
    const res = (await gate(req('/en/about')))!
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('3600')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const html = await res.text()
    expect(html).toContain('Back soon')
    expect(html).toContain('Painting the walls.')
    for (const path of ['/admin', '/admin/collections/pages', '/api/globals/maintenance', '/api/users/login']) expect(await gate(req(path))).toBeNull()
    expect(await (await gate(req('/', { method: 'HEAD' })))!.text()).toBe('')
  })

  it('lets someone signed in through, and nobody when the bypass is turned off', async () => {
    const read = reader({ enabled: true })
    expect(await maintenanceGate({ read, env: {} })(req('/', { cookie: 'a=1; payload-token=abc' }))).toBeNull()
    expect((await maintenanceGate({ read, env: {}, bypassCookie: false })(req('/', { cookie: 'payload-token=abc' })))!.status).toBe(503)
  })

  it('lets the environment force it either way', async () => {
    expect(await maintenanceGate({ read: reader({ enabled: true }), env: { SITE_MAINTENANCE: 'off' } })(req('/'))).toBeNull()
    const forced = (await maintenanceGate({ read: reader({ enabled: false }), env: { SITE_MAINTENANCE: 'on' } })(req('/')))!
    expect(forced.status).toBe(503)
    // Forced on still shows the admin's words, and plain defaults if the switch can't be read.
    expect((await (await maintenanceGate({ read: reader(new Error('down')), env: { SITE_MAINTENANCE: 'on' } })(req('/')))!.text())).toContain('getting things ready')
    expect(await maintenanceGate({ read: reader({ enabled: true }), env: { SITE_MAINTENANCE: 'on' }, envVar: false })(req('/', {}))).not.toBeNull()
  })

  it('stays open when off, and when the switch has never been readable', async () => {
    expect(await maintenanceGate({ read: reader({ enabled: false }), env: {} })(req('/'))).toBeNull()
    expect(await maintenanceGate({ read: reader(null), env: {} })(req('/'))).toBeNull()
    expect(await maintenanceGate({ read: reader(new Error('down')), env: {} })(req('/'))).toBeNull()
  })

  it('reuses a read for a few seconds, and keeps the last answer if a later read fails', async () => {
    vi.useFakeTimers()
    let state: MaintenanceState | Error = { enabled: true }
    const read = vi.fn(async () => {
      if (state instanceof Error) throw state
      return state
    })
    const gate = maintenanceGate({ read, env: {}, cacheSeconds: 10 })
    expect((await gate(req('/')))!.status).toBe(503)
    state = { enabled: false }
    expect((await gate(req('/')))!.status).toBe(503) // cached
    expect(read).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(11_000)
    expect(await gate(req('/'))).toBeNull() // re-read: open
    state = new Error('down')
    vi.advanceTimersByTime(11_000)
    expect(await gate(req('/'))).toBeNull() // last answer (open) stands
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('reads the global over REST, with the Vercel protection bypass when the deployment has one', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ enabled: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const gate = maintenanceGate({ origin: ORIGIN, env: { VERCEL_AUTOMATION_BYPASS_SECRET: 's3cret' } })
      expect((await gate(req('/x')))!.status).toBe(503)
      const [url, init] = fetchMock.mock.calls[0]!
      expect(url).toBe(`${ORIGIN}/api/globals/maintenance?depth=0`)
      expect((init!.headers as Record<string, string>)['x-vercel-protection-bypass']).toBe('s3cret')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('the address the gate reads from', () => {
  const SECRET = 'made-up-secret'
  const OTHER = 'https://other.example'
  const from = (origin: string) => ({ url: `${origin}/`, headers: new Headers({ host: new URL(origin).host, 'x-forwarded-host': new URL(origin).host }) })
  const answer = (enabled: boolean) => new Response(JSON.stringify({ enabled }), { status: 200 })
  const stubFetch = (respond: () => Response = () => answer(true)) => {
    const mock = vi.fn(async (_url: string, _init?: RequestInit) => respond())
    vi.stubGlobal('fetch', mock)
    return mock
  }
  let logged: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>
  beforeEach(() => {
    logged = vi.fn<(...args: unknown[]) => void>()
    vi.spyOn(console, 'error').mockImplementation(logged)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const askedFor = async (options: Parameters<typeof maintenanceGate>[0]) => {
    const fetchMock = stubFetch()
    await maintenanceGate(options)(from(OTHER))
    return fetchMock.mock.calls.map(([url]) => new URL(url).origin)
  }

  it('is the configured one, whatever address the request names, with one cached answer', async () => {
    const fetchMock = stubFetch()
    const gate = maintenanceGate({ origin: `${ORIGIN}/`, env: { VERCEL_AUTOMATION_BYPASS_SECRET: SECRET } })
    expect((await gate(from(OTHER)))!.status).toBe(503)
    expect((await gate(from(ORIGIN)))!.status).toBe(503)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`${ORIGIN}/api/globals/maintenance?depth=0`])
  })

  it('comes from the option, then SITE_MAINTENANCE_ORIGIN, then the Vercel system values', async () => {
    const vercel = { VERCEL: '1', VERCEL_URL: 'deploy.example', VERCEL_PROJECT_PRODUCTION_URL: 'prod.example' }
    const env = { ...vercel, VERCEL_ENV: 'production', SITE_MAINTENANCE_ORIGIN: 'http://internal.example:3000' }
    expect(await askedFor({ origin: ORIGIN, env })).toEqual([ORIGIN])
    expect(await askedFor({ env })).toEqual(['http://internal.example:3000'])
    expect(await askedFor({ origin: '', env })).toEqual(['http://internal.example:3000'])
    expect(await askedFor({ env: { ...vercel, VERCEL_ENV: 'production' } })).toEqual(['https://prod.example'])
    expect(await askedFor({ env: { ...vercel, VERCEL_ENV: 'preview' } })).toEqual(['https://deploy.example'])
    expect(await askedFor({ env: { VERCEL: '1', VERCEL_ENV: 'production', VERCEL_URL: 'deploy.example' } })).toEqual(['https://deploy.example'])
    // Vercel's names count only on Vercel.
    expect(await askedFor({ env: { VERCEL_URL: 'deploy.example' } })).toEqual([])
  })

  it('when missing: sends nothing, leaves the site open and says why once', async () => {
    const fetchMock = stubFetch()
    const gate = maintenanceGate({ env: { VERCEL_AUTOMATION_BYPASS_SECRET: SECRET } })
    expect(await gate(from(ORIGIN))).toBeNull()
    expect(await gate(from(OTHER))).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(logged).toHaveBeenCalledTimes(1)
    const line = String(logged.mock.calls[0]![0])
    expect(line).toContain('no site address is configured')
    expect(line).toContain('SITE_MAINTENANCE_ORIGIN')
    expect(line).toContain('the site stays open')
    expect(line).toContain('SITE_MAINTENANCE=on')
  })

  it('when missing: the environment can still close the site', async () => {
    const fetchMock = stubFetch()
    const res = (await maintenanceGate({ env: { SITE_MAINTENANCE: 'on' } })(from(ORIGIN)))!
    expect(res.status).toBe(503)
    expect(await res.text()).toContain('getting things ready')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('when unusable: is reported without echoing it, and no other source stands in', async () => {
    for (const bad of ['site.example', 'ftp://site.example', `${ORIGIN}/shop`, `${ORIGIN}?a=1`, 'https://name:hunter2@site.example']) {
      logged.mockClear()
      expect(await askedFor({ origin: bad, env: { SITE_MAINTENANCE_ORIGIN: ORIGIN } })).toEqual([])
      expect(logged).toHaveBeenCalledTimes(1)
      expect(String(logged.mock.calls[0]![0])).toContain('the `origin` option must be')
      expect(String(logged.mock.calls[0]![0])).not.toContain('hunter2')
    }
  })

  it('is what your own reader gets, or an empty string, and the reader still works without one', async () => {
    const read = reader({ enabled: true })
    expect((await maintenanceGate({ read, origin: ORIGIN, env: {} })(from(OTHER)))!.status).toBe(503)
    expect((await maintenanceGate({ read, env: {} })(from(OTHER)))!.status).toBe(503)
    expect(read.mock.calls).toEqual([[ORIGIN], ['']])
    expect(logged).not.toHaveBeenCalled()
  })

  it('logs a failed read without the other error\u2019s words, and again only after a read has worked', async () => {
    vi.useFakeTimers()
    let fail = true
    stubFetch(() => {
      if (fail) throw new TypeError(`invalid header value "${SECRET}"`)
      return answer(true)
    })
    const gate = maintenanceGate({ origin: ORIGIN, env: { VERCEL_AUTOMATION_BYPASS_SECRET: SECRET } })
    await gate(from(ORIGIN))
    await gate(from(ORIGIN))
    expect(logged).toHaveBeenCalledTimes(1)
    fail = false
    expect((await gate(from(ORIGIN)))!.status).toBe(503)
    fail = true
    vi.advanceTimersByTime(11_000)
    expect((await gate(from(ORIGIN)))!.status).toBe(503)
    expect(logged).toHaveBeenCalledTimes(2)
    expect(String(logged.mock.calls[1]![0])).toContain('The last answer stands.')
    expect(JSON.stringify(logged.mock.calls)).not.toContain(SECRET)
  })

  describe('redirects, with real servers on 127.0.0.1', () => {
    const servers: Server[] = []
    const listen = async (handle: (req: IncomingMessage, res: ServerResponse) => void) => {
      const server = createServer(handle)
      servers.push(server)
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    }
    afterEach(async () => {
      for (const server of servers.splice(0)) {
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
      }
    })
    const env = { VERCEL_AUTOMATION_BYPASS_SECRET: SECRET }

    it('never follows one to another address', async () => {
      let elsewhereHits = 0
      const elsewhere = await listen((_req, res) => {
        elsewhereHits++
        res.end(JSON.stringify({ enabled: true }))
      })
      const site = await listen((_req, res) => res.writeHead(307, { location: `${elsewhere}/moved` }).end())
      expect(await maintenanceGate({ origin: site, env })(from(site))).toBeNull()
      expect(elsewhereHits).toBe(0)
      expect(String(logged.mock.calls[0]![0])).toContain(`redirects to ${elsewhere}`)
      expect(JSON.stringify(logged.mock.calls)).not.toContain(SECRET)
    })

    it('follows one that stays on the configured address', async () => {
      const seen: Array<[string, unknown]> = []
      const site = await listen((req, res) => {
        seen.push([req.url!, req.headers['x-vercel-protection-bypass']])
        if (req.url!.startsWith('/api/globals/maintenance?')) res.writeHead(308, { location: '/api/globals/maintenance/?depth=0' }).end()
        else res.end(JSON.stringify({ enabled: true }))
      })
      expect((await maintenanceGate({ origin: site, env })(from(site)))!.status).toBe(503)
      expect(seen).toEqual([
        ['/api/globals/maintenance?depth=0', SECRET],
        ['/api/globals/maintenance/?depth=0', SECRET],
      ])
    })

    it('gives up on a loop', async () => {
      let hits = 0
      const site = await listen((req, res) => {
        hits++
        res.writeHead(302, { location: req.url! }).end()
      })
      expect(await maintenanceGate({ origin: site, env })(from(site))).toBeNull()
      expect(hits).toBe(4)
      expect(String(logged.mock.calls[0]![0])).toContain('redirected more than 3 times')
    })
  })
})
