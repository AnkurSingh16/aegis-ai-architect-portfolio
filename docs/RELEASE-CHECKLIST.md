# Pre-merge & release checklist

- [ ] Human-approved scope with clear acceptance criteria
- [ ] Architect and challenger review for meaningful design changes
- [ ] `git diff` inspected; no credentials, environment files, secrets or sensitive data
- [ ] `npm run lint` and `npm run typecheck` both pass
- [ ] `npm run test:coverage` passes; HTML reports reviewed; missing risks logged
- [ ] `npm run build` passes
- [ ] Changed endpoint contracts documented and tested; negative/security cases included
- [ ] GitHub pull request opened from feature branch; CI all green
- [ ] Reviewer approves merge; avoid direct main pushes
- [ ] No production demo endpoint without authorization and tenant isolation
- [ ] No deployment/`terraform apply` without user approval, cost estimate and rollback plan
