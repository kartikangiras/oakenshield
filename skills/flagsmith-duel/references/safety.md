# What is guarded, and what is not

**Checked against Flagsmith Cloud on 27 November 2026.** While an experiment was running, the
Admin API accepted a change of split, an edit to a version's value, and the deletion of a version.
A paused experiment kept serving every version. So the lock on a running experiment is this
skill's seal, not Flagsmith's API.

| Risk | Guard |
|---|---|
| Starting something the person did not agree to | `start` needs the code `plan` printed; the code is a digest of the plan's flag, environment, versions, split, events and rule, so any change to them invalidates it |
| Writing to production unasked | Protected environments also need `approve`, which only runs on a person's terminal and makes them type the environment's name |
| A start that fails half way | The seal is written before the experiment is switched on; `start` with the same code continues from the seal instead of creating a second experiment |
| A new flag appearing in other environments | The flag is created switched off; only the experiment's environment serves versions |
| A second experiment on the same flag | `plan` and `start` refuse while one is not completed |
| Changing versions under another environment's experiment | Versions belong to the flag in every environment; `start` refuses to change them while any environment runs an experiment on the flag |
| A stray version | Flagsmith requires every version of a flag in its experiment; `plan` names any the plan does not mention and never deletes it |
| Edits mid-run (split, value, version, metric, audience, pause) | `audit` compares Flagsmith with the seal; `verdict` and `finish` run it first and refuse on a difference |
| Stopping on a lucky streak | `verdict` does not fetch conversions before the planned sample |
| A guardrail that passes because nothing was measured | Flagsmith gives no estimate for a metric with few conversions; `verdict` then runs an exact test on Flagsmith's counts and says so in `guardrails_by` |
| Asking until the answer changes | `verdict` keeps its first answer and returns it from then on |
| Rolling out on stale numbers | The `finish` code is a digest of the winner and the counts the person saw |
| The flag not serving what was decided | `start`, `finish` and `stop` evaluate test identities with `flagsmith eval` and report what the SDK returns |

**Not guarded.** An edit that is made and reverted between two audits leaves no trace this skill
can see (the split and a version's value carry no change time); run `audit` on a schedule to
narrow that window. Approval codes are a convention for an agent that follows instructions, not a
defence against one that does not: for that, use a protected environment and keep the Flagsmith
key away from the agent.
