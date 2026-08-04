variable "environment" { type = string }
variable "location" { type = string }
variable "name_prefix" { type = string }
variable "postgres_sku" { type = string  default = "B_Standard_B2s" }
variable "postgres_version" { type = string default = "16" }
variable "image" { type = string default = "mcr.microsoft.com/azuredocs/containerapps-helloworld:latest" }
variable "allowed_ingress_cidrs" { type = list(string) default = [] }
