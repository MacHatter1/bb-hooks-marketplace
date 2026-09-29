# Hook review checklist

Each item names the failure it prevents. The examples are real bugs found in
this catalog. Security and performance items feed the scores in
[scoring.md](scoring.md), which sets the points for each. Correctness and PR
rules aren't scored, but any failure in them means "request changes".

## Security (scored)

- **Discloses everything.** Every host contacted, every file written, and
  every thread spawned, told, archived or retried is named in the `summary`
  or `description`. Anything else is a hidden side effect.
- **No literal `{{secret:…}}`.** A catalog template may only get credentials
  through its own `secret: true` string params. Secret names are predictable
  (`<hook id>/<param>`), so a template that writes a secret reference itself
  can read another hook's credential.
- **No inline credentials.** No token, webhook URL or password is written
  into `command`, `url`, `headers`, `body` or a param `default`. Anything
  that grants access is `secret: true`. That includes webhook URLs and
  routing keys.
- **No remote code.** Nothing like `curl … | sh`, `bash <(curl …)`, `eval`
  of fetched or decoded data, `base64 -d | sh`, or installing packages.
- **No obfuscation.** No encoded blobs, no `printf '\x…'` building commands,
  and nothing a reviewer can't read in one pass.
- **Data goes only where the listing says.** For URL templates, the host is
  fixed or is a param the user supplies. With no `body`, the whole event
  (agent replies, message text) is sent, so confirm that's intended. Command
  templates contact only the named service.
- **Stays out of BB and the user's config.** No reads or writes under
  `~/.bb`, `~/.ssh` or shell rc files. No `bb hooks`, `bb settings` or
  `bb plugin` calls. No crontab or launchctl.
- **Nothing destructive by default.** `rm -r`, force pushes, and
  `bb thread archive`/`delete`/`stop` either need a `match` scope enforced
  through a required param, or must be the whole stated purpose with the
  blast radius spelled out. Example: `archive-when-done` without `--title`
  archives every thread after every turn.
- **No persistence.** Nothing is left running after the hook exits (`&`,
  `nohup`, `disown`, `setsid`).

## Correctness (not scored; any failure means request changes)

- **Works on every listed event.** Check each field against the payload table
  in `runtime.md`. Example: `{{error}}` is always empty on `turn.failed`,
  where you'd use `errorInfo.category`.
- **Quoting.** Params are assigned to variables first and used as `"$var"`.
  No `{{param}}` inside quotes, and every expansion is quoted. Values starting
  with `-` go after `--` or `-e` (`grep -Eq -e "$pattern"`). Because params
  are single-quoted, a path param of `~/x` doesn't expand. Either expand it
  (`case $path in "~/"*) path="$HOME/${path#\~/}";; esac`) or ask for an
  absolute path.
- **Variables are set on every path.** Example: `continue-on-capacity` set
  `bb=` only inside the `if` branch, so when the payload check matched,
  `"$bb" thread tell` ran as `""` and exited 127.
- **Text extraction does what the description says.** Test with two matches,
  none, and odd characters. Example: `sed 's/.*#\([0-9]*\).*/\1/'` is greedy,
  so it returns the last `#n`, not the first.
- **Regexes are in the right dialect and precise.** `match` is JavaScript;
  `grep -E` is POSIX ERE. Test near misses: `sk-[A-Za-z0-9_-]{20,}` blocks
  "task-list-item-renderer-component" unless it's anchored with `\b`. Test
  real positives too, such as fine-grained GitHub tokens (`github_pat_…`) and
  `gho_`, `ghs_` and `ghu_` tokens.
- **Uses the right BB data source.** `bb thread history` doesn't include the
  spawn prompt. Use `bb thread retry` rather than telling the agent to
  "continue". Branch on `errorInfo.category`, not provider wording.
- **Tools are checked and named.** Every non-POSIX tool (`jq`, `gh`,
  `osascript`) is listed in `notes`. When a missing tool would make the hook
  silently do nothing, check for it up front
  (`command -v jq >/dev/null || { echo … >&2; exit 1; }`).
- **URL bodies are valid JSON** once rendered, and fit the target API's
  documented schema and limits. Examples: Teams Workflows expects an Adaptive
  Card, Pushover messages are capped at 1024 chars, and PagerDuty severity
  must be one of four values.
- **Gates exit deliberately.** Exit 0 proceeds, 2 rejects, 3 waits, and any
  other exit applies `onError` (default proceed). A gate meant to enforce a
  policy needs `"onError": "reject"` or a design where failure is safe.
- **Portable.** POSIX `sh` (no bashisms), flags that work on both BSD and GNU
  (watch `sed -i` and `date -d`), and `${TMPDIR:-/tmp}` for temp files.

## Performance (scored)

- **Loops and duplicates.** A hook that spawns, tells or retries must not
  retrigger itself or its siblings.
  - A child spawned with `--parent-thread` sends its parent a
    `child-completed` system message when it finishes. That message runs a
    new parent turn, which fires `thread.idle` (or `turn.failed`) on the
    parent again. A `BB_PARENT_THREAD_ID` guard only stops the child from
    chaining; it doesn't stop the parent from re-triggering.
  - Also skip turns that weren't started by the user (the last
    `client/turn/requested` in `bb thread log`, where `.data.initiator` is
    not `user`), or use a per-thread stamp file with a cap.
  - `turn.failed` fires on every retry, and BB's provider-retry may retry the
    same turn in parallel with your hook.
- **Frequency.** `thread.idle` fires after every turn. Anything that posts
  comments, sends email or pages someone on idle fires on every follow-up
  message.
- **Gates are fast and side-effect free.** They finish well under 8 s, make
  no network calls where avoidable, and write nothing. Consider who else
  sends messages: agent teams, playbooks and other hooks' spawns are gated
  too (`require-ticket` rejects them unless it exempts `initiator != user`).
- **Footgun defaults.** An empty scope on a destructive or noisy hook, or a
  broad pattern that matches everyday text (`#2` in "try approach #2").
- **Timeouts.** `timeoutMs` covers the worst case (for example `gh` on a slow
  network) without being needlessly long. Gates are capped at 8 s whatever
  they set.
## Listing (Nit)

- The `summary` is one sentence that states the effect and the trigger. The
  `description` covers setup (accounts, keys, webhook creation) and states
  limits.
- Param labels name the regex dialect ("JavaScript regex" vs "grep -E"),
  units and allowed values.
- `tags` are relevant, and `homepage` is set when there's a page to link to.

## PR rules (not scored; any failure means request changes)

- **Touches only `hooks-catalog.json` and the generated README table.**
  Changes to `scripts/`, `schema/`, `stats/`, `.github/`, `.bb/`,
  `package*.json` or `scores.json` can weaken the checks this review relies
  on, or award the contributor their own score (`stats/` is the install
  counter). Score them as a security Critical, and ask for them in a separate
  PR that a maintainer reviews on its own.
- **Leaves the catalog `name` alone.** Renaming it breaks every installed
  `community/<id>` reference. Top-level `version`, `homepage` and `author`
  belong to the maintainers, so ask the contributor to revert changes to
  them.
- **New `id` values are unique and descriptive,** and don't reuse a removed
  id. Removing or renaming an existing template needs a stated reason.
- **Edits to someone else's template are called out in the PR body.** They
  bump that template's `version` and keep the behaviour its listing
  promises.
- **Credits the contributor.** `author` is the PR author's GitHub login, and
  `version` is set (new templates start at 1.0.0).
- **The PR is complete.** Its checklist is ticked, `npm run validate` passes
  on the PR's catalog (there is no CI, so run it yourself), and every new
  template has a README row (the inspector checks this).
