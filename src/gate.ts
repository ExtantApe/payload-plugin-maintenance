import { DEFAULT_SLUG } from './index.js'
import { renderPage, type PageContent, type PageTheme } from './page.js'

/**
 * The request side, for a Next.js proxy (middleware). It doesn't import Payload:
 * it reads the Maintenance global over the site's own REST API, cached for a few
 * seconds per server instance.
 *
 *   const gate = maintenanceGate({ brand: 'My Site' })
 *   export async function proxy(request) {
 *     const closed = await gate(request)
 *     if (closed) return closed
 *     ...
 *   }
 *
 * The REST read goes to the site's configured address: the `origin` option, the
 * SITE_MAINTENANCE_ORIGIN environment variable, or on Vercel the address in
 * Vercel's system environment variables.
 *
 * Your proxy's matcher must skip the admin and the API (the gate also skips
 * them itself, so it can never call itself in a loop).
 */
export type GateOptions = {
  /**
   * The address the gate reads the switch from: scheme, host and optional port, for example `https://www.example.com`.
   * Default: the `SITE_MAINTENANCE_ORIGIN` environment variable, then on Vercel the project's production domain
   * (in production) or the deployment's own address (elsewhere).
   */
  origin?: string
  /** Global slug, if you changed it in the plugin. */
  slug?: string
  /** Payload's API route, as a path starting with `/`. Default `/api`. */
  apiRoute?: string
  /** Payload's admin route. Default `/admin`. */
  adminRoute?: string
  /** Paths that always stay open, by prefix (for example `/healthz`). The admin and API always do. */
  openPaths?: string[]
  /** Environment variable that overrides the admin switch: `on` closes the site, `off` opens it, anything else defers to the switch. Default `SITE_MAINTENANCE`; `false` to ignore the environment. */
  envVar?: string | false
  /** Cookie whose presence lets someone through (they're signed in). Default Payload's `payload-token`; `false` to let nobody through. Presence only: this is a convenience, not access control. */
  bypassCookie?: string | false
  /** How long a read of the switch is reused, in seconds. Default 10. */
  cacheSeconds?: number
  /** `Retry-After` header, in seconds. Default 3600. */
  retryAfterSeconds?: number
  /** Brand line above the heading, and page language. */
  brand?: string
  lang?: string
  theme?: PageTheme
  /** Your own reader of the switch instead of the REST call (for tests, or a different store). It gets the configured address, or an empty string if there is none. */
  read?: (origin: string) => Promise<MaintenanceState | null>
  /** Environment to read the override, the address and the Vercel values from. Default `process.env`. */
  env?: Record<string, string | undefined>
}

export type MaintenanceState = { enabled?: boolean | null } & Pick<PageContent, 'heading' | 'message' | 'backAround'>

type RequestLike = {
  url: string
  method?: string
  cookies?: { get(name: string): { value: string } | undefined }
  headers?: { get(name: string): string | null }
}

const ON = new Set(['on', 'true', '1', 'yes'])
const OFF = new Set(['off', 'false', '0', 'no'])

/** `true`/`false` when the environment forces the switch, `null` when it leaves it to the admin. */
export function envOverride(value: string | undefined): boolean | null {
  const v = (value ?? '').trim().toLowerCase()
  return ON.has(v) ? true : OFF.has(v) ? false : null
}

const ORIGIN_VAR = 'SITE_MAINTENANCE_ORIGIN'
const MAX_REDIRECTS = 3
const LOG_PREFIX = 'payload-plugin-maintenance:'

/** A failed read whose message is written here, so it's safe to log. */
class ReadError extends Error {}

type ConfiguredOrigin = { origin: string; problem: null } | { origin: ''; problem: string }

function parseOrigin(value: string, source: string): ConfiguredOrigin {
  try {
    const url = new URL(value)
    const bare = url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password
    if (bare && (url.protocol === 'https:' || url.protocol === 'http:')) return { origin: url.origin, problem: null }
  } catch {
    // Reported below. The value isn't echoed, in case it holds a password.
  }
  return { origin: '', problem: `${source} must be an http or https address with no path, query or sign-in details, like https://www.example.com` }
}

/** The site's address as the host configured it. A value that is set but unusable is reported, never replaced by a later source. */
function configuredOrigin(option: string | undefined, env: Record<string, string | undefined>): ConfiguredOrigin {
  if (option?.trim()) return parseOrigin(option.trim(), 'the `origin` option')
  const fromEnv = env[ORIGIN_VAR]?.trim()
  if (fromEnv) return parseOrigin(fromEnv, ORIGIN_VAR)
  if (env.VERCEL === '1') {
    // In production, the production domain: Vercel's Standard Protection leaves it reachable. Elsewhere, this deployment.
    const name = env.VERCEL_ENV === 'production' && env.VERCEL_PROJECT_PRODUCTION_URL ? 'VERCEL_PROJECT_PRODUCTION_URL' : 'VERCEL_URL'
    const host = env[name]?.trim()
    if (host) return parseOrigin(`https://${host}`, name)
  }
  return { origin: '', problem: `no site address is configured. Pass the \`origin\` option or set ${ORIGIN_VAR}` }
}

type Endpoint = { url: URL; problem: null } | { url: null; problem: string }

/** Where the REST read goes. It has to stay on the configured address, whatever `apiRoute` holds. */
function switchEndpoint(site: ConfiguredOrigin, api: string, slug: string): Endpoint {
  if (site.problem !== null) return { url: null, problem: site.problem }
  try {
    const url = new URL(`${site.origin}${api}/globals/${encodeURIComponent(slug)}?depth=0`)
    if (url.origin === site.origin) return { url, problem: null }
  } catch {
    // Reported below. The value isn't echoed, in case it holds a password.
  }
  return { url: null, problem: 'the `apiRoute` option must be a path on the site that starts with /, like /api' }
}

function cookieValue(request: RequestLike, name: string): string | undefined {
  const direct = request.cookies?.get(name)?.value
  if (direct !== undefined) return direct
  const header = request.headers?.get('cookie') ?? ''
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return v.join('=')
  }
  return undefined
}

/** Builds the gate. Returns a function that answers a closed site's request, or `null` to let it through. */
export function maintenanceGate(options: GateOptions = {}) {
  const slug = options.slug ?? DEFAULT_SLUG
  const api = (options.apiRoute ?? '/api').replace(/\/$/, '')
  const admin = (options.adminRoute ?? '/admin').replace(/\/$/, '')
  const open = [api, admin, ...(options.openPaths ?? [])]
  const envVar = options.envVar === undefined ? 'SITE_MAINTENANCE' : options.envVar
  const bypass = options.bypassCookie === undefined ? 'payload-token' : options.bypassCookie
  const ttl = (options.cacheSeconds ?? 10) * 1000
  // Fixed for the life of the gate, so every cached answer comes from this one address.
  const site = configuredOrigin(options.origin, options.env ?? process.env)
  const endpoint = switchEndpoint(site, api, slug)
  let cached: { at: number; state: MaintenanceState | null } | null = null
  let reported: string | null = null

  const readRest = async (): Promise<MaintenanceState | null> => {
    if (endpoint.problem !== null) throw new ReadError(endpoint.problem)
    const headers: Record<string, string> = { accept: 'application/json' }
    // Vercel Deployment Protection refuses a deployment's own requests unless they carry its automation bypass.
    const vercelBypass = (options.env ?? process.env).VERCEL_AUTOMATION_BYPASS_SECRET
    if (vercelBypass) headers['x-vercel-protection-bypass'] = vercelBypass
    let target = endpoint.url
    // Redirects are followed by hand, and only within the configured address.
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetch(target.href, { headers, cache: 'no-store', redirect: 'manual' })
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
      if (location === null) {
        if (!res.ok) throw new ReadError(`the request to ${site.origin} answered HTTP ${res.status}`)
        return (await res.json()) as MaintenanceState
      }
      const next = new URL(location, target)
      if (next.origin !== site.origin) {
        throw new ReadError(`${site.origin} redirects to ${next.origin}, which the gate doesn't follow. If that is your site, configure it as the address`)
      }
      target = next
    }
    throw new ReadError(`${site.origin} redirected more than ${MAX_REDIRECTS} times`)
  }

  /** Says why the switch couldn't be read, once per reason until a read works again. */
  function report(error: unknown) {
    // Other errors' messages aren't logged: they can quote header values or connection strings.
    const reason = error instanceof ReadError ? error.message : 'the request or reader failed'
    const outcome = cached?.state
      ? 'The last answer stands.'
      : `With no answer, the site stays open even if "Close the site" is ticked${envVar ? `, unless ${envVar}=on` : ''}.`
    const line = `${LOG_PREFIX} can't read the maintenance switch: ${reason}. ${outcome}`
    if (line === reported) return
    reported = line
    console.error(line)
  }

  /**
   * Reads the switch, reusing a recent answer. If a read fails, the last answer
   * stands; with none yet, the site stays open (maintenance is a courtesy page,
   * not a security control, so an outage of the API shouldn't close the site).
   */
  async function state(): Promise<MaintenanceState | null> {
    if (cached && Date.now() - cached.at < ttl) return cached.state
    try {
      const s = await (options.read ? options.read(site.origin) : readRest())
      cached = { at: Date.now(), state: s }
      reported = null
      return s
    } catch (error) {
      report(error)
      if (cached) {
        cached = { at: Date.now(), state: cached.state }
        return cached.state
      }
      return null
    }
  }

  // A setup that can't work is also logged as soon as the gate is built. A custom reader may not need an address.
  if (!options.read && endpoint.problem !== null) report(new ReadError(endpoint.problem))

  return async function gate(request: RequestLike): Promise<Response | null> {
    const url = new URL(request.url)
    if (open.some((p) => url.pathname === p || url.pathname.startsWith(`${p}/`))) return null
    const forced = envVar ? envOverride((options.env ?? process.env)[envVar]) : null
    if (forced === false) return null
    if (bypass && cookieValue(request, bypass)) return null
    const s = forced === true ? await state().then((x) => x ?? {}) : await state()
    if (forced !== true && !s?.enabled) return null
    const html = renderPage({ brand: options.brand, lang: options.lang, heading: s?.heading, message: s?.message, backAround: s?.backAround }, options.theme)
    return new Response(request.method === 'HEAD' ? null : html, {
      status: 503,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'retry-after': String(options.retryAfterSeconds ?? 3600),
        'cache-control': 'no-store',
      },
    })
  }
}
