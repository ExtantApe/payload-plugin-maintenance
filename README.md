# payload-plugin-maintenance

Maintenance mode for Payload: close a site with a back-soon page and HTTP 503 from an admin switch, while the admin, API and signed-in staff keep working.

**Status:** early (0.2.0). From 0.2.0 it is published as `@extantape/payload-plugin-maintenance`; the earlier package name is deprecated in its favor. Unit tests cover the page, the global's access and the gate (switch, environment override, sign-in bypass, cache, failed reads, the Vercel protection header, the configured site address and redirects). The Vercel address defaults are tested with made-up values only, not on a Vercel deployment. The same approach already runs on a live site as a hand-written switch; this package hasn't been installed in a real site yet.

## What it does

- Adds a **Maintenance** global to the admin: a "Close the site" checkbox, a heading, a message and an optional "Expected back" line.
- Gives you a gate for your Next.js proxy (middleware). While the site is closed, every page answers one small page with HTTP 503 and `Retry-After`, so search engines treat it as temporary. Nothing is cached, so reopening shows at once.
- The admin and the API always stay open: you can sign in and reopen, and webhooks and crons keep running.
- Anyone signed in (Payload's session cookie) still sees the site, so staff can check it before reopening. That's a convenience, not access control: the cookie's presence is enough, and your pages enforce their own access as usual. Turn it off with `bypassCookie: false`.
- An environment variable (`SITE_MAINTENANCE=on` or `off`) overrides the switch, for when the admin itself is down or you want a deploy to start closed.
- The page has light and dark colours, no scripts and no outside requests. Everything typed in the admin is shown as plain text.

Limits:

- The switch is read over your site's REST API and reused for 10 seconds per server instance, so a change can take that long to show everywhere.
- The gate needs to know your site's address (see [Site address](#site-address)). Without it the switch can't be read.
- **Don't use maintenance mode to hide content that is unsafe for children.** Unpublish that content. The API stays open, signed-in people still see the site, and the site stays open when the switch has never been read.
- If the switch can't be read, the last answer stands; if it has never been read, the site stays open. Maintenance is a courtesy page, not a security control, so an API outage shouldn't close the site. The gate writes the reason to the server log (`console.error`), once per reason until a read works again. A missing or invalid address or `apiRoute` is also logged when the gate is built, which is when your proxy module loads.
- One switch per deployment. A multi-tenant site closes every tenant together.
- On Vercel with Deployment Protection, the gate's request to its own API is refused unless "Protection Bypass for Automation" is on; the gate sends `VERCEL_AUTOMATION_BYPASS_SECRET` when it exists.

## On its own, and with others

**On its own:** Maintenance needs only Payload and a Next.js proxy. It adds one global and a gate, and reads the switch over your site's own API.

**Works with:** any plugin, since it doesn't touch their collections or routes. The admin and API stay open while the site is closed, so other plugins' webhooks and scheduled jobs keep running. Nothing in it is built for one plugin in particular.

**Family:** Maintenance has no family on purpose: it sits beside every plugin. The families are a working draft, and Fulfillment is due to be split.

## Install

```bash
npm install @extantape/payload-plugin-maintenance
```

```ts
// payload.config.ts
import { maintenance } from '@extantape/payload-plugin-maintenance'

export default buildConfig({
  // ...
  plugins: [maintenance({ access: ({ req }) => req.user?.role === 'admin' })],
})
```

```ts
// src/proxy.ts (Next.js 16; middleware.ts on older versions)
import { maintenanceGate } from '@extantape/payload-plugin-maintenance/gate'

// Self-hosted: also set SITE_MAINTENANCE_ORIGIN, or pass `origin` here. See "Site address".
const gate = maintenanceGate({ brand: 'My Site' })

export async function proxy(request: NextRequest) {
  const closed = await gate(request)
  if (closed) return closed
  // ...the rest of your proxy
}

export const config = { matcher: ['/((?!admin|api|_next|favicon.ico).*)'] }
```

## Site address

The gate reads the switch from the address you configure. It takes the first of these that is set:

1. The `origin` option, for example `maintenanceGate({ origin: 'https://www.example.com' })`.
2. The `SITE_MAINTENANCE_ORIGIN` environment variable.
3. On Vercel, from [Vercel's system environment variables](https://vercel.com/docs/environment-variables/system-environment-variables): `VERCEL_PROJECT_PRODUCTION_URL` in production, `VERCEL_URL` in previews and other deployments. The project has to expose them to deployments.

**Self-hosted sites must set 1 or 2.** On Vercel you need to set one only if the system variables aren't exposed, or if the address Vercel gives redirects to another one (for example `example.com` to `www.example.com`). In that case use the address that answers directly.

Write it as scheme and host, with a port if needed: `https://www.example.com` or `http://127.0.0.1:3000`. A path, query or sign-in details make it invalid; a base path goes in `apiRoute`, which must start with `/` (for example `/shop/api`). It can be an internal address, as long as your proxy can reach the API there. Use `https` unless the request stays on a network you trust. If you run several environments, give each its own address, so each reads its own switch.

The gate follows up to 3 redirects that stay on that address. It doesn't follow a redirect to another one, including `http` to `https`.

**If the address is missing or invalid,** the gate can't read the switch. The site **stays open, even if "Close the site" is ticked**, and the server log says why. An invalid value isn't replaced by the next one in the list. An `apiRoute` that would send the request anywhere other than that address is treated the same way, and nothing is sent. `SITE_MAINTENANCE=on` still closes the site, with the default words. After upgrading or changing the address, tick "Close the site" once and check that a signed-out visitor sees the page.

## Upgrading from 0.2.0

0.3.0 has a **breaking change**: the gate reads the switch only from a configured [site address](#site-address). Check each of these before you upgrade:

- **Self-hosted:** pass `origin` or set `SITE_MAINTENANCE_ORIGIN`. Use the scheme, host and optional port, with no path. A base path goes in `apiRoute`. Until this is set, the site is **open to signed-out visitors, even if "Close the site" is already ticked**.
- **Vercel, system environment variables not exposed:** expose them to deployments, or set `SITE_MAINTENANCE_ORIGIN`.
- **Vercel, production domain redirects** (for example `example.com` to `www.example.com`, or to another domain): set `SITE_MAINTENANCE_ORIGIN` to the address that answers directly.
- **An API that redirects to another host, port or scheme** (including `http` to `https`): configure the final address.
- **A custom `read` that used its argument:** it now gets the configured address, or an empty string if there is none.
- **Several environments that share one env file:** give each its own address.
- **After upgrading:** tick "Close the site" once and check that a signed-out visitor sees the page.

If the site has to stay closed while you upgrade, set `SITE_MAINTENANCE=on` until that check is done. While it's set, the page shows whether or not the switch can be read, so unset it before the check.

## Access

`access` decides who can close and reopen the site and edit the page. It's a Payload `Access` function and goes to Payload as the global's `update` access as it is.

With no `access`, only users of your admin collection (`admin.user` in your Payload config, usually `users`) can change it. Anyone signed in through another auth collection, such as site members, is refused, and so is everyone if the config names no admin collection. Reading the global stays open to anyone: it holds nothing private.

**Changed 2026-11-11 (unreleased):** the default used to let any signed-in account change the switch, members of other auth collections included. Sites relying on the old default must pass the option, for example `access: ({ req }) => Boolean(req.user)`.

Gate options: `origin`, `slug`, `apiRoute`, `adminRoute`, `openPaths`, `envVar`, `bypassCookie`, `cacheSeconds`, `retryAfterSeconds`, `brand`, `lang`, `theme` (light and dark colours), and `read` to supply your own reader. Your reader gets the configured address, or an empty string if there is none.

## Commands

```bash
npm test          # Vitest
npm run typecheck
npm run build     # dist/
```

Releasing: see `RELEASING.md`.

## License

MIT
