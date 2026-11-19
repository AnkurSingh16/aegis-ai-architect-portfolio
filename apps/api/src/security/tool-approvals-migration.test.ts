import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { migrationsDirectory } from '../storage/migrations.js';

/** Static checks on migration 007. Real-database verification runs separately when TEST_DATABASE_URL is set. */
describe('tool approvals migration 007 (static)', () => {
  it('is additive: creates a new table and does not drop or alter existing objects', async () => {
    const sql = await readFile(new URL('007_tool_approvals.sql', migrationsDirectory), 'utf8');
    expect(sql).toContain('CREATE TABLE aegis.tool_approvals');
    const code = sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
    expect(code).not.toMatch(/\bDROP\b|\bTRUNCATE\b|ALTER TABLE aegis\.(support_cases|case_reviews|memberships|documents)/i);
  });

  it('enables and forces row-level security with tenant-scoped policies', async () => {
    const sql = await readFile(new URL('007_tool_approvals.sql', migrationsDirectory), 'utf8');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql.match(/aegis\.tenant_id/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('grants the application role only the columns the store needs and restricts updates by trigger', async () => {
    const sql = await readFile(new URL('007_tool_approvals.sql', migrationsDirectory), 'utf8');
    expect(sql).toContain('GRANT UPDATE (status, approved_by, decided_at, consumed_at)');
    expect(sql).toContain('CREATE TRIGGER tool_approval_transition');
    expect(sql).toContain("('pending', 'approved'), ('pending', 'rejected'), ('approved', 'consumed')");
  });

  it('keeps self-approval impossible at the schema level', async () => {
    const sql = await readFile(new URL('007_tool_approvals.sql', migrationsDirectory), 'utf8');
    expect(sql).toContain('CHECK (approved_by IS NULL OR approved_by <> requested_by)');
  });
});
