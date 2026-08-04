output "container_app_fqdn" { value = azurerm_container_app.api.ingress[0].fqdn }
output "acr_login_server" { value = azurerm_container_registry.this.login_server }
