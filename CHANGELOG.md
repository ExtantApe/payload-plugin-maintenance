# Changelog

## 0.3.0 (Unreleased)

- **Breaking change:** the gate reads the switch from a configured site address: the new `origin` option, then the `SITE_MAINTENANCE_ORIGIN` environment variable, then on Vercel `VERCEL_PROJECT_PRODUCTION_URL` (production) or `VERCEL_URL` (elsewhere).
  - **Self-hosted sites must set `origin` or `SITE_MAINTENANCE_ORIGIN`** to the site's address, for example `https://www.example.com`. Until then the site stays open even if "Close the site" is ticked, and the server log says why. `SITE_MAINTENANCE=on` still closes it.
  - **Vercel sites** need no change if system environment variables are exposed to deployments and that address answers without redirecting to another one. Otherwise, set `SITE_MAINTENANCE_ORIGIN` to the address that answers directly.
  - See "Upgrading from 0.2.0" in the README for every change a site may need.
- The request for the switch is sent only to the configured address. An `apiRoute` that would lead elsewhere (one that doesn't start with `/`, for example) is treated as invalid configuration.
- A missing or invalid address or `apiRoute` is also logged when the gate is built.
- Redirects are followed only when they stay on the configured address, up to 3.
- The gate logs why it can't read the switch, once per reason until a read works again.
- A custom `read` now gets the configured address, or an empty string if there is none.
- README: maintenance mode isn't for hiding content that is unsafe for children; unpublish it.
- Tested: unit tests with made-up requests and environment values (the `apiRoute` cases with a stand-in `fetch`), and redirects against local servers on 127.0.0.1. Not tested: a real Next.js proxy (Node or Edge runtime), a Vercel deployment (including Deployment Protection and rolling releases) or a running Payload site.

## 0.2.0 (2026-11-11)

- **Behavior change (2026-11-11):** with no `access` option, only users of the admin collection (`admin.user` in the Payload config) can turn maintenance on or off and edit the page. Before, any signed-in account of any auth collection could, members included. Sites relying on the old default must pass the option.

## 0.1.0

- First release: the Maintenance global and the proxy gate.
