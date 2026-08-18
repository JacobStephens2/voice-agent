# Slice-one PSTN acceptance

Slice one is accepted only for the exact immutable Release that passes both the
automated suites and five consecutive real PSTN runs. Run the attended wizard
from a checkout whose `HEAD` is the active Release:

```bash
./ops/acceptance/run-slice-one.sh
```

Set `ACCEPTANCE_RECORD=/absolute/path/to/record.json` to choose another record
location. By default the wizard writes `acceptance/slice-one-pstn.json` in the
checkout. Review and preserve that sanitized file as release evidence.

## Campaign order

The planned five-run sequence is:

1. AT&T, indoors.
2. Tello, indoors.
3. AT&T, walking outdoors with representative telephone noise.
4. Tello, with ordinary representative background noise.
5. AT&T, indoors.

Each attempt records the carrier, environment, pass/fail result, authenticated
Evidence Record task link, callback and health-answer latency, interruption
count and qualitative observation, qualitative transcription observation,
completion-notice outcome, and whether the Callback Handshake, Bountywell
answer, Evidence Record, boundary checks, and no-manual-intervention rule passed.
Do not paste telephone numbers, raw transcripts, audio, secrets, rejected
evidence, or provider payloads into an observation.

A failed attempt is appended with `result: "failed"`; it is never removed or
silently retried. The validator considers only the latest consecutive passing
suffix, requires five complete runs in that suffix, and requires both carriers
and an outdoor walking run within those five.

## Automated and monitoring gates

Before calls, the wizard verifies the exact Release with monorepo typechecking,
the full automated test suite, the deployment-health check, and the private
Prometheus scrape. It then asks the owner to inspect **Voice Agent · Slice One
Operational Path** in Grafana, including its same-host warning and the explicit
Voice Agent and registered Bountywell API probes.

The monitoring is intentionally same-host. It can diagnose component, provider,
application, resource, and policy failures, but cannot independently establish
that the Agent Host or its network is reachable.

## Record lifecycle

The record contains immutable logical events:

- `automated-verification` for the exact 40-character Release commit;
- one `pstn-run` per attempted call, with a strictly increasing sequence;
- one terminal `slice-one-accepted` event written only by the validator.

Use the validator without the wizard when inspecting a record:

```bash
pnpm acceptance:slice-one status --record acceptance/slice-one-pstn.json
```

Once the terminal acceptance event exists, the CLI refuses every further append.
