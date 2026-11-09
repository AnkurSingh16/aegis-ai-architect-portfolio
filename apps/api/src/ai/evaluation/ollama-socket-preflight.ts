export interface OllamaTcpRecord {
  pid: number;
  command: string;
  name: string;
  state?: string;
}

/** Parse lsof -FpcnT output, retaining its explicit TCP state field. */
export function parseOllamaTcpRecords(output: string): OllamaTcpRecord[] {
  const records: OllamaTcpRecord[] = [];
  let pid = 0;
  let command = '';
  let current: OllamaTcpRecord | undefined;
  let sawFile = false;
  let sawCommand = false;
  let sawQueueReceive = false;
  let sawQueueSend = false;
  const finishCurrent = (): void => {
    if (current && (!current.name || !current.state)) throw new Error('Ollama TCP socket metadata is incomplete or unsupported.');
  };
  for (const line of output.split('\n')) {
    if (line === '') continue;
    if (/^p\d+$/.test(line)) {
      finishCurrent();
      if (pid !== 0 && !sawFile) throw new Error('Ollama TCP socket metadata is incomplete or unsupported.');
      pid = Number(line.slice(1));
      command = '';
      sawCommand = false;
      sawFile = false;
      current = undefined;
    } else if (/^c\S.*$/.test(line) && pid > 0 && !sawCommand && !current) {
      command = line.slice(1);
      sawCommand = true;
    } else if (/^f\S+$/.test(line) && pid > 0 && sawCommand) {
      finishCurrent();
      current = { pid, command, name: '' };
      records.push(current);
      sawFile = true;
      sawQueueReceive = false;
      sawQueueSend = false;
    } else if (/^n\S.*$/.test(line) && current && current.name.length === 0) {
      current.name = line.slice(1);
    } else if (/^TST=\S+$/.test(line) && current && current.state === undefined) {
      current.state = line.slice(4);
    } else if (/^TQR=\d+$/.test(line) && current && !sawQueueReceive) {
      sawQueueReceive = true;
    } else if (/^TQS=\d+$/.test(line) && current && !sawQueueSend) {
      sawQueueSend = true;
    } else {
      throw new Error('Ollama TCP socket metadata is incomplete or unsupported.');
    }
  }
  finishCurrent();
  if (pid !== 0 && !sawFile) throw new Error('Ollama TCP socket metadata is incomplete or unsupported.');
  return records;
}

/** Fail closed unless Ollama is loopback-only and no other client is connected. */
export function assertSafeOllamaTcpRecords(records: readonly OllamaTcpRecord[], currentPid: number): void {
  if (records.length === 0 || records.some((record) => !Number.isSafeInteger(record.pid) || record.pid <= 0 ||
      record.command.length === 0 || record.name.length === 0 || !['LISTEN', 'ESTABLISHED'].includes(record.state ?? ''))) {
    throw new Error('Ollama TCP socket metadata is incomplete or unsupported.');
  }
  const listeners = records.filter((record) => record.state === 'LISTEN');
  if (listeners.length !== 1 || listeners[0]?.name !== '127.0.0.1:11434' || listeners[0]?.command !== 'ollama') {
    throw new Error('Ollama is not bound exclusively to the approved loopback endpoint.');
  }
  const listenerPid = listeners[0].pid;
  const established = records.filter((record) => record.state === 'ESTABLISHED');
  const clientPort = (name: string): string | undefined => {
    const port = name.match(/^127\.0\.0\.1:(\d+)->127\.0\.0\.1:11434$/)?.[1];
    return port !== undefined && Number(port) >= 1 && Number(port) <= 65535 ? port : undefined;
  };
  const serverPort = (name: string): string | undefined => {
    const port = name.match(/^127\.0\.0\.1:11434->127\.0\.0\.1:(\d+)$/)?.[1];
    return port !== undefined && Number(port) >= 1 && Number(port) <= 65535 ? port : undefined;
  };
  const ownClientEndpoints = new Set(established.filter((record) => record.pid === currentPid && clientPort(record.name) !== undefined)
    .map((record) => record.name));
  for (const record of established) {
    const peerPort = serverPort(record.name);
    const localPort = clientPort(record.name);
    const isOllamaServerSide = peerPort !== undefined;
    const isClientSide = localPort !== undefined;
    if (!isClientSide && !isOllamaServerSide) {
      throw new Error('Another Ollama client is connected; concurrent generation cannot be ruled out.');
    }
    if (isClientSide && record.pid !== currentPid) {
      throw new Error('Another Ollama client is connected; concurrent generation cannot be ruled out.');
    }
    if (isOllamaServerSide) {
      const matchingOwn = peerPort !== undefined && ownClientEndpoints.has(`127.0.0.1:${peerPort}->127.0.0.1:11434`);
      if (!matchingOwn || record.command !== 'ollama' || record.pid !== listenerPid) {
        throw new Error('Another Ollama client is connected; concurrent generation cannot be ruled out.');
      }
    }
  }
}
