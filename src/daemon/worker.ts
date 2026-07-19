import { runScheduledBackup } from '../scheduler/run.js'

try {
  const result = await runScheduledBackup()
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exitCode = result.state === 'success' ? 0 : result.state === 'warning' ? 2 : 1
} catch {
  process.stderr.write('scheduled-backup: SCHEDULER_RUN_FAILED\n')
  process.exitCode = 1
}
