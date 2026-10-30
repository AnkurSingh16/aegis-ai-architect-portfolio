resource "auth0_resource_server" "cases" {
  name             = "Aegis Case API"
  identifier       = var.api_identifier
  signing_alg      = "RS256"
  enforce_policies = false
}

resource "auth0_resource_server_scope" "read_cases" {
  resource_server_identifier = auth0_resource_server.cases.identifier
  scope                      = "read:cases"
  description                = "Read cases for an authorized tenant membership."
}

resource "auth0_resource_server_scope" "write_cases" {
  resource_server_identifier = auth0_resource_server.cases.identifier
  scope                      = "write:cases"
  description                = "Create and update cases for an authorized tenant membership."
}

resource "auth0_client" "local_spa" {
  name                = var.spa_name
  app_type            = "spa"
  oidc_conformant     = true
  is_first_party      = true
  grant_types         = ["authorization_code"]
  callbacks           = ["http://127.0.0.1:49321/auth/callback"]
  allowed_origins     = ["http://127.0.0.1:49321"]
  web_origins         = ["http://127.0.0.1:49321"]
  allowed_logout_urls = ["http://127.0.0.1:49321"]
}

# Singular resource appends this SPA to the selected connection without owning
# or replacing the connection's complete enabled-client list.
resource "auth0_connection_client" "local_spa_database" {
  connection_id = var.database_connection_id
  client_id     = auth0_client.local_spa.id
}
