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

export type SessionEvent =
  | { type: 'chain'; hops: HopStatus[] }
  | { type: 'hop'; hop: HopStatus }
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | { type: 'closed' };

export interface ConnectRequest {
  sessionId: string;
  route: string[];
  cols: number;
  rows: number;
}
