# LIVADAI Admin API (MVP / Phase 0-1)

## Security

Admin endpoints (`/admin/*`, session-based) require all conditions:

- authenticated user
- `role === "ADMIN"`
- user email included in `ADMIN_ALLOWED_EMAILS` (comma-separated env)

Example (Railway env):

`ADMIN_ALLOWED_EMAILS=admin@livadai.com,founder@livadai.com`

## Rate limit (basic)

In-memory rate limit is enabled for `/admin/*` session routes:

- `ADMIN_RATE_LIMIT_WINDOW_MS` (default `60000`)
- `ADMIN_RATE_LIMIT_MAX` (default `240`)

## Audit log

Collection: `admin_audit_logs`

Fields (MVP):

- `actorId`
- `actorEmail`
- `actionType`
- `targetType`
- `targetId`
- `reason`
- `diff`
- `ip`
- `userAgent`
- `createdAt`

## Endpoints (current)

### Overview / Dashboard

- `GET /admin/dashboard`
  - KPI counters (users, experiences, bookings, reports)

### Audit

- `GET /admin/audit-logs/recent?limit=12`
  - latest admin actions (topbar / quick monitoring)
- `GET /admin/audit-logs?q=&actionType=&targetType=&actorEmail=&from=&to=&page=&limit=`
  - full audit list with filters and diff/meta payloads

### Users

- `GET /admin/users?q=&role=&status=&page=&limit=`
- `GET /admin/users/:id`
  - user details + counts + recent entities (bookings/experiences/reports) + timeline + recent audit
- `PATCH /admin/users/:id`
  - body (partial): `role`, `isBlocked`, `isBanned`, `invalidateSessions`, `reason`
  - `reason` required for block/ban actions

### Experiences

- `GET /admin/experiences?q=&active=&status=&page=&limit=`
- `GET /admin/experiences/:id`
  - experience details + media preview data + counts + recent bookings/reports + timeline + recent audit
- `PATCH /admin/experiences/:id`
  - body (partial): `isActive`, `status`, `reason`
  - `reason` required for disable/cancel actions

### Bookings

- `GET /admin/bookings?q=&status=&paid=&hostId=&explorerId=&experienceId=&from=&to=&page=&limit=`
- `GET /admin/bookings/:id`
  - details + payments + reports + messages count
- `POST /admin/bookings/:id/cancel`
  - body: `reason` (required)
  - admin cancel workflow with optional Stripe refund attempt
- `POST /admin/bookings/:id/refund`
  - body: `reason` (required)
  - manual Stripe refund for refundable bookings

### Reports / Moderation

- `GET /admin/reports?q=&status=&type=&assigned=&from=&to=&page=&limit=`
  - `status=OPEN_INBOX` => `OPEN + INVESTIGATING`
  - `assigned=me|unassigned|all`
- `POST /admin/reports/:id/action`
  - body: `action`, optional `reason`, optional `note`
  - actions:
    - `ASSIGN_TO_ME`
    - `UNASSIGN`
    - `MARK_OPEN`
    - `MARK_INVESTIGATING`
    - `MARK_HANDLED`
    - `MARK_IGNORED`
    - `PAUSE_EXPERIENCE` (reason required)
    - `SUSPEND_USER` (reason required)

### Payments & Refunds

- `GET /admin/payments/health`
  - summary KPIs:
    - refund failed bookings
    - disputes
    - Stripe onboarding incomplete hosts
    - payout attention (eligible payout but host Stripe issues)
  - lists:
    - `refundFailedBookings`
    - `stripeOnboardingIncompleteHosts`
    - `payoutAttentionBookings`
    - `disputedPayments`

### System

- `GET /admin/system/health`
  - runtime info (node/env/uptime)
  - Mongo connection state/name/host
  - security config flags (`ADMIN_ALLOWED_EMAILS`, secrets, admin rate limit)
  - integrations config flags (Stripe, Cloudinary, Resend, SMTP)
  - web config (`ALLOWED_WEB_ORIGINS`)
  - ops attention counters (reports/refunds/disputes/stale payments/audit activity)

### Media Ops

- `GET /admin/media/stats`

## Next planned tabs

- `/admin/messages`
