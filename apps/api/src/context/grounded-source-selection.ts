import type { GroundedSource } from '../ai/grounded-analysis.js';
import { assembleContext, ContextBudgetError, type Passage } from './context-assembler.js';

/**
 * Source selection for grounded analysis, through the context assembler. Behind a feature flag that is OFF by default
 * (AEGIS_CONTEXT_ASSEMBLER=enabled turns it on). When the flag is off the route is byte-for-byte unchanged. When it is on,
 * the assembler decides which retrieved sources fit the budget, keeping the retrieval order, and drops the rest with a reason.
 * Pure. The budget values are PROVISIONAL development values, not calibrated against the model's context window.
 */
export const CONTEXT_ASSEMBLER_ENV = 'AEGIS_CONTEXT_ASSEMBLER' as const;

export interface ContextAssemblyOptions {
  readonly enabled: boolean;
  readonly budgetTokens: number;
  readonly reservedOutputTokens: number;
}

export const PROVISIONAL_CONTEXT_BUDGET = Object.freeze({ budgetTokens: 1500, reservedOutputTokens: 512 });

export function contextAssemblyFromEnv(env: NodeJS.ProcessEnv): ContextAssemblyOptions {
  return { enabled: env[CONTEXT_ASSEMBLER_ENV] === 'enabled', ...PROVISIONAL_CONTEXT_BUDGET };
}

export interface SourceSelection {
  readonly sources: readonly GroundedSource[];
  readonly dropped: readonly { readonly citationId: string; readonly reason: string }[];
  readonly tokenizer: string;
  readonly budgetTokens: number;
}

/**
 * Keeps the sources that fit, in their given (retrieval) order. If even the trusted instruction and question do not fit, no
 * source is selected: the caller then abstains rather than sending evidence the budget cannot hold.
 */
export function selectGroundedSources(sources: readonly GroundedSource[], question: string, options: Omit<ContextAssemblyOptions, 'enabled'>): SourceSelection {
  const passages: Passage[] = sources.map((source, index) => ({
    id: source.citationId, sourceId: source.sourceIdentity, text: source.content, priority: sources.length - index, score: 0,
  }));
  try {
    const assembled = assembleContext({
      instruction: 'Grounded case analysis over the evidence below.', question: question.trim().length > 0 ? question : 'case analysis',
      passages, history: [], budgetTokens: options.budgetTokens, reservedOutputTokens: options.reservedOutputTokens,
    });
    const included = new Set(assembled.includedPassageIds);
    return {
      sources: sources.filter((source) => included.has(source.citationId)),
      dropped: assembled.trace.filter((entry) => entry.kind === 'passage' && !entry.included)
        .map((entry) => ({ citationId: entry.ref, reason: entry.reason ?? 'over_budget' })),
      tokenizer: assembled.tokenizer, budgetTokens: options.budgetTokens,
    };
  } catch (error) {
    if (error instanceof ContextBudgetError) {
      return { sources: [], dropped: sources.map((source) => ({ citationId: source.citationId, reason: 'instruction_over_budget' })),
        tokenizer: 'approx-bytes-div-4', budgetTokens: options.budgetTokens };
    }
    throw error;
  }
}
