# Security policy

Templates in this catalog run on the machine that hosts a user's BB server,
with that user's rights. Trust is the whole product.

## What we guarantee

- Every template shows exactly what it runs before it can be installed.
- Credentials are only ever template parameters marked `secret`, stored
  encrypted by BB and never written into a hook.
- No template downloads and executes remote code, obscures what it runs, or
  sends data anywhere except the service its listing names.
- Install counts are opt-in and separate from templates: BB asks before
  sending anything, and a count is only the template id and version of an
  install from this catalog. The counter never stores network addresses, only
  salted hashes deleted after a day. See [`stats/`](stats).
- Every change is validated by `scripts/validate.mjs` and reviewed by a
  code owner before it reaches `main`.

## Reporting a template that misbehaves

Do not open a public issue. Contact the maintainer directly
([@MacHatter1](https://github.com/MacHatter1)) with the template id and what
it did; if GitHub's **Report a vulnerability** button is available on this
repository, use that. You will get a response within a few days, and the
template will be pulled from the catalog first and discussed second.

## Pinning

Subscribers who want change control can pin a release:
`bb hooks marketplace add MacHatter1/bb-hooks-marketplace@v1.1.0`.
