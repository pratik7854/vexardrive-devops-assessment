# VexarDrive Fleet Ping – Production Readiness Submission

This package is an implementation-ready baseline for the Fleet Ping Service assessment. The application repository itself was not supplied with the assessment brief, so application-specific findings are intentionally marked as validation items rather than asserted as facts.

## Contents

- `TECHNICAL_REPORT.md` — decisions, risks, operations, and assumptions
- `architecture.mmd` — Mermaid architecture diagram
- `infra/terraform` — Azure Container Apps production foundation
- `.github/workflows/ci-cd.yml` — test → build → scan → publish → deploy → verify workflow
- `Dockerfile` and `.dockerignore` — production container reference

## Applying this to the supplied service repository

Copy the root-level Docker and GitHub Actions files, then place `infra/terraform` in the service repository. Adapt the `CMD` only if the service's entry point is not `src/server.js`. Add the endpoints and graceful shutdown behaviour described in the report to the application before enabling the pipeline.

## Terraform usage

Terraform state must be stored in an encrypted remote backend (Azure Storage with private access and state locking). Do **not** commit `*.tfvars`, state, credentials, or generated plan files.

```sh
cd infra/terraform
cp environments/dev.tfvars.example environments/dev.tfvars
terraform init
terraform plan -var-file=environments/dev.tfvars
```

Use a separate subscription or resource group per environment. Bootstrap state storage separately, and deploy using GitHub Actions OpenID Connect rather than an Azure client secret.

## Validation before submission

1. Run application unit/integration tests and `npm audit --omit=dev`.
2. Build and run the image locally; exercise `/healthz` and `/readyz`.
3. Run `terraform fmt -check`, `terraform validate`, and a plan for each environment.
4. Configure GitHub environments: `development`, `staging`, and protected `production`.
5. Set repository variables (`AZURE_*`, `ACR_NAME`, `CONTAINER_APP_NAME`, `RESOURCE_GROUP`) and environment approvals.

