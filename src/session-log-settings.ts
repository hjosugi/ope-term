import { readBoundedStorage, writeBoundedStorage } from './storage';

export interface SessionLogPolicy {
  enabled: boolean;
  fileNameTemplate: string;
  timestamps: boolean;
  rotationBytes: number;
  retainedFiles: number;
}

const STORAGE_KEY = 'ope-term.session-logs.v1';
const MAX_POLICIES = 256;
const MAX_STORAGE_BYTES = 256 * 1024;
const MIB = 1024 * 1024;
const MAX_TEMPLATE_BYTES = 160;
const TEMPLATE_VARIABLES = ['{host}', '{user}', '{date}', '{time}'] as const;
const UNSAFE_FILE_NAME_CHARACTERS = /[\u0000-\u001f\u007f\\/<>:"|?*]/u;

export interface SessionLogPolicyDraft {
  enabled: boolean;
  fileNameTemplate: string;
  timestamps: boolean;
  rotationMiB: string | number;
  retainedFiles: string | number;
  hasDirectory: boolean;
}

export type SessionLogPolicyResult =
  | { ok: true; policy: SessionLogPolicy }
  | { ok: false; message: string };

export function defaultLogPolicy(): SessionLogPolicy {
  return {
    enabled: false,
    fileNameTemplate: '{host}-{user}-{date}-{time}.log',
    timestamps: true,
    rotationBytes: 25 * MIB,
    retainedFiles: 5,
  };
}

export function loadLogPolicies(storage: Pick<Storage, 'getItem'> = localStorage): Record<string, SessionLogPolicy> {
  try {
    const parsed: unknown = JSON.parse(readBoundedStorage(storage, STORAGE_KEY, MAX_STORAGE_BYTES) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const policies: Record<string, SessionLogPolicy> = {};
    for (const [key, value] of Object.entries(parsed).slice(0, MAX_POLICIES)) {
      if (!key || key.length > 256) continue;
      const policy = normalizePolicy(value);
      if (policy) policies[key] = policy;
    }
    return policies;
  } catch {
    return {};
  }
}

export function saveLogPolicies(
  policies: Record<string, SessionLogPolicy>,
  storage: Pick<Storage, 'setItem'> = localStorage,
): boolean {
  return writeBoundedStorage(
    storage,
    STORAGE_KEY,
    JSON.stringify(Object.fromEntries(Object.entries(policies).slice(0, MAX_POLICIES))),
    MAX_STORAGE_BYTES,
  );
}

export function normalizePolicy(value: unknown): SessionLogPolicy | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<SessionLogPolicy>;
  if (typeof candidate.fileNameTemplate !== 'string' || !isValidFileNameTemplate(candidate.fileNameTemplate)) return null;
  if (typeof candidate.enabled !== 'boolean' || typeof candidate.timestamps !== 'boolean') return null;
  if (!Number.isSafeInteger(candidate.rotationBytes) || !Number.isSafeInteger(candidate.retainedFiles)) return null;
  return {
    enabled: candidate.enabled,
    fileNameTemplate: candidate.fileNameTemplate,
    timestamps: candidate.timestamps,
    rotationBytes: Math.min(1024 * MIB, Math.max(MIB, candidate.rotationBytes!)),
    retainedFiles: Math.min(20, Math.max(1, candidate.retainedFiles!)),
  };
}

export function createLogPolicy(draft: SessionLogPolicyDraft): SessionLogPolicyResult {
  const fileNameTemplate = draft.fileNameTemplate.trim();
  if (!isValidFileNameTemplate(fileNameTemplate)) {
    return {
      ok: false,
      message: 'file template は固定変数だけを使い、portableな名前で .log で終えてください。',
    };
  }
  if (draft.enabled && !draft.hasDirectory) {
    return { ok: false, message: '有効化する前に保存先 directory を選択してください。' };
  }

  const rotationMiB = boundedNumber(draft.rotationMiB, 25, 1, 1024);
  const retainedFiles = Math.floor(boundedNumber(draft.retainedFiles, 5, 1, 20));
  return {
    ok: true,
    policy: {
      enabled: draft.enabled,
      fileNameTemplate,
      timestamps: draft.timestamps,
      rotationBytes: Math.floor(rotationMiB * MIB),
      retainedFiles,
    },
  };
}

export function isValidFileNameTemplate(template: string): boolean {
  if (
    !template.endsWith('.log')
    || new TextEncoder().encode(template).length > MAX_TEMPLATE_BYTES
    || UNSAFE_FILE_NAME_CHARACTERS.test(template)
  ) {
    return false;
  }
  let staticText = template;
  for (const variable of TEMPLATE_VARIABLES) staticText = staticText.replaceAll(variable, '');
  return !/[{}]/u.test(staticText);
}

function boundedNumber(value: string | number, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  const finite = Number.isFinite(parsed) && parsed !== 0 ? parsed : fallback;
  return Math.min(maximum, Math.max(minimum, finite));
}
