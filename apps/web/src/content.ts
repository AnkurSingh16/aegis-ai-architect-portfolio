export const portfolioProjects = [
  {
    tag: 'AI PLATFORM · IN PROGRESS',
    title: 'Aegis AI',
    summary: 'An enterprise customer-operations copilot designed for security, auditability, retrieval grounding and human-approved actions.',
    capabilities: ['Node.js / TypeScript', 'React', 'RAG architecture', 'Human approval'],
  },
  {
    tag: 'ARCHITECTURE · PLANNED',
    title: 'Identity & Access',
    summary: 'A reference case study exploring CIAM, OIDC, authorization, tenant separation and secure migration patterns.',
    capabilities: ['Auth0 / OAuth2', 'JWT validation', 'Terraform', 'Observability'],
  },
  {
    tag: 'PLATFORM · PLANNED',
    title: 'Engineering Excellence',
    summary: 'Demonstrable delivery engineering: CI/CD, quality gates, deterministic evaluation, SLOs and operational readiness.',
    capabilities: ['GitHub Actions', 'Testing', 'Cost control', 'SRE practices'],
  },
] as const;
