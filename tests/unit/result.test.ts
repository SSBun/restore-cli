import { describe, expect, it } from 'vitest'
import { formatHumanResult, serializeCliResult } from '../../src/util/result.js'

describe('CLI result formatting', () => {
  const result = {
    operation: 'backup',
    state: 'failure',
    category: 'lock',
    repositoryId: 'repository-1',
    counts: {
      filesConsidered: 32,
      filesWritten: 0,
      filesSkipped: 3,
      filesFailed: 0,
      bytesRead: 374336,
      bytesWritten: 0,
    },
    issues: [
      {
        code: 'SOURCE_MISSING',
        category: 'source',
        message: 'Declared source is missing',
      },
      {
        code: 'LOCK_OWNERSHIP_CHANGED',
        category: 'lock',
        message: 'Repository lock ownership changed',
      },
    ],
  }

  it('formats a colored, indented failure summary', () => {
    const output = formatHumanResult(result)

    expect(output).toContain('\x1b[31m✗')
    expect(output).toContain('Backup')
    expect(output).toContain('\n  ')
    expect(output).toContain('Counts')
    expect(output).toContain('366 KiB')
    expect(output).toContain('Issues (2)')
    expect(output).toContain('SOURCE_MISSING')
    expect(output).toContain('LOCK_OWNERSHIP_CHANGED')
  })

  it('keeps JSON output unchanged', () => {
    expect(JSON.parse(serializeCliResult(result, true))).toEqual(result)
  })

  it('reports truncated issues instead of hiding them', () => {
    const issues = Array.from({ length: 17 }, (_, index) => ({
      code: `ISSUE_${index + 1}`,
      category: 'lock',
      message: `Issue ${index + 1}`,
    }))
    const output = formatHumanResult({ ...result, issues })

    expect(output).toContain('Issues (17)')
    expect(output).toContain('ISSUE_16')
    expect(output).not.toContain('ISSUE_17')
    expect(output).toContain('... 1 more not shown')
  })

  it('humanizes command names and aligns boolean metadata', () => {
    const output = formatHumanResult({
      operation: 'legacy-migrate',
      state: 'success',
      category: 'success',
      dryRun: true,
      degraded: false,
    })

    expect(output).toContain('Legacy migrate')
    expect(output).not.toContain('legacy-migrate')
    expect(output).toContain('\n  \x1b[2mDry run')
    expect(output).toContain('\n  \x1b[2mDegraded')
  })
})
