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
  voice-agent-subagent.service
  voice-agent-broker.service
  voice-agent-probes.service
  voice-agent-probes.timer
  voice-agent-promotion-resume.path
  voice-agent-promotion-resume.service
)

voice_agent_authority_programs=(
  "ops/release/deployment-authority-authorization-verifier.mjs:deployment-authority-authorization-verifier.mjs"
)

voice_agent_authority_extras=(
  "ops/prometheus/install-scrape.sh:install-prometheus-scrape.sh"
  "ops/grafana/install-dashboard.sh:install-grafana-dashboard.sh"
)
