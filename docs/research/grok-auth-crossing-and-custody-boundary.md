# Grok Auth Crossing and Credential Custody Boundary contradictions

_Researched 2026-08-31 against this repository, ADR-0068, ADR-0069,
upstream systemd and sudo source, and Linux kernel documentation. This is a
static Research Finding: it made no Agent Host change and did not run the
contract unit or enrollment wizard on the host._

## Finding

The mode repair in issue #168 is necessary but not sufficient. The current
contract unit cannot perform the Auth Crossing that the attended shell probe
performs, and the installed crossing cannot simultaneously satisfy the current
Credential Custody Boundary probe. These are architecture contradictions, not
more installation-mode defects. They should remain fail-closed until the owner
chooses a compensating boundary for issues
[#168](https://github.com/JacobStephens2/voice-agent/issues/168) and
[#76](https://github.com/JacobStephens2/voice-agent/issues/76).

## The Auth Crossing cannot run under the contract unit

The exact execution chain is:

1. The [contract unit](../../ops/systemd/voice-agent-grok-contract@.service)
   starts the fixed executor as `voice-grok` with `NoNewPrivileges=true`, an
   empty `CapabilityBoundingSet` and `AmbientCapabilities`,
   `ProtectSystem=strict`, and `/var/lib/voice-grok-auth` in
   `InaccessiblePaths`.
2. Before starting Grok, the
   [executor](../../apps/worker/src/grok-contract-executor.ts) invokes the
   configured broker with `--probe`. The [broker](../../ops/grok/grok-token-broker)
   executes `/usr/bin/sudo -n -H -u voice-grok-auth` and the root-owned helper.
3. The [helper](../../ops/grok/grok-token-helper) reads the custody identity's
   `auth.json` and, when the OIDC entry has expired, runs Grok as that identity
   so it can renew and rewrite the entry. ADR-0069 makes that renewal part of
   the crossing contract ([ADR-0069](../adr/0069-renew-the-grok-login-where-a-delegation-needs-it.md)).

Three unit restrictions conflict with that chain:

- **`NoNewPrivileges=true` is fatal before sudoers is evaluated.** systemd
  documents that the setting covers the service and every descendant and
  prevents `execve()` from gaining privilege through setuid/setgid bits or file
  capabilities
  ([systemd source](https://github.com/systemd/systemd/blob/d0fcc5a9ecbd01305eb6a7629643c892a58bd5ea/man/systemd.exec.xml#L928-L945));
  the kernel specifies that setuid/setgid bits no longer change IDs once
  `no_new_privs` is set
  ([kernel documentation](https://docs.kernel.org/userspace-api/no_new_privs.html)).
  sudo's own startup checks that it became effective UID 0 and exits with a
  specific `no_new_privs` diagnostic when it did not
  ([sudo source](https://github.com/sudo-project/sudo/blob/194042b55c54055c7337fbbd93a518e8da69866f/src/sudo.c#L982-L1000)).
  Therefore the setuid `/usr/bin/sudo` invocation in the broker cannot cross
  from `voice-grok` to `voice-grok-auth` in this unit. A successful attended
  shell probe does not test this property because systemd explicitly limits
  `NoNewPrivileges` to the unit's own descendants.

- **The empty capability sets are a second conflict, not the remedy for the
  first.** `CapabilityBoundingSet=` with no entries empties the bounding set and
  also affects the effective, permitted, and inheritable sets
  ([systemd source](https://github.com/systemd/systemd/blob/d0fcc5a9ecbd01305eb6a7629643c892a58bd5ea/man/systemd.exec.xml#L860-L878)).
  sudo changes the run-as identity with `setresuid`/`setuid`
  ([sudo source](https://github.com/sudo-project/sudo/blob/194042b55c54055c7337fbbd93a518e8da69866f/src/exec.c#L183-L208));
  Linux assigns arbitrary UID and GID manipulation to `CAP_SETUID` and
  `CAP_SETGID`
  ([kernel capability definitions](https://github.com/torvalds/linux/blob/abdf623ddb75b24659018d3952d8f61937306ae5/include/uapi/linux/capability.h#L149-L159)).
  Removing only `NoNewPrivileges` would therefore still leave the intended
  identity transition without the capabilities sudo uses to complete it. The
  exact minimum capability set for the Agent Host's sudo/PAM/audit build must
  be measured through the real unit; it must not be guessed or replaced with a
  broad set.

- **The helper's credential store is hidden from every process in the unit.**
  systemd makes an `InaccessiblePaths` entry and everything below it
  inaccessible to all processes in the unit's filesystem namespace
  ([systemd source](https://github.com/systemd/systemd/blob/d0fcc5a9ecbd01305eb6a7629643c892a58bd5ea/man/systemd.exec.xml#L1808-L1838)).
  Changing UID cannot escape that namespace, and the empty capability set also
  removes `CAP_SYS_ADMIN`, which systemd identifies as the capability that
  could undo such mount restrictions
  ([systemd source](https://github.com/systemd/systemd/blob/d0fcc5a9ecbd01305eb6a7629643c892a58bd5ea/man/systemd.exec.xml#L1858-L1871)).
  Thus even a successful UID transition would leave the helper unable to read
  `/var/lib/voice-grok-auth/.grok/auth.json`. If that path were merely made
  visible, `ProtectSystem=strict` and the current `ReadWritePaths` would still
  make it read-only, preventing the renewal ADR-0069 requires
  ([systemd source](https://github.com/systemd/systemd/blob/d0fcc5a9ecbd01305eb6a7629643c892a58bd5ea/man/systemd.exec.xml#L1497-L1516)).

`RestrictSUIDSGID=true` does not explain or solve this failure: it prevents
creating or marking new SUID/SGID filesystem objects, not executing the
already-installed setuid sudo binary
([systemd source](https://github.com/systemd/systemd/blob/d0fcc5a9ecbd01305eb6a7629643c892a58bd5ea/man/systemd.exec.xml#L2808-L2819)).
The unit's address-family allowlist includes the ordinary Internet families,
so network reach for renewal is not the first failing restriction.

This contradicts ADR-0068's claim that the runner obtains its token through
the sudoers crossing under the deployed contract unit
([ADR-0068](../adr/0068-pin-and-prove-the-grok-runner-before-it-works.md)).
It also explains why an attended-shell crossing can pass while the exact unit
still cannot run: the two probes execute under different security contexts.

## The installed crossing fails the current custody proof

The [single boundary list](../../apps/worker/src/grok-credential-custody.ts)
includes `/usr/local/libexec/voice-agent`. The
[custody probe](../../apps/worker/src/grok-custody-probe.ts) treats a directory
as reached when `stat` and `readdir` succeed. Consequently a `0755 root:root`
directory is necessarily counted as readable by a direct `voice-grok` probe.
That is a static consequence of the checked-in probe and Unix mode, not a
claim that this Research Finding ran the probe on the Agent Host.

No second layer currently closes that reach:

- the [Grok sandbox profile](../../ops/grok/sandbox.toml) deliberately has no
  `deny` list, and `describeSandboxProfileDrift` rejects a profile that adds
  one because the enrolled runner refuses such profiles on this host;
- the [contract unit](../../ops/systemd/voice-agent-grok-contract@.service)
  does not include `/usr/local/libexec/voice-agent` in `InaccessiblePaths`,
  because the parent runner is expected to execute the broker; and
- the [sudoers rule](../../ops/grok/sudoers-voice-grok-token-helper) authorizes
  the two helper forms solely by caller identity (`voice-grok`) and exact
  command. The parent runner and model-selected commands share that identity,
  so sudoers cannot distinguish them.

The pre-finding comments in `grok-credential-custody.ts` and
`grok-token-broker` said the model sandbox denied this path. That false claim
is corrected alongside this finding without changing the boundary. More
importantly, ADR-0068's corrected claim that identity permissions and the
systemd unit hold the whole Credential Custody Boundary is false for this
member: identity permissions deliberately allow the crossing directory, while
the unit does not hide it. The currently installed AppArmor
[`unpriv_bwrap` profile](../../ops/apparmor/bwrap-userns-restrict) denies child
capabilities but has no file denial for the crossing.

Simply removing `NoNewPrivileges` or exposing the auth store would make the
runner path less broken while also making the same path available to a
model-selected command. Conversely, putting the crossing directory in the
unit's `InaccessiblePaths` would protect it from the model and make it
unavailable to the runner. The present one-identity, one-unit boundary cannot
express the distinction ADR-0068 requires.

## Decisions held for the owner

No hardening or boundary should change until these choices are recorded for
#168/#76 (and, because they revise the implemented claims, in a follow-up to
ADR-0068/ADR-0069):

1. **Where the trusted-parent/model-child split is enforced.** The leading
   candidate is an independently enforced Bubblewrap-child profile, such as a
   reviewed AppArmor rule on `unpriv_bwrap`, that denies the crossing
   directory and auth store only after the fixed runner has crossed. It needs
   a canary under the real contract unit proving that the parent can cross
   while a model-selected child cannot list or execute the broker or helper.
   Grok's own `deny` setting is not this control; it is known not to start on
   the host.

2. **Where privilege lives.** Two viable shapes need explicit comparison:

   - retain sudo inside the contract unit, disable only the hardening that the
     exact transition requires, determine and pin the minimum capability set
     against the Agent Host's sudo build, make the auth store readable and
     renewable only where needed, and prove the child profile strips that
     privilege and denies both crossing files; or
   - keep `NoNewPrivileges`, the empty capability set, and the hidden auth
     store on the Grok unit, and move the crossing into a separately confined
     broker service/IPC boundary. systemd documents that `NoNewPrivileges`
     does not extend to processes requested through a separate IPC service
     ([systemd source](https://github.com/systemd/systemd/blob/d0fcc5a9ecbd01305eb6a7629643c892a58bd5ea/man/systemd.exec.xml#L939-L957)),
     but that service must authenticate and authorize only the two reviewed
     operations, and the model child must be independently denied its socket
     or activation interface.

   Running the Grok unit as root, granting a broad capability set, or merely
   deleting `NoNewPrivileges` are not acceptable alternatives.

3. **What the custody acceptance proves after the split.** The current direct
   identity probe cannot both require zero readable boundary paths and permit
   the same identity to traverse a `0755` boundary directory. The owner must
   choose whether the canonical proof moves inside the independently enforced
   model-child profile, whether parent and child receive distinct identities,
   or whether the crossing becomes a separately tested capability while the
   path remains in the Credential Custody Boundary. Until that compensating
   boundary and canary are approved, do not remove the path, weaken the probe,
   or count an attended-shell result as the service witness. Changing the
   directory to `0711` would only make `readdir` fail while known executable
   paths remain callable, so it is not a custody fix.

4. **Which real-host witnesses close enrollment.** After Human Merge and the
   Fresh-Passkey deployment-authority upgrade, acceptance must exercise the
   exact contract unit, the successful broker probe and renewal path, the
   failed child attempts against both crossing files and the auth store, and
   the custody canary selected above. An attended shell invocation alone is
   insufficient.

## Current host status remains partial

The dated issue #168 follow-up in
[`grok-build-install-and-auth.md`](grok-build-install-and-auth.md) remains the
only host witness: `/usr/local/libexec/voice-agent` was restored to
`0755 root:root` and `voice-grok` traversal was independently verified, but the
broker/helper binaries remain absent. No broker installation, contract-unit
crossing, or wizard-past-prerequisites witness is claimed. Those actions remain
attended after Human Merge, and this finding shows that they must wait for the
architectural decision above rather than merely installing the files.
