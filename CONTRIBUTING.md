# Contributing

## Pull requests

- Keep each pull request focused on one coherent behavior.
- Link the problem or acceptance criteria in the description.
- Add or update tests for every behavior change.
- Never include real credentials, private profile data or raw production provider responses.
- Run `npm run check` before pushing.
- Let Qodo review the pull request before merge.
- Resolve valid findings with code and regression tests; explain intentional dismissals.
- Request a follow-up review after fixes so the final state is visible in the PR history.

## Design rules

- Preserve observed facts, computed signals, inferences and assumptions as distinct types.
- Every factual claim must resolve to stored evidence.
- Use agents for semantic judgment; use deterministic code for counts, dates and scores.
- Make paid operations explicit, bounded, approval-gated and resumable.
- Fail closed on unknown provider states and invalid external data.
