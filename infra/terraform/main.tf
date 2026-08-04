locals { name = lower("${var.name_prefix}-${var.environment}") }

resource "azurerm_resource_group" "this" { name = "rg-${local.name}" location = var.location }

resource "azurerm_log_analytics_workspace" "this" {
  name = "law-${local.name}" location = var.location resource_group_name = azurerm_resource_group.this.name
  sku = "PerGB2018" retention_in_days = 30
}

resource "azurerm_container_app_environment" "this" {
  name = "cae-${local.name}" location = var.location resource_group_name = azurerm_resource_group.this.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.this.id
}

resource "azurerm_container_registry" "this" {
  name = replace("acr${local.name}", "-", "") location = var.location resource_group_name = azurerm_resource_group.this.name
  sku = "Standard" admin_enabled = false
}

resource "azurerm_user_assigned_identity" "app" { name = "id-${local.name}-api" location = var.location resource_group_name = azurerm_resource_group.this.name }

resource "azurerm_key_vault" "this" {
  name = "kv-${local.name}" location = var.location resource_group_name = azurerm_resource_group.this.name
  tenant_id = data.azurerm_client_config.current.tenant_id sku_name = "standard"
  enable_rbac_authorization = true purge_protection_enabled = true soft_delete_retention_days = 90
}

data "azurerm_client_config" "current" {}

resource "azurerm_role_assignment" "kv_secrets" {
  scope = azurerm_key_vault.this.id role_definition_name = "Key Vault Secrets User"
  principal_id = azurerm_user_assigned_identity.app.principal_id
}
resource "azurerm_role_assignment" "acr_pull" {
  scope = azurerm_container_registry.this.id role_definition_name = "AcrPull"
  principal_id = azurerm_user_assigned_identity.app.principal_id
}

resource "random_password" "postgres" { length = 32 special = true }
resource "azurerm_key_vault_secret" "postgres_password" { name = "postgres-admin-password" value = random_password.postgres.result key_vault_id = azurerm_key_vault.this.id }

resource "azurerm_postgresql_flexible_server" "this" {
  name = "psql-${local.name}" resource_group_name = azurerm_resource_group.this.name location = var.location
  version = var.postgres_version administrator_login = "pgadmin" administrator_password = random_password.postgres.result
  sku_name = var.postgres_sku storage_mb = 32768 backup_retention_days = 14 geo_redundant_backup_enabled = false
  authentication { password_auth_enabled = true }
}

resource "azurerm_container_app" "api" {
  name = "ca-${local.name}-api" resource_group_name = azurerm_resource_group.this.name container_app_environment_id = azurerm_container_app_environment.this.id
  revision_mode = "Single"
  identity { type = "UserAssigned" identity_ids = [azurerm_user_assigned_identity.app.id] }
  registry { server = azurerm_container_registry.this.login_server identity = azurerm_user_assigned_identity.app.id }
  secret { name = "db-password" identity = azurerm_user_assigned_identity.app.id keyvault_secret_id = azurerm_key_vault_secret.postgres_password.versionless_id }
  template {
    min_replicas = 2 max_replicas = 10
    container {
      name = "api" image = var.image cpu = 0.5 memory = "1Gi"
      env { name = "PORT" value = "8080" }
      env { name = "DB_PASSWORD" secret_name = "db-password" }
      liveness_probe { transport = "HTTP" port = 8080 path = "/healthz" initial_delay = 10 interval_seconds = 30 timeout = 3 failure_count_threshold = 3 }
      readiness_probe { transport = "HTTP" port = 8080 path = "/readyz" initial_delay = 5 interval_seconds = 10 timeout = 3 failure_count_threshold = 3 }
    }
    http_scale_rule { name = "http" concurrent_requests = 50 }
  }
  ingress { external_enabled = true target_port = 8080 transport = "http" traffic_weight { percentage = 100 latest_revision = true } }
}
