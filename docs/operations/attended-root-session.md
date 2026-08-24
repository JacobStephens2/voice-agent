# Attended root session

Two procedures need the owner at a root terminal and can share one session: the
deployment-authority upgrade that activates reviewed root orchestration, and the
restricted Codex Keeplore Button Trial. Run them in this order — the trial
depends on the units the upgrade installs.

Neither can be delegated. Terminal access is not authority: the upgrade needs a
Fresh Passkey Action in the PWA, and the trial needs a live Telephone Session.

## Before you connect

The trial opens an authenticated browser as `voice-codex` and exits if no
display is forwarded, so start the session with trusted X11 forwarding rather
than reconnecting halfway through.

1. Launch XQuartz on the workstation and leave it running.
2. Connect with trusted forwarding:

   ```bash
   ssh -Y jacob@stephens.page
   ```

3. Confirm the display arrived before going further. An empty value means the
   trial will refuse at its browser stage:

   ```bash
   echo "$DISPLAY"        # expect something like localhost:10.0
   xdpyinfo | head -1     # expect a "name of display:" line, not an error
   ```

Then move to the active Release. Both wizards must run from here — several
commands resolve configuration by walking up from the working directory, and
`codex login status` in particular misreports a healthy login as logged-out when
run from a home directory:

```bash
cd /opt/voice-agent/current
```

## Part 1 — Upgrade the pinned deployment authority

Automatic Promotion never replaces root-pinned orchestration, systemd
definitions, or AppArmor profiles. A merged and promoted Release can therefore
carry reviewed changes to `ops/release/` or `ops/systemd/` that are still
dormant, because the live copies under `/usr/local/libexec/voice-agent` are
pinned. This attended upgrade is what activates them.

Confirm there is drift to apply, and that the active Release is the one you
expect:

```bash
readlink -f /opt/voice-agent/current
R=$(readlink -f /opt/voice-agent/current)
for f in promotion-state.sh record-promotion-failure.sh resume-promotion.sh; do
  sudo cmp -s "$R/ops/release/$f" "/usr/local/libexec/voice-agent/$f" \
    && echo "$f: pinned matches release" || echo "$f: pinned is older"
done
```

Then run the wizard:

```bash
./ops/upgrade-agent-host-deployment-authority.sh
```

Five stages. What to expect, and where to stop:

1. **Verify the reviewed active Release.** Refuses anything but the exact active
   Release from the latest successful Human Merge.
2. **Review the pinned-authority differences.** Every script, verifier, unit,
   and AppArmor profile this will pin is displayed. Read it. No credential
   values are shown; if one appears, stop.
3. **Authorize with a Fresh Passkey Action.** Root prepares a random five-minute
   challenge bound to this exact commit. In the PWA, choose **Create
   deployment-authority Fresh Passkey proof** and authenticate an approved owner
   passkey before it expires. If no authenticator prompt appears, stop — a
   signed-in session is not authorization. On a first-ever upgrade there is an
   extra one-time step: approve the displayed candidate passkeys at the root
   terminal, assert one to enroll it, then assert again to authorize. Abort if a
   displayed candidate is unexpected. The prepare stage states when the
   challenge expires and how long is left; if the window lapses, the PWA says
   the challenge expired and the prepare stage is re-run from the terminal.
4. **Upgrade and activate.** Stages the manifest, switches the pin, retains the
   prior authority, and re-promotes the same Release through the newly pinned
   promoter so new unit definitions are installed and health-verified together.
   Both the prior authority and the prior AppArmor definition are restored
   automatically if activation or health verification fails.
5. **Verify the restricted Subagent boundary.** The upgraded promoter must
   provision the Subagent and pass the full health contract.

Verify the pin actually moved:

```bash
for f in promotion-state.sh record-promotion-failure.sh resume-promotion.sh; do
  sudo cmp -s "$R/ops/release/$f" "/usr/local/libexec/voice-agent/$f" \
    && echo "$f: pinned" || echo "$f: STILL OLD"
done
systemctl show voice-agent-promotion-resume.service \
  -p StartLimitIntervalUSec -p StartLimitBurst
```

## Part 2 — Run the Keeplore Button Trial

```bash
./ops/acceptance/run-keeplore-button-trial.sh
```

Four stages:

1. **Verify the restricted Subagent boundary.** Prints a `systemd-analyze
   security` report. Confirm no sudo capability, Docker socket, production
   directory write, production secret source, or Operations Broker access, and
   that only the pinned publisher holds App publication authority.
2. **Enroll Codex and verify App publication.** Skips the device flow when
   `voice-codex` is already logged in. Runs two isolation proofs: model commands
   must not read the subscription credential or reach the publisher socket.
3. **Enroll the authenticated Keeplore browser session.** Opens Chromium on the
   forwarded display. Sign into Keeplore, then close the browser to save the
   session. It re-saves even when a valid session already exists.
4. **Pin the source revision and run the telephone trial.** Accept the offered
   `origin/main` commit unless you mean to pin an older one, then place the
   call.

On the call:

- Say: *Make the Get Rid Of button match Remove in Keeplore's table view.*
- Confirm **only** if the readback names Keeplore production, table-only scope,
  the visual measurements, and unchanged card view. Ordinary affirmatives work —
  "yes", "I confirm — yes", "that is correct". A qualified answer such as "yes,
  but also change card view" declines, and unclear speech leaves the same Task
  Confirmation pending so you can simply answer again.
- Say *Stop* at any point to halt at the next safe boundary. Completed commits
  and unfinished work are preserved without reset, stash, or deletion.

The wizard then prints the structured Delegation Result. Open the reported pull
request and inspect its branch, commits, changed file, automated check,
authenticated desktop and mobile screenshots, computed styles, card-view proof,
and risks. **Do not merge until you accept it as the Human Merge.**

## Afterwards

`voice-agent-promotion-resume.service` carries a stale `failed` result from
2026-08-18. It is inert — the `.path` unit stays armed and systemd restarts a
failed `oneshot` on its next trigger — and it is the last evidence of that
incident now the journal has rotated. Clear it when you no longer want the
marker:

```bash
sudo systemctl reset-failed voice-agent-promotion-resume.service
```
