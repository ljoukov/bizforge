---
name: bizforge-founder-setup
description: Coordinates BizForge Step 1 from consent through public-evidence intake, minimum founder interview, editable thesis review, and confirmed snapshot handoff. Use when starting, resuming, correcting, revoking, or deleting a complete founder-setup run.
license: MIT
compatibility: Requires TrueForge with a sandbox enabled, all three BizForge founder subskills, and the BizForge MCP Step 1 tools listed below.
metadata:
  author: bizforge
  version: "0.5.0"
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

Call `bizforge_get_data_status` before collecting any founder data and require healthy,
persistent storage that accepts founder records. Treat this as internal infrastructure: in
ordinary healthy onboarding replies, do not narrate the backend, storage mode, record origin,
MCP source fields, or implementation names. Surface infrastructure only when degraded, when a
write fails, or when the founder explicitly asks. If durable persistence is unavailable, fail
closed before collecting profile data and ask the founder to try again after the service is
restored. Do not offer an alternate storage or test mode.

Verify the public-profile connector only if the founder requests profile enrichment and the MCP
reports healthy persistent storage. Never use the temporary TrueForge sandbox as the durable store
and never expose infrastructure requirements as founder questions.

## Conversation bootstrap and internal IDs

### Greeting-only landing turn

When the opening user message is only a greeting or social opener—such as `hello`, `hi`, `hey`,
or `good morning`—do not start a setup run and do not call MCP, connector, or sandbox tools. Do
not discuss storage mode, consent, schemas, IDs, or the interview yet. Reply in no more than two
short sentences, using this wording or a very close equivalent:

> Hi — I’ll help match your skills and interests to evidence-backed business opportunities. Tell
> me your main competencies or interests, or paste your LinkedIn profile URL.

This is a pre-intake landing turn, not founder data collection. If the message contains both a
greeting and substantive founder input or a profile URL, skip the landing response and process
the supplied input normally. After the founder supplies a competency, interest, or profile URL,
continue with the capability/status and consent gates below.

A new setup may begin with one short, non-sensitive seed such as `workflow and operations
automation`. Treat that phrase as a candidate competency or area of interest, not as a complete
profile and not as permission to manufacture missing answers. Acknowledge it naturally, then run
the minimum interview for the founder's actual preferences and constraints. Never require a
prepared scenario, JSON, a display name, or a long intake form in the first user message.

`founderId`, `setupRunId`, consent/evidence/snapshot IDs, and idempotency keys are
application-controlled identifiers. Never ask the founder to supply any of them. For a new run,
generate an opaque `clientRequestId` UUID in the enabled sandbox, then call
`bizforge_create_founder_setup_run` with both `founderId` and `setupRunId` omitted. The MCP
allocates and returns both IDs. Retain the creation key until the response is reconciled; if that
response is ambiguous, retry the exact same create input with the same key so the MCP replays the
same run. Keep the returned founder/setup IDs in the run context and use them in later tool
calls. On resume, use only IDs previously returned by an authoritative MCP record. Where a later
schema requires a caller-generated record ID or idempotency key, create another opaque
collision-resistant UUID in the sandbox and never derive it from the founder's name or answers.
TrueForge session and turn IDs are different: use them only when the host exposes them; never ask
the founder for host metadata or fabricate it.

If durable capabilities are missing, do not collect founder answers, call an external profile
source, set `confirmedAt`, or hand anything to Stage 2. Do not expose tool argument names,
schema requirements, or generated IDs as questions.

The BizForge MCP tool schemas are authoritative. Consent is stored as one immutable
`ConsentRecord` per scope. `FounderEvidenceDraft` and `FounderInterviewPatch` remain conceptual
objects inside the transition's currently untyped `stateData`; the MCP does not validate those
intermediate shapes. Apply this skill's acceptance checks before transition and never claim that
a successful transition proves the envelope is well formed. Each
`bizforge_transition_founder_setup_run` call includes `setupRunId`, expected version, target
state, and an idempotency key. On an ambiguous write, reconcile with
`bizforge_get_founder_setup_run`; never retry blindly or infer state from chat history.

## State machine

Use the MCP-created `setupRunId` and move only through these states:

```text
CONSENT_PENDING
  -> PUBLIC_EVIDENCE       when profile collection is explicitly consented
  -> INTERVIEW             when profile collection is skipped
PUBLIC_EVIDENCE
  -> INTERVIEW
INTERVIEW
  -> INTERVIEW             after a merged incremental interview checkpoint
  -> DRAFT_REVIEW          only when required fields and one competency are supported
DRAFT_REVIEW
  -> DRAFT_REVIEW          after edits
  -> CONFIRMED             after exact-version approval and confirmation-level validation
CONFIRMED
  -> REVISION_DRAFT        when the founder requests a correction; retain the prior snapshot only
                            while version-history consent is active
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
   evidence, snapshot retention, optional version history, and optional Stage 2 use. Present
   these scopes together in one compact, plain-language consent control when possible, while
   recording one immutable MCP consent event per scope. This gate applies equally to the
   interview-only branch. Then load `bizforge-founder-minimum-interview`, compute a field gap
   map, and ask only what remains missing, candidate, or contradictory. Treat a one-line opening
   seed as a candidate competency that still needs level/experience confirmation. Use choice
   controls for enums/skip/confirmation and ordinary chat or Generative UI for numeric/free-text
   answers.
3. When `readyForDraft` is true and persistence succeeded, load
   `bizforge-founder-thesis-editor`. Apply corrections and base-validate the draft with
   `confirmedAt` absent. Show the exact version and obtain explicit approval. Only then have the
   host stamp `confirmedAt`, atomically recheck retention consent with `bizforge_get_consent`,
   validate the exact final artifact with `bizforge_validate_founder_profile_snapshot`, save it
   with `bizforge_save_confirmed_founder_profile`, and use the updated `CONFIRMED` run returned by
   that atomic save. Do not issue a second state transition. For real founder data, these
   confirmation/save steps require healthy persistent storage.
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
- Make current onboarding state and the next required action visible. Show persistence details
  only when degraded, failed, or explicitly requested.
- Do not begin opportunity research or market scoring in Step 1.

## Completion contract

For real founder data, Step 1 is complete only when all of the following are true and
`bizforge_get_data_status` reports healthy persistent storage:

- the exact displayed thesis version was explicitly confirmed;
- canonical and confirmation-level validators passed;
- `bizforge_save_confirmed_founder_profile` returned the immutable snapshot and every referenced
  item resolves with `bizforge_get_evidence`;
- every retained competency is evidence-backed;
- the coordinator can return the persisted `snapshotId` without exposing raw personal data;
- `founderId`, `setupRunId`, consent/evidence IDs, and idempotency keys remain internal even at
  completion unless the founder explicitly requests technical diagnostics.

Report `stage2HandoffEligible` separately. It is true only when
`use_confirmed_founder_snapshot_for_research` is active and the canonical save succeeded;
otherwise Step 1 may still be complete while Stage 2 remains consent-blocked. Return the saved
`snapshotId` as the shared Step 1 output reference, never a prose reconstruction. For any other
missing completion condition, return the current nonterminal state and blockers. Never report
Step 1 complete from chat text or sandbox files alone.

For a healthy persistent completion, keep the founder-facing result concise: show the confirmed
`snapshotId`, setup state, and downstream research eligibility. Do not include infrastructure,
record-origin fields, `founderId`, or `setupRunId` in that normal result.
