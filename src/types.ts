export interface HostProfile {
  alias: string;
  hostname: string;
  user?: string;
  port: number;
  proxyJump?: string;
  chain: string[];
}

export type HopState = 'pending' | 'connecting' | 'connected' | 'error';

export interface HopStatus {
  index: number;
  alias: string;
  state: HopState;
}

export interface HostKeyPrompt {
  requestId: string;
  hop: string;
  hostname: string;
  port: number;
  algorithm: string;
  fingerprint: string;
  status: 'unknown' | 'changed';
  existingLine?: number;
}

export type SessionEvent =
  | { type: 'chain'; hops: HopStatus[] }
  | { type: 'hop'; hop: HopStatus }
  | { type: 'host_key_prompt'; prompt: HostKeyPrompt }
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | { type: 'closed' };

export interface ConnectRequest {
  sessionId: string;
  route: string[];
  cols: number;
  rows: number;
}
