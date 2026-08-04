# Fleet Ping Service: production-readiness report

## Executive summary

I would run this workload on Azure Container Apps (ACA) with Azure Database for PostgreSQL Flexible Server, Key Vault, Container Registry, and Azure Monitor. ACA is the right initial trade-off: the service is a stateless HTTP ingestion API, does not demonstrate a requirement for Kubernetes primitives, and benefits from revision-based releases and HTTP autoscaling without the operational cost of AKS. AKS becomes appropriate only when there is a demonstrated need for complex scheduling, custom networking controls unavailable in ACA, or a broader platform already operated by a capable SRE team.

The supplied brief did not contain the starter service repository. Therefore I cannot truthfully claim code-specific defects or test the resulting image. This submission supplies the production baseline and a precise review checklist; findings marked **Validate** must be confirmed against the repository before submission.

## Initial assessment and priority

| Priority | Finding / validation | Risk and required action |
|---|---|---|
| P0 | **Validate** secrets in `.env`, Compose, GitHub workflow, history, and Docker build context | Credential disclosure. Remove, rotate exposed values, use Key Vault and GitHub OIDC; add secret scanning. |
| P0 | **Validate** authentication/authorisation of ping and driver-login endpoints | Spoofed locations or account compromise. Verify issuer/audience/signature/expiry, rate-limit login, and authorize vehicle-to-driver scope. |
| P0 | **Validate** SQL parameterisation and database role | Injection and destructive access. Parameterize every query and use a non-owner runtime role. |
| P1 | **Validate** request schemas, body-size limits, coordinate bounds, timestamp handling and idempotency | Unbounded payloads, corrupt telemetry, duplicate pings. Add schema validation, a small body limit, UTC, and a client event ID with a unique constraint. |
| P1 | **Validate** database pooling, timeouts, retries and graceful shutdown | Connection exhaustion or lost writes during deploys. Set pool cap per replica, connect/query/statement timeouts, bounded retries only for transient errors, and drain on `SIGTERM`. |
| P1 | **Validate** dependency age, lockfile, npm scripts and tests | Known vulnerabilities or non-reproducible builds. Pin supported Node LTS, commit lockfile, run `npm ci`, audit and renovate. |
| P1 | **Validate** error handler, logging and health endpoints | Leaked internals and opaque incidents. Return safe errors; write structured JSON with correlation IDs; add endpoints below. |
| P2 | **Validate** indexes and retention | Ping volume can make latest-location and history queries degrade. Index `(vehicle_id, recorded_at DESC)`, partition/retain historic data based on product needs. |

## Implemented baseline and rationale

`Dockerfile` uses a pinned Node base, deterministic production-only dependency installation, a non-root user, a minimal runtime stage, and an application health check. `.dockerignore` prevents secrets, VCS data, dependencies and Terraform state reaching the Docker build context. The application must listen on `0.0.0.0:$PORT`; the entrypoint should be changed only if the actual service uses a different file.

The Terraform baseline creates a resource group, Log Analytics, ACA environment, ACR, Key Vault with RBAC, a user-assigned managed identity, PostgreSQL Flexible Server, and an ACA service with two minimum replicas, HTTP autoscaling, Key Vault secret reference, ACR pull through managed identity, and liveness/readiness probes. It is deliberately non-deployed and has no credentials checked in.

For a real production apply, I would extend the Terraform with hub/spoke VNet integration, a delegated PostgreSQL subnet, private DNS zones, a Key Vault private endpoint, and Azure Front Door Premium/WAF. The included compact Terraform is a readable service baseline; private networking requires organization-specific IP ranges, hub DNS/Firewall ownership and subscription policy decisions that cannot responsibly be invented here. The desired boundary is shown in the architecture diagram: PostgreSQL and Key Vault have no public ingress; only Front Door is Internet facing; ACA receives client traffic only through Front Door/WAF; ACA reaches private services over TLS and private DNS.

## Health, readiness and runtime behaviour

- `GET /healthz`: returns 200 when the process event loop is live. It never calls the database.
- `GET /readyz`: returns 200 only after configuration has loaded and a bounded `SELECT 1` database check succeeds; otherwise 503.
- On `SIGTERM`, stop accepting new connections, mark readiness false, wait a bounded period for in-flight requests, close the PostgreSQL pool, then exit. ACA gives the process its termination grace period.
- Emit JSON logs to stdout: timestamp, level, event, request/correlation ID, route, status, duration, vehicle ID hashed or redacted, and error classification. Do not log passwords, tokens, raw authorization headers, or precise location payloads unless justified by policy.

## CI/CD and release control

The workflow demonstrates `test → build → scan → containerize → deploy → verify`. Pull requests run tests, linting, dependency audit, and filesystem scanning. Main/tag pushes build an immutable SHA-tagged image, scan the image, publish it to ACR, deploy it, and call `/readyz`. Authentication uses GitHub Actions OIDC; GitHub environment-scoped variables hold only identifiers, never secrets.

Development deploys from `main`; staging deploys an immutable candidate after integration tests; production deploys only a signed/reviewed version tag through a protected GitHub environment with named approvers and change-ticket evidence. Retain the previous ACA revision until soak verification completes. On verification failure, the workflow activates the prior revision; alerts should also create an incident. Use a migration job before a backward-compatible release, and never auto-rollback a database migration that may destroy data.

## Database operations

Use PostgreSQL Flexible Server private access, zone-redundant HA for production, at least 14 days retention initially, and geo-redundant backups for the production RPO/RTO requirement. Test point-in-time restore quarterly into an isolated recovery resource group and document actual recovery times. Backup success alone is not proof of recoverability.

The application runtime account gets only `CONNECT`, schema `USAGE`, and the exact DML privileges required. Schema migrations use a separate short-lived CI identity/account and are serialized. Migrations must be forward-compatible: expand schema, deploy code that handles both forms, backfill in throttled batches, then contract later. Cap the node `pg` pool (for example 10 connections per replica) and ensure ACA maximum replicas times pool size remains below the database connection budget; introduce PgBouncer when replicas/traffic require it.

As ingestion grows, batch writes where latency permits, use idempotency keys, partition ping history by time, maintain a compact latest-location table, and apply retention/archive policy. Consider a queue only after measurements show database write bursts cannot be economically absorbed; it introduces ordering, replay, and operational complexity.

## Security, identity and network model

Key Vault is the secret source of truth. ACA uses a user-assigned managed identity granted only `Key Vault Secrets User` and `AcrPull`; the deployment identity receives narrowly scoped contributor rights to the target resource group and `AcrPush` at the registry. OIDC federated credentials eliminate an Azure client secret in GitHub. Separate identities, vaults, registries, and resource groups/subscriptions by environment.

TLS terminates at Front Door and is re-encrypted to ACA. WAF rate limits and filters requests; application-level rate limiting remains necessary for login. PostgreSQL uses TLS enforcement, private access and a dedicated delegated subnet. Key Vault uses private endpoint and private DNS. NSGs/Udrs are constrained to required flows, with diagnostics enabled. Protect admin/break-glass access with MFA/PIM and audit logs.

## Monitoring and alerts

Send ACA system logs, application JSON logs, PostgreSQL diagnostics and Application Insights telemetry to a central Log Analytics workspace. Build dashboards for request volume, p50/p95/p99 latency, 4xx/5xx rate, accepted/rejected pings, login failures, container revision/restarts, CPU/memory, pool utilization, database CPU/storage/connections, and replication/backup events.

| Alert | Trigger | Operational meaning |
|---|---|---|
| API availability | 5xx rate > 2% for 10 minutes or synthetic check fails twice | Clients cannot reliably submit locations. |
| Latency | p95 ping latency exceeds the SLO (e.g. 500 ms) for 15 minutes | Service is degrading before it becomes unavailable. |
| Readiness/restarts | no ready replicas for 5 minutes, or restart spike after a release | Bad revision, dependency outage, or resource issue. |
| Database saturation | CPU > 80%, connections > 80%, storage > 80%, or replication/backup issue | Protects ingestion and gives capacity lead time. |
| Authentication abuse | login failures or 401/429s exceed baselined rate | Credential stuffing or a client defect. |
| Telemetry freshness | no accepted pings for a fleet/region beyond expected interval | Detects silent client or route failure even if the API is up. |

Use severity based on user impact, route critical alerts to an on-call service, and attach runbooks with dashboard links. Review noisy thresholds monthly.

## Assumptions, limitations, cost and next work

Assumptions: Internet-connected vehicles submit HTTPS requests; traffic is initially moderate and stateless; one region is acceptable; no Azure subscription was available for a live deployment. Costs are controlled with ACA consumption autoscaling (minimum two replicas only for production), PostgreSQL burstable/General Purpose sizing based on measurements, 30-day hot logs with archive policy, and no AKS control plane or always-on worker fleet. Production HA, Front Door Premium, private endpoints, geo-backups and Log Analytics ingestion are deliberate reliability/security costs; validate them against the business RPO/RTO and data classification.

I would next: inspect and harden the actual endpoint code; write integration/load tests; complete organization-specific private networking Terraform; add Azure Policy, Defender image scanning and SBOM/signing; load-test with realistic ping bursts; establish SLOs; exercise restore and rollback; and run a threat model covering vehicle credential provisioning and location-data privacy.

## AI use disclosure

AI assistance was used to draft this infrastructure/documentation baseline. Before submission, the candidate must inspect the real repository, run the listed validation commands, review every generated line, and adjust claims to observed behaviour.
