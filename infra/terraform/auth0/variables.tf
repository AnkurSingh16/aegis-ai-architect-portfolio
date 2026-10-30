variable "auth0_domain" {
  description = "Auth0 tenant domain without a scheme or path."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9.-]+$", var.auth0_domain)) && !strcontains(var.auth0_domain, "..")
    error_message = "auth0_domain must be a bare Auth0 tenant hostname."
  }
}

variable "database_connection_id" {
  description = "ID of the existing Auth0 database connection to enable for the new SPA."
  type        = string
  sensitive   = false

  validation {
    condition     = length(trimspace(var.database_connection_id)) > 0
    error_message = "database_connection_id must identify an existing database connection."
  }
}

variable "api_identifier" {
  description = "Unique JWT audience for the Aegis Case API."
  type        = string
  default     = "https://aegis-ai.local/api"

  validation {
    condition     = can(regex("^https://[^[:space:]]+$", var.api_identifier))
    error_message = "api_identifier must be an HTTPS URI without whitespace."
  }
}

variable "spa_name" {
  description = "Display name for the local Aegis browser application."
  type        = string
  default     = "Aegis AI Local SPA"
}
