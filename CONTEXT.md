# Voice Development and Operations

This context describes a personal, voice-first system for discussing, changing, and operating the applications on its owner's Linux server.

## Language

**Voice Agent**:
A personal, voice-first assistant that discusses codebases, directs development and operational work, and delegates complex tasks to other agents.
_Avoid_: Operations Copilot, voice interface

**Subagent**:
Any agent initiated by the Voice Agent to perform delegated work, including Codex, Claude Code, Grok, and Kimi Code sessions.
_Avoid_: Specialist Agent, worker

**Delegation**:
The automatic transfer of deeper work from the Voice Agent to another agent selected by the Voice Agent.
_Avoid_: Handoff, agent call

**Incident Diagnosis**:
A conversational investigation that establishes why an observed server operation or service failed and proposes a remedy without applying it.
_Avoid_: Debug session, troubleshooting request

**Intervention**:
A change to application code, data, services, or infrastructure intended to alter the state of a system.
_Avoid_: Fix, action

**Incident Response**:
The handling of an incident from diagnosis through any chosen intervention and verification.
_Avoid_: Incident Diagnosis

**Standing Autonomy Policy**:
The pre-authorized limits within which the Voice Agent may perform interventions without requesting per-action approval.
_Avoid_: Blanket permission, unrestricted access

**Bounded Excerpt**:
An explicitly requested, code-filtered subset of server data that may be shared with a hosted model provider.
_Avoid_: Raw payload, unrestricted context

**Evidence Record**:
The visual record of a work session, including the conversation, inspected evidence, delegated work, changes, verification, and conclusions; raw telephone audio is excluded outside temporary debugging.
_Avoid_: Transcript, chat history

**Telephone Session**:
A live telephone call that serves as the primary conversational channel between the user and the Voice Agent.
_Avoid_: Voice chat, phone interface

**WebRTC Session**:
A live voice conversation carried directly between the PWA and the Voice Agent over the internet rather than through the telephone network.
_Avoid_: Telephone Session, browser call

**Callback Handshake**:
A telephone-session authentication flow in which an attempted inbound call is replaced by an outbound call to the user's registered number.
_Avoid_: Caller-ID authentication, spoken password

**Completion Callback**:
An outbound call placed by the Voice Agent when delegated work finishes; if unanswered, it falls back to a Silent Notification.
_Avoid_: Callback Handshake, status call

**Personal Prototype**:
The single-user version of the Voice Agent that serves its owner and may use the owner's subscription-authenticated coding tools.
_Avoid_: Customer product, multi-tenant service

**Promotion**:
The automatic transition of a registered application's human-merged `main` branch into production.
_Avoid_: Direct push, deploy

**Deployment Contract**:
An application-specific definition of how a merged change is built, released, verified, and rolled back.
_Avoid_: Deploy script, generic deployment

**Silent Notification**:
A work-completion notice delivered without initiating a Telephone Session; initially, an email containing a summary and an authenticated Evidence Record link.
_Avoid_: Callback, status email

**Managed Host**:
The single Linux server whose applications the Voice Agent develops and operates; initially, the DigitalOcean VM at `stephens.page`.
_Avoid_: Target, box, machine

**Chart35 Login Incident**:
An Incident Diagnosis concerning apparent unavailability of the Express API that supports login for Chart35.
_Avoid_: Server down

**Keeplore Button Trial**:
A feature-work trial in which the Voice Agent delegates resizing the “Get Rid Of” controls on Keeplore's use-by table to match its row-level “Remove” controls.
_Avoid_: Button test

**Bountywell Outage Drill**:
A controlled Incident Response trial in which Bountywell's API is deliberately stopped and the Voice Agent must diagnose and recover it without being told the injected fault.
_Avoid_: Production outage, chaos test
