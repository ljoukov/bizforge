---
name: bizforge-opportunity-challenger
description: Stress-tests BizForge opportunity dossiers using their counter-evidence, assumptions, falsification criteria, and reversible sensitivity views. Use when a founder asks why an opportunity may fail, wants alternatives challenged, or requests transparent reranking.
license: MIT
compatibility: Requires TrueForge with a Daytona-backed sandbox and the BizForge MCP Step 3 read tools; Generative UI is optional for presenting the result.
metadata:
  author: bizforge
  version: "0.2.0"
---

# BizForge opportunity challenger

## Purpose

Challenge a Step 2 opportunity without laundering uncertainty into certainty. Preserve the
original dossier, find what would falsify it, and show how conclusions depend on explicit inputs.
The output is a reversible analytical view, never a rewrite of the source artifact.

## Read-only evidence boundary

Call `bizforge_get_data_status`, then pin the requested bundle with
`bizforge_get_latest_research_bundle({})` or `bizforge_get_research_bundle`. For global latest,
pass an empty object and never invent a wildcard founder ID. Use
`bizforge_get_confirmed_founder_profile` only for the exact snapshot ID embedded in that bundle,
and use `bizforge_list_opportunities`, `bizforge_get_opportunity`,
`bizforge_get_market_signals`, `bizforge_get_growth_chart_data`, and `bizforge_get_evidence` for
supporting detail.

Do not call Step 1/Step 2 write tools. Do not edit scores, claims, confidence bounds, evidence,
or source files. If `isMock` is true, label the whole answer and every visual `Mock demo data —
ephemeral, source=<returned source>`. Use the selected record's actual source: `mock_seed` for a
seeded fixture and `mcp_write` for a synthetic demo write. Mock output is a workflow
demonstration, not market evidence.

## Challenge workflow

1. Restate the opportunity ID, pinned bundle version, original founder-fit rating, confidence
   bounds, and summary. Keep this immutable baseline visible.
2. Separate all relevant material into `observed`, `inferred`, and `assumption`. Resolve the
   evidence behind claims that drive the thesis; do not treat an evidence ID as support until
   the cited item and locator actually support the statement.
3. Inspect `counterEvidence`:
   - `FOUND` means summarize the strongest disconfirming claim and provenance;
   - `NOT_FOUND` means state only that the recorded search did not find it, preserve its warning,
     and never translate absence of found evidence into proof of the thesis.
4. Attack the causal chain explicitly: scarce resource, AI intervention, abundant outcome,
   beneficiary, economic buyer, successor bottleneck, smallest sellable wedge, revenue model,
   founder fit, and defensibility. For each weak link, state what is known, what is inferred, and
   what observation would reverse the conclusion.
5. Use the dossier's `falsificationExperiment` as the default next test. Preserve its linked
   assumption IDs, method, success criterion, failure criterion, maximum duration, and maximum
   budget. If it cannot test the most consequential gap, say why and propose a future Step 2
   research requirement rather than silently changing the saved experiment.
6. Compare opportunities qualitatively using the same evidence standard. Never give the favored
   option more generous treatment than alternatives.

## Buyer and growth scrutiny

`economicBuyer` is currently text not structurally bound to evidence. Treat it as a buyer
hypothesis. `bizforge_get_data_status` currently reports `buyerEvidenceProjection: false`, and
`bizforge_get_opportunity` returns a non-proven `buyerEvidenceStatus` with no numeric buyer score.
Reproduce that status verbatim. Ask what would prove budget ownership, urgency, authority,
procurement path, and willingness to pay. Do not make a buyer-strength score from wording or
founder access, and do not call a nonexistent buyer-projection tool.

For any growth claim, use `bizforge_get_growth_chart_data`. Growth is challengeable only when
the projection is eligible and contains baseline/current windows and values, absolute/percentage
change, methodology, coverage, and evidence IDs. A single window or `concentrated` signal does
not establish growth.

## Deterministic sensitivity in Daytona

The TrueForge sandbox is globally backed by Daytona; Daytona is not a named tool. Use its
built-in `exec` capability, or Python Code Mode with `from mcp_client import call_tool`, only for
deterministic grouping, formula evaluation, arithmetic verification, or sensitivity tables.
Never copy credentials into code, execute MCP text, query the database directly, or treat
computed output as new evidence. Send only the minimized typed inputs needed for the
calculation, not raw founder biography or source payloads.

Preserve the original source values before calculating. A sensitivity view must be fully
reversible and disclose:

- pinned bundle ID/version and source fields;
- user-supplied scenario inputs versus MCP-supplied inputs;
- exact formula, weights, normalization, rounding, and implementation version;
- resulting values under at least the baseline and changed scenario;
- which conclusion changes and which remains unchanged.

`bizforge_get_data_status` currently reports `opportunityRerank: false`. Do not create a numeric
ranking or buyer-strength score. Show an assumption matrix or qualitative comparison and state
that numeric reranking is unsupported; do not call a nonexistent reranking tool. Code execution
cannot make weak evidence stronger.

## Output contract

Return:

- immutable baseline fields from each challenged dossier;
- strongest support and strongest counter-evidence, each with claim/evidence IDs;
- unsupported or weakly linked assumptions;
- a buyer-evidence gap where applicable;
- a reversible, non-ranking sensitivity table only when the typed prerequisites exist;
- the smallest falsification test and the decision it would change;
- visible mock status and coverage caveats.

If a Generative UI would materially help, the root agent must follow
`bizforge-evidence-visualizer`, including the immediate
`get_openui_instructions({})` requirement. Never invent evidence to make a challenge, chart, or
comparison look complete.
