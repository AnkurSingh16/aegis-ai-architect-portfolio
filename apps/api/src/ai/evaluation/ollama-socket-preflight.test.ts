import { describe, expect, it } from 'vitest';
import { assertSafeOllamaTcpRecords, parseOllamaTcpRecords } from './ollama-socket-preflight.js';

const listener = { pid: 44786, command: 'ollama', name: '127.0.0.1:11434', state: 'LISTEN' } as const;
const closed = (overrides: Record<string, unknown> = {}) => ({ pid: 44786, command: 'ollama',
  name: '127.0.0.1:11434->127.0.0.1:56259', state: 'CLOSED', queueReceiveBytes: 0, queueSendBytes: 0, ...overrides });

describe('Ollama socket preflight', () => {
  it('reads the explicit lsof TCP state and accepts only loopback listener', () => {
    const records = parseOllamaTcpRecords('p44786\ncollama\nf4\nn127.0.0.1:11434\nTST=LISTEN\nTQR=0\nTQS=0\n');
    expect(records).toEqual([{ pid: 44786, command: 'ollama', name: '127.0.0.1:11434', state: 'LISTEN',
      queueReceiveBytes: 0, queueSendBytes: 0 }]);
    expect(() => assertSafeOllamaTcpRecords(records, 100)).not.toThrow();
  });

  it('accepts an Ollama-owned CLOSED server socket only with the observed complete loopback metadata', () => {
    const records = parseOllamaTcpRecords('p44786\ncollama\nf4\nn127.0.0.1:11434\nTST=LISTEN\nTQR=0\nTQS=0\n' +
      'f7\nn127.0.0.1:11434->127.0.0.1:56259\nTST=CLOSED\nTQR=0\nTQS=0\n');
    expect(records).toContainEqual(expect.objectContaining({ pid: 44786, command: 'ollama',
      name: '127.0.0.1:11434->127.0.0.1:56259', state: 'CLOSED', queueReceiveBytes: 0, queueSendBytes: 0 }));
    expect(() => assertSafeOllamaTcpRecords(records, 100)).not.toThrow();
  });

  it('accepts multiple valid CLOSED records owned by the approved listener', () => {
    expect(() => assertSafeOllamaTcpRecords([listener, closed(),
      closed({ name: '127.0.0.1:11434->127.0.0.1:56260' }),
      closed({ name: '127.0.0.1:11434->127.0.0.1:59198' })], 100)).not.toThrow();
  });

  it('rejects CLOSED records from a foreign process or a different Ollama PID', () => {
    expect(() => assertSafeOllamaTcpRecords([listener, closed({ pid: 300, command: 'browser' })], 100))
      .toThrow('Ollama TCP socket metadata is incomplete or unsupported.');
    expect(() => assertSafeOllamaTcpRecords([listener, closed({ pid: 44787 })], 100))
      .toThrow('Ollama TCP socket metadata is incomplete or unsupported.');
  });

  it('rejects non-loopback, client-side, and unknown CLOSED endpoint forms', () => {
    for (const name of ['0.0.0.0:11434->127.0.0.1:56259', '127.0.0.1:56259->127.0.0.1:11434',
      '127.0.0.1:11434->localhost:56259', '127.0.0.1:11434->127.0.0.2:56259', 'unexpected']) {
      expect(() => assertSafeOllamaTcpRecords([listener, closed({ name })], 100))
        .toThrow('Ollama TCP socket metadata is incomplete or unsupported.');
    }
  });

  it('rejects malformed or out-of-range CLOSED peer ports', () => {
    for (const port of ['0', '65536', 'not-a-port', '']) {
      expect(() => assertSafeOllamaTcpRecords([listener, closed({ name: `127.0.0.1:11434->127.0.0.1:${port}` })], 100))
        .toThrow('Ollama TCP socket metadata is incomplete or unsupported.');
    }
  });

  it('rejects CLOSED records without complete queue metadata or state', () => {
    expect(() => assertSafeOllamaTcpRecords([listener, closed({ queueReceiveBytes: undefined })], 100))
      .toThrow('Ollama TCP socket metadata is incomplete or unsupported.');
    expect(() => assertSafeOllamaTcpRecords([listener, closed({ queueSendBytes: Number.NaN })], 100))
      .toThrow('Ollama TCP socket metadata is incomplete or unsupported.');
    expect(() => assertSafeOllamaTcpRecords([listener, { ...closed(), state: undefined }], 100))
      .toThrow('Ollama TCP socket metadata is incomplete or unsupported.');
  });

  it('rejects unsupported states and incomplete CLOSED lsof fields', () => {
    expect(() => assertSafeOllamaTcpRecords([listener, { ...closed(), state: 'TIME_WAIT' }], 100))
      .toThrow('Ollama TCP socket metadata is incomplete or unsupported.');
    const incomplete = parseOllamaTcpRecords('p44786\ncollama\nf4\nn127.0.0.1:11434\nTST=LISTEN\n' +
      'f7\nn127.0.0.1:11434->127.0.0.1:56259\nTST=CLOSED\n');
    expect(() => assertSafeOllamaTcpRecords(incomplete, 100))
      .toThrow('Ollama TCP socket metadata is incomplete or unsupported.');
  });

  it('rejects an external established client even when CLOSED records are valid', () => {
    const records = [listener, closed(),
      { pid: 76236, command: 'node', name: '127.0.0.1:58406->127.0.0.1:11434', state: 'ESTABLISHED' },
      { pid: 44786, command: 'ollama', name: '127.0.0.1:11434->127.0.0.1:58406', state: 'ESTABLISHED' }];
    expect(() => assertSafeOllamaTcpRecords(records, 100))
      .toThrow('Another Ollama client is connected; concurrent generation cannot be ruled out.');
  });

  it('rejects an external CLOSE_WAIT client even when CLOSED records are valid', () => {
    expect(() => assertSafeOllamaTcpRecords([listener, closed(),
      { pid: 76236, command: 'node', name: '127.0.0.1:58406->127.0.0.1:11434', state: 'CLOSE_WAIT' }], 100))
      .toThrow('Another Ollama client is connected; concurrent generation cannot be ruled out.');
  });

  it('fails closed when the TCP state field is missing', () => {
    expect(() => parseOllamaTcpRecords('p44786\ncollama\nf4\nn127.0.0.1:11434\n'))
      .toThrow('Ollama TCP socket metadata is incomplete or unsupported.');
  });

  it('rejects unknown, duplicate, and incomplete lsof fields', () => {
    expect(() => parseOllamaTcpRecords('p44786\ncollama\nf4\nn127.0.0.1:11434\nTST=LISTEN\nX=unexpected\n'))
      .toThrow('Ollama TCP socket metadata is incomplete or unsupported.');
    expect(() => parseOllamaTcpRecords('p44786\ncollama\nf4\nn127.0.0.1:11434\nn127.0.0.1:11434\nTST=LISTEN\n'))
      .toThrow('Ollama TCP socket metadata is incomplete or unsupported.');
    expect(() => parseOllamaTcpRecords('p44786\ncollama\nf4\nTST=LISTEN\n'))
      .toThrow('Ollama TCP socket metadata is incomplete or unsupported.');
    expect(() => parseOllamaTcpRecords('p44786\ncollama\n'))
      .toThrow('Ollama TCP socket metadata is incomplete or unsupported.');
  });

  it('fails closed on malformed process and TCP state metadata', () => {
    expect(() => assertSafeOllamaTcpRecords([{ pid: Number.NaN, command: 'ollama', name: '127.0.0.1:11434', state: 'LISTEN' }], 100))
      .toThrow('Ollama TCP socket metadata is incomplete or unsupported.');
    expect(() => assertSafeOllamaTcpRecords([listener, { pid: 1, command: 'ollama', name: '127.0.0.1:11434', state: 'UNKNOWN' }], 100))
      .toThrow('Ollama TCP socket metadata is incomplete or unsupported.');
  });

  it('rejects a listener on any non-approved interface', () => {
    const records = parseOllamaTcpRecords('p44786\ncollama\nf4\nn*:11434\nTST=LISTEN\n');
    expect(() => assertSafeOllamaTcpRecords(records, 100)).toThrow('Ollama is not bound exclusively to the approved loopback endpoint.');
  });

  it('rejects duplicate loopback listeners', () => {
    const records = parseOllamaTcpRecords('p44786\ncollama\nf4\nn127.0.0.1:11434\nTST=LISTEN\np44787\ncollama\nf4\nn127.0.0.1:11434\nTST=LISTEN\n');
    expect(() => assertSafeOllamaTcpRecords(records, 100)).toThrow('Ollama is not bound exclusively to the approved loopback endpoint.');
  });

  it('rejects an established connection owned by another client', () => {
    const records = parseOllamaTcpRecords('p44786\ncollama\nf4\nn127.0.0.1:11434\nTST=LISTEN\np300\ncbrowser\nf5\nn127.0.0.1:50000->127.0.0.1:11434\nTST=ESTABLISHED\n');
    expect(() => assertSafeOllamaTcpRecords(records, 100)).toThrow('Another Ollama client is connected; concurrent generation cannot be ruled out.');
  });

  it('rejects an unrecognized established endpoint shape', () => {
    const records = [
      { pid: 44786, command: 'ollama', name: '127.0.0.1:11434', state: 'LISTEN' },
      { pid: 300, command: 'browser', name: 'unexpected', state: 'ESTABLISHED' },
    ];
    expect(() => assertSafeOllamaTcpRecords(records, 100)).toThrow('Another Ollama client is connected; concurrent generation cannot be ruled out.');
  });

  it('rejects an Ollama server-side connection owned by a different process', () => {
    const records = [
      { pid: 44786, command: 'ollama', name: '127.0.0.1:11434', state: 'LISTEN' },
      { pid: 44787, command: 'ollama', name: '127.0.0.1:11434->127.0.0.1:50000', state: 'ESTABLISHED' },
      { pid: 100, command: 'node', name: '127.0.0.1:50000->127.0.0.1:11434', state: 'ESTABLISHED' },
    ];
    expect(() => assertSafeOllamaTcpRecords(records, 100)).toThrow('Another Ollama client is connected; concurrent generation cannot be ruled out.');
  });

  it('rejects established endpoints with out-of-range peer ports', () => {
    const records = [
      { pid: 44786, command: 'ollama', name: '127.0.0.1:11434', state: 'LISTEN' },
      { pid: 100, command: 'node', name: '127.0.0.1:70000->127.0.0.1:11434', state: 'ESTABLISHED' },
    ];
    expect(() => assertSafeOllamaTcpRecords(records, 100)).toThrow('Another Ollama client is connected; concurrent generation cannot be ruled out.');
  });

  it('allows only the current harness HTTP health connection paired with the Ollama listener', () => {
    const records = [
      { pid: 44786, command: 'ollama', name: '127.0.0.1:11434', state: 'LISTEN' },
      { pid: 100, command: 'node', name: '127.0.0.1:50000->127.0.0.1:11434', state: 'ESTABLISHED' },
      { pid: 44786, command: 'ollama', name: '127.0.0.1:11434->127.0.0.1:50000', state: 'ESTABLISHED' },
    ];
    expect(() => assertSafeOllamaTcpRecords(records, 100)).not.toThrow();
  });

  it('allows the current harness loopback health socket after its HTTP request closes', () => {
    const records = [
      { pid: 44786, command: 'ollama', name: '127.0.0.1:11434', state: 'LISTEN' },
      { pid: 100, command: 'node', name: '127.0.0.1:50000->127.0.0.1:11434', state: 'CLOSE_WAIT' },
    ];
    expect(() => assertSafeOllamaTcpRecords(records, 100)).not.toThrow();
  });

  it('rejects a closing Ollama socket owned by another client or with an unknown endpoint', () => {
    const foreign = [
      { pid: 44786, command: 'ollama', name: '127.0.0.1:11434', state: 'LISTEN' },
      { pid: 300, command: 'browser', name: '127.0.0.1:50000->127.0.0.1:11434', state: 'CLOSE_WAIT' },
    ];
    const malformed = [
      { pid: 44786, command: 'ollama', name: '127.0.0.1:11434', state: 'LISTEN' },
      { pid: 100, command: 'node', name: 'unexpected', state: 'CLOSE_WAIT' },
    ];
    expect(() => assertSafeOllamaTcpRecords(foreign, 100)).toThrow('Another Ollama client is connected; concurrent generation cannot be ruled out.');
    expect(() => assertSafeOllamaTcpRecords(malformed, 100)).toThrow('Another Ollama client is connected; concurrent generation cannot be ruled out.');
  });
});
