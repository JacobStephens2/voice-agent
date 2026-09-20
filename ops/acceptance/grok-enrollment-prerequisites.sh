#!/usr/bin/env bash
#
# The first boundary-verification stage of Grok Provider Enrollment. The
# enrollment wizard sources this file and supplies its fixed paths plus the
# ordinary wizard presentation functions. Keeping the stage sourceable lets
# acceptance coverage exercise its stop boundary against isolated fixtures;
# the production caller still uses the real `sudo -u voice-grok` crossing.

# require DESCRIPTION REMEDY CHECK... — verify one prerequisite and retain
# every missing item so the operator receives the complete prerequisite list.
require() {
  local description="$1" remedy="$2"
  shift 2
  if "$@" >/dev/null 2>&1; then return 0; fi
  printf '  %s✗%s %s\n' "$RED" "$RESET" "$description"
  note "    $remedy"
  REQUIREMENTS_MISSING=$((REQUIREMENTS_MISSING + 1))
}

# Execute the Auth Crossing as the identity that has to reach it, before a
# credential is required. Zero means the probe answered; 10-14 are the
# helper's documented credential and crossing statuses. Any other status means
# the executor did not reach a broker/helper pair implementing this contract.
token_broker_is_reachable() {
  local status=0
  sudo -u voice-grok "$TOKEN_BROKER" --probe >/dev/null 2>&1 || status=$?
  case "$status" in
    0|10|11|12|13|14) return 0 ;;
    *) return 1 ;;
  esac
}

verify_grok_enrollment_boundary() {
  local REQUIREMENTS_MISSING=0
  local SETUP_REMEDY="Run the one-time setup block at the top of docs/operations/grok-enrollment.md as root."
  local AUTHORITY_REMEDY="Install it through the attended deployment-authority upgrade: ./ops/upgrade-agent-host-deployment-authority.sh"

  stage "Verify the enrollment boundary"
  say "The reviewed release owns provisioning; this stage verifies it without broadening authority."
  require "the executor identity voice-grok exists" "$SETUP_REMEDY" id voice-grok
  require "the custody identity voice-grok-auth exists" "$SETUP_REMEDY" id voice-grok-auth
  require "the pinned Grok Build runner is installed at $GROK" \
    "Install the reviewed release; see 'Install the runner' in docs/operations/grok-enrollment.md." \
    sudo test -x "$GROK"
  require "the reviewed requirements layer is installed at $GROK_REQUIREMENTS" \
    "$SETUP_REMEDY" sudo test -r "$GROK_REQUIREMENTS"
  require "voice-grok can execute the token broker through $TOKEN_BROKER_DIRECTORY" \
    "Restore the reviewed directory mode with: sudo chmod 0755 /usr/local/libexec/voice-agent. If the broker is absent, $AUTHORITY_REMEDY" \
    token_broker_is_reachable
  require "the token helper is pinned at $TOKEN_HELPER" "$AUTHORITY_REMEDY" \
    sudo test -x "$TOKEN_HELPER"
  require "the contract unit is installed" "$AUTHORITY_REMEDY" \
    sudo test -e "/etc/systemd/system/voice-agent-grok-contract@.service"
  require "the token helper is root-owned" "$AUTHORITY_REMEDY" \
    sudo test "$(sudo stat -c %U "$TOKEN_HELPER" 2>/dev/null)" = root
  require "the sudoers rule for the token crossing is root-owned" "$SETUP_REMEDY" \
    sudo test "$(sudo stat -c %U /etc/sudoers.d/voice-grok-token-helper 2>/dev/null)" = root
  require "the executor state directory belongs to voice-grok" "$SETUP_REMEDY" \
    sudo test "$(sudo stat -c %U /var/lib/voice-grok 2>/dev/null)" = voice-grok
  require "the custody state directory belongs to voice-grok-auth" "$SETUP_REMEDY" \
    sudo test "$(sudo stat -c %U /var/lib/voice-grok-auth 2>/dev/null)" = voice-grok-auth
  require "the Bubblewrap child overlay denies the Auth Crossing" "$AUTHORITY_REMEDY" \
    sudo grep -Fq 'deny /usr/local/libexec/voice-agent/' \
      /etc/apparmor.d/local/unpriv_bwrap
  if (( REQUIREMENTS_MISSING > 0 )); then
    printf '\n'
    warn "$REQUIREMENTS_MISSING prerequisite(s) are missing. Nothing has been changed; install them and run this wizard again."
    return 1
  fi

  sudo visudo -c >/dev/null
  # The refresh credential's custody is the whole point of the two identities.
  # Prove the executor cannot reach it before anything is authorized into it.
  sudo -u voice-grok test ! -r /var/lib/voice-grok-auth
  if [[ "$(sudo sysctl -n kernel.yama.ptrace_scope)" == "0" ]]; then
    warn "kernel.yama.ptrace_scope is 0: a model-selected command could read the access token out of the runner's memory. Install ops/grok/sysctl-voice-grok-ptrace.conf and run sysctl --system."
    return 1
  fi
  sudo systemd-analyze security "voice-agent-grok-contract@enrollment.service" --no-pager || true
  step "Confirm the contract unit grants only CAP_SETUID and CAP_SETGID for the sudoers crossing, and has no Docker socket or production directory. Child AppArmor, not this unit, denies the Auth Crossing to model-selected Bubblewrap children."
  step "Under the real contract unit, confirm the parent broker probe answers and a Bubblewrap child cannot list or execute /usr/local/libexec/voice-agent. Run ops/grok/auth-crossing-child-canary.sh from a Grok Delegation; an attended shell is not this witness. If the unit probe fails for want of one more capability, record that cap rather than granting a kitchen-sink set."
  pause "Review the boundary report, then press Enter."
}
