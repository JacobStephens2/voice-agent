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
)

voice_agent_authority_apparmor_profiles=(
  "ops/apparmor/bwrap-userns-restrict:bwrap-userns-restrict"
)

voice_agent_authority_programs=(
  "ops/release/deployment-authority-authorization-verifier.mjs:deployment-authority-authorization-verifier.mjs"
  "ops/release/keeplore-github-app-publisher.ts:keeplore-github-app-publisher.ts"
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

# voice_agent_authority_pinned_paths
#
# Print, one per line in manifest order, the reviewed file's Release-relative
# source path and the pinned-relative path the attended upgrade installs it at,
# separated by a tab. The pinned layout is decided here rather than at each
# reader, so a comparison of what a host is running cannot look for a path no
# upgrade has ever written.
voice_agent_authority_pinned_paths() {
  local entry mapping
  for entry in "${voice_agent_authority_scripts[@]}"; do
    printf 'ops/release/%s\t%s\n' "$entry" "$entry"
  done
  for entry in "${voice_agent_authority_units[@]}"; do
    printf 'ops/systemd/%s\tsystemd/%s\n' "$entry" "$entry"
  done
  for mapping in "${voice_agent_authority_apparmor_profiles[@]}"; do
    printf '%s\tapparmor/%s\n' "${mapping%%:*}" "${mapping#*:}"
  done
  for mapping in "${voice_agent_authority_programs[@]}"; do
    printf '%s\t%s\n' "${mapping%%:*}" "${mapping#*:}"
  done
  # The Keeplore tools are staged in their own subdirectory of the authority
  # root by `upgrade-deployment-authority.sh`, which reads the bare right-hand
  # sides above to install a second copy under `/usr/local/libexec/keeplore/`.
  for mapping in "${voice_agent_authority_keeplore_tools[@]}"; do
    printf '%s\tkeeplore/%s\n' "${mapping%%:*}" "${mapping#*:}"
  done
  for mapping in "${voice_agent_authority_extras[@]}"; do
    printf '%s\t%s\n' "${mapping%%:*}" "${mapping#*:}"
  done
}
