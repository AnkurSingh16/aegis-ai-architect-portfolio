output "issuer" {
  description = "Public Auth0 issuer URL for API configuration."
  value       = "https://${var.auth0_domain}/"
}

output "audience" {
  description = "Public API identifier and expected access-token audience."
  value       = auth0_resource_server.cases.identifier
}

output "spa_client_id" {
  description = "Public client ID for the local Authorization Code + PKCE SPA."
  value       = auth0_client.local_spa.id
}
