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

### Users

- `GET /admin/users?q=&role=&status=&page=&limit=`
- `PATCH /admin/users/:id`
  - body (partial): `role`, `isBlocked`, `isBanned`, `invalidateSessions`, `reason`
  - `reason` required for block/ban actions

### Experiences

- `GET /admin/experiences?q=&active=&status=&page=&limit=`
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

### Media Ops

- `GET /admin/media/stats`

## Next planned tabs

- `/admin/reports`
- `/admin/payments`
- audit log full table + filters
