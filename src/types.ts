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

export interface AuthField {
  label: string;
  echo: boolean;
}

export interface AuthPrompt {
  requestId: string;
  hop: string;
  username: string;
  kind: 'password' | 'keyboard_interactive' | 'key_passphrase';
  title: string;
  instructions: string;
  fields: AuthField[];
}

/**
 * Why a session ended.
 *
 * - `local`: the operator closed the tab or the app closed the session.
 * - `remote`: the remote shell exited and the peer closed the channel.
 * - `transport`: the connection was lost without a channel close, including a
 *   keepalive timeout, a network change, or an I/O failure mid-session.
 * - `failed`: the session never reached a shell (config, host key, auth).
 */
export type CloseReason = 'local' | 'remote' | 'transport' | 'failed';

export type SessionEvent =
  | { type: 'chain'; hops: HopStatus[] }
  | { type: 'hop'; hop: HopStatus }
  | { type: 'host_key_prompt'; prompt: HostKeyPrompt }
  | { type: 'auth_prompt'; prompt: AuthPrompt }
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | { type: 'closed'; reason: CloseReason };

export interface ConnectRequest {
  sessionId: string;
  route: string[];
  cols: number;
  rows: number;
}
