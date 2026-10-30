terraform {
  required_version = ">= 1.9.0, < 2.0.0"

  cloud {
    organization = "aegis-ai-portfolio"

    workspaces {
      name = "aegis-auth0-dev"
    }
  }

  required_providers {
    auth0 = {
      source  = "auth0/auth0"
      version = "= 1.59.0"
    }
  }
}

provider "auth0" {
  domain = var.auth0_domain
}
