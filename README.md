# BizForge

BizForge is an evidence-backed opportunity research agent. It looks for real market
scarcities that AI may make abundant, identifies the buyer who benefits, and ranks the
resulting business hypotheses against a founder's capabilities and constraints.

This repository is a hackathon project built on
[TrueForge](https://github.com/truefoundry/trueforge), Bright Data, and OpenAI.

## Workflow

BizForge is designed as three stages:

1. **Founder setup** — an interactive TrueForge agent produces a confirmed founder profile.
2. **Batch research** — a headless, resumable pipeline collects evidence, computes market
   signals, maps value chains and validates scarcity-removal hypotheses.
3. **Exploration** — an interactive TrueForge agent explains, challenges and reranks a
   completed research bundle.

Stage 2 is the engineering core. TrueForge owns planning and agent judgment; deterministic
TypeScript owns collection reliability, provenance, state transitions, trend math and claim
validation.

## Current scope

The first implementation slice establishes the contracts and safety rails for Stage 2:

- strict runtime-validated domain schemas;
- an explicit research-run state machine;
- evidence-linked claims and opportunity dossiers;
- deterministic opportunity scoring;
- research-bundle validation;
- provider ports, plus a headless TrueForge session/turn adapter; the Bright Data adapter follows
  in the ingestion PR;
- fail-closed handling for indeterminate, non-idempotent TrueForge session creation;
- automated formatting, linting, type checking, tests and builds.

See [the architecture](docs/architecture.md) for the planned runtime boundaries.

## Development

Requirements:

- Node.js 22 or newer
- npm 10 or newer

```bash
npm install
cp .env.example .env
npm run check
```

`npm run check` runs formatting verification, linting, TypeScript checks, unit tests and the
production build. Unit tests use synthetic records and do not require API keys.

## Credentials

Local credentials belong only in `.env`:

- `OPENAI_API_KEY`
- `BRIGHT_DATA_API_KEY`
- `DAYTONA_API_KEY`
- optional TrueForge connection settings

Never commit `.env`, raw provider responses containing personal data, or runtime artifacts.
Only `.env.example` is tracked, and it contains names rather than values.

## Review workflow

Every substantive change is developed on a branch and reviewed through a GitHub pull request.
Qodo is configured to review state-transition correctness, retry and idempotency behavior,
provenance, prompt-injection isolation, privacy boundaries and secret-safe logging. Accepted
findings receive regression tests before a follow-up review.

## License

[MIT](LICENSE)
