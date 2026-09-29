# Catalog format reference

`hooks-catalog.json` is a JSON document describing a catalog and its templates.
Our Hooks plugin for BB reads it (version 0.3.0 or later; see the
[README](../README.md#requirements)).
The [JSON Schema](../schema/hooks-catalog.schema.json) is the source of truth for
validation; run `npm run validate` after editing the catalog.

## Example

```json
{
  "$schema": "./schema/hooks-catalog.schema.json",
  "name": "community",
  "version": "1.0.0",
  "templates": [
    {
      "id": "pagerduty",
      "name": "PagerDuty alert",
      "summary": "Trigger a PagerDuty incident when a thread or turn fails.",
      "kind": "observe",
      "events": ["thread.failed", "turn.failed"],
      "tags": ["notifications", "on-call"],
      "author": "your-github-login",
      "version": "1.0.0",
      "params": [
        {
          "key": "routingKey",
          "label": "Integration routing key",
          "type": "string",
          "required": true,
          "secret": true
        }
      ],
      "url": "https://events.pagerduty.com/v2/enqueue",
      "body": "{\"routing_key\":\"{{routingKey}}\",\"payload\":{\"summary\":\"BB {{event}}: {{thread.title}}\"}}"
    }
  ]
}
```

## Template fields

- `id` — lowercase letters, digits and dashes. Installed as
  `<catalog-name>/<id>`.
- `name`, `summary` — listing text. Optional metadata includes `description`,
  `tags`, `author`, `version`, `homepage` and `notes`.
- `kind` — `observe` reacts to events; `gate` decides whether a message may
  reach the agent.
- `events` — events that trigger an observe template: `thread.created`,
  `thread.active`, `thread.idle`, `thread.failed`, `thread.archived`,
  `thread.unarchived`, `thread.deleted`, `interaction.pending`,
  `message.queued`, `message.dispatched`, `message.cancelled`, `turn.failed`,
  `experimental_thread.events` and `experimental_terminal.input`. Gate
  templates use `message.dispatch` only.
- `params` — each parameter has a `key`, `label` and `type` (`string`,
  `integer` or `agent`), with optional `default`, `required`, `secret` and
  `description`. An `agent` parameter lets the user choose who runs a spawned
  thread. In a command, it expands to `{{key.mode}}`, `{{key.providerId}}`,
  `{{key.model}}`, `{{key.reasoningLevel}}` and `{{key.serviceTier}}`. BB also
  sets `BB_MODEL`, `BB_REASONING_LEVEL` and `BB_SERVICE_TIER` for inherited
  settings.
- A template must have exactly one of `command` (a `/bin/sh` script) or `url`
  (an HTTPS endpoint that receives a JSON POST). Optional fields include `body`
  (a JSON template), `headers`, `match` (`projectId`, `providerId`, `title` and
  `text` regular expressions), `timeoutMs` and `onError` (`proceed`, `reject`
  or `wait` for gate hooks).

## Placeholders

- `{{param}}` is filled when the user installs the template: shell-quoted in
  `command` (integers are inserted verbatim), and inserted verbatim in `url`,
  `headers` and `match`. In `body`, parameter values are JSON-escaped. Secret
  parameters become `{{secret:…}}` references that BB resolves when the hook
  runs.
- In `body`, other placeholders read the event at run time: `{{event}}`,
  `{{thread.title}}`, `{{thread.id}}`, `{{lastAssistantText|500}}` (truncated),
  `{{error|500}}` and other payload paths.
- Commands receive the event as JSON on stdin and these environment variables:
  `BB_HOOK_EVENT`, `BB_THREAD_ID`, `BB_THREAD_TITLE`, `BB_THREAD_STATUS`,
  `BB_PROJECT_ID`, `BB_PROVIDER_ID`, `BB_ENVIRONMENT_ID`,
  `BB_PARENT_THREAD_ID`, `BB_SERVER_URL` and `BB_CLI` (the `bb` binary). Gate
  hooks also receive `BB_MESSAGE_TEXT`. They can proceed with exit code 0,
  reject with exit code 2 (stderr is the reason), wait with exit code 3, or
  return a JSON decision on stdout.
