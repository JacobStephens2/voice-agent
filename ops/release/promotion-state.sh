#!/usr/bin/env bash

promotion_state_initialize() {
  getent group voice-agent >/dev/null || groupadd --system voice-agent
  promotion_state_directory=/var/lib/voice-agent-promotions
  promotion_state="$promotion_state_directory/state.tsv"
  promotion_attempts="$promotion_state_directory/attempts.jsonl"
  promotion_metrics="$promotion_state_directory/promotions.prom"
  install -d -o root -g voice-agent -m 0750 "$promotion_state_directory"

  consecutive_failures=0
  circuit_state=closed
  last_failed_commit=-
  last_attempted_commit=-
  if [[ -f $promotion_state ]]; then
    IFS=$'\t' read -r consecutive_failures circuit_state last_failed_commit \
      last_attempted_commit < "$promotion_state"
    last_attempted_commit=${last_attempted_commit:--}
    if [[ ! $consecutive_failures =~ ^[0-9]+$ ]] || \
      [[ $circuit_state != closed && $circuit_state != open ]] || \
      [[ $last_failed_commit != - && ! $last_failed_commit =~ ^[0-9a-f]{40}$ ]] || \
      [[ $last_attempted_commit != - && ! $last_attempted_commit =~ ^[0-9a-f]{40}$ ]]; then
      printf 'Promotion circuit-breaker state is invalid.\n' >&2
      return 1
    fi
  fi
}

promotion_state_assert_allowed() {
  local commit=$1 manual_rollback=${2:-0} fresh_resume=${3:-0}
  if [[ $circuit_state == open && $last_failed_commit == "$commit" && \
    $manual_rollback != 1 && $fresh_resume != 1 ]]; then
    printf 'Promotion circuit breaker is open for release %s; a new Human Merge is required.\n' \
      "$commit" >&2
    return 1
  fi
}

promotion_state_record() {
  local commit=$1 previous=$2 result=$3 stage=$4 manual_rollback=${5:-0}
  local attempted_at metric_tmp state_tmp success_value
  if [[ ! $commit =~ ^[0-9a-f]{40}$ ]] || \
    [[ $result != succeeded && $result != failed ]] || \
    [[ ! $stage =~ ^[a-z-]+$ ]]; then
    printf 'Promotion Attempt evidence is invalid.\n' >&2
    return 1
  fi

  attempted_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if [[ $result == succeeded ]]; then
    consecutive_failures=0
    circuit_state=closed
    last_failed_commit=-
  else
    consecutive_failures=$((consecutive_failures + 1))
    last_failed_commit=$commit
    if (( consecutive_failures >= 3 )); then
      circuit_state=open
    fi
  fi
  if [[ $manual_rollback != 1 ]]; then
    last_attempted_commit=$commit
  fi

  state_tmp=$(mktemp "$promotion_state_directory/.state.XXXXXX")
  printf '%s\t%s\t%s\t%s\n' \
    "$consecutive_failures" "$circuit_state" "$last_failed_commit" \
    "$last_attempted_commit" > "$state_tmp"
  chown root:voice-agent "$state_tmp"
  chmod 0640 "$state_tmp"
  mv -f "$state_tmp" "$promotion_state"

  printf '{"attemptedAt":"%s","commit":"%s","previous":"%s","result":"%s","stage":"%s","consecutiveFailures":%s,"circuitState":"%s"}\n' \
    "$attempted_at" "$commit" "$previous" "$result" "$stage" \
    "$consecutive_failures" "$circuit_state" >> "$promotion_attempts"
  chown root:voice-agent "$promotion_attempts"
  chmod 0640 "$promotion_attempts"

  if [[ $result == succeeded ]]; then success_value=1; else success_value=0; fi
  metric_tmp=$(mktemp "$promotion_state_directory/.metrics.XXXXXX")
  printf '# HELP voice_agent_promotion_consecutive_failures Consecutive failed Promotion Attempts.\n' > "$metric_tmp"
  printf '# TYPE voice_agent_promotion_consecutive_failures gauge\n' >> "$metric_tmp"
  printf 'voice_agent_promotion_consecutive_failures %s\n' "$consecutive_failures" >> "$metric_tmp"
  printf '# HELP voice_agent_promotion_circuit_open Whether the Deployment Circuit Breaker is open.\n' >> "$metric_tmp"
  printf '# TYPE voice_agent_promotion_circuit_open gauge\n' >> "$metric_tmp"
  if [[ $circuit_state == open ]]; then
    printf 'voice_agent_promotion_circuit_open 1\n' >> "$metric_tmp"
  else
    printf 'voice_agent_promotion_circuit_open 0\n' >> "$metric_tmp"
  fi
  printf '# HELP voice_agent_promotion_last_attempt_success Whether the latest Promotion Attempt succeeded.\n' >> "$metric_tmp"
  printf '# TYPE voice_agent_promotion_last_attempt_success gauge\n' >> "$metric_tmp"
  printf 'voice_agent_promotion_last_attempt_success %s\n' "$success_value" >> "$metric_tmp"
  chown root:voice-agent "$metric_tmp"
  chmod 0640 "$metric_tmp"
  mv -f "$metric_tmp" "$promotion_metrics"
}
