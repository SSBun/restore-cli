import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LAUNCHCTL_PATH,
  buildLaunchAgentPlist,
  getLaunchAgentStatus,
  installLaunchAgent,
  removeLaunchAgent,
} from '../../src/scheduler/launchd.js'
import type { CommandRunner, LaunchAgentPaths } from '../../src/scheduler/launchd.js'

const roots: string[] = []

async function fixture(): Promise<{
  paths: LaunchAgentPaths
  runner: CommandRunner
  calls: string[][]
}> {
  const root = await mkdtemp(join(tmpdir(), 'restore-launchd-'))
  roots.push(root)
  const directory = join(root, 'Library', 'LaunchAgents')
  const paths = { directory, plist: join(directory, 'com.ssbun.restore-cli.scheduler.plist') }
  let loaded = false
  const calls: string[][] = []
  const runner: CommandRunner = vi.fn(async (executable, args) => {
    calls.push([executable, ...args])
    if (args[0] === 'bootout') loaded = false
    if (args[0] === 'bootstrap') loaded = true
    return {
      exitCode: args[0] === 'print' && !loaded ? 3 : 0,
      stdout: '',
      stderr: '',
      executionError: false,
    }
  })
  return { paths, runner, calls }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('launchd scheduler adapter', () => {
  it('renders a deterministic escaped one-shot LaunchAgent plist', () => {
    const definition = {
      executable: '/opt/node&runtime/bin/node',
      arguments: ['/tmp/worker<one>.js', '--mode="safe"'],
      intervalHours: 12,
    }
    const first = buildLaunchAgentPlist(definition)
    expect(buildLaunchAgentPlist(definition)).toBe(first)
    expect(first).toContain('<integer>43200</integer>')
    expect(first).toContain('/opt/node&amp;runtime/bin/node')
    expect(first).toContain('/tmp/worker&lt;one&gt;.js')
    expect(first).toContain('--mode=&quot;safe&quot;')
    expect(first).toContain('<key>RunAtLoad</key>')
    expect(first).not.toContain('Shell')
    expect(() => buildLaunchAgentPlist({ ...definition, intervalHours: 0 })).toThrow()
  })

  it('installs, reloads, reports, and removes idempotently through injected launchctl', async () => {
    const { paths, runner, calls } = await fixture()
    const definition = {
      executable: '/usr/local/bin/node',
      arguments: ['/usr/local/lib/restore/worker.js'],
      intervalHours: 12,
    }
    await expect(installLaunchAgent(definition, { paths, runner, uid: 501 })).resolves.toEqual({
      installed: true,
      loaded: true,
    })
    await expect(installLaunchAgent(definition, { paths, runner, uid: 501 })).resolves.toEqual({
      installed: true,
      loaded: true,
    })
    expect(await readFile(paths.plist, 'utf8')).toBe(buildLaunchAgentPlist(definition))
    expect((await lstat(paths.plist)).mode & 0o777).toBe(0o600)
    expect(calls.some((call) => call[0] === LAUNCHCTL_PATH && call[1] === 'bootstrap')).toBe(true)
    await expect(getLaunchAgentStatus({ paths, runner, uid: 501 })).resolves.toEqual({
      installed: true,
      loaded: true,
    })
    await expect(removeLaunchAgent({ paths, runner, uid: 501 })).resolves.toEqual({
      installed: false,
      loaded: false,
    })
    await expect(removeLaunchAgent({ paths, runner, uid: 501 })).resolves.toEqual({
      installed: false,
      loaded: false,
    })
  })

  it('refuses to replace a symlinked plist', async () => {
    const { paths, runner } = await fixture()
    await rm(paths.directory, { recursive: true, force: true })
    const outside = join(paths.directory, '..', 'outside')
    await mkdir(paths.directory, { recursive: true })
    await writeFile(outside, 'outside')
    await symlink(outside, paths.plist)
    await expect(
      installLaunchAgent(
        {
          executable: '/usr/local/bin/node',
          arguments: ['/tmp/worker.js'],
          intervalHours: 12,
        },
        { paths, runner, uid: 501 },
      ),
    ).rejects.toThrow('unsafe')
    expect(await readFile(outside, 'utf8')).toBe('outside')
  })

  it('does not report a stopped service when launchctl itself cannot execute', async () => {
    const { paths } = await fixture()
    const runner: CommandRunner = async () => ({
      exitCode: 1,
      stdout: '',
      stderr: '',
      executionError: true,
    })
    await expect(removeLaunchAgent({ paths, runner, uid: 501 })).rejects.toThrow(
      'could not be executed',
    )
  })
})
