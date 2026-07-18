import type { CredentialProvider } from '../protection/credentials.js'
import { RepositoryError, listOperationResults, openRepository } from '../repository/index.js'
import type {
  ClassifiedIssue,
  OperationCategory,
  OperationResult,
  OperationState,
  ProtectionMode,
  RepositoryHandle,
} from '../repository/index.js'
import { verifyV1Repository } from '../verify/index.js'
import type { VerificationReport } from '../verify/index.js'

const RPO_DEGRADED_AFTER_MS = 24 * 60 * 60 * 1000
const RECENT_OPERATION_LIMIT = 10
const MAX_VERIFICATION_ISSUES = 32
const SAFE_ISSUE_CODE = /^[A-Z][A-Z0-9_]{0,99}$/

export interface V1StatusTargetCapabilities {
  readable: true
  writeChecked: boolean
  writable: boolean | null
  readback: boolean | null
  atomicRename: boolean | null
}

export interface V1StatusOptions {
  repositoryPath: string
  expectedRepositoryId: string
  expectedProtection: ProtectionMode
  credentialProvider?: CredentialProvider
  schedulerIntervalHours: number
  schedulerRunning?: boolean | null
  nextScheduledAt?: string | null
  now?: () => Date
  open?: typeof openRepository
  verify?: typeof verifyV1Repository
  history?: typeof listOperationResults
}

export interface V1StatusResult {
  operation: 'status'
  state: OperationState
  category: OperationCategory
  startedAt: string
  endedAt: string
  repositoryId: string
  repositoryLocation: string | null
  protection: {
    mode: ProtectionMode
    state: 'secure' | 'insecure'
  }
  target: {
    state: 'available' | 'unavailable'
    capabilities: V1StatusTargetCapabilities | null
  }
  scheduler: {
    configured: boolean
    state: 'disabled' | 'configured' | 'running' | 'stopped' | 'unknown'
    intervalHours: number
    nextScheduledAt: string | null
  }
  recoveryPoints: {
    healthy: number
    partial: number
    failed: number
    latestId: string | null
    latestHealthyId: string | null
    latestHealthyAt: string | null
  }
  rpo: {
    ageMs: number | null
    degradedAfterMs: number
    degraded: boolean
  }
  verification: {
    structural: {
      at: string
      pointId: string | null
      filesVerified: number
      bytesRead: number
    } | null
    content: { at: string; pointId: string | null; filesVerified: number; bytesRead: number } | null
  }
  recentOperations: OperationResult[]
  issues: ClassifiedIssue[]
  nextAction: string | null
}

function safeNow(now?: () => Date): Date {
  const value = now?.() ?? new Date()
  if (!Number.isFinite(value.getTime())) throw new Error('invalid time')
  return value
}

function schedulerState(options: V1StatusOptions): V1StatusResult['scheduler'] {
  const configured = options.schedulerIntervalHours > 0
  return {
    configured,
    state: !configured
      ? 'disabled'
      : options.schedulerRunning === true
        ? 'running'
        : options.schedulerRunning === false
          ? 'stopped'
          : options.schedulerRunning === null || options.schedulerRunning === undefined
            ? 'configured'
            : 'unknown',
    intervalHours: options.schedulerIntervalHours,
    nextScheduledAt: options.nextScheduledAt ?? null,
  }
}

function statusIssue(
  code: string,
  category: ClassifiedIssue['category'],
  message: string,
  nextAction: string,
): ClassifiedIssue {
  return { code, category, message, nextAction }
}

function failedStatus(
  options: V1StatusOptions,
  started: Date,
  issue: ClassifiedIssue,
): V1StatusResult {
  const ended = safeNow(options.now)
  return {
    operation: 'status',
    state: 'failure',
    category: issue.category,
    startedAt: started.toISOString(),
    endedAt: ended.toISOString(),
    repositoryId: options.expectedRepositoryId,
    repositoryLocation: null,
    protection: {
      mode: options.expectedProtection,
      state: options.expectedProtection === 'encrypted' ? 'secure' : 'insecure',
    },
    target: { state: 'unavailable', capabilities: null },
    scheduler: schedulerState(options),
    recoveryPoints: {
      healthy: 0,
      partial: 0,
      failed: 0,
      latestId: null,
      latestHealthyId: null,
      latestHealthyAt: null,
    },
    rpo: { ageMs: null, degradedAfterMs: RPO_DEGRADED_AFTER_MS, degraded: true },
    verification: { structural: null, content: null },
    recentOperations: [],
    issues: [issue],
    nextAction: issue.nextAction ?? null,
  }
}

function verificationHistory(
  history: readonly OperationResult[],
  scope: 'structural' | 'content',
): V1StatusResult['verification']['structural'] {
  const result = history.find(
    (entry) =>
      entry.operation === 'verify' &&
      entry.verificationScope === scope &&
      entry.state !== 'failure',
  )
  return result
    ? {
        at: result.endedAt,
        pointId: result.pointId ?? null,
        filesVerified: Math.max(
          0,
          result.counts.filesConsidered - result.counts.filesFailed - result.counts.filesSkipped,
        ),
        bytesRead: result.counts.bytesRead,
      }
    : null
}

function latestHealthy(
  report: VerificationReport,
): VerificationReport['points'][number] | undefined {
  return report.points.find(
    (point) => point.structurallyHealthy && point.manifestHealth === 'healthy',
  )
}

function targetCapabilities(repository: RepositoryHandle): V1StatusTargetCapabilities {
  const capabilities = repository.preflight.capabilities
  return {
    readable: true,
    writeChecked: capabilities.writeChecked,
    writable: capabilities.writeChecked ? capabilities.writable : null,
    readback: capabilities.writeChecked ? capabilities.readback : null,
    atomicRename: capabilities.writeChecked ? capabilities.atomicRename : null,
  }
}

const SAFE_ISSUE_CATEGORIES = new Set<ClassifiedIssue['category']>([
  'warning',
  'partial',
  'configuration',
  'authentication',
  'lock',
  'source',
  'destination',
  'integrity',
  'unsupported',
  'cancelled',
  'internal',
])

function sanitizeVerificationIssue(issue: ClassifiedIssue, index: number): ClassifiedIssue {
  const code = SAFE_ISSUE_CODE.test(issue.code) ? issue.code : `VERIFICATION_ISSUE_${index + 1}`
  const category = SAFE_ISSUE_CATEGORIES.has(issue.category) ? issue.category : 'integrity'
  return statusIssue(
    code,
    category,
    `Repository verification reported ${code}`,
    'Run structural verification and inspect repository diagnostics',
  )
}

function verificationFailureCategory(report: VerificationReport): ClassifiedIssue['category'] {
  return report.category !== 'success' && SAFE_ISSUE_CATEGORIES.has(report.category)
    ? report.category
    : 'integrity'
}

function verificationIdentityMatches(
  report: VerificationReport,
  repository: RepositoryHandle,
): boolean {
  return (
    report.repositoryId === repository.descriptor.repositoryId &&
    report.protection === repository.descriptor.protection
  )
}

function verificationIssues(
  report: VerificationReport,
  repository: RepositoryHandle,
): ClassifiedIssue[] {
  const issues = report.issues
    .slice(0, MAX_VERIFICATION_ISSUES)
    .map((issue, index) => sanitizeVerificationIssue(issue, index))
  if (!verificationIdentityMatches(report, repository)) {
    issues.unshift(
      statusIssue(
        'VERIFICATION_REPORT_MISMATCH',
        'integrity',
        'Repository verification identity did not match the authenticated status target',
        'Run structural verification against the configured repository',
      ),
    )
  } else if (report.state === 'failure') {
    const failureCategory = verificationFailureCategory(report)
    const primaryIndex = issues.findIndex((issue) => issue.category === failureCategory)
    if (primaryIndex >= 0) {
      const [primary] = issues.splice(primaryIndex, 1)
      if (primary) issues.unshift(primary)
    } else {
      issues.unshift(
        statusIssue(
          'VERIFICATION_FAILED',
          failureCategory,
          'Repository verification failed without a matching usable diagnostic',
          'Run structural verification and inspect repository diagnostics',
        ),
      )
    }
  }
  return issues
}

export async function getV1Status(options: V1StatusOptions): Promise<V1StatusResult> {
  const started = safeNow(options.now)
  let repository: RepositoryHandle | undefined
  try {
    repository = await (options.open ?? openRepository)(options.repositoryPath, {
      intent: 'read',
      expectedRepositoryId: options.expectedRepositoryId,
      expectedProtection: options.expectedProtection,
      ...(options.credentialProvider ? { credentialProvider: options.credentialProvider } : {}),
    })
  } catch (error) {
    const category = error instanceof RepositoryError ? error.category : 'authentication'
    return failedStatus(
      options,
      started,
      statusIssue(
        error instanceof RepositoryError ? error.code : 'REPOSITORY_AUTHENTICATION_FAILED',
        category,
        error instanceof RepositoryError ? error.message : 'Repository could not be authenticated',
        'Connect the expected repository and unlock it with a valid credential',
      ),
    )
  }

  try {
    if (repository.descriptor.protection === 'encrypted' && !repository.protector) {
      return failedStatus(
        options,
        started,
        statusIssue(
          'REPOSITORY_AUTHENTICATION_FAILED',
          'authentication',
          'Encrypted repository is locked',
          'Unlock the repository with a valid credential',
        ),
      )
    }
    const borrowedRepository: RepositoryHandle = { ...repository, close() {} }
    const report = await (options.verify ?? verifyV1Repository)({
      repositoryPath: options.repositoryPath,
      expectedRepositoryId: options.expectedRepositoryId,
      expectedProtection: options.expectedProtection,
      ...(options.credentialProvider ? { credentialProvider: options.credentialProvider } : {}),
      selector: { kind: 'all' },
      scope: 'structural',
      openRepository: async () => borrowedRepository,
    })
    const issues = verificationIssues(report, repository)
    let history: OperationResult[] = []
    try {
      history = await (options.history ?? listOperationResults)(repository)
    } catch {
      issues.push(
        statusIssue(
          'INVALID_OPERATION_HISTORY',
          'integrity',
          'Operation history is malformed or unsafe',
          'Inspect operation history before relying on recent-operation status',
        ),
      )
    }
    const healthyPoints = report.points.filter(
      (point) => point.structurallyHealthy && point.manifestHealth === 'healthy',
    )
    const partialPoints = report.points.filter(
      (point) => point.structurallyHealthy && point.manifestHealth === 'partial',
    )
    const failedCount = report.points.length - healthyPoints.length - partialPoints.length
    const healthy = latestHealthy(report)
    const now = safeNow(options.now)
    const ageMs = healthy?.completedAt
      ? Math.max(0, now.getTime() - Date.parse(healthy.completedAt))
      : null
    const stale = ageMs === null || ageMs > RPO_DEGRADED_AFTER_MS
    if (failedCount > 0) {
      issues.push(
        statusIssue(
          'RECOVERY_POINT_FAILURES',
          'integrity',
          'One or more published recovery points failed strict structural verification',
          'Run repository structural verification and avoid failed points',
        ),
      )
    }
    if (stale) {
      issues.push(
        statusIssue(
          'RPO_DEGRADED',
          'warning',
          'No successful healthy backup exists within the 24-hour RPO',
          'Run backup after confirming the repository target and source configuration',
        ),
      )
    }
    if (options.expectedProtection === 'plaintext') {
      issues.push(
        statusIssue(
          'PLAINTEXT_REPOSITORY_INSECURE',
          'warning',
          'Repository content and metadata are not encrypted',
          'Use an encrypted repository for sensitive configuration',
        ),
      )
    }
    const ended = safeNow(options.now)
    const identityMismatch = !verificationIdentityMatches(report, repository)
    const verificationCategory = identityMismatch
      ? 'integrity'
      : report.state === 'failure'
        ? verificationFailureCategory(report)
        : undefined
    const degraded = issues.length > 0
    return {
      operation: 'status',
      state: verificationCategory ? 'failure' : degraded ? 'degraded' : 'success',
      category: verificationCategory ?? (degraded ? (issues[0]?.category ?? 'warning') : 'success'),
      startedAt: started.toISOString(),
      endedAt: ended.toISOString(),
      repositoryId: repository.descriptor.repositoryId,
      repositoryLocation: repository.descriptor.targetIdentity.stableIdentity,
      protection: {
        mode: repository.descriptor.protection,
        state: repository.descriptor.protection === 'encrypted' ? 'secure' : 'insecure',
      },
      target: { state: 'available', capabilities: targetCapabilities(repository) },
      scheduler: schedulerState(options),
      recoveryPoints: {
        healthy: healthyPoints.length,
        partial: partialPoints.length,
        failed: failedCount,
        latestId: report.resolvedPointIds[0] ?? null,
        latestHealthyId: healthy?.pointId ?? null,
        latestHealthyAt: healthy?.completedAt ?? null,
      },
      rpo: { ageMs, degradedAfterMs: RPO_DEGRADED_AFTER_MS, degraded: stale },
      verification: {
        structural: verificationHistory(history, 'structural'),
        content: verificationHistory(history, 'content'),
      },
      recentOperations: history.slice(0, RECENT_OPERATION_LIMIT),
      issues,
      nextAction: issues[0]?.nextAction ?? null,
    }
  } catch {
    return failedStatus(
      options,
      started,
      statusIssue(
        'STATUS_EVALUATION_FAILED',
        'integrity',
        'Repository status could not be derived safely',
        'Run structural verification and inspect repository diagnostics',
      ),
    )
  } finally {
    repository.close()
  }
}
