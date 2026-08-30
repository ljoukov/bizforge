---
name: bizforge-founder-setup
description: Coordinates BizForge Step 1 from consent through public-evidence intake, minimum founder interview, editable thesis review, and confirmed snapshot handoff. Use when starting, resuming, correcting, revoking, or deleting a complete founder-setup run.
license: MIT
compatibility: Requires TrueForge with a sandbox enabled, all three BizForge founder subskills, and the BizForge MCP Step 1 tools listed below.
metadata:
  author: bizforge
  version: "0.2.0"
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
following the named skill with the MCP-recorded setup-run state and its reported storage status;
skills do not invoke each other automatically.

## Capability gate

At the start or resume of every setup run, verify that the attached BizForge MCP provides these
exact tools:

- data mode: `bizforge_get_data_status`;
- setup state: `bizforge_create_founder_setup_run`, `bizforge_get_founder_setup_run`, and
  `bizforge_transition_founder_setup_run`;
- consent: `bizforge_record_consent` and `bizforge_get_consent`;
- evidence: `bizforge_put_evidence` and `bizforge_get_evidence`;
- snapshot: `bizforge_validate_founder_profile_snapshot`,
  `bizforge_save_confirmed_founder_profile`, and `bizforge_get_confirmed_founder_profile`;
- deletion: `bizforge_request_founder_data_deletion` and `bizforge_get_deletion_status`.

Call `bizforge_get_data_status` before collecting any founder data. Inspect `dataMode`,
`storageBackend`, `isMock`, `ephemeral`, fixture/schema versions, and warnings. If `isMock` or
`ephemeral` is true, never collect a real public profile, never persist real founder input, and
never claim durable confirmation or deletion. Keep real input `session_only`. Only an explicitly
synthetic demo founder may exercise the mock write/save path, and only after the user accepts
that it is mock and ephemeral. Label every such artifact `mock=true` and show the exact returned
`source`: `mcp_write` for a synthetic demo write and `mock_seed` only for a seeded fixture.
For that accepted demo only, pass `isSynthetic: true` and the required
`acceptMockStorage: true` acknowledgement on mock writes. The acknowledgement does not make the
store durable or authorize real founder data.

Verify the public-profile connector only if the founder requests profile enrichment and the MCP
reports a durable non-mock mode. Never use the temporary TrueForge sandbox as the durable store
and never invent missing runtime IDs.

If durable capabilities are missing or the MCP reports mock/ephemeral mode, permit a clearly
labelled `session_only` interview draft
but do not call an external profile source, claim durable retention, set `confirmedAt`, or hand
anything to Stage 2.

The BizForge MCP tool schemas are authoritative. Consent is stored as one immutable
`ConsentRecord` per scope. `FounderEvidenceDraft` and `FounderInterviewPatch` remain conceptual
objects inside the transition's currently untyped `stateData`; the MCP does not validate those
intermediate shapes. Apply this skill's acceptance checks before transition and never claim that
a successful transition proves the envelope is well formed. Each
`bizforge_transition_founder_setup_run` call includes `setupRunId`, expected version, target
state, and an idempotency key. On an ambiguous write, reconcile with
`bizforge_get_founder_setup_run`; never retry blindly or infer state from chat history.

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
   host stamp `confirmedAt`, atomically recheck retention consent with `bizforge_get_consent`,
   validate the exact final artifact with `bizforge_validate_founder_profile_snapshot`, save it
   with `bizforge_save_confirmed_founder_profile`, and use the updated `CONFIRMED` run returned by
   that atomic save. Do not issue a second state transition. For real founder data, these
   confirmation/save steps require a durable non-mock data status.
4. `bizforge_save_confirmed_founder_profile` creates the canonical immutable Step 1 output that
   Step 2 and Step 3 share through the BizForge MCP. Saving that output is not itself a Stage 2
   handoff. Set `stage2HandoffEligible` only when
   `use_confirmed_founder_snapshot_for_research` is active and the save returns success.
   Confirmation without Stage 2 consent remains a valid private Step 1 outcome.
5. On correction after confirmation, atomically enter `REVISION_DRAFT`, seed a new draft linked
   to the immutable prior snapshot, and confirm only a newly validated version. Never mutate the
   old snapshot. On revocation or deletion—including after confirmation—enter
   `DELETION_REQUESTED`, stop progression, call
   `bizforge_request_founder_data_deletion`, and follow the thesis editor's scoped deletion
   procedure. Poll `bizforge_get_deletion_status` only as needed for a user-visible update.

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

For real founder data, Step 1 is complete only when all of the following are true and
`bizforge_get_data_status` reports a durable non-mock backend:

- the exact displayed thesis version was explicitly confirmed;
- canonical and confirmation-level validators passed;
- `bizforge_save_confirmed_founder_profile` returned the immutable snapshot and every referenced
  item resolves with `bizforge_get_evidence`;
- every retained competency is evidence-backed;
- the coordinator can return the persisted `snapshotId` and `setupRunId` without exposing raw
  personal data.

Report `stage2HandoffEligible` separately. It is true only when
`use_confirmed_founder_snapshot_for_research` is active and the canonical save succeeded;
otherwise Step 1 may still be complete while Stage 2 remains consent-blocked. Return the saved
`snapshotId` as the shared Step 1 output reference, never a prose reconstruction. For any other
missing completion condition, return the current nonterminal state and blockers. Never report
Step 1 complete from chat text or sandbox files alone.

An explicitly accepted synthetic demo may return `demoComplete: true`, but must never be
represented as real or durable Step 1 completion. Saving the demo snapshot deterministically
creates a validated mock `ResearchBundle` tied to that exact snapshot; expose its bundle ID and
version as a demo handoff to Step 3, never as real Step 2 research. Keep
`stage2HandoffEligible: false`; the response may separately report
`mockStep2DemoEligible: true` when the synthetic, consented demo bundle is available.
