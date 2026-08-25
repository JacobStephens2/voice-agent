#!/usr/bin/env bash

voice_agent_authority_scripts=(
  candidate-preflight.sh
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
# pair either verifies nothing or reads a setting nobody writes.
voice_agent_authority_keeplore_tools=(
  "ops/keeplore/collect-keeplore-repository-policy.sh:collect-keeplore-repository-policy.sh"
  "ops/keeplore/keeplore-config.sh:keeplore-config.sh"
  "ops/keeplore/promote-keeplore-release.sh:promote-keeplore-release.sh"
  "ops/keeplore/record-keeplore-bypass-attestation.sh:record-keeplore-bypass-attestation.sh"
  "ops/keeplore/resolve-keeplore-worktree.sh:resolve-keeplore-worktree.sh"
)

voice_agent_authority_extras=(
  "ops/prometheus/install-scrape.sh:install-prometheus-scrape.sh"
  "ops/grafana/install-dashboard.sh:install-grafana-dashboard.sh"
)
