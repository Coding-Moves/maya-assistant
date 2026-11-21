# Reliable processing lifecycle

This document is the implementation contract for issues #27 and #28. It is
deliberately separate from the current group-media queue: a queued media row
is useful, but it is not yet a complete, observable lifecycle for every owner
message and integration action.

## One logical request

Every inbound WhatsApp message and externally requested action will receive:

- a stable `idempotency_key`, derived from the WhatsApp account, chat JID and
  platform message ID (or a source-specific stable identifier);
- a random `correlation_id` for logs and child integration calls;
- a persisted job record with only metadata and references. Credentials,
  unbounded message content and media bytes do not belong in lifecycle logs.

Receiving the same delivery again must return the existing job instead of
creating another final reply, task, reminder, Calendar write, or upload.

## States

Jobs move only through this state machine:

```text
received -> validated -> queued -> processing -> completed
                                  |       |
                                  |       +-> waiting_integration
                                  |                |
                                  |                +-> processing
                                  v
                               retrying -> queued
                                  |
                                  +-> failed | cancelled
```

`waiting_integration` means an explicit external dependency is being checked.
`failed` is terminal and keeps a sanitized reason/category. `cancelled` is
terminal and means work was deliberately stopped before an external side
effect. A worker may claim only queued/retry-due work atomically; a stale
`processing` lease is recovered to `retrying` after its lease expires.

## Retry and uncertain outcomes

Read-only operations use bounded exponential backoff: 1 minute, 5 minutes,
then 30 minutes; after the third failed attempt they enter a dead-letter
terminal state. Oversize, unsupported, malformed and permission-denied media
are terminal immediately and receive a specific private explanation.

An action that can change external state—Calendar write or future NFC upload—
must have a stable reconciliation key. A timeout after the request was sent is
`unknown`, not a reason to retry. Maya first queries authoritative evidence;
only an absent side effect may be retried. A final WhatsApp response is stored
atomically before/with the delivery reservation so retries cannot send a second
final answer.

## Capability registry

Each integration reports distinct fields, never one vague “connected” flag:

| Field | Meaning |
| --- | --- |
| enabled | The deployment and owner settings allow this operation. |
| configured | Required non-secret settings and secret references exist. |
| authenticated | A credential/session was recently accepted. |
| reachable | The provider was reached during the last attempt. |
| paused | The owner disabled source checks. |
| last_success_at | Timestamp of authoritative successful work. |
| last_failure | Sanitized category only: auth, timeout, rate_limit, malformed, permission, unknown. |

Maya must answer capability questions from this registry. No result is
different from a failed or stale result: a failed LMS check must never become
“no assignments”.

## Media policy

Owner voice, image, video, document and text-file requests must use the same
durable lifecycle as text after type/size validation. Short accepted media is
acknowledged privately, then produces one final answer. Transcripts and media
descriptions are untrusted data linked to the original chat/message ID. Group
media continues to be read-only and cannot invoke owner tools or alter policy.

Temporary bytes are removed after processing or terminal failure. The retained
job record contains only metadata, lifecycle timestamps and sanitized error
category.

## Required tests before implementation PR closes #27/#28

1. Duplicate WhatsApp deliveries create one job and one final reply.
2. A crash before and after a worker claim recovers safely from a lease.
3. Timeout/rate-limit retry timing is bounded; malformed/oversize media does
   not retry.
4. A message sent while voice processing runs remains ordered and does not
   inherit the wrong context.
5. Empty successful portal result, failed portal query, paused source and
   expired authentication produce different user-facing outcomes.
6. A simulated uncertain external write is reconciled before a retry.
7. Correlation IDs trace receipt, integration call and final outcome without
   putting a credential, prompt or raw private payload in logs.
8. English, Urdu and Roman Urdu voice transcripts enter the same verified-owner
   command/context path as text; an empty or low-confidence transcript asks
   for clarification rather than acting.
