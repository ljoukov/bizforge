# BizForge architecture

## Shared stage boundary

All three stages exchange canonical artifacts through one application-owned MCP server. Chat
text and temporary Daytona files are never handoff records.

```text
Stage 1 setup agent
  -> confirmed FounderProfileSnapshot + evidence
  -> BizForgeDataStore
       -> Stage 2 reads the exact snapshot and writes a validated ResearchBundle
       -> Stage 3 reads the exact bundle version through read-only MCP projections
```

`BizForgeDataStore` separates persistence from protocol and domain validation. The first adapter
is an in-memory, synthetic demo store. Publishing an explicitly synthetic founder snapshot in
that mode deterministically produces a mock ResearchBundle tied to the same snapshot, exercising
the real contracts while Stage 2 collection is not yet connected. The production follow-up will
replace that adapter with SQLite; mock/persisted data mode remains separate from memory/SQLite
storage backend so a fixture can never be mistaken for evidence.

The MCP endpoint uses Streamable HTTP on loopback with Host/Origin validation. Step 1 receives
the setup, consent, evidence, confirmation and deletion tools; Step 2 receives the bundle write
boundary; Step 3 receives explicit read-only tools only.

## Goal

Stage 2 turns a confirmed founder profile into a versioned research bundle. It must remain
useful after process restarts, explain every factual claim, and distinguish observations from
inference.

```text
FounderProfileSnapshot
        |
        v
TrueForge research plan
        |
        v
Approval for cost and data scope
        |
        v
Bright Data acquisition jobs
        |
        v
Immutable evidence -> normalized facts -> deterministic signals
        |
        v
TrueForge scarcity hypotheses and skeptical review
        |
        v
Deterministic claim validation -> versioned ResearchBundle
```

## Responsibility boundaries

### TrueForge

- Convert a founder profile into a bounded research manifest.
- Pause for approval before paid or privacy-sensitive collection.
- Delegate bounded qualitative research to specialist subagents.
- Map value chains and propose scarcity-removal hypotheses.
- Seek counter-evidence and synthesize opportunity dossiers.
- Render Stage 3 evidence and comparisons with Generative UI only after loading the current
  OpenUI instructions.
- Use the Daytona-backed sandbox only for deterministic grouping, arithmetic, sensitivity checks
  and chart-data shaping; sandbox calculations never become evidence.

### Deterministic TypeScript

- Submit, poll, download and reconcile provider jobs.
- Enforce record, time and cost budgets.
- Validate untrusted provider and model output.
- Normalize entities, deduplicate reposts and compute temporal signals.
- Persist checkpoints and immutable raw-artifact hashes.
- Reject unsupported claims and calculate visible scores.

### Qodo

Qodo is not a runtime component. It reviews the TypeScript implementation through GitHub pull
requests and records findings, decisions, fixes and follow-up reviews.

## Trust boundaries

All scraped text and model output is untrusted data. It must never become executable
instructions. Provider credentials remain in local environment or TrueForge connector
configuration and must not enter prompts, artifacts, logs or sandbox files.

Personal profile ingestion requires consent. Persist the confirmed, minimized founder snapshot;
do not retain fields that the research workflow does not need.

The in-memory demo is not durable. Real founder profile collection stays disabled/session-only in
mock mode; only explicitly synthetic demo snapshots may exercise the downstream handoff.

## Scarcity workflow

For each candidate market, Stage 2 records:

1. The observed market change.
2. The existing value chain.
3. Evidence that a resource is genuinely scarce.
4. How AI could remove or reduce that scarcity.
5. The resulting abundant outcome and its economic buyer.
6. The successor bottleneck created by the intervention.
7. The mechanism for capturing value before commoditization.
8. Counter-evidence and the cheapest falsification experiment.

Founder fit is applied only after the market and scarcity evidence is computed. This prevents a
founder's interests from being mistaken for demand.

## Planned provider boundary

Bright Data collection will sit behind an application-owned port. The adapter will persist the
request intent before triggering a paid job, preserve the returned snapshot ID before polling,
and quarantine unknown states or schema drift. An ambiguous submission must not be retried
blindly because that can duplicate paid work.

TrueForge will reach the pipeline through a narrow BizForge MCP server rather than receiving raw
credentials. The initial tools will preview cost, enqueue an approved collection plan, inspect
status, query evidence and calculate signals.

TrueForge session creation is a special failure boundary. Its create API has neither an
idempotency key nor a client-reference field, and sessions created from the same saved agent cannot
be distinguished reliably by timestamps. The runner must persist an application `attemptId` before
the request and persist the returned session ID before starting a turn. If the response is lost,
the run fails non-retryably as `AGENT_SESSION_CREATION_INDETERMINATE`; it must not guess a session or
submit again automatically. The attempt ID supports audit and an explicit operator decision, not
provider-side correlation. Exact automated recovery would require TrueForge to echo a unique client
reference or honor an idempotency key.
