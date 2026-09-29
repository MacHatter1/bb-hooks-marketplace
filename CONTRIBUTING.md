# Contributing a hook template

1. Copy an existing entry in `hooks-catalog.json` that is closest to yours.
2. Give it a unique kebab-case `id`, a clear `name` and one-sentence `summary`,
   `tags` so people can find it, and your GitHub login as `author` (with a
   `version`, and a `homepage` if there is one) so the listing credits you. Add a `description` with setup steps
   when the target service needs an account, key, or webhook.
3. Put every credential in a `secret: true` string param. Never bake a token,
   webhook URL, or password into `command`, `url`, `headers`, or `body`.
4. Prefer `url` + `body` for services with an HTTP API: BB signs and sends
   the request itself and no shell runs. Use `command` only when a script is
   genuinely needed, keep it POSIX `sh`, and state external tools in `notes`
   (for example `jq`, `gh`, `osascript`).
5. Gate templates (`kind: "gate"`) must answer in well under 8 seconds and
   should be side-effect free.
6. Test it locally against a BB:

   ```
   npm install
   npm run validate
   python3 -m http.server 8765 --bind 127.0.0.1   # in this directory
   bb hooks marketplace add http://127.0.0.1:8765/hooks-catalog.json
   bb hooks use community/<your-id> --set key=value --yes
   bb hooks test <hook-id>
   ```

7. Open a pull request. Nothing runs automatically on GitHub, so a reviewer
   runs `npm run validate` themselves and checks that the template does what
   its summary says and nothing else.

Templates that download and execute remote code, hide what they run, or
exfiltrate data will not be merged.
