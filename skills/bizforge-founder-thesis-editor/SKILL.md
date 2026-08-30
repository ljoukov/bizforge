---
name: bizforge-founder-thesis-editor
description: Synthesizes, edits, validates, confirms, versions, or deletes a BizForge FounderThesis while preserving evidence and epistemic labels. Use when founder evidence and interview answers are ready for review, or when an existing founder thesis must be corrected, reconfirmed, revoked, or removed.
license: MIT
compatibility: Requires TrueForge with a sandbox enabled and the BizForge MCP Step 1 tools listed below. Without them, drafts cannot be confirmed.
metadata:
  author: bizforge
  version: "0.5.0"
---

# BizForge founder thesis editor

> Founder setup produces an editable, evidence-backed planning thesis—not a psychological
> profile. Use only public professional evidence collected with explicit consent and direct
> founder self-report. Keep observation, self-report, inference, and assumption distinct;
> collect and retain only what Stage 2 needs.

## Purpose

Turn consented evidence and founder answers into two distinct artifacts:

1. an editable, human-readable `FounderThesis`; and
2. a machine-readable `FounderProfileSnapshot` that matches BizForge's canonical contract.

Only an explicitly confirmed snapshot may enter Stage 2. The thesis is a planning aid, not an
assessment of identity, psychology, employability, or worth.

## Inputs

- Active consent receipt or an interview-only/no-profile record.
- `FounderEvidenceDraft` and its resolvable evidence items.
- `FounderInterviewPatch` and its user-input evidence items.
- An existing thesis/snapshot when revising, revoking, or deleting.

If any required input is unresolved, keep the result in `draft` status and show the gap. Never
fabricate a value to satisfy the schema.

## Required runtime capabilities

Before confirmation, verify these attached BizForge MCP tools:

- `bizforge_get_data_status` for the authoritative data and storage mode;
- `bizforge_get_founder_setup_run` and `bizforge_transition_founder_setup_run` for versioned
  setup state;
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

The TrueForge sandbox is temporary working space. It is never the durable snapshot, evidence,
or consent store. If any required capability is absent or durable persistence is unavailable,
fail closed before collecting further founder data and do not set `confirmedAt`.

Load evidence and interview envelopes only with `bizforge_get_founder_setup_run`. Record draft
edits with `bizforge_transition_founder_setup_run`, the current expected version, and an
idempotency key. The transition's `stateData` is untyped, so apply the focused skills' acceptance
checks yourself. `bizforge_save_confirmed_founder_profile` performs the atomic final
`CONFIRMED` transition. Do not rebuild missing state from chat history or blindly retry an
ambiguous write.

## Compose the editable thesis

Present a concise, editable review with these sections:

- **Capabilities:** competency, level, evidence basis, uncertainty, and corrections.
- **Operating envelope:** hours, capital, launch horizon, and team size.
- **Offer and customer preferences:** offer types, customer types, and sales tolerance.
- **Risk and regulatory boundaries:** direct founder self-report only.
- **Access advantages:** buyer, distribution, data, expertise, or partner access.
- **Hard constraints and exclusions.**
- **Unknowns and assumptions:** each assumption includes a validation plan.
- **Source summary:** enough provenance for the founder to inspect or remove any retained item.

Visibly label each statement as external observation, founder self-report, inference, or
assumption. Never collapse those categories into a single authoritative narrative.

## Review and correction

1. Show the complete minimized thesis version that would be saved.
2. Invite section-by-section corrections, removals, and additions. Do not ask only a generic
   “looks good?” question.
3. When the founder confirms or corrects an inference, create a new `user_input` evidence item
   and observed self-report claim. Do not merely increase model confidence. Preserve the prior
   inference as superseded only when `retain_founder_version_history` remains active; otherwise
   follow the retention/deletion policy rather than silently keeping it.
4. Re-render the exact corrected version.
5. Base-validate that rendered draft with `confirmedAt` absent, then ask for explicit
   confirmation of the exact version.
6. Only after the founder confirms it, have the host stamp `confirmedAt`, atomically recheck
   active retention consent with `bizforge_get_consent`, and call
   `bizforge_validate_founder_profile_snapshot` against the exact final artifact. Silence,
   continued conversation, or approval of an earlier version is not confirmation.
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

Validate the draft through `bizforge_validate_founder_profile_snapshot` before asking for
confirmation, then validate the host-stamped exact artifact through the same tool's confirmed
mode after approval. The tool applies `ConfirmedFounderProfileSnapshotSchema`; manual inspection
or an “equivalent” model-generated validator is not sufficient. Check that:

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

Base-schema success is necessary but not sufficient because drafts intentionally allow
`confirmedAt` to be absent. The confirmed-snapshot gate must additionally require `confirmedAt`.
`bizforge_save_confirmed_founder_profile` creates the canonical immutable Step 1 output shared
with Step 2 and Step 3 through MCP. Active
`use_confirmed_founder_snapshot_for_research` consent is a separate
`stage2HandoffEligible` gate: a founder may confirm and retain a private snapshot without
authorizing Stage 2. If validation or save is unavailable, the thesis may remain editable, but
it must not be marked confirmed or passed to Stage 2.

## Versioning and status

Keep workflow metadata outside the strict machine snapshot:

- `draft`: editable; `confirmedAt` absent; never sent to Stage 2;
- `confirmed`: exact displayed version explicitly approved; immutable snapshot ID;
- `deletion_requested`: collection and Stage 2 handoff stop immediately.

Any correction after confirmation creates a new snapshot ID and version. Never mutate a
confirmed snapshot in place.

## Revocation and deletion

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
- The founder could correct each current item, request scoped retention changes or deletion,
  and saw the exact confirmed version.
- `confirmedAt` is absent on drafts and present only after explicit approval.
- No unresolved required field, prohibited inference, or psychological claim appears.
- Every competency is evidence-backed and `sourceEvidenceIds` has no orphan references.
- Stage 2 receives only the immutable confirmed snapshot, never the draft envelope.
