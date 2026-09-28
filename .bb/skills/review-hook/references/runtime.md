# How BB runs a hook template

Checked against bb-plugin-hooks 0.3 (`src/templates.ts`, `src/runner.ts`,
`src/payload.ts`, `server.ts`). If a finding depends on one of these details
and the plugin source is available, confirm it there.

## Install time (`bb hooks use`)

Each event becomes its own hook. Observe templates accept `--event`
overrides, so check the command against events a user might add, not just the
defaults. Gate templates only run on `message.dispatch`.

| Field | What `{{param}}` becomes | Consequence |
| --- | --- | --- |
| `command` | single-quoted for sh; integers verbatim; secrets become `"$BB_SECRET_<NAME>"` | Assign params to variables first (`repo={{repo}}`), then use `"$repo"`. A placeholder inside quotes (`"{{repo}}"`) puts literal `'…'` into the value. |
| `url`, `headers` | verbatim; secrets resolve to the raw value when the hook runs | |
| `body` | JSON-escaped string contents | Write `"{{param}}"` inside a JSON string. |
| `match` | verbatim, then compiled as a JavaScript `RegExp` (max 512 chars) | Secret params aren't available in match. POSIX classes like `[[:upper:]]` don't work here. |

- Placeholders that aren't params stay as they are. In `command`, `url`,
  `headers` and `match` that leaves the literal `{{x}}` text. In `body` they
  read the event payload when the hook runs: `{{thread.title}}`, or
  `{{lastAssistantText|500}}` to truncate with `…`. Missing paths render as
  empty strings and objects render as JSON.
- Secret params are stored encrypted under the name `<hook id>/<param>`, for
  example `pagerduty/routingKey`, and the hook itself only holds
  `{{secret:pagerduty/routingKey}}`. At run time the runner resolves every
  `{{secret:NAME}}` it finds in `command`, `url`, `headers` or `body`,
  including names the template wrote itself. Because the names are
  predictable, a template that contains a literal `{{secret:…}}` can read
  another hook's credential. That is always a Block.
- `{{secret:…}}` in `body` is resolved after payload placeholders render.
  Payload text such as the agent's reply or a thread title can therefore pull
  in a secret the same hook already references. That's an upstream plugin
  issue, but avoid templates that echo agent text next to a secret
  (webhook-URL services are the usual case).
- `required` together with `default` is contradictory, and this repo's
  validator rejects it.

## Run time

- **Commands** run under `/bin/sh -c` on the BB server host, not in the
  thread's workspace, and inherit the server's whole environment. The event
  arrives as one line of JSON on stdin. Output is capped at 64 KiB. The
  default timeout is 30 s and the maximum 600 s. Up to 8 observe hooks run at
  once.
- **Gates** run in their own lane of 4 and are capped at 8 s each. All gates
  on one message share an 8.5 s budget, and gates that run out of budget get
  their `onError` applied. A slow gate delays every message.
- **Environment:** `BB_HOOK_EVENT`, `BB_HOOK_ID`, `BB_THREAD_ID`,
  `BB_PROJECT_ID`, `BB_PROVIDER_ID`, `BB_THREAD_STATUS`, `BB_THREAD_TITLE`
  (first 1,000 chars), `BB_SERVER_URL` and `BB_CLI`.
  `BB_PARENT_THREAD_ID` and `BB_ENVIRONMENT_ID` are set only when the thread
  has them.
  - Gates also get `BB_DISPATCH_ATTEMPT`, `BB_MESSAGE_TEXT` (first 1,000
    chars only, so read `.input.text` from stdin for the whole message), and
    `BB_MODEL`, `BB_REASONING_LEVEL`, `BB_SERVICE_TIER` and
    `BB_PERMISSION_MODE`.
  - Observe hooks get that `BB_MODEL` group only when their text mentions one
    of those names.
- **URL hooks** send a POST with `content-type: application/json`,
  `x-bb-hooks-event` and `x-bb-hooks-id`, plus HMAC signature headers when the
  user has set a webhook secret. Redirects are refused. `http://` is accepted
  even though the docs say HTTPS. With no `body`, the entire event JSON is
  sent, including `lastAssistantText`, `error` or the dispatch `input`. A
  non-2xx response counts as an error in `bb hooks history`.
- Secret values of 8 characters or more are redacted from output and errors.
  Shorter ones aren't.
- **`match`** filters before anything runs. `projectId` and `providerId` must
  match exactly. `title` and `text` are JavaScript regexes tested against the
  first 20,000 chars. `text` is:
  - the message on `message.dispatch`
  - `lastAssistantText` on `thread.idle`
  - `error` on `thread.failed`
  - the queued message on `message.*`
  - otherwise empty, so only a pattern that matches `""` passes.

## Event payloads

Every payload carries `event`, `hookId`, `timestamp` and `serverUrl`. These
fields are what `{{…}}` and `jq` can read.

| Event | Fires | Fields |
| --- | --- | --- |
| `thread.idle` | after **every** turn, not once per thread | `thread`, `lastAssistantText` |
| `thread.failed` | thread enters error | `thread`, `error` |
| `turn.failed` | every failed turn, **including each retry's failure**; the thread is already in `error` | `threadId`, `requestId`, `turnId`, `errorInfo` (`{category, httpStatusCode, providerCode}` or null), `inputAccepted`, `rateLimits`, `attemptNumber`, `thread` (looked up). **No error text**, so `{{error}}` is empty. |
| `interaction.pending` | the agent is waiting on the user | `thread`, `interaction` |
| `message.queued` / `.dispatched` / `.cancelled` | queue changes | `entry` (`threadId`, `content`), `thread` |
| `message.dispatch` (gate) | before **every** message reaches a provider, including agent-sent, system and retried ones | `thread` (status is `pending` for a thread's first message), `input` (`text`, `blocks`), `initiator` (`user`, `agent`, `system` or `mixed`), `senderThreadId`, `parentThreadId`, `attempt`, `requestedExecution` |
| `thread.created` | a thread row is created; the first message may not exist yet | `thread` |

`errorInfo.category` is one of `rate-limit`, `overloaded`, `billing`,
`unauthorized`, `context-window-exceeded`, `connection-failed`,
`stream-disconnected`, `internal`, `policy`, `unknown`, and a few others.
Branch on the category instead of matching a provider's error wording.

`bb hooks test` sends a sample payload. For `turn.failed` it has
`errorInfo: null`, so a command that exits 0 on the sample may never have
reached its main path.

## Gate decisions

If the last stdout line is a JSON decision, it wins. Otherwise exit 0
proceeds, 2 rejects (the first 5 lines, up to 500 chars, of stderr are
shown), and 3 waits. Any other exit code, a timeout or a crash applies
`onError`, which defaults to **proceed**, so a broken gate lets everything
through. Gates also see messages from agents, from orchestration (agent
teams, playbooks) and from other hooks' `bb thread spawn`, `tell` and
`retry`.

## bb CLI facts that commands rely on

- `bb thread history <id> --json` is the user's prompt history, newest
  first. It doesn't include the spawn prompt, so a single-turn thread returns
  `[]`. To get the prompt of a failed turn, read the `client/turn/requested`
  events from `bb thread log <id> --json --all` and match `.data.requestId`
  to the payload's `requestId`.
- `bb thread retry <id> --turn <requestId>` re-runs a failed turn properly
  (it continues mid-stream when `inputAccepted` is true). Prefer it over
  `bb thread tell … "continue"`.
- A thread spawned with `--parent-thread` reports back to its parent. When it
  finishes, the parent gets a `[bb system] … completed` message
  (`initiator: system`, `systemMessageKind: child-completed`) that runs a
  parent turn. Any hook on the parent's `thread.idle` or `turn.failed` fires
  again.
- `bb thread log <id> --json --limit N` returns the **oldest** N events. Use
  `--all` (or `--after-seq`) to reach the latest turn.
- `bb thread output <id>` prints the final output. Pass long text with
  `--prompt-file -` or `--message-file -`.
- Call `bb` as `"${BB_CLI:-bb}"`, and assign such variables before any branch
  that could skip the assignment.
