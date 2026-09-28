# Scoring

Score every added or changed template out of 100 twice: once for security and
once for performance.

- Start each score at 100. Subtract each deduction once per distinct problem
  and stop at 0.
- A Critical deduction caps that score at 40, even if the arithmetic comes
  out higher.
- List every deduction under its template, so another maintainer can check
  the number.
- A PR scores the same as its lowest-scoring template, because a catalog is
  only as safe as its worst entry.
- Inspector lines tagged `sec` and `perf` are candidates for deductions.
  Confirm each one by reading the template before you count it.
- Only deduct for confirmed problems. A problem is confirmed when you
  reproduced it, or when the template's code together with BB's documented
  or observed behaviour shows it. List PLAUSIBLE problems without points, and
  re-score once they're confirmed.
- Don't deduct for Hooks plugin bugs that affect every template alike, such
  as secrets being resolved after payload text. Note them once in the report
  instead.
- Scores for templates already in the catalog live in `scores.json` at the
  repo root, next to their deductions and unscored issues.

## Security: can it hurt the user or leak their data?

| Deduction | When |
| --- | --- |
| **−60, and cap at 40 (Critical)** | A destination or side effect the listing doesn't disclose. A literal `{{secret:…}}`. A credential written inline or as a default. Downloads and runs code. Obfuscation. Touches `~/.bb`, `~/.ssh`, shell rc files, crontab or launchctl. Changes BB configuration. The PR changes review tooling or scores (`scripts/`, `schema/`, `stats/`, `.github/`, `.bb/`, `package*.json`, `scores.json`). Text in the PR aimed at the reviewer or an agent. |
| **−25 (High)** | A credential or capability URL that isn't `secret: true`. Sends agent replies, message text or the whole event somewhere the listing doesn't make obvious. A destructive action (archive, delete, `rm`, force push) without an enforced scope. A policy gate whose failure lets the message through (`onError` proceed) when bypassing it matters. |
| **−10 (Medium)** | An injection-shaped construct: an unquoted expansion, or a placeholder inside quotes, even when today's values are safe. `eval` or `sh -c` on a built string. Writes agent output to a predictable or shared path such as `/tmp` with the default umask. Plain `http://` for a service that carries credentials. A loose trigger that can send data to a target the user didn't intend (for example, any `#n` in a title picks the issue). |
| **−3 (Low)** | A disclosure that's present but vague. No `--` or `-e` before a user-supplied pattern. Output that could echo a secret shorter than 8 characters, which BB doesn't redact. |

## Performance: what does it cost to have installed?

| Deduction | When |
| --- | --- |
| **−60, and cap at 40 (Critical)** | Can loop or fan out with no bound on rate or count: a spawn, tell or retry that its own result re-triggers. Watch for child-completed turns on the parent, `turn.failed` on every retry, and gates seeing hook-spawned messages. |
| **−25 (High)** | Rate-limited but with no total cap (for example "at most once every 2 minutes, forever"). Spawns agent threads after every turn of every thread by default. A gate that makes network calls or can take more than 2 s (it delays every message). Leaves a process running. |
| **−10 (Medium)** | Side effects on a high-frequency event (`thread.idle` fires every turn, `experimental_thread.events` up to once a second) with no scope, beyond what the listing's purpose needs. Heavy work on every run (`bb thread log --all`, downloads, large payloads) when a lighter source exists. Duplicates work BB already does, such as retrying alongside provider-retry. A network call in a command with no time limit (`curl` without `--max-time`). A `timeoutMs` far above the worst case. |
| **−3 (Low)** | Redundant subprocesses or pipes. Unbounded output (no `head -c`). Long payload fields sent without truncation (`{{lastAssistantText|N}}`). |

Correctness isn't scored. A template that doesn't do what its summary says
gets "request changes" whatever its scores. Record those problems as Fix
findings.

## Grades

Show each score with its letter grade. `scripts/scores.mjs` computes it the
same way for the README.

| Grade | Score | Grade | Score | Grade | Score |
| --- | --- | --- | --- | --- | --- |
| A+ | 97–100 | B- | 80–82 | D+ | 67–69 |
| A | 93–96 | C+ | 77–79 | D | 63–66 |
| A- | 90–92 | C | 73–76 | D- | 60–62 |
| B+ | 87–89 | C- | 70–72 | F | below 60 |
| B | 83–86 | | | | |

## Verdict

| Condition | Verdict |
| --- | --- |
| Any Critical | close. If it looks like an honest mistake, request changes and explain why it's Critical. |
| Security below 90, performance below 75, any correctness Fix, or a PR-rule Fix | request changes |
| Otherwise | approve; Nits can be follow-ups |

## Presentation

```
| Template            | Security   | Performance | Verdict         |
| ------------------- | ---------- | ----------- | --------------- |
| community/follow-up | 100/100 A+ | 15/100 F    | request changes |
| PR                  | 100/100 A+ | 15/100 F    | request changes |

community/follow-up
  perf −60 (cap 40): each child's completion starts a parent turn, whose thread.idle spawns another child
  perf −25: spawns a thread after every turn of every top-level thread unless the user adds --title
```

In this example, the arithmetic gives 100 − 60 − 25 = 15, which is already
below the cap of 40, so the score is 15.
