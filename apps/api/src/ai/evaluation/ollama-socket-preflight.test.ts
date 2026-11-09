import { describe, expect, it } from 'vitest';
import { assertSafeOllamaTcpRecords, parseOllamaTcpRecords } from './ollama-socket-preflight.js';

describe('Ollama socket preflight', () => {
  it('reads the explicit lsof TCP state and accepts only loopback listener', () => {
    const records = parseOllamaTcpRecords('p44786\ncollama\nf4\nn127.0.0.1:11434\nTST=LISTEN\nTQR=0\nTQS=0\n');
    expect(records).toEqual([{ pid: 44786, command: 'ollama', name: '127.0.0.1:11434', state: 'LISTEN' }]);
    expect(() => assertSafeOllamaTcpRecords(records, 100)).not.toThrow();
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
    expect(() => assertSafeOllamaTcpRecords([{ pid: 1, command: 'ollama', name: '127.0.0.1:11434', state: 'CLOSE_WAIT' }], 100))
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
});
