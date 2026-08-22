#!/usr/bin/env bash
set -euo pipefail
exec 8>&-

if [[ $# -ne 2 || ! $1 =~ ^--(prepare|enroll|activate)$ || \
  ! $2 =~ ^[0-9a-f]{40}$ ]]; then
  printf 'Usage: %s --prepare|--enroll|--activate <40-character-active-release-commit>\n' \
    "$0" >&2
  exit 1
fi

mode=${1#--}
commit=$2
test_root=${VOICE_AGENT_AUTHORITY_TEST_ROOT:-}
if [[ -n $test_root ]]; then
  if [[ ${EUID} -eq 0 || $test_root != /* || $test_root == / || \
    ! -d $test_root ]]; then
    printf 'The deployment-authority test root is invalid.\n' >&2
    exit 1
  fi
  filesystem_root=$(cd "$test_root" && pwd -P)
  test_mode=true
  node_bin=$(command -v node)
else
  if [[ ${EUID} -ne 0 ]]; then
    printf 'Run this attended deployment-authority upgrade as root.\n' >&2
    exit 1
  fi
  filesystem_root=
  test_mode=false
  node_bin=/usr/bin/node
fi

host_path() {
  printf '%s%s' "$filesystem_root" "$1"
}

release=$(host_path "/opt/voice-agent/releases/$commit")
current=$(host_path /opt/voice-agent/current)
authority=$(host_path /usr/local/libexec/voice-agent)
authority_parent=$(dirname "$authority")
apparmor_directory=$(host_path /etc/apparmor.d)
repository_registration=$(host_path /etc/voice-agent/promotion-repository)
promotion_state=$(host_path /var/lib/voice-agent-promotions/state.tsv)
verified_merges=$(host_path \
  /var/lib/voice-agent-promotions/verified-human-merges.tsv)
authority_state=$(host_path /var/lib/voice-agent-deployment-authority)
authorization_request=$(host_path \
  /var/lib/voice-agent-promotion-resume/deployment-authority-upgrade.request)
authorization_challenge=$(host_path \
  /var/lib/voice-agent-promotion-resume/deployment-authority-upgrade.challenge)
authentication_database=$(host_path /var/lib/voice-agent/voice-agent.sqlite)
authorization_credentials="$authority_state/authorization-credentials.json"
authorization_candidates="$authority_state/authorization-credentials.pending.json"
reviewed_authorization_verifier="$release/ops/release/deployment-authority-authorization-verifier.mjs"
authorization_verifier=$reviewed_authorization_verifier
pinned_authorization_verifier="$authority/deployment-authority-authorization-verifier.mjs"
release_immutability="$release/ops/release/release-immutability.sh"
authority_events="$authority_state/events.jsonl"
lock_path=$(host_path /run/voice-agent-deployment-authority-upgrade.lock)

if [[ $test_mode == false ]]; then
  exec 7>/run/voice-agent-main-promotion-queue.lock
  flock -x 7
  exec 9>"$lock_path"
  flock -x 9
fi

if [[ ! -L $current || $(readlink -f "$current") != "$release" ]] || \
  [[ ! -f $release/.voice-agent-release ]] || \
  [[ $(<"$release/.voice-agent-release") != "$commit" ]]; then
  printf 'Release %s is not the active immutable Voice Agent Release.\n' \
    "$commit" >&2
  exit 1
fi

expected_upgrader="$release/ops/release/upgrade-deployment-authority.sh"
if [[ $(readlink -f "$0") != "$expected_upgrader" ]]; then
  printf 'Run the upgrader from the active immutable Release.\n' >&2
  exit 1
fi
if [[ ! -d $authority || ! -x $authority/promote-release.sh ]]; then
  printf 'Existing pinned deployment authority is unavailable.\n' >&2
  exit 1
fi

if [[ ! -f $release_immutability ]]; then
  printf 'The reviewed Release immutability verifier is unavailable.\n' >&2
  exit 1
fi
# shellcheck source=release-immutability.sh
source "$release_immutability"

if [[ $test_mode == false ]]; then
  if [[ $(stat -c %U "$release") != root ]] || \
    ! voice_agent_release_tree_is_immutable "$release"; then
    printf 'The active Release is not immutable root-owned source.\n' >&2
    exit 1
  fi
  for evidence in "$promotion_state" "$verified_merges"; do
    if [[ ! -f $evidence || $(stat -c %U "$evidence") != root ]]; then
      printf 'Root-owned Human Merge evidence is unavailable.\n' >&2
      exit 1
    fi
  done
  if [[ $(stat -c %U "$authority") != root ]] || \
    [[ -n $(find "$authority" -perm /022 -print -quit) ]]; then
    printf 'Existing pinned deployment authority is not immutable root-owned source.\n' >&2
    exit 1
  fi
fi

if [[ ! -f $promotion_state ]]; then
  printf 'Promotion state for the active Release is unavailable.\n' >&2
  exit 1
fi
IFS=$'\t' read -r failures circuit last_failed last_attempted \
  < "$promotion_state"
if [[ ! $failures =~ ^[0-9]+$ || $circuit != closed || \
  $last_failed != - || $last_attempted != "$commit" ]]; then
  printf 'Release %s is not the latest successful Promotion.\n' "$commit" >&2
  exit 1
fi
if [[ ! -f $verified_merges ]] || \
  ! awk -F '\t' -v commit="$commit" '$2 == commit { found=1 } END { exit !found }' \
    "$verified_merges"; then
  printf 'Release %s has no verified Human Merge transition.\n' "$commit" >&2
  exit 1
fi

manifest="$release/ops/release/deployment-authority-manifest.sh"
if [[ ! -f $manifest ]]; then
  printf 'The reviewed deployment-authority manifest is unavailable.\n' >&2
  exit 1
fi
# shellcheck source=deployment-authority-manifest.sh
source "$manifest"

for script in "${voice_agent_authority_scripts[@]}"; do
  source_path="$release/ops/release/$script"
  if [[ ! -f $source_path ]]; then
    printf 'Reviewed deployment authority is missing %s.\n' "$script" >&2
    exit 1
  fi
  bash -n "$source_path"
done
for unit in "${voice_agent_authority_units[@]}"; do
  if [[ ! -f $release/ops/systemd/$unit ]]; then
    printf 'Reviewed deployment authority is missing %s.\n' "$unit" >&2
    exit 1
  fi
done
for mapping in "${voice_agent_authority_apparmor_profiles[@]}"; do
  source_path=${mapping%%:*}
  if [[ ! -f $release/$source_path ]]; then
    printf 'Reviewed deployment authority is missing %s.\n' "$source_path" >&2
    exit 1
  fi
  if [[ $test_mode == false ]]; then
    /usr/sbin/apparmor_parser -Q "$release/$source_path"
  fi
done
for mapping in "${voice_agent_authority_programs[@]}"; do
  source_path=${mapping%%:*}
  if [[ ! -f $release/$source_path ]]; then
    printf 'Reviewed deployment authority is missing %s.\n' "$source_path" >&2
    exit 1
  fi
  "$node_bin" --experimental-strip-types --check "$release/$source_path"
done
for mapping in "${voice_agent_authority_extras[@]}"; do
  source_path=${mapping%%:*}
  if [[ ! -f $release/$source_path ]]; then
    printf 'Reviewed deployment authority is missing %s.\n' "$source_path" >&2
    exit 1
  fi
  bash -n "$release/$source_path"
done
if [[ -e $pinned_authorization_verifier ]] && {
  [[ -L $pinned_authorization_verifier ]] ||
  ! cmp -s "$pinned_authorization_verifier" \
    "$reviewed_authorization_verifier"
}; then
  printf 'The active Release cannot replace its pinned authorization verifier.\n' \
    >&2
  exit 1
fi
if [[ -f $pinned_authorization_verifier ]]; then
  authorization_verifier=$pinned_authorization_verifier
fi
if [[ ! -f $authorization_verifier ]]; then
  printf 'The reviewed Fresh Passkey authorization verifier is unavailable.\n' >&2
  exit 1
fi

mkdir -p "$authority_parent" "$authority_state/backups" "$(dirname "$lock_path")"
if [[ $test_mode == false ]]; then
  chown root:root "$authority_state" "$authority_state/backups"
  chmod 0755 "$authority_state" "$authority_state/backups"
fi

if [[ $mode == prepare ]]; then
  rm -f -- "$authorization_challenge" "$authorization_request" \
    "$authorization_candidates"
  if ! "$node_bin" "$authorization_verifier" prepare "$commit" \
    "$authorization_challenge" "$authorization_credentials" \
    "$authentication_database" "$authorization_candidates"; then
    rm -f -- "$authorization_challenge" "$authorization_candidates"
    exit 1
  fi
  if [[ $test_mode == false ]]; then
    chown root:voice-agent "$authorization_challenge"
    chmod 0640 "$authorization_challenge"
    if [[ -f $authorization_candidates ]]; then
      chown root:root "$authorization_candidates"
      chmod 0600 "$authorization_candidates"
    fi
    if [[ -f $authorization_credentials ]]; then
      chown root:root "$authorization_credentials"
      chmod 0600 "$authorization_credentials"
    fi
  fi
  printf 'Prepared a five-minute root-owned Fresh Passkey challenge for %s.\n' \
    "$commit"
  exit 0
fi

if [[ ! -f $authorization_request || -L $authorization_request ]]; then
  printf 'Authorize this deployment-authority upgrade with a Fresh Passkey Action.\n' >&2
  exit 1
fi
if [[ ! -f $authorization_challenge || -L $authorization_challenge || \
  -L $authorization_credentials ]]; then
  printf 'Prepare a root-owned Fresh Passkey challenge before activation.\n' >&2
  exit 1
fi
if [[ $mode == activate && ! -f $authorization_credentials ]]; then
  printf 'Enroll the root-owned deployment passkey before activation.\n' >&2
  exit 1
fi
if [[ $mode == enroll ]] && {
  [[ -f $authorization_credentials ]] ||
  [[ ! -f $authorization_candidates ]] ||
  [[ -L $authorization_candidates ]]
}; then
  printf 'Prepare and approve existing owner passkey candidates before enrollment.\n' >&2
  exit 1
fi
if [[ $test_mode == false ]] && {
  [[ $(stat -c %U "$authorization_request") != voice-agent ]] ||
  [[ $(stat -c %a "$authorization_request") != 640 ]] ||
  [[ $(stat -c %U "$authorization_challenge") != root ]] ||
  [[ $(stat -c %a "$authorization_challenge") != 640 ]] ||
  { [[ -f $authorization_credentials ]] &&
    { [[ $(stat -c %U "$authorization_credentials") != root ]] ||
      [[ $(stat -c %a "$authorization_credentials") != 600 ]]; }; } ||
  { [[ -f $authorization_candidates ]] &&
    { [[ $(stat -c %U "$authorization_candidates") != root ]] ||
      [[ $(stat -c %a "$authorization_candidates") != 600 ]]; }; }
}; then
  printf 'The Fresh Passkey upgrade authorization has invalid ownership.\n' >&2
  exit 1
fi
touch "$authority_events"
if [[ $test_mode == false ]]; then
  chown root:voice-agent "$authority_events"
  chmod 0640 "$authority_events"
fi
append_authority_event() {
  local type=$1 details=${2:-}
  if [[ -n $details ]]; then
    printf '{"occurredAt":"%s","commit":"%s","type":"%s","details":%s}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$commit" "$type" \
      "$details" >> "$authority_events"
  else
    printf '{"occurredAt":"%s","commit":"%s","type":"%s"}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$commit" "$type" \
      >> "$authority_events"
  fi
}
stage=
previous=
processing_request=
switched=false
committed=false
backup=
authorization_verified=false
projection_published=false
current_existed=false
current_backup=
current_tmp=
authorization_registry_stage=
apparmor_previous=
apparmor_changed=false

restore_apparmor_profiles() {
  local mapping profile target_path backup_path
  if [[ $apparmor_changed != true ]]; then return 0; fi
  for mapping in "${voice_agent_authority_apparmor_profiles[@]}"; do
    profile=${mapping#*:}
    target_path="$apparmor_directory/$profile"
    backup_path="$apparmor_previous/$profile"
    if [[ $test_mode == false && -f $target_path ]]; then
      /usr/sbin/apparmor_parser -R "$target_path" || true
    fi
    if [[ -f $backup_path ]]; then
      install_reviewed_file 0644 "$backup_path" "$target_path"
      if [[ $test_mode == false ]]; then
        /usr/sbin/apparmor_parser -r "$target_path"
      fi
    else
      rm -f -- "$target_path"
    fi
  done
  apparmor_changed=false
}

restore_current_projection() {
  if [[ $projection_published == true ]]; then
    if [[ $current_existed == true ]]; then
      mv "$current_backup" "$authority_state/current"
      current_backup=
    else
      rm -f -- "$authority_state/current"
    fi
    projection_published=false
  fi
}

restore_previous_authority() {
  local failed="$authority_parent/.voice-agent.failed.$$"
  if [[ $switched == true && -d $previous ]]; then
    restore_apparmor_profiles
    if [[ -d $authority ]]; then
      mv "$authority" "$failed"
    fi
    mv "$previous" "$authority"
    rm -rf -- "$failed"
    switched=false
    restore_current_projection
    VOICE_AGENT_DEPLOYMENT_AUTHORITY_UPGRADE=rollback \
      "$authority/promote-release.sh" "$commit"
  fi
}

cleanup() {
  local status=$? rollback_status=0
  trap - EXIT
  if [[ $status -ne 0 && $committed == false ]]; then
    if [[ $switched == true ]]; then
      restore_previous_authority || rollback_status=$?
      if [[ $rollback_status -eq 0 ]]; then
        append_authority_event deployment-authority-upgrade-rolled-back || true
      else
        append_authority_event deployment-authority-upgrade-rollback-failed || true
      fi
    elif [[ $authorization_verified == true ]]; then
      if [[ $mode == enroll ]]; then
        append_authority_event deployment-authority-passkey-enrollment-failed \
          || true
      else
        append_authority_event deployment-authority-upgrade-failed || true
      fi
    else
      if [[ $mode == enroll ]]; then
        append_authority_event \
          deployment-authority-passkey-enrollment-rejected || true
      else
        append_authority_event \
          deployment-authority-upgrade-authorization-rejected || true
      fi
    fi
  fi
  if [[ -n $stage && -d $stage ]]; then
    rm -rf -- "$stage"
  fi
  if [[ -n $previous && -d $previous ]]; then
    rm -rf -- "$previous"
  fi
  if [[ -n $current_backup && -f $current_backup ]]; then
    rm -f -- "$current_backup"
  fi
  if [[ -n $current_tmp && -f $current_tmp ]]; then
    rm -f -- "$current_tmp"
  fi
  if [[ -n $authorization_registry_stage && \
    -f $authorization_registry_stage ]]; then
    rm -f -- "$authorization_registry_stage"
  fi
  if [[ -n $apparmor_previous && -d $apparmor_previous ]]; then
    rm -rf -- "$apparmor_previous"
  fi
  if [[ -n $processing_request ]]; then rm -f -- "$processing_request"; fi
  rm -f -- "$authorization_challenge" "$authorization_candidates"
  exit "$status"
}
trap cleanup EXIT

processing_request=$(mktemp \
  "$(dirname "$lock_path")/voice-agent-authority-request.XXXXXX")
rm -f -- "$processing_request"
mv "$authorization_request" "$processing_request"
verification_command=verify-authentication
verification_registry=$authorization_credentials
if [[ $mode == enroll ]]; then
  verification_command=verify-enrollment
  verification_registry=$authorization_candidates
fi
authorization_registry_stage=$(mktemp \
  "$authority_state/.authorization-credentials.next.XXXXXX")
rm -f -- "$authorization_registry_stage"
verification_details=$("$node_bin" "$authorization_verifier" \
  "$verification_command" \
  "$commit" "$authorization_challenge" "$verification_registry" \
  "$processing_request" "$authorization_registry_stage")
if [[ ! $verification_details =~ ^\{.*\}$ ]]; then
  printf 'The Fresh Passkey verifier returned invalid evidence details.\n' >&2
  exit 1
fi
if [[ $test_mode == false ]]; then
  chown root:root "$authorization_registry_stage"
  chmod 0600 "$authorization_registry_stage"
fi
authorization_verified=true
if [[ $mode == enroll ]]; then
  append_authority_event deployment-authority-passkey-enrolled \
    "$verification_details"
  mv "$authorization_registry_stage" "$authorization_credentials"
  authorization_registry_stage=
  committed=true
  rm -f -- "$processing_request" "$authorization_challenge" \
    "$authorization_candidates"
  printf 'Enrolled the root-owned deployment-authority passkey.\n'
  exit 0
fi
append_authority_event deployment-authority-upgrade-authorized \
  "$verification_details"
mv "$authorization_registry_stage" "$authorization_credentials"
authorization_registry_stage=

stage=$(mktemp -d "$authority_parent/.voice-agent.next.XXXXXX")
previous=$(mktemp -d "$authority_parent/.voice-agent.previous.XXXXXX")
rmdir "$previous"
current_backup=$(mktemp "$authority_state/.current.previous.XXXXXX")
if [[ -f $authority_state/current ]]; then
  cp -p "$authority_state/current" "$current_backup"
  current_existed=true
else
  rm -f -- "$current_backup"
  current_backup=
fi

mkdir -p "$stage/systemd" "$stage/apparmor"

install_reviewed_file() {
  local mode=$1 source_path=$2 target_path=$3
  if [[ $test_mode == true ]]; then
    install -m "$mode" "$source_path" "$target_path"
  else
    install -o root -g root -m "$mode" "$source_path" "$target_path"
  fi
}

for script in "${voice_agent_authority_scripts[@]}"; do
  install_reviewed_file 0755 "$release/ops/release/$script" "$stage/$script"
done
for unit in "${voice_agent_authority_units[@]}"; do
  install_reviewed_file 0644 "$release/ops/systemd/$unit" \
    "$stage/systemd/$unit"
done
for mapping in "${voice_agent_authority_apparmor_profiles[@]}"; do
  source_path=${mapping%%:*}
  target_path=${mapping#*:}
  install_reviewed_file 0644 "$release/$source_path" \
    "$stage/apparmor/$target_path"
done
for mapping in "${voice_agent_authority_programs[@]}"; do
  source_path=${mapping%%:*}
  target_path=${mapping#*:}
  install_reviewed_file 0644 "$release/$source_path" "$stage/$target_path"
done
for mapping in "${voice_agent_authority_extras[@]}"; do
  source_path=${mapping%%:*}
  target_path=${mapping#*:}
  install_reviewed_file 0755 "$release/$source_path" "$stage/$target_path"
done

if [[ -d $authority ]]; then
  mv "$authority" "$previous"
fi
mv "$stage" "$authority"
stage=
switched=true

backup=$(mktemp -d \
  "$authority_state/backups/before-$commit-$(date -u +%Y%m%dT%H%M%SZ).XXXXXX")
rmdir "$backup"
cp -a "$previous" "$backup"

apparmor_previous=$(mktemp -d \
  "$authority_parent/.voice-agent.apparmor.previous.XXXXXX")
mkdir -p "$apparmor_directory" "$backup/system-apparmor"
for mapping in "${voice_agent_authority_apparmor_profiles[@]}"; do
  profile=${mapping#*:}
  target_path="$apparmor_directory/$profile"
  if [[ -f $target_path ]]; then
    cp -p "$target_path" "$apparmor_previous/$profile"
    cp -p "$target_path" "$backup/system-apparmor/$profile"
  else
    touch "$backup/system-apparmor/.absent-$profile"
  fi
done
apparmor_changed=true
for mapping in "${voice_agent_authority_apparmor_profiles[@]}"; do
  profile=${mapping#*:}
  target_path="$apparmor_directory/$profile"
  install_reviewed_file 0644 "$authority/apparmor/$profile" "$target_path"
  if [[ $test_mode == false ]]; then
    /usr/sbin/apparmor_parser -r "$target_path"
  fi
done

if [[ ! -f $repository_registration ]]; then
  printf 'The root-owned Promotion repository registration is unavailable.\n' >&2
  exit 1
fi
registered_repository=$(<"$repository_registration")
if [[ -z $registered_repository || $registered_repository == *$'\n'* ]]; then
  printf 'The Promotion repository registration is invalid.\n' >&2
  exit 1
fi
"$authority/install-release.sh" "$registered_repository" "$commit"
VOICE_AGENT_DEPLOYMENT_AUTHORITY_UPGRADE=1 \
  "$authority/promote-release.sh" "$commit"
append_authority_event deployment-authority-upgrade-activated
current_tmp=$(mktemp "$authority_state/.current.XXXXXX")
printf '%s\n' "$commit" > "$current_tmp"
if [[ $test_mode == false ]]; then
  chown root:root "$current_tmp"
  chmod 0644 "$current_tmp"
fi
mv "$current_tmp" "$authority_state/current"
current_tmp=
projection_published=true
if [[ $test_mode == true && \
  ${VOICE_AGENT_AUTHORITY_TEST_FAIL_AFTER_CURRENT:-0} == 1 ]]; then
  false
fi
committed=true
switched=false
apparmor_changed=false
rm -rf -- "$previous"
rm -rf -- "$apparmor_previous"
apparmor_previous=
rm -f -- "$processing_request"
rm -f -- "$authorization_challenge"
if [[ -n $current_backup ]]; then rm -f -- "$current_backup"; fi
printf 'Upgraded pinned Voice Agent deployment authority from reviewed Release %s.\n' \
  "$commit"
