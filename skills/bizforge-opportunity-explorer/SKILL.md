---
name: bizforge-opportunity-explorer
description: Coordinates evidence-grounded exploration and comparison of BizForge Step 2 opportunity dossiers. Use when a founder wants to inspect, compare, select, or question opportunities in a ResearchBundle.
license: MIT
compatibility: Requires TrueForge with the BizForge MCP Step 3 read tools; attach the evidence visualizer and opportunity challenger skills for UI and scrutiny.
metadata:
  author: bizforge
  version: "0.3.0"
---

# BizForge opportunity explorer

## Purpose

Help a founder understand a validated Step 2 `ResearchBundle` without turning hypotheses into
facts. This is a read-only Step 3 workflow. It may compare opportunities and help the user choose
what to examine next, but it must not rewrite Step 1 or Step 2 records.

Attach these three Step 3 skills to the same saved TrueForge root agent:

- `bizforge-opportunity-explorer` — coordinates the conversation and MCP reads;
- `bizforge-evidence-visualizer` — authors Generative UI and evidence-safe charts;
- `bizforge-opportunity-challenger` — tests assumptions, counter-evidence, and sensitivity.

Skills do not invoke one another. The root agent must explicitly follow the appropriate attached
skill when the user asks for a chart, interactive comparison, challenge, or sensitivity view.

## Read-only source of truth

Call `bizforge_get_data_status` first and require `persistenceReady` plus
`capabilities.step3ReadProjections`. Then use only these BizForge MCP read tools:

- `bizforge_get_latest_research_bundle({})` when no bundle ID or founder ID was supplied. Omit
  `founderId` for the global latest bundle; never send `"*"`, `"all"`, `"latest"`, or another
  invented selector. Supply `founderId` only when the user or an earlier canonical MCP record
  provided the exact ID;
- `bizforge_get_research_bundle` for a specific bundle ID/version;
- `bizforge_get_confirmed_founder_profile` for the exact snapshot ID embedded in the bundle;
- `bizforge_list_opportunities` for a compact index;
- `bizforge_get_opportunity` for a selected dossier;
- `bizforge_get_market_signals` for cited signal details;
- `bizforge_get_growth_chart_data` for an eligibility-checked growth projection;
- `bizforge_get_evidence` for cited provenance.

Do not call Step 1 or Step 2 write tools. Do not query a database, sandbox file, or external
source as a substitute for MCP data. Pin the chosen `bundleId` and `bundleVersion` for the whole
answer. If the latest version changes, disclose that and ask before switching.

## Exploration workflow

1. Load and pin the requested bundle. State its ID, version, research window, generated time,
   embedded founder snapshot ID, and warnings. Resolve that exact snapshot when
   founder-fit context matters; never substitute a newer profile.
2. Use `bizforge_list_opportunities` for the overview. Preserve opportunity IDs, original
   founder-fit ratings, confidence bounds, and warning language exactly. Do not invent a score
   or sort order that the MCP did not provide.
3. Briefly ask what matters most when the answer would change the comparison: time to revenue,
   available capital, offer type, buyer access, regulatory exposure, or learning goal. If the
   user has not specified a preference, show a neutral evidence summary instead of guessing.
4. Fetch only the dossiers selected by the user, or a small comparison set if they asked for an
   overview. For each, distinguish:
   - observed claims supported by evidence;
   - inferences with their rationale and confidence bounds;
   - assumptions and their validation plan;
   - counter-evidence status and warning;
   - the next falsification experiment, budget, and duration.
5. Resolve market signals and important evidence IDs before making a comparative statement.
   Keep exact evidence IDs available in the answer and explain coverage, sample size, retrieval
   time, and methodology in plain language.
6. When a visual would materially help, follow `bizforge-evidence-visualizer`. When the user asks
   “why not,” “what could fail,” or requests a ranking/sensitivity analysis, follow
   `bizforge-opportunity-challenger`.
7. End with a reversible next step: inspect evidence, compare two dossiers, run the documented
   falsification experiment, or name a missing source to collect in a future Step 2 run.

## Economic buyer boundary

The current `ResearchBundle` includes `economicBuyer` text but does not structurally bind that
field itself to evidence. `bizforge_get_data_status` currently reports
`buyerEvidenceProjection: false`, and `bizforge_get_opportunity` returns a non-proven
`buyerEvidenceStatus` with no buyer score. Reproduce that status verbatim and present the
potential buyer as a **hypothesis/evidence gap**. Do not render a buyer-strength chart, numeric
buyer score, or claim that willingness to pay has been demonstrated.

The same status reports `opportunityRerank: false`; therefore preserve the source order and use a
qualitative comparison. Do not invent or call a buyer-projection or reranking tool.

Direct beneficiary and economic buyer are not necessarily the same actor. Keep them separate and
name the evidence needed to validate who controls budget and purchasing authority.

## Answer contract

Every substantive comparison must include:

- pinned bundle ID/version and research window;
- original opportunity IDs and unmodified founder-fit/confidence fields;
- the strongest observed support and strongest counterpoint for each option;
- provenance links by evidence ID for claims that drive the conclusion;
- explicit gaps, coverage caveats, and assumptions;
- a falsification next step with the MCP-provided success/failure criteria where available.

Never fabricate plausible facts to fill an empty view. Never imply that code execution, visual
polish, repetition, or model confidence strengthens evidence.
