# Voice Development and Operations

This context describes a personal, voice-first system for discussing, changing, and operating the applications on its owner's Linux server.

## Language

**Voice Agent**:
A personal, voice-first assistant that discusses codebases, directs development and operational work, and delegates complex tasks to other agents.
_Avoid_: Operations Copilot, voice interface

**Subagent**:
Any agent initiated by the Voice Agent to perform delegated work, including Codex, Claude Code, Grok, and Kimi Code sessions.
_Avoid_: Specialist Agent, worker

**Code Subagent**:
A Subagent that may receive repository context and modify Delegated Worktrees while using brokers for Git publication, dependency access, and external effects rather than unrestricted public-network access.
_Avoid_: Coding provider, unrestricted shell

**Research Subagent**:
A Subagent that may use the unrestricted public internet without receiving repository contents, host credentials, or administrative authority and returns a primary-source Research Finding.
_Avoid_: Code Subagent, browser tool

**Research Finding**:
A durable Markdown artifact in a codebase that answers a research question from primary sources with citations and implementation-relevant limitations.
_Avoid_: Raw webpage, browsing transcript, uncited summary

**Provider Enrollment**:
An attended credential-custody action that binds one Subagent provider identity to its authenticated subscription or API route, observed privacy settings, and accepted runtime without granting repository, publication, or host authority by itself.
_Avoid_: Provider login, Delegation, authority activation

**Delegation**:
The automatic transfer of deeper work, potentially spanning multiple codebases, from the Voice Agent to another agent selected by the Voice Agent.
_Avoid_: Handoff, agent call

**Durable Task**:
The authoritative unit of work that retains one identity and state history across Telephone Sessions, PWA interactions, notifications, callbacks, tool operations, and Subagent processes.
_Avoid_: Conversation, call, model session

**Operation**:
An idempotent, durably identified tool invocation whose accepted state and result survive retries, call loss, and process restarts without repeating its external effect.
_Avoid_: Tool call, command, action

**Evidence Event**:
An immutable entry in a Durable Task's append-only history recording an accepted request, decision, Operation, Delegation, observation, correction, or outcome from which its current Evidence Record is projected.
_Avoid_: Editable log row, mutable status

**Delegation Brief**:
The structured input to a Subagent containing the goal, Registered Codebase, constraints, acceptance criteria, authorized capabilities, and relevant bounded context without raw voice transcripts.
_Avoid_: Prompt, transcript, handoff message

**Delegation Result**:
The structured Subagent outcome containing status, verification, risks, the failure that ended a run, and the branch, commits, changed files, and pull-request state for each affected codebase.
_Avoid_: Final answer, raw agent log

**Restricted Run Evidence**:
The trusted runner's own account of a failed Delegation, retained under that Delegation's evidence directory: the restricted runner's exit status and bounded standard error, and the model workspace as it stood when the run ended, carrying no voice transcript.
_Avoid_: Model report, agent transcript, event stream

**Secret Execution Manifest**:
An authenticated, versioned allowlist describing credentials that may be resolved for one restricted execution path; it controls blast radius but does not conceal injected credentials from the receiving process.
_Avoid_: Environment file, vault access, secret containment

**Brokered Secret Use**:
An execution in which a narrow broker uses a credential on behalf of a caller and returns a sanitized result without disclosing the credential to the Voice Agent or Subagent.
_Avoid_: Secret injection, manifest, shared credential

**Credential Custody Boundary**:
The designated host stores whose SSH, provider, browser-session, passkey, TLS, deployment, and application credentials may be used only through typed brokers and are never directly readable by a Subagent.
_Avoid_: Repository secret filtering, hidden prompt, unrestricted root

**Code Inquiry**:
A narrow, read-only search of a registered codebase performed directly by the Voice Agent to answer an immediate conversational question using bounded code excerpts; broad analysis and all code changes are delegated to a Subagent.
_Avoid_: Delegation, code edit, repository dump

**Registered Codebase**:
A repository enrolled explicitly or through policy-authorized discovery for Code Inquiry and Delegation with a fixed path, remote, production branch, isolated-worktree location, verification commands, and, when deployed, a Deployment Contract.
_Avoid_: Application directory, discovered repository, arbitrary path

**Configuration Repository**:
The private Registered Codebase that represents reproducible Agent Host packages, services, network policy, device setup, recovery inventory, and other Host Patch targets.
_Avoid_: Server notes, live host configuration, backup

**Delegated Worktree**:
The persistent isolated Git worktree and non-production branch assigned to one codebase within a Delegation; a multi-codebase Delegation owns one per affected repository. It remains until its pull request is merged or closed and is never automatically removed while dirty.
_Avoid_: Live checkout, shared working tree, temporary directory

**Human Merge**:
A pull-request merge into a Registered Codebase's production branch performed by an authenticated human GitHub user after required checks, never a direct push or bot action; it authorizes Promotion of that exact merge commit.
_Avoid_: Push to main, automated merge, deployment approval

**Administrative Publisher App**:
A GitHub App installed across the owner's repositories that may push one task-assigned non-production branch and create or observe its pull request with a repository-narrowed token, but cannot merge, administer repositories, bypass rules, or deploy.
_Avoid_: Personal access token, Keeplore App, GitHub user login

**Repository Administration Broker**:
A typed credential-custody service that may create private repositories, observe or install standard production-branch rules, and observe the Administrative Publisher App installation without accessing repository contents, weakening rules, or approving, merging, closing, or deleting.
_Avoid_: Administrative Publisher App, GitHub administrator shell

**Incident Diagnosis**:
A conversational investigation that establishes why an observed server operation or service failed and proposes a remedy without applying it.
_Avoid_: Debug session, troubleshooting request

**Intervention**:
A change to application code, data, services, or infrastructure intended to alter the state of a system.
_Avoid_: Fix, action

**Live Patch**:
A time-bounded, independently recoverable mutation of version-controlled production files whose accepted diff must be reproduced in an isolated branch and pull request or removed from production at its rollback deadline.
_Avoid_: Hotfix, direct deploy, production edit

**Host Patch**:
A time-bounded, independently recoverable mutation of non-version-controlled Agent Host state that must be captured in a reproducible configuration repository or removed at its rollback deadline.
_Avoid_: Manual server tweak, permanent shell change

**Incident Response**:
The handling of an incident from diagnosis through any chosen intervention and verification.
_Avoid_: Incident Diagnosis

**Standing Autonomy Policy**:
The pre-authorized limits within which the Voice Agent may perform interventions without requesting per-action approval.
_Avoid_: Blanket permission, unrestricted access

**Administrative Autonomy Policy**:
A Fresh-Passkey-activated Standing Autonomy Policy that permits broad multi-codebase work and brokered Agent Host administration without per-Operation approval while withholding designated credential-store access, production-branch mutation, ad hoc production-data mutation, and self-activation of authority.
Its authenticated revision remains active until Administrative Suspension or another Fresh Passkey Action revises it.
_Avoid_: YOLO mode, always approve, unrestricted root

**Administrative Suspension**:
An owner-triggered state that refuses new administrative Operations, activates every armed Live Patch and Host Patch rollback, and preserves Delegated Worktrees and Evidence Records until a Fresh Passkey Action reactivates Administrative Autonomy.
_Avoid_: Task stop, service shutdown, rollback deletion

**Task Confirmation**:
A concise spoken readback of the target application, environment, and intended state-changing outcome—not the eventual Operation plan—that remains pending until the user affirmatively confirms or declines it, before the Voice Agent accepts a Durable Task or Delegation.
_Avoid_: Per-operation approval, conversational acknowledgement

**Bounded Provider Retry**:
The single recovery a Telephone Session may spend on a transient speech-provider fault, replayed under the durable turn identity that already failed; a fault with nothing left to replay, and every later failure, ends the call through one prerecorded response instead while preserving accepted Durable Tasks.
_Avoid_: Automatic provider failover, unlimited retry, redial

**Telephone Session Fault**:
A broken invariant the Voice Agent itself raises during a Telephone Session, as opposed to a failure a speech or interpretation provider reported; its description is fixed text authored in the system and carries nothing from the call, which is what makes it safe to describe to an operator at any stage.
_Avoid_: Provider failure, provider outage, speech error

**Bounded Excerpt**:
An explicitly requested, code-filtered subset of server data that may be shared with a hosted model provider.
_Avoid_: Raw payload, unrestricted context

**Production Data Observation**:
A brokered, task-relevant view of live data that defaults to schema, aggregates, bounded samples, and secret or personal-data redaction; raw records require the confirmed task to identify them.
_Avoid_: Database access, production dump, unrestricted query

**Evidence Record**:
The canonical visual history of a Durable Task, including conversations, inspected evidence, Operations, delegated work, changes, verification, and conclusions; raw telephone audio and raw command or provider output are excluded outside temporary debugging or execution.
_Avoid_: Transcript, chat history

**Evidence Lifecycle Policy**:
An authenticated, durable policy that authorizes scheduled expiry of ordinary Evidence Events after their retention window while preserving Durable Task and Operation identities.
_Avoid_: Ad hoc deletion, task deletion, retention cleanup

**PWA**:
The installable, authenticated browser interface for visual security actions, operational controls, Durable Task status, and Evidence Records; conversational task initiation and WebRTC are separate interaction capabilities.
_Avoid_: Dashboard, native app, telephone interface

**Telephone Session**:
A live outbound telephone call that serves as the primary conversational channel after a Callback Handshake succeeds through answering-machine detection and DTMF confirmation.
_Avoid_: Voice chat, phone interface

**Task Media**:
Audio, video, or image content explicitly attached to or identified in a confirmed Durable Task for disclosure to its selected provider; it excludes raw Telephone Session audio unless separately authorized.
_Avoid_: Call recording, ambient media

**WebRTC Session**:
A live voice conversation carried directly between the PWA and the Voice Agent over the internet rather than through the telephone network.
_Avoid_: Telephone Session, browser call

**Callback Handshake**:
A telephone-session authentication flow in which an inbound call from a passkey-registered number accepts no commands, ends, and is replaced by an outbound call to that number; the session becomes authorized only after a human answer and DTMF confirmation.
_Avoid_: Caller-ID authentication, spoken password

**Registered Telephone**:
A telephone number enrolled through a fresh passkey action and permitted to request and receive Callback Handshakes.
_Avoid_: Caller ID, contact number, trusted caller

**Trusted Browser Session**:
A 30-day PWA session established by a passkey and sufficient for ordinary task requests and Evidence Record access, but not for changing authority or other fresh-passkey operations.
_Avoid_: Remembered passkey, permanent login

**Fresh Passkey Action**:
A recent WebAuthn assertion required at the moment of authority expansion, policy or recovery change, Secret Execution Manifest activation, or raw-audio debugging.
_Avoid_: Logged-in session, voice confirmation, email confirmation

**Completion Callback**:
An outbound call placed by the Voice Agent when delegated work finishes; if unanswered, it falls back to a Silent Notification.
_Avoid_: Callback Handshake, status call

**Personal Prototype**:
The single-user version of the Voice Agent that serves its owner and may use the owner's subscription-authenticated coding tools.
_Avoid_: Customer product, multi-tenant service

**Promotion**:
The automatic, verified transition of the exact commit produced by a Human Merge into production.
_Avoid_: Direct push, deploy

**Release**:
An immutable application build produced from the exact commit of one Human Merge and retained as a distinct rollback target.
_Avoid_: Live checkout, mutable build, branch

**Promotion Attempt**:
One serial, auditable attempt to make a Release active, including preflight checks, any authorized migration, atomic switching, post-Promotion health verification, and automatic rollback on failure.
_Avoid_: Deployment job, release build

**Deployment Circuit Breaker**:
The per-application guard that pauses automatic Promotion after three consecutive failed Promotion Attempts and permits one half-open recovery attempt after a new Human Merge or authenticated human reset.
_Avoid_: Deployment failure, manual pause

**Deployment Contract**:
An authenticated, versioned policy record defining how a Human Merge is built into a Release, migrated, promoted, health-verified, and rolled back.
_Avoid_: Deploy script, generic deployment

**Silent Notification**:
A work-completion notice delivered without initiating a Telephone Session; initially, a generic email containing an authenticated Evidence Record link and no operational evidence or authority-bearing credential.
_Avoid_: Callback, status email

**Recovery Code**:
An offline, single-use secret that may restore authentication only long enough to enroll a replacement passkey and cannot authorize an Intervention.
_Avoid_: Backup password, email reset, approval code

**Bootstrap Code**:
A short-lived, single-use secret generated through existing server access solely to establish the first two passkeys, after which bootstrap enrollment is permanently disabled.
_Avoid_: Recovery Code, password, standing login

**Agent Host**:
The single Linux server that runs the Voice Agent and the applications it develops and operates; initially, the DigitalOcean VM at `stephens.page`.
_Avoid_: Control Host, Managed Host, target

**Operations Broker**:
The narrow, policy-enforcing interface through which the Voice Agent observes or changes applications and services on the Agent Host.
_Avoid_: SSH shell, command runner

**Subagent Runner**:
The restricted execution environment on the Agent Host in which Subagents inspect code, edit isolated branches, and run verification.
_Avoid_: Operations Broker, unrestricted shell

**Chart35 Login Incident**:
An Incident Diagnosis concerning apparent unavailability of the Express API that supports login for Chart35.
_Avoid_: Server down

**Keeplore Onboarding**:
The attended enrollment of Keeplore that reconciles its live working tree, fixes its Registered Codebase boundaries, establishes CI, production-branch rules, a least-privilege GitHub App, and a versioned Deployment Contract, and proves the real deployment path with one harmless Human Merge before any feature Delegation.
_Avoid_: Keeplore setup, first deploy

**Live Checkout Inspection**:
The read-only re-inspection of a live application checkout — repository, production branch, head commit, uncommitted paths, serving path, and verification seams — performed before automation pulls, branches, builds, or deploys, and never resolving the owner's uncommitted work itself.
_Avoid_: Git status check, cleanup

**Repository Policy Observation**:
An append-only record of what a Registered Codebase's production-branch rules and least-privilege GitHub App installation were seen to be, carrying whether the Voice Agent's own credentials or the owner's authenticated account established it; an unobserved or expired boundary is reported as unassessed rather than satisfied.
_Avoid_: Branch protection check, policy scan, compliance status

**Keeplore Button Trial**:
A feature-work trial in which the Voice Agent delegates resizing the “Get Rid Of” controls on Keeplore's use-by table to match its row-level “Remove” controls.
_Avoid_: Button test

**Bountywell Outage Drill**:
A controlled Incident Response trial in which `bountywell-api.service` is deliberately stopped behind an independent recovery timer and the Voice Agent must diagnose and recover it without being told the injected fault.
_Avoid_: Production outage, chaos test
