import { CaseStorageError, validateCaseId, validateStatus, validateSyntheticCase, type CaseRepository } from './cases.js';

export type CaseCommand =
  | { command: 'list' }
  | { command: 'create'; syntheticCase: string }
  | { command: 'read' | 'audit' | 'triage'; id: string }
  | { command: 'update'; id: string; status: string };

/** No tenant flags, arbitrary SQL, customer text or additional arguments are accepted. */
export function parseCaseCommand(args: string[]): CaseCommand {
  const [command, first, second] = args;
  if (command === 'list' && args.length === 1) return { command };
  if (command === 'create' && args.length === 2) return { command, syntheticCase: validateSyntheticCase(first) };
  if ((command === 'read' || command === 'audit' || command === 'triage') && args.length === 2) {
    return { command, id: validateCaseId(first) };
  }
  if (command === 'update' && args.length === 3) return { command, id: validateCaseId(first), status: validateStatus(second) };
  throw new CaseStorageError('invalid_input');
}

export async function executeCaseCommand(repository: CaseRepository, command: CaseCommand): Promise<unknown> {
  switch (command.command) {
    case 'list': return repository.list();
    case 'create': return repository.create(command.syntheticCase);
    case 'read': return repository.read(command.id);
    case 'update': return repository.update(command.id, command.status);
    case 'audit': return repository.audit(command.id);
    case 'triage': return repository.triage(command.id);
  }
}
