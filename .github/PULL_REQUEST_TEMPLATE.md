## What this adds or changes

<!-- One or two sentences. For a new template: what it does, which service, which events. -->

## Checklist

- [ ] `npm run validate` passes locally
- [ ] Credentials are `secret: true` params, never inline in `command`, `url`, `headers` or `body`
- [ ] External tools the template needs are named in `notes`
- [ ] The `summary` says exactly what the hook does, and nothing else happens
- [ ] Tested against a running BB (`bb hooks marketplace add http://127.0.0.1:8765/hooks-catalog.json`, then `bb hooks use` and `bb hooks test`)
