---
name: bizforge-founder-minimum-interview
description: Runs the minimum necessary BizForge founder interview, asking only for missing business constraints and preferences and recording answers as provenance-backed self-report. Use after public evidence is collected or skipped, when required FounderProfileSnapshot fields remain unknown, uncertain, or contradictory.
license: MIT
compatibility: Requires TrueForge with a sandbox enabled, an interactive chat or Generative UI channel, and the BizForge MCP Step 1 tools listed below.
metadata:
  author: bizforge
  version: "0.2.0"
---

# BizForge minimum founder interview

> Founder setup produces an editable, evidence-backed planning thesis—not a psychological
> profile. Use only public professional evidence collected with explicit consent and direct
> founder self-report. Keep observation, self-report, inference, and assumption distinct;
> collect and retain only what Stage 2 needs.

## Purpose

Fill only the decision-relevant fields that public evidence cannot establish reliably. Produce
a `FounderInterviewPatch` for the thesis editor without inventing defaults, repeating answered
questions, or turning the interview into a personality assessment.

## Inputs

- A `FounderEvidenceDraft`; it may be empty because profile collection was skipped.
- Existing founder-confirmed answers and prior interview patches.
- The active consent status and any correction, revocation, or deletion request.

If consent is revoked or deletion is requested, stop the interview and hand off that request.

## Required runtime capabilities

Call `bizforge_get_data_status` before asking for or retaining founder input. If `isMock` or
`ephemeral` is true, keep real founder answers `session_only`: do not call
`bizforge_put_evidence`, do not claim persistence, and do not make the draft confirmable. Only
explicitly synthetic demo answers may exercise mock writes after the user accepts the
mock/ephemeral limitation. Label them `mock=true` and show the exact returned `source`:
`mcp_write` for a synthetic demo write and `mock_seed` only for a seeded fixture. For that
accepted synthetic demo only, pass `isSynthetic: true` and `acceptMockStorage: true` on the
applicable mock writes.

Use `bizforge_put_evidence` to record each retained answer as a canonical `user_input` evidence
item and `bizforge_get_evidence` to verify that its returned ID resolves. Describe that record as
durable only when `bizforge_get_data_status` says it is durable. The host or persistence boundary
must inject authoritative TrueForge session, turn, and input IDs. Never invent those identifiers,
and never use a sandbox file path as a durable artifact reference.

Use `bizforge_get_founder_setup_run` to load current evidence/interview state and
`bizforge_transition_founder_setup_run` to atomically persist each `FounderInterviewPatch` with
`setupRunId`, expected version, and an idempotency key. The patch is conceptual and transition
`stateData` is currently untyped; apply this skill's output and acceptance checks before calling
the tool and do not claim that the MCP validated the patch shape. Never blindly retry an
ambiguous transition or reconstruct missing persisted state from conversation memory.

Before durably persisting any answer—even on the interview-only branch—explain and use
`bizforge_record_consent` to record separate consent scopes for
`retain_minimized_founder_self_report`,
`retain_minimized_founder_snapshot`, optional `retain_founder_version_history`, and optional
`use_confirmed_founder_snapshot_for_research`. The last scope controls Stage 2 use and is not a
condition for completing a private Step 1 draft. If self-report retention is declined, keep the
conversation `session_only`, do not call the evidence persistence API, and do not confirm a
snapshot.

If durable persistence is unavailable or `bizforge_get_data_status` reports mock/ephemeral mode,
the founder may continue conversationally, but label the result `session_only` and
`readyForDraft: false`. Do not claim that it can be confirmed or used by Stage 2.

## Build a gap map first

Before asking anything, classify each required field as:

- `confirmed` — direct founder answer already exists;
- `candidate` — public evidence suggests a value, but the founder has not confirmed it;
- `missing` — no usable value exists;
- `contradictory` — sources disagree;
- `declined` — the founder prefers not to answer.

Never re-ask a confirmed field. Never infer appetite or tolerance values from profile evidence.

## Question policy

Ask a compact interview covering only missing, candidate, or contradictory fields. Use the
choice-oriented question control for bounded enums, skip choices, and final confirmation. Use
ordinary chat turns or a registered Generative UI form for numeric and free-text fields. Attach
each response to explicit field keys before normalization. Group the interview into at most
these six topics, then ask follow-ups only for invalid or ambiguous answers:

1. **Operating budget:** hours per week, starting capital in USD, and target days to first
   revenue.
2. **Team:** intended team size, including whether the founder expects to start solo.
3. **Offer and buyer:** software, service, or hybrid; and consumer, SMB, mid-market,
   enterprise, or public-sector customers.
4. **Selling and access:** direct low/medium/high sales tolerance and existing access to
   potential buyers, distribution, data, expertise, or partners.
5. **Risk and regulation:** directly self-reported low/medium/high risk tolerance and
   regulatory tolerance.
6. **Boundaries:** geography, launch horizon, hard constraints, and explicitly unwanted
   industries or business models.

Also show candidate competencies from public evidence and ask the founder to correct, remove,
or confirm them. At least one responsibly supported competency is required for a confirmed
snapshot.

If no candidate competency exists, ask the founder to name one to three competencies relevant
to building, operating, or selling a business, choose a self-assessed level, and optionally give
years of experience. Persist each as `user_input` evidence. Make clear that the founder may
correct or remove it and that the self-assessment is not externally verified.

After the founder confirms the normalized self-assessment, attach the returned `user_input`
evidence ID to that competency. Put attribution confidence on the observed claim: after exact
confirmation it may use `lower = estimate = upper = 1` because it says only that the founder
made the statement. For the competency's distinct proficiency confidence, use the conservative
uncorroborated-self-report policy `lower = 0.25`, `estimate = 0.5`, `upper = 0.75`, with a
rationale that the level is self-reported and not externally verified. Do not raise proficiency
confidence merely because attribution is certain; only a pinned deterministic policy using new
corroborating evidence may change it. Optional `yearsExperience` must be between 0 and 80.

Every question must offer “not sure” or “prefer not to answer.” A declined required value stays
unresolved; it is not permission to choose a default.

## Normalize transparently

Normalize answers only with deterministic conversions, then echo the result for correction.
Examples:

- “six weeks” becomes `42` days;
- “about ten hours” becomes `10` hours per week only after the founder confirms that number;
- “just me” becomes team size `1`;
- currency other than USD must show the source amount, conversion date/rate, and converted USD
  amount before confirmation.

The canonical business-appetite constraints are:

- `hoursPerWeek`: greater than 0 and at most 168;
- `capitalBudgetUsd`: at least 0;
- `timeToFirstRevenueDays`: a positive integer;
- `teamSize`: a positive integer;
- `preferredOfferTypes`: one or more unique values from `software`, `service`, `hybrid`;
- `preferredCustomerTypes`: one or more unique values from `consumer`, `smb`, `mid_market`,
  `enterprise`, `public_sector`;
- `salesTolerance`, `riskTolerance`, `regulatoryTolerance`: `low`, `medium`, or `high`.

## Record self-report as evidence

For each answer or correction, send the normalized answer and its field key to
`bizforge_put_evidence`. It must return a complete canonical `user_input` evidence item,
including title,
summary, source record ID, SHA-256 digest, durable artifact reference, locator, and extraction
provenance. The host or tool injects runtime session/turn/input IDs. Represent the corresponding
claim as an observed statement such as “The founder states …”.

A founder-confirmed correction creates a new user-input evidence item and claim. Do not edit
the public source or silently replace conflicting history.

When testimony conflicts with public evidence:

- preserve both sources and flag the discrepancy;
- let the founder's current statement govern current preferences and constraints;
- do not treat the founder's statement as proof that an external historical record is false.

## Output: `FounderInterviewPatch`

Return:

- normalized `businessAppetite` fields;
- confirmed/corrected competencies;
- constraints, exclusions, geography, and access advantages;
- user-input evidence items and observed claims;
- contradictions and `unresolvedFields`;
- `readyForDraft: true` only when every required field and at least one competency can be
  represented without fabrication.

Use this explicit envelope shape:

```text
FounderInterviewPatch
  founderId
  setupRunId
  businessAppetite?         absent until all required values are known
  competencies[]
  constraints[]
  accessAdvantages[]
  userInputEvidenceIds[]
  observedClaimIds[]
  contradictions[]
  unresolvedFields[]
  persistenceStatus         durable | mock_ephemeral | session_only | failed
  readyForDraft
```

The `bizforge_put_evidence` schema is authoritative for evidence, while the interview patch in
transition `stateData` is not server-validated. Never inline an approximate evidence record when
persistence failed.

Apply every output and acceptance check in this skill, then call
`bizforge_transition_founder_setup_run` for the compare-and-set transition to `DRAFT_REVIEW`.
The successful transition records the untyped patch in the active backend but does not prove its
shape is valid or make mock storage durable. A rendered chat summary is not an MCP handoff.

Do not emit a schema-valid placeholder merely to make `readyForDraft` true.

## Hard boundaries

- No biography fishing, therapy-style probing, personality tests, or hidden suitability score.
- No value judgment about the founder's ambition, experience, risk appetite, or preferences.
- No inference of sales/risk/regulatory tolerance from career history.
- Do not solicit sensitive personal data. If the founder independently states a
  business-relevant constraint, preserve only the operational limitation they want retained.
- Do not start market research, recommend opportunities, or score founder fit during Step 1.

## Acceptance checks

Before handoff to `bizforge-founder-thesis-editor`, verify:

- Every question mapped to an actually missing, candidate, or contradictory field.
- No confirmed answer was asked twice.
- Normalized values satisfy the canonical constraints and were echoed for correction.
- Every retained answer has resolvable user-input evidence.
- Unknown or declined values remain explicit; no defaults were invented.
- All tolerance fields came from direct self-report.
- The founder could correct, skip, revoke consent, or request deletion throughout.
