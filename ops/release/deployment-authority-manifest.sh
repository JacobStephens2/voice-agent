#!/usr/bin/env bash

voice_agent_authority_scripts=(
  candidate-preflight.sh
  deployment-authority-drift.sh
  deployment-authority-manifest.sh
  deployment-health.sh
  git-credential-github-app.sh
  github-source-token.sh
  install-release.sh
  promote-main.sh
  promote-release.sh
  promotion-state.sh
  record-promotion-failure.sh
  release-immutability.sh
  resume-promotion.sh
  rollback-release.sh
  upgrade-deployment-authority.sh
  verify-human-merge.sh
)

voice_agent_authority_units=(
  voice-agent-api.service
  voice-agent-worker.service
  voice-agent-keeplore-publisher.service
  voice-agent-subagent.service
  voice-agent-broker.service
  voice-agent-probes.service
  voice-agent-probes.timer
  voice-agent-promotion-resume.path
  voice-agent-promotion-resume.service
  # The Grok contract Delegation runs one bounded model process per Durable
  # Task under a template unit rather than a long-running service, so it is
  # authority to install but not a runtime unit to restart. It holds the
  # Credential Custody Boundary on the host side of the reviewed sandbox: a
  # host that could start this work without the reviewed unit would run the
  # model with whatever boundary the invoking shell happened to have.
  voice-agent-grok-contract@.service
)

voice_agent_authority_apparmor_profiles=(
  "ops/apparmor/bwrap-userns-restrict:bwrap-userns-restrict"
)

voice_agent_authority_programs=(
  # source path : pinned path : published mode. Unlike the category-level
  # arrays above, these programs do not share one mode: data read by Node stays
  # non-executable, while an Auth Crossing invoked by exec must be executable.
  "ops/release/deployment-authority-authorization-verifier.mjs:deployment-authority-authorization-verifier.mjs:0644"
  "ops/release/keeplore-github-app-publisher.ts:keeplore-github-app-publisher.ts:0644"
  # The Grok token crossing. The broker is what the runner invokes as its
  # configured auth provider and the helper is the only thing that may read the
  # refresh credential, so both are reviewed root authority rather than release
  # content: the sudoers rule and the root-managed provider configuration name
  # these exact pinned paths, and a host running an unreviewed copy at either
  # path would have moved the custody boundary without an attended action.
  "ops/grok/grok-token-broker:grok-token-broker:0755"
  "ops/grok/grok-token-helper:grok-token-helper:0755"
)

# The Keeplore programs that write the repository-policy journal the pinned
# publisher re-reads before it will publish anything. The publisher is reviewed
# authority installed above; these must travel with it, because a host carrying
# a newer publisher and an older writer refuses every publication over a field
# one side stopped writing and the other still requires.
# The promoter and the shared boundaries it sources travel together for the
# same reason: post-Promotion appearance verification is declared in the
# registration and read by the promoter, and a host carrying one half of that
# pair either verifies nothing or reads a setting nobody writes. The
# re-promoter belongs to the same pair — it labels the attempts it makes, and a
# host whose promoter did not yet understand those labels would appearance-
# verify the retained Release it stepped back to and roll production onto it.
voice_agent_authority_keeplore_tools=(
  "ops/keeplore/collect-keeplore-repository-policy.sh:collect-keeplore-repository-policy.sh"
  "ops/keeplore/keeplore-config.sh:keeplore-config.sh"
  "ops/keeplore/promote-keeplore-release.sh:promote-keeplore-release.sh"
  "ops/keeplore/record-keeplore-bypass-attestation.sh:record-keeplore-bypass-attestation.sh"
  "ops/keeplore/repromote-keeplore-merge.sh:repromote-keeplore-merge.sh"
  "ops/keeplore/resolve-keeplore-worktree.sh:resolve-keeplore-worktree.sh"
  # The Keeplore tools resolve the Human Merge verifier beside themselves, so a
  # re-promotion can refuse an unverified commit before it moves production.
  "ops/release/verify-human-merge.sh:verify-human-merge.sh"
)

voice_agent_authority_extras=(
  "ops/prometheus/install-scrape.sh:install-prometheus-scrape.sh"
  "ops/grafana/install-dashboard.sh:install-grafana-dashboard.sh"
)

# Print one file's mode as the four-digit octal form used by this manifest.
# GNU stat is present on the Agent Host; BSD stat keeps the same contract
# exercisable by the isolated macOS scenario harness.
voice_agent_authority_path_mode() {
  local path=$1 raw_mode
  if raw_mode=$(stat -c %a -- "$path" 2>/dev/null); then
    :
  else
    raw_mode=$(stat -f %Lp -- "$path") || return 1
  fi
  if [[ ! $raw_mode =~ ^[0-7]{3,4}$ ]]; then return 1; fi
  printf '%04o\n' "$((8#$raw_mode))"
}

# voice_agent_authority_pinned_paths
#
# Print, one per line in manifest order, the reviewed file's Release-relative
# source path, the pinned-relative path the attended upgrade installs it at,
# and its published mode, separated by tabs. Layout and mode are decided here
# rather than at each reader, so installation and drift cannot disagree about
# what a pinned path means.
voice_agent_authority_pinned_paths() {
  local entry mapping pinned published_mode
  for entry in "${voice_agent_authority_scripts[@]}"; do
    printf 'ops/release/%s\t%s\t0755\n' "$entry" "$entry"
  done
  for entry in "${voice_agent_authority_units[@]}"; do
    printf 'ops/systemd/%s\tsystemd/%s\t0644\n' "$entry" "$entry"
  done
  for mapping in "${voice_agent_authority_apparmor_profiles[@]}"; do
    printf '%s\tapparmor/%s\t0644\n' "${mapping%%:*}" "${mapping#*:}"
  done
  for mapping in "${voice_agent_authority_programs[@]}"; do
    pinned=${mapping#*:}
    published_mode=${mapping##*:}
    printf '%s\t%s\t%s\n' \
      "${mapping%%:*}" "${pinned%%:*}" "$published_mode"
  done
  # The Keeplore tools are staged in their own subdirectory of the authority
  # root by `upgrade-deployment-authority.sh`, which reads the bare right-hand
  # sides above to install a second copy under `/usr/local/libexec/keeplore/`.
  for mapping in "${voice_agent_authority_keeplore_tools[@]}"; do
    printf '%s\tkeeplore/%s\t0755\n' "${mapping%%:*}" "${mapping#*:}"
  done
  for mapping in "${voice_agent_authority_extras[@]}"; do
    printf '%s\t%s\t0755\n' "${mapping%%:*}" "${mapping#*:}"
  done
}
