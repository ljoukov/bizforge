---
name: bizforge-founder-minimum-interview
description: Runs the minimum necessary BizForge founder interview, asking only for missing business constraints and preferences and recording answers as provenance-backed self-report. Use after public evidence is collected or skipped, when required FounderProfileSnapshot fields remain unknown, uncertain, or contradictory.
license: MIT
compatibility: Requires TrueForge with a sandbox enabled, an interactive chat or Generative UI channel, and the BizForge MCP Step 1 tools listed below.
metadata:
  author: bizforge
  version: "0.6.0"
---

# BizForge minimum founder interview

> Founder setup produces an editable, evidence-backed planning thesis—not a psychological
> profile. Use only public professional evidence the founder supplied or asked BizForge to read,
> plus direct founder self-report. Keep observation, self-report, inference, and assumption
> distinct; collect and retain only what Stage 2 needs.

## Purpose

Fill only the decision-relevant fields that public evidence cannot establish reliably. Produce
a `FounderInterviewPatch` for the thesis editor without inventing defaults, repeating answered
questions, or turning the interview into a personality assessment.

## Inputs

- A `FounderEvidenceDraft`; it may be empty because profile collection was skipped.
- Existing founder-confirmed answers and prior interview patches.
- Internal authorization status and any restriction, revocation, or deletion request the founder
  explicitly raised.
- An optional one-line competency or business-interest seed from the opening message.

If the founder explicitly revokes authorization or requests deletion, stop the interview and
hand off that request. Do not introduce these controls during ordinary onboarding.

## Required runtime capabilities

The coordinator's greeting-only landing turn is pre-intake and requires no status call. After
the founder supplies a competency, interest, answer, or profile URL, call
`bizforge_get_data_status` before collecting or retaining founder input. Require healthy
persistent storage that accepts founder records, and do not narrate backend, storage, origin, or
MCP source fields in ordinary interview replies. If durable persistence is unavailable, fail
closed before collecting or retaining answers.

Before final confirmation, use each volunteered answer only in the active editable working draft;
do not call `bizforge_put_evidence` or claim that the answer has been durably retained. After the
founder explicitly confirms the exact profile for saving and opportunity research, use
`bizforge_put_evidence` to record each confirmed answer as a canonical `user_input` evidence item
and `bizforge_get_evidence` to verify that its returned ID resolves. Describe that record as durable
only when `bizforge_get_data_status` says it is durable. The host or persistence boundary may
expose authoritative TrueForge session and turn IDs. Use those values only when available; never
ask the founder for them and never fabricate host metadata. If they are unavailable, use a
schema-valid non-agent extraction method for the directly normalized self-report or do not retain
the answer. Never use a sandbox file path as a durable artifact reference.

Use `bizforge_get_founder_setup_run` to load current workflow state and retain the returned internal
IDs without asking the founder for them. Keep unconfirmed interview content in the active
TrueForge working draft rather than durable MCP `stateData`. A transition may checkpoint
non-content workflow progress, but it must not persist the founder's answers before the concise
final confirmation handled by the thesis editor. When `readyForDraft` is true, move to
`DRAFT_REVIEW` with the current version and a sandbox-generated opaque idempotency key, then render
the complete working draft in the same active setup conversation. The patch is conceptual and
transition `stateData` is currently untyped; apply this skill's output and acceptance checks before
calling the tool and do not claim that the MCP validated the patch shape. Never blindly retry an
ambiguous transition or reconstruct missing persisted state after the active context is lost.

Volunteering an interview answer authorizes its use in the active editable working draft, but not
durable persistence by itself. Do not interrupt normal onboarding with a separate consent,
privacy, storage, retention, revocation, or deletion questionnaire. The thesis editor asks one
concise final content action: `Confirm and save this profile for opportunity research?` Only an
affirmative response to that exact reviewed profile authorizes persistence and downstream use;
the thesis editor then records the required MCP scopes internally before any answer is persisted.
If the founder explicitly says not to save an answer, restricts its use, revokes authorization, or
requests deletion, honor that request and do not persist or reuse the affected content.

If durable persistence is unavailable, do not collect founder answers. Briefly ask the founder
to retry after the service is restored; do not claim that a draft can be confirmed or used by
Stage 2.

## Build a gap map first

Before asking anything, classify each required field as:

- `confirmed` — direct founder answer already exists;
- `candidate` — public evidence suggests a value, but the founder has not confirmed it;
- `missing` — no usable value exists;
- `contradictory` — sources disagree;
- `declined` — the founder prefers not to answer.

Never re-ask a confirmed field. Never infer appetite or tolerance values from profile evidence.

## Start naturally from a one-line seed

If the opening message is only a phrase such as `workflow and operations automation`, record it
as a candidate competency in the active working draft and begin the interview. Do not ask the
founder to restate it in a schema, provide IDs, answer a privacy question, or supply the rest of
the profile at once. Ask for the candidate competency's self-assessed level and optional years of
experience, then gather the missing business preferences in compact conversational groups. The
short seed does not imply a name, budget, availability, target revenue date, team size, offer
model, customer segment, sales tolerance, risk tolerance, regulatory tolerance, exclusions, or
access advantage.

Keep each turn easy to answer: normally ask one coherent group with no more than four related
values, accept natural-language replies, normalize them, recompute the gap map, and move to the
next missing group. Never expose MCP field names or internal record identifiers in a
founder-facing question.

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
years of experience. Prepare each as `user_input` evidence for persistence only after the final
profile confirmation. Make clear that the founder may correct or remove it and that the
self-assessment is not externally verified.

After the founder confirms and authorizes saving the complete exact profile, persist the
normalized self-assessment and attach the returned `user_input` evidence ID to that competency.
Put attribution confidence on the observed claim: after exact confirmation it may use
`lower = estimate = upper = 1` because it says only that the founder made the statement. For the
competency's distinct proficiency confidence, use the conservative uncorroborated-self-report
policy `lower = 0.25`, `estimate = 0.5`, `upper = 0.75`, with a rationale that the level is
self-reported and not externally verified. Do not raise proficiency confidence merely because
attribution is certain; only a pinned deterministic policy using new corroborating evidence may
change it. Optional `yearsExperience` must be between 0 and 80.

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

For each answer or correction, prepare the normalized answer and its field key in the working
draft. After the founder explicitly confirms and authorizes saving the exact profile, send those
confirmed answers to `bizforge_put_evidence`. It must return a complete canonical `user_input`
evidence item, including title, summary, source record ID, SHA-256 digest, durable artifact
reference, locator, and extraction provenance. The host or tool injects runtime
session/turn/input IDs. Represent the corresponding claim as an observed statement such as “The
founder states …”.

After final save authorization, a founder-confirmed correction creates a new user-input evidence
item and claim. Do not edit the public source or silently replace conflicting history.

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
  userInputEvidenceIds[]      empty until final confirmation persists the prepared evidence
  observedClaimIds[]          empty until final confirmation persists the prepared claims
  contradictions[]
  unresolvedFields[]
  persistenceStatus         pending_confirmation | durable | failed
  readyForDraft
```

The `bizforge_put_evidence` schema is authoritative for evidence, while the interview patch in
transition `stateData` is not server-validated. Never inline an approximate evidence record when
persistence failed.

Apply every output and acceptance check in this skill, then call
`bizforge_transition_founder_setup_run` for the compare-and-set transition to `DRAFT_REVIEW`
without placing unconfirmed founder answers in durable `stateData`. The successful transition
records workflow progress but does not prove the working patch shape is valid. A rendered chat
summary is not an MCP handoff.

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
- Before final confirmation, no answer was durably persisted; after confirmation, every retained
  answer has resolvable user-input evidence.
- Unknown or declined values remain explicit; no defaults were invented.
- All tolerance fields came from direct self-report.
- Any explicit request to skip a field, restrict use, revoke authorization, or delete data was
  honored without proactively turning normal onboarding into a privacy questionnaire.
