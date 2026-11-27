---
name: flagsmith-duel
description: Settle a disagreement between competing versions of a screen, message, price or setting with one Flagsmith experiment, from plan to rollout, using the Flagsmith CLI. Use when people or agents disagree about which version is better, when asked to A/B test two or more proposals against what ships today, or to start, check, judge or finish such an experiment. Creates the flag, the versions, the metrics and the experiment, seals the run against edits, applies a decision rule fixed before the start, and rolls out the winner. Stops to ask a person before starting and before rolling out.
compatibility: Needs the Flagsmith CLI 2.0 or later (logged in, or FLAGSMITH_API_KEY set), Node 20 or later, and git.
---

# Flagsmith duel

Two or more versions compete against today's version in one Flagsmith experiment. One script does
every Flagsmith read and write through the `flagsmith` CLI:

```
node <this skill>/scripts/duel.mjs <command> [plan file]
```

Each command prints **one line of JSON**. Do what its `next` field says. Do not read the script,
and do not call the Flagsmith API yourself: the script already fetches only the fields it needs.
The plan file defaults to `duel.json` in the current directory.

## The job

1. One command writes the plan and checks it. Each version's value (text or JSON) is a file,
   which you do not need to read:
   `init <flag> --environment <name> --version <key>=<file> --version <key>=<file> --goal <event>
   --hypothesis "<one sentence>" [--guardrail <event>] [--min <visitors per version>]
   [--project <id>] [--new-environment]`
   It writes `duel.json`, changes nothing in Flagsmith, and prints what `start` would do, with an
   approval code. **Show the person that line and ask.**
2. `plan` prints that line again after the plan file is edited by hand (its other fields are in
   `references/plan.md`; read it only if one is needed).
3. `start --approve <code>` creates what is missing (flag, versions, metrics, experiment), starts
   the experiment, checks what the SDK now serves, and writes the seal. If it fails half way, run
   it again with the same code: it continues from where it stopped.
4. `audit` compares Flagsmith with the seal. Run it when asked "is it still clean?" and in CI
   (exit code 2 means something changed). `verdict` and `finish` run it themselves first.
5. `verdict` reports `collecting` (visitor counts only) until every arm has the planned sample,
   then `decided` or `void` with the reason in `why`. That answer is read once: asking again
   returns the same one. **Show the person that line and ask.**
6. `finish --approve <code>` completes the experiment so the flag serves the winner to everyone in
   that environment, then checks it. Add `--remove-losers` only if the person asks.

`stop --approve <code>` ends a run early: no winner, everyone gets today's version.

## Where you stop

- An approval code is only valid after the person said yes to the line it came with. Never pass a
  code they have not seen. If the plan or the numbers change, the code changes: ask again.
- Environments named like production (or listed in the plan's `protect`) also need the person to
  run `approve` in their own terminal. You cannot do that for them. Pass on the command you are given.
- After `start`, do not edit the plan, the flag, the split or a version, and do not look at results
  any other way. `verdict` reads outcomes once the sample is in; looking early is how false
  winners happen.
- "Neither version beats today's" and "void" are answers. Report them; do not rerun to get another.
- If a command fails, report its `error` and follow `next`. Do not work around it with other commands.

## Reporting

Tell the person the `why` sentence and the winner, and name the file in `details` for the full
table. The reasons behind the rule and the guards are in `references/rule.md` and
`references/safety.md`; read them only when the person asks why.
