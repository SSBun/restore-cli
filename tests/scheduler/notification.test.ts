import { describe, expect, it, vi } from 'vitest'
import type { CommandRunResult } from '../../src/scheduler/launchd.js'
import { OSASCRIPT_PATH, sendLocalNotification } from '../../src/scheduler/notification.js'

describe('macOS scheduler notifications', () => {
  it('uses a fixed executable without a shell and bounds control characters', async () => {
    const runner = vi.fn<[executable: string, args: readonly string[]], Promise<CommandRunResult>>(
      async () => ({ exitCode: 0, stdout: '', stderr: '', executionError: false }),
    )
    await expect(
      sendLocalNotification(
        { title: 'Restore\nAlert', message: `Failure\0${'x'.repeat(500)}` },
        runner,
      ),
    ).resolves.toBe(true)
    expect(runner).toHaveBeenCalledOnce()
    const [executable, args] = runner.mock.calls[0] ?? []
    expect(executable).toBe(OSASCRIPT_PATH)
    expect(args?.[0]).toBe('-l')
    expect(args?.at(-2)).not.toContain('\n')
    expect(args?.at(-1)?.length).toBeLessThanOrEqual(160)
  })
})
