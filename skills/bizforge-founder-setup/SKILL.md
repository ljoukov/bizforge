---
name: bizforge-founder-setup
description: Coordinates BizForge Step 1 from consent through public-evidence intake, minimum founder interview, editable thesis review, and confirmed snapshot handoff. Use when starting, resuming, correcting, revoking, or deleting a complete founder-setup run.
license: MIT
compatibility: Requires TrueForge with a sandbox enabled; all three BizForge founder subskills; interactive chat or Generative UI; and durable typed BizForge setup-run, consent, evidence, snapshot-validation, snapshot-storage, and deletion APIs.
metadata:
  author: bizforge
  version: "0.1.0"
---

# BizForge founder setup coordinator

> Founder setup produces an editable, evidence-backed planning thesis—not a psychological
> profile. Use only public professional evidence collected with explicit consent and direct
> founder self-report. Keep observation, self-report, inference, and assumption distinct;
> collect and retain only what Stage 2 needs.

## Purpose

Coordinate the three focused Step 1 skills without duplicating their detailed policies:

- `bizforge-founder-public-evidence`
- `bizforge-founder-minimum-interview`
- `bizforge-founder-thesis-editor`

All three skills must be attached to the same saved TrueForge agent. A handoff means loading and
following the named skill with the persisted setup-run state; skills do not invoke each other
automatically.

## Capability gate

At the start or resume of every setup run, verify that attached application tools provide:

- typed setup-run create/get/compare-and-set transition operations with schema versioning and
  idempotency support;
- durable consent recording/resolution;
- durable canonical evidence persistence/resolution;
- pinned founder-snapshot validation and immutable persistence;
- deletion request and per-system status inspection.

Verify the public-profile connector only if the founder requests profile enrichment. Never use
the temporary TrueForge sandbox as the durable store and never invent missing runtime IDs.

If durable capabilities are missing, permit a clearly labelled `session_only` interview draft
but do not call an external profile source, claim durable retention, set `confirmedAt`, or hand
anything to Stage 2.

The setup-run API is authoritative for `ConsentReceipt`, `FounderEvidenceDraft`, and
`FounderInterviewPatch` schemas. Each state transition must validate the relevant envelope and
include `setupRunId`, expected version, target state, and an idempotency key. On an ambiguous
write, reconcile by reading the run; never retry blindly or infer state from chat history.

## State machine

Use one host-provided `setupRunId` and move only through these states:

```text
CONSENT_PENDING
  -> PUBLIC_EVIDENCE       when profile collection is explicitly consented
  -> INTERVIEW             when profile collection is skipped
PUBLIC_EVIDENCE
  -> INTERVIEW
INTERVIEW
  -> DRAFT_REVIEW          only when required fields and one competency are supported
DRAFT_REVIEW
  -> DRAFT_REVIEW          after edits
  -> CONFIRMED             after exact-version approval and confirmation-level validation
CONFIRMED
  -> REVISION_DRAFT        when the founder requests a correction; prior snapshot stays immutable
REVISION_DRAFT
  -> REVISION_DRAFT        after edits
  -> CONFIRMED             after a new exact version is approved and validated
any state, including CONFIRMED
  -> DELETION_REQUESTED
```

Unknown state, missing persisted state, failed validation, revoked processing consent, or an
ambiguous write must fail closed. Do not silently restart the setup run or duplicate retained
records.

## Procedure

1. Load `bizforge-founder-public-evidence` when the founder supplies or wants to use a public
   professional profile. Obtain its separate consent scopes before any source call. If the
   founder declines or required tools are absent, record the interview-only branch.
2. Before retaining any interview answer, obtain separate consent for minimized self-report
   evidence, snapshot retention, optional version history, and optional Stage 2 use. This gate
   applies equally to the interview-only branch. Then load `bizforge-founder-minimum-interview`,
   compute a field gap map, and ask only what remains missing, candidate, or contradictory. Use
   choice controls for enums/skip/confirmation and ordinary chat or Generative UI for
   numeric/free-text answers.
3. When `readyForDraft` is true and persistence succeeded, load
   `bizforge-founder-thesis-editor`. Apply corrections and base-validate the draft with
   `confirmedAt` absent. Show the exact version and obtain explicit approval. Only then have the
   host stamp `confirmedAt`, atomically recheck retention consent, validate the exact final
   artifact with `ConfirmedFounderProfileSnapshotSchema`, and persist/transition it.
4. Handoff the immutable confirmed snapshot to Stage 2 only when
   `use_confirmed_founder_snapshot_for_research` is active and the persistence tool returns
   success. Confirmation without Stage 2 consent remains a valid private Step 1 outcome.
5. On correction after confirmation, atomically enter `REVISION_DRAFT`, seed a new draft linked
   to the immutable prior snapshot, and confirm only a newly validated version. Never mutate the
   old snapshot. On revocation or deletion—including after confirmation—enter
   `DELETION_REQUESTED`, stop progression, and follow the thesis editor's scoped deletion
   procedure.

Deletion status must be one of `pending`, `pending_expiry`, `completed`, `failed`, or
`unverifiable`; keep per-system reasons visible and never collapse a partial result into
`completed`.

## Interaction rules

- Say why a public source or question is needed before collecting it.
- Show normalized numeric values before saving them.
- Preserve “not sure” and “prefer not to answer” as unresolved rather than guessing.
- Make current state, persistence status, and the next required action visible.
- Do not begin opportunity research or market scoring in Step 1.

## Completion contract

Step 1 is complete only when all of the following are true:

- the exact displayed thesis version was explicitly confirmed;
- canonical and confirmation-level validators passed;
- the immutable snapshot and every referenced evidence item were durably persisted;
- every retained competency is evidence-backed;
- the coordinator can return the persisted `snapshotId` and `setupRunId` without exposing raw
  personal data.

Report `stage2HandoffEligible` separately. It is true only when
`use_confirmed_founder_snapshot_for_research` is active; otherwise Step 1 may still be complete
while Stage 2 remains consent-blocked. For any other missing completion condition, return the
current nonterminal state and blockers. Never report Step 1 complete from chat text or sandbox
files alone.
