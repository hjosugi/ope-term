export interface SessionLogPolicy {
  enabled: boolean;
  fileNameTemplate: string;
  timestamps: boolean;
  rotationBytes: number;
  retainedFiles: number;
}

const STORAGE_KEY = 'ope-term.session-logs.v1';
const MAX_POLICIES = 256;
const MIB = 1024 * 1024;

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
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}');
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
): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(Object.entries(policies).slice(0, MAX_POLICIES))));
}

export function normalizePolicy(value: unknown): SessionLogPolicy | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<SessionLogPolicy>;
  if (typeof candidate.fileNameTemplate !== 'string' || candidate.fileNameTemplate.length < 1 || candidate.fileNameTemplate.length > 160) return null;
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

