# Stage 2 architecture

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
