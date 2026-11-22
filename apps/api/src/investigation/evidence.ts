import type { TenantQueryable } from '../security/tool-approval-store.js';
import { retrieveDocumentChunks } from '../documents/retrieval.js';
import { evidenceRef, limits, type EvidenceBundle, type EvidenceItem } from './contracts.js';
import { isUnsafeExcerpt } from './review.js';

/**
 * The retrieval agent's evidence path. It reuses the existing tenant-scoped lexical retrieval (documents/retrieval.ts) under the
 * retrieval role's row level security. Every returned item is a real chunk of a real document row in the tenant. Nothing is generated.
 * Items whose text matches a prompt-injection marker are removed and counted, so the reviewer never sees them as evidence.
 *
 * Known limit recorded in docs/P8-INVESTIGATION-WORKFLOW.md: the lexical path has no paraphrase recall (C2 review, finding 3) and stops
 * at its context byte budget without reporting the cut (finding 1). The milestone reports a no-result answer rather than guessing.
 */
export async function retrieveEvidence(client: TenantQueryable, tenantId: string, query: string, topK: number): Promise<EvidenceBundle> {
  const k = Math.max(1, Math.min(limits.topK, topK));
  const chunks = await retrieveDocumentChunks(client as unknown as Parameters<typeof retrieveDocumentChunks>[0], tenantId, query);
  const items: EvidenceItem[] = [];
  let filteredUnsafe = 0;
  for (const chunk of chunks.slice(0, k)) {
    if (isUnsafeExcerpt(chunk.content)) { filteredUnsafe += 1; continue; }
    items.push({ ref: evidenceRef(chunk.sourceIdentity, chunk.version, chunk.position), sourceIdentity: chunk.sourceIdentity,
      version: chunk.version, position: chunk.position, title: chunk.title, excerpt: chunk.content.slice(0, limits.excerptChars),
      rank: chunk.rank });
  }
  return { status: items.length > 0 ? 'found' : 'insufficient', query, items, filteredUnsafe };
}
