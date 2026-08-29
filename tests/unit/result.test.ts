import { describe, expect, it } from 'vitest'
import { formatHumanResult, serializeCliResult } from '../../src/util/result.js'

const result = {
  operation: 'backup',
  state: 'success',
  category: 'success',
  mirrorPath: '/safe/RestoreBackup',
  dryRun: true,
  changed: false,
  counts: { created: 1, modified: 2, deleted: 3 },
  issues: [],
}

describe('CLI result formatting', () => {
  it('formats the concise mirror result', () => {
    const output = formatHumanResult(result)
    expect(output).toContain('Backup')
    expect(output).toContain('/safe/RestoreBackup')
    expect(output).toContain('Dry run')
    expect(output).toContain('Created')
    expect(output).toContain('Deleted')
  })

  it('keeps JSON output unchanged', () => {
    expect(JSON.parse(serializeCliResult(result, true))).toEqual(result)
  })

  it('truncates long issue lists visibly', () => {
    const issues = Array.from({ length: 17 }, (_, index) => ({
      code: `ISSUE_${index + 1}`,
      message: `Issue ${index + 1}`,
    }))
    const output = formatHumanResult({ ...result, state: 'failure', issues })
    expect(output).toContain('Issues (17)')
    expect(output).toContain('ISSUE_16')
    expect(output).not.toContain('ISSUE_17')
    expect(output).toContain('... 1 more not shown')
  })
})
