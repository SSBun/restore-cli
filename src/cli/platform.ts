import { execFileSync } from 'node:child_process'

export const SUPPORTED_MACOS_MAJORS = [26, 15, 14] as const
export const SW_VERS_PATH = '/usr/bin/sw_vers'

export interface PlatformFacts {
  platform: string
  architecture: string
  productVersion: string | null
}

export interface PlatformCheckResult {
  operation: 'platform-check'
  state: 'success' | 'failure'
  category: 'success' | 'unsupported'
  platform: string
  architecture: string
  productVersion: string | null
  supportedMacOSMajors: readonly number[]
  issues: Array<{
    code: string
    category: 'unsupported'
    message: string
    nextAction: string
  }>
  nextAction: string | null
}

export interface PlatformDependencies {
  platform: string
  architecture: string
  productVersion(): string | null
}

const DEFAULT_DEPENDENCIES: PlatformDependencies = {
  platform: process.platform,
  architecture: process.arch,
  productVersion() {
    try {
      const value = execFileSync(SW_VERS_PATH, ['-productVersion'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10_000,
      }).trim()
      return value.length > 0 && value.length <= 100 ? value : null
    } catch {
      return null
    }
  },
}

function failure(facts: PlatformFacts, code: string, message: string): PlatformCheckResult {
  const nextAction = 'Use an Apple Silicon Mac running macOS Tahoe 26, Sequoia 15, or Sonoma 14'
  return {
    operation: 'platform-check',
    state: 'failure',
    category: 'unsupported',
    ...facts,
    supportedMacOSMajors: [...SUPPORTED_MACOS_MAJORS],
    issues: [{ code, category: 'unsupported', message, nextAction }],
    nextAction,
  }
}

export function checkSupportedPlatform(
  overrides: Partial<PlatformDependencies> = {},
): PlatformCheckResult {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  const facts: PlatformFacts = {
    platform: dependencies.platform,
    architecture: dependencies.architecture,
    productVersion: dependencies.productVersion(),
  }
  if (facts.platform !== 'darwin') {
    return failure(facts, 'UNSUPPORTED_OPERATING_SYSTEM', 'Restore 1.0 supports macOS only')
  }
  if (facts.architecture !== 'arm64') {
    return failure(
      facts,
      'UNSUPPORTED_ARCHITECTURE',
      'Restore 1.0 supports Apple Silicon only; Intel Macs are not supported',
    )
  }
  const match = /^(\d+)(?:\.\d+){0,2}$/.exec(facts.productVersion ?? '')
  const major = match ? Number(match[1]) : Number.NaN
  if (!Number.isSafeInteger(major)) {
    return failure(
      facts,
      'MACOS_VERSION_UNAVAILABLE',
      'The macOS product version could not be determined safely',
    )
  }
  if (!(SUPPORTED_MACOS_MAJORS as readonly number[]).includes(major)) {
    return failure(
      facts,
      'UNSUPPORTED_MACOS_VERSION',
      'This macOS major version is outside the Restore 1.0 support window',
    )
  }
  return {
    operation: 'platform-check',
    state: 'success',
    category: 'success',
    ...facts,
    supportedMacOSMajors: [...SUPPORTED_MACOS_MAJORS],
    issues: [],
    nextAction: null,
  }
}
