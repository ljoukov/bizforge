---
name: bizforge-founder-thesis-editor
description: Synthesizes, edits, validates, confirms, versions, or deletes a BizForge FounderThesis while preserving evidence and epistemic labels. Use when founder evidence and interview answers are ready for review, or when an existing founder thesis must be corrected, reconfirmed, revoked, or removed.
license: MIT
compatibility: Requires TrueForge with a sandbox enabled and the BizForge MCP Step 1 tools listed below. Without them, drafts cannot be confirmed.
metadata:
  author: bizforge
  version: "0.6.0"
---

# BizForge founder thesis editor

> Founder setup produces an editable, evidence-backed planning thesis—not a psychological
> profile. Use only public professional evidence the founder supplied or asked BizForge to read,
> plus direct founder self-report. Keep observation, self-report, inference, and assumption
> distinct; collect and retain only what Stage 2 needs.

## Purpose

Turn founder-authorized evidence and answers into two distinct artifacts:

1. an editable, human-readable `FounderThesis`; and
2. a machine-readable `FounderProfileSnapshot` that matches BizForge's canonical contract.

Only an explicitly confirmed snapshot may enter Stage 2. The thesis is a planning aid, not an
assessment of identity, psychology, employability, or worth.

## Inputs

- Internal authorization records created from the founder's supplied sources and explicit final
  confirmation.
- `FounderEvidenceDraft` and its resolvable evidence items.
- The active `FounderInterviewPatch` working draft and its prepared, not-yet-persisted
  self-report evidence items.
- An existing thesis/snapshot when revising, revoking, or deleting.

If any required input is unresolved, keep the result in `draft` status and show the gap. Never
fabricate a value to satisfy the schema.

## Required runtime capabilities

Before confirmation, verify these attached BizForge MCP tools:

- `bizforge_get_data_status` for the authoritative data and storage mode;
- `bizforge_get_founder_setup_run` and `bizforge_transition_founder_setup_run` for versioned
  setup state;
- `bizforge_record_consent` for the internal scopes activated by explicit final confirmation;
- `bizforge_put_evidence` for confirmed founder self-report;
- `bizforge_get_evidence` for every referenced evidence item;
- `bizforge_validate_founder_profile_snapshot` for the pinned canonical schema and confirmed
  snapshot gate;
- `bizforge_save_confirmed_founder_profile` and `bizforge_get_confirmed_founder_profile` for
  immutable canonical Step 1 output;
- `bizforge_get_consent` for evidence retention, version history, and Stage 2 use;
- `bizforge_request_founder_data_deletion` and `bizforge_get_deletion_status` for deletion.

Call `bizforge_get_data_status` first and require healthy persistent storage that accepts founder
records. Keep backend, origin, and source fields out of normal founder-facing review and
completion messages. If durable persistence is unavailable, do not save a confirmed profile,
set `confirmedAt`, or claim durable retention or deletion.

Use the TrueForge sandbox only for computation. Canonical snapshots, evidence, and consent records
belong in BizForge MCP. If any required capability is absent or persistence is unavailable, fail
closed before collecting further founder data and do not set `confirmedAt`.

Load durable workflow state only with `bizforge_get_founder_setup_run`. Keep unconfirmed founder
answers in the active TrueForge working draft, and use `bizforge_transition_founder_setup_run`
only for non-content workflow progress until final confirmation. Use the current expected version
and an idempotency key for every transition. The transition's `stateData` is untyped, so apply the
focused skills' acceptance checks yourself. `bizforge_save_confirmed_founder_profile` performs
the atomic final `CONFIRMED` transition. If the active working draft is lost, do not reconstruct
personal content from unrelated state or blindly retry an ambiguous write.

## Compose the editable thesis

Present a concise, editable review with these sections:

- **Capabilities:** competency, level, evidence basis, uncertainty, and corrections.
- **Operating envelope:** hours, capital, launch horizon, and team size.
- **Offer and customer preferences:** offer types, customer types, and sales tolerance.
- **Risk and regulatory boundaries:** direct founder self-report only.
- **Access advantages:** buyer, distribution, data, expertise, or partner access.
- **Hard constraints and exclusions.**
- **Unknowns and assumptions:** each assumption includes a validation plan.
- **Source summary:** enough provenance for the founder to inspect each source that would support
  the saved profile.

Visibly label each statement as external observation, founder self-report, inference, or
assumption. Never collapse those categories into a single authoritative narrative.

## Review and correction

1. Show the complete minimized thesis version that would be saved.
2. Invite section-by-section corrections, removals, and additions. Do not ask only a generic
   “looks good?” question.
3. When the founder confirms or corrects an inference, prepare a new self-report claim in the
   active working draft. Do not merely increase model confidence. Create its durable `user_input`
   evidence item only after the final confirmation in step 6. Preserve a prior inference as
   superseded only when internal authorization for version history remains active; otherwise do
   not silently keep it.
4. Re-render the exact corrected version.
5. Preflight the rendered draft's field structure and business constraints with `confirmedAt`
   absent, then ask for explicit confirmation of the exact content. Full MCP evidence-reference
   validation follows persistence in step 6.
6. Ask one concise final content action: `Confirm and save this profile for opportunity
   research?` Do not add a separate consent, privacy, storage, retention, revocation, deletion,
   or downstream-use questionnaire. Only after the founder affirmatively confirms that exact
   displayed profile, silently use `bizforge_record_consent` to activate
   `retain_minimized_founder_self_report`, `retain_minimized_founder_snapshot`, and
   `use_confirmed_founder_snapshot_for_research`; persist and resolve the confirmed self-report
   evidence; have the host stamp `confirmedAt`; atomically recheck the internal records with
   `bizforge_get_consent`; and call `bizforge_validate_founder_profile_snapshot` against the exact
   final artifact. Silence, continued conversation, or approval of an earlier version is not
   confirmation.
7. Only when that post-approval validation succeeds, call
   `bizforge_save_confirmed_founder_profile`, verify its immutable output with
   `bizforge_get_confirmed_founder_profile`, and use the updated `CONFIRMED` run returned by the
   atomic save. Do not call `bizforge_transition_founder_setup_run` again.

## Canonical machine snapshot

The `FounderProfileSnapshot` must contain exactly these top-level fields and no workflow-status
or UI-only fields:

```text
snapshotId
founderId
displayName?                 optional
publicProfileUrl?            optional HTTP(S) URL
competencies[]               at least one
businessAppetite
constraints[]
accessAdvantages[]
sourceEvidenceIds[]          unique; includes every nested evidence reference
claims.observed[]
claims.inferred[]
claims.assumptions[]
capturedAt                   ISO timestamp with offset
confirmedAt?                 ISO timestamp with offset; absent for drafts
```

Each competency contains `name`, `level`, optional `yearsExperience`, unique `evidenceIds`, and
bounded `confidence` (`lower <= estimate <= upper`, each from 0 to 1). Allowed levels are
`learning`, `working`, `advanced`, and `expert`.

`businessAppetite` contains:

```text
hoursPerWeek
capitalBudgetUsd
timeToFirstRevenueDays
teamSize
preferredOfferTypes[]
preferredCustomerTypes[]
salesTolerance
riskTolerance
regulatoryTolerance
```

Observed and inferred claims require one or more evidence IDs. Inferred claims additionally
require a rationale. Assumptions must have no evidence IDs and require both a rationale and a
validation plan. Every claim has a unique ID, statement, creation time, and bounded confidence.

Before asking for confirmation, preflight the draft's field shape and constraints without
claiming canonical validation. After approval, persist the confirmed evidence and validate the
host-stamped exact artifact through `bizforge_validate_founder_profile_snapshot` in confirmed
mode. The tool applies `ConfirmedFounderProfileSnapshotSchema`; manual inspection or an
“equivalent” model-generated validator is not sufficient. Check that:

- all identifiers are non-empty opaque URL-safe strings;
- all evidence IDs resolve in the evidence store;
- every retained competency has at least one evidence ID;
- every competency/claim evidence ID also appears in `sourceEvidenceIds`;
- `sourceEvidenceIds` is the exact transitive closure of the current competency and claim
  references, with no orphan IDs;
- claim creation times are not later than the completed snapshot time;
- `confirmedAt` is not earlier than `capturedAt`;
- all lists that require uniqueness contain no duplicates;
- all business-appetite enums and numeric bounds are valid.

The confirmed-snapshot gate requires `confirmedAt`; a structurally valid working draft is not a
confirmed snapshot.
`bizforge_save_confirmed_founder_profile` creates the canonical immutable Step 1 output shared
with Step 2 and Step 3 through MCP. The explicit action `Confirm and save this profile for
opportunity research?` covers both durable profile saving and downstream opportunity research;
record those internal scopes silently so `stage2HandoffEligible` can pass without an additional
questionnaire. If the founder explicitly restricts downstream use, honor that restriction: the
snapshot may remain private and must not be handed to Stage 2. If validation or save is
unavailable, the thesis may remain editable, but it must not be marked confirmed or passed to
Stage 2.

## Versioning and status

Keep workflow metadata outside the strict machine snapshot:

- `draft`: editable; `confirmedAt` absent; never sent to Stage 2;
- `confirmed`: exact displayed version explicitly approved; immutable snapshot ID;
- `deletion_requested`: collection and Stage 2 handoff stop immediately.

Any correction after confirmation creates a new snapshot ID and version. Never mutate a
confirmed snapshot in place.

## Revocation and deletion

This section is reactive only. Do not describe these mechanics, advertise privacy controls, or
present revocation, retention, or deletion choices during normal onboarding. Apply them when the
founder explicitly asks to restrict use, revoke authorization, or delete data.

Branch by the exact revoked scope:

- Collection withdrawal stops future public-profile calls.
- Stage 2 processing withdrawal stops new handoffs and active founder-fit processing without
  deleting records whose retention remains authorized.
- Version-history withdrawal records a new consent event; verify that superseded versions,
  derived indexes, and replay payloads are minimized while the current authorized snapshot is
  preserved.
- Evidence or self-report retention withdrawal finds every dependent competency, snapshot,
  claim, research bundle, founder-fit derivative, index, and cache; invalidates those objects;
  blocks Stage 2; and requests deletion of the affected dependency closure.
- Snapshot-retention withdrawal requests deletion of snapshots and all derivatives that cannot
  legally exist without them.

Reserve the full-system inventory for an explicit deletion request for the current setup run. It
covers that run's consent receipts, snapshots and version history, evidence artifacts, claims,
research bundles, founder-fit derivatives, indexes/caches, TrueForge session transcripts,
provider-side retained data, and backup-expiry obligations. The current deletion tool is
setup-run scoped; never imply it removed another run for the same founder. Use
`bizforge_request_founder_data_deletion` only after explicit confirmation and inspect per-system
status with `bizforge_get_deletion_status`. Report deletion as complete only after all
controllable copies are confirmed removed and any provider/backup expiry obligation is
explicitly resolved.

Deleting the Markdown thesis alone is not sufficient.

Use explicit deletion outcomes: `pending`, `pending_expiry`, `completed`, `failed`, or
`unverifiable`, with per-system reasons and timestamps.

## Hard boundaries

- No psychographic labels, personality profile, founder archetype, or founder-worth score.
- Later founder fit may use explicit competencies and constraints only.
- Do not turn profile interests into evidence of market demand.
- Do not begin research, recommend opportunities, or score markets during Step 1.
- Do not hide unresolved required fields or unsupported claims to produce a cleaner narrative.

## Acceptance checks

Before emitting a confirmed snapshot, verify:

- The canonical schema parses the exact machine artifact successfully.
- Every evidence ID resolves and every nested reference is in `sourceEvidenceIds`.
- The human review clearly distinguishes observation, self-report, inference, and assumption.
- The founder saw and affirmatively approved the exact confirmed version, and any restriction,
  revocation, or deletion request they explicitly raised was honored.
- `confirmedAt` is absent on drafts and present only after explicit approval.
- No unresolved required field, prohibited inference, or psychological claim appears.
- Every competency is evidence-backed and `sourceEvidenceIds` has no orphan references.
- Stage 2 receives only the immutable confirmed snapshot, never the draft envelope.
