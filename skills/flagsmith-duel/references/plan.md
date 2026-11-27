# The plan file

```json
{
  "name": "First screen duel",
  "flag": "first_screen",
  "environment": "Staging",
  "hypothesis": "A shorter first screen gets more visitors to run a check.",
  "control": "control",
  "versions": {
    "agent_a": { "by": "Agent A", "hypothesis": "…", "value": { "any": "json" }, "predicts": { "control": 0.3, "agent_a": 0.4, "agent_b": 0.35 } },
    "agent_b": { "by": "Agent B", "hypothesis": "…", "file": "b.json" }
  },
  "split": { "agent_a": 33, "agent_b": 33 },
  "goal": { "event": "check_run", "name": "Ran a check" },
  "guardrails": [{ "event": "setup_snippet_copied", "name": "Copied the setup snippet" }],
  "rule": { "min_per_arm": 150, "win_above": 0.95, "harm_below": 0.05 },
  "protect": ["Staging"]
}
```

| Field | Meaning |
|---|---|
| `flag` | The flag the code reads with `getExperimentFlag`. Created (switched off elsewhere) if missing. |
| `environment` | Name or client-side key. `"create_environment": true` makes it if missing. |
| `project` | Only when the directory is not bound to a project (`flagsmith init`). |
| `control` | The value visitors get today. The code must treat it as "show what we show now". |
| `versions` | One to four challengers. The key becomes the variation key the SDK reports. `value` is text or JSON (stored as text, 20,000 characters at most); `file` reads it from a file beside the plan. |
| `versions.*.predicts` | Optional: the author's predicted conversion rate per arm. `verdict` scores it. |
| `split` | Percent of visitors per challenger. Control gets the rest. Default: equal shares. |
| `goal.event` | The event the code sends with `trackEvent`. A metric counting visitors who sent it at least once is created, or reused if the environment has one. |
| `guardrails` | Events that must not get worse. |
| `rule` | See `rule.md`. `min_per_arm` is the sample every arm needs before outcomes are read. |
| `protect` | Extra environment names or keys that need the person's own `approve`. |

Files written beside the plan: `duel.seal.json` (what was started), `duel.verdict.json` (the full
result table, the rule, prediction scores), `duel.approvals.json` (a person's terminal approvals).
