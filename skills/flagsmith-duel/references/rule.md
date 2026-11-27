# The rule

The rule is part of the plan, and the plan's digest is the approval code for the start. So the rule
cannot be changed after the numbers are known without breaking the seal.

1. **Seal broken: no verdict.** If `audit` finds a difference between Flagsmith and the seal, the
   run cannot name a winner.
2. **Sample first.** Until every arm has `min_per_arm` visitors, `verdict` reads exposure counts
   only. Conversions are not fetched, so nobody can stop the run on a lucky streak.
3. **Split check.** If the sample ratio p-value is below 0.001, visitors were not divided as
   planned and the verdict is `void`. The p-value is Flagsmith's when it gives one. Flagsmith Cloud
   gave none for a three-version experiment (27 November 2026), so otherwise it is a chi-square
   test of Flagsmith's visitor counts against the planned split; `sample_ratio_by` in
   `duel.verdict.json` says which.
4. **Qualify.** A challenger qualifies when Flagsmith's chance to win against control on the goal
   is above `win_above`, and its chance to win on every guardrail is not below `harm_below`.
   Flagsmith gives no estimate for a metric with few conversions (it gave none at 2 to 5 per
   version). Such a guardrail is judged by a one-sided Fisher exact test on Flagsmith's counts:
   it fails when the challenger has fewer conversions than control with a p-value below
   `harm_below`. `guardrails_by` in `duel.verdict.json` says which was used.
5. **Decide.** Nobody qualifies: control stays. One qualifies: it wins. Several qualify: the
   highest observed rate wins.
6. **Once.** The first `decided` or `void` verdict is kept in `duel.verdict.json`. Asking again
   returns that verdict (`read_once: true`) and does not read Flagsmith's results a second time.

Flagsmith compares each challenger with control, never challengers with each other. When two
challengers both qualify, `verdict` adds a two-proportion z-test on Flagsmith's own counts
(`head_to_head` in `duel.verdict.json`) and says so when the two cannot be told apart. That number
is this script's arithmetic, not Flagsmith's.

Predictions, when the plan has them, are scored by mean absolute error against the observed rates.
The score never affects the decision.
