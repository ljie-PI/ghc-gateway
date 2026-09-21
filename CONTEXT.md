# GHC Gateway

GHC Gateway exposes several client protocols through one local GitHub Copilot gateway while preserving each protocol's observable behavior.

## Language

**Gateway Foundation**:
The shared runtime capabilities on which all protocol endpoints and management functions run.
_Avoid_: Framework, platform layer

**Protocol Endpoint Module**:
A client-facing protocol slice that owns one route's request planning, response semantics, streaming lifecycle, and wire behavior.
_Avoid_: Protocol adapter, controller

**Responses Execution Plan**:
The immutable choice for one Responses request to use the native upstream protocol or the Chat bridge.
_Avoid_: Runtime profile, fallback mode

**Bound Account**:
The stable GitHub.com or GHES identity selected for one request and held unchanged for that request's lifetime.
_Avoid_: Current account, active login

**Responses History**:
The minimal durable history used by the Chat bridge to reconstruct calls referenced by a later Responses request.
_Avoid_: Session, conversation log

**Stream Execution**:
One live inference stream between a client and an upstream model.
_Avoid_: Session, resumable stream

**Admin Management Interface**:
The unauthenticated loopback management surface served by the listener root and `/admin/api/v1`; any local process that can connect may use it.
_Avoid_: Admin Session, browser authentication

**Semantic Checkpoint**:
A completed Responses output item whose minimal history is safe to commit durably.
_Avoid_: Chunk, packet

**Usage Bucket**:
A content-free aggregate of request, token, error, and latency measurements for one time period and dimension set.
_Avoid_: Raw telemetry, event log

**Operational Event**:
A sanitized diagnostic record of a gateway lifecycle transition or administrative action.
_Avoid_: Request log, audit body
