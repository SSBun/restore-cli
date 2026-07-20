import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  configExists: vi.fn(),
  initializeRepository: vi.fn(),
  loadConfig: vi.fn(),
  mkdir: vi.fn(),
  multiselect: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  writeConfig: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({ mkdir: mocks.mkdir }))

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  isCancel: () => false,
  log: { error: vi.fn(), warn: vi.fn() },
  multiselect: mocks.multiselect,
  select: mocks.select,
  spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
  text: mocks.text,
}))

vi.mock('../repository/index.js', () => ({
  initializeRepository: mocks.initializeRepository,
}))

vi.mock('../plugin/loader.js', () => ({
  getAllPlugins: () => [
    { name: 'vscode', sources: [{ sensitivity: 'private' }] },
    { name: 'ssh', sources: [{ sensitivity: 'secret' }] },
    { name: 'sops', sources: [{ sensitivity: 'secret' }] },
    { name: 'custom-public', sources: [{ sensitivity: 'public' }] },
  ],
}))

vi.mock('./loader.js', () => ({
  configExists: mocks.configExists,
  loadConfig: mocks.loadConfig,
  prunePlaintextSecretAcceptances: (config: unknown) => config,
  writeConfig: mocks.writeConfig,
}))

import { runWizard } from './wizard.js'

const repository = {
  repositoryId: '00000000-0000-4000-8000-000000000001',
  repositoryPath: '/tmp/backup/RestoreBackup',
  createdAt: '2026-07-19T00:00:00.000Z',
  protection: 'plaintext',
  targetIdentity: {
    deviceId: '1',
    fileSystemType: 'apfs',
    mountPath: '/tmp',
    stableIdentity: 'volume:00000000-0000-4000-8000-000000000001',
  },
  availableBytes: '1',
  recoveryCredentialExported: false,
} as const

const existingConfig = {
  destination: { name: 'backup', path: '/tmp/backup', type: 'local' as const },
  repository: { id: repository.repositoryId, protection: 'plaintext' as const },
  plugins: ['vscode'],
  plaintextSecretAcceptances: [],
  daemon: { intervalHours: 12 },
  maxSnapshots: 14,
}

describe('configuration wizard repository flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mkdir.mockResolvedValue(undefined)
    mocks.initializeRepository.mockResolvedValue(repository)
    mocks.multiselect.mockResolvedValue(['vscode'])
    mocks.loadConfig.mockReturnValue(existingConfig)
  })

  it('initializes and saves a plaintext repository during first setup', async () => {
    mocks.configExists.mockReturnValue(false)
    mocks.select.mockResolvedValueOnce('local').mockResolvedValueOnce('type')
    mocks.text
      .mockResolvedValueOnce('backup')
      .mockResolvedValueOnce('/tmp/backup')
      .mockResolvedValueOnce('12')
      .mockResolvedValueOnce('14')

    await runWizard()

    expect(mocks.initializeRepository).toHaveBeenCalledWith({
      targetPath: '/tmp/backup',
      protection: 'plaintext',
    })
    expect(mocks.writeConfig).toHaveBeenCalledWith(
      expect.objectContaining({ repository: existingConfig.repository }),
    )
    const pluginOptions = mocks.multiselect.mock.calls[0]?.[0].options as Array<{ value: string }>
    expect(pluginOptions.map((option) => option.value)).not.toEqual(
      expect.arrayContaining(['ssh', 'sops']),
    )
  })

  it('does not initialize again when only backup settings change', async () => {
    mocks.configExists.mockReturnValue(true)
    mocks.select.mockResolvedValueOnce('edit-settings').mockResolvedValueOnce('save-exit')
    mocks.text.mockResolvedValueOnce('24').mockResolvedValueOnce('14')

    await runWizard()

    expect(mocks.initializeRepository).not.toHaveBeenCalled()
    expect(mocks.writeConfig).toHaveBeenCalledWith(
      expect.objectContaining({ repository: existingConfig.repository }),
    )
  })

  it('initializes a new repository when the destination changes', async () => {
    const newRepository = {
      ...repository,
      repositoryId: '00000000-0000-4000-8000-000000000002',
      repositoryPath: '/tmp/new-backup/RestoreBackup',
    }
    mocks.configExists.mockReturnValue(true)
    mocks.initializeRepository.mockResolvedValue(newRepository)
    mocks.select
      .mockResolvedValueOnce('edit-destination')
      .mockResolvedValueOnce('local')
      .mockResolvedValueOnce('type')
      .mockResolvedValueOnce('save-exit')
    mocks.text.mockResolvedValueOnce('new').mockResolvedValueOnce('/tmp/new-backup')

    await runWizard()

    expect(mocks.initializeRepository).toHaveBeenCalledWith({
      targetPath: '/tmp/new-backup',
      protection: 'plaintext',
    })
    expect(mocks.writeConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: expect.objectContaining({ path: '/tmp/new-backup' }),
        repository: { id: newRepository.repositoryId, protection: 'plaintext' },
      }),
    )
  })

  it('preserves secret plugin choices when editing an encrypted configuration', async () => {
    mocks.configExists.mockReturnValue(true)
    mocks.loadConfig.mockReturnValue({
      ...existingConfig,
      repository: { id: repository.repositoryId, protection: 'encrypted' },
      plugins: ['vscode', 'ssh'],
    })
    mocks.select.mockResolvedValueOnce('edit-plugins').mockResolvedValueOnce('save-exit')
    mocks.multiselect.mockResolvedValueOnce(['vscode', 'ssh'])

    await runWizard()

    expect(mocks.initializeRepository).not.toHaveBeenCalled()
    expect(mocks.writeConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        plugins: ['vscode', 'ssh'],
        repository: { id: repository.repositoryId, protection: 'encrypted' },
      }),
    )
    const pluginOptions = mocks.multiselect.mock.calls[0]?.[0].options as Array<{ value: string }>
    expect(pluginOptions.map((option) => option.value)).toContain('ssh')
  })

  it('removes secret plugins after an encrypted configuration changes destination', async () => {
    mocks.configExists.mockReturnValue(true)
    mocks.loadConfig.mockReturnValue({
      ...existingConfig,
      repository: { id: repository.repositoryId, protection: 'encrypted' },
      plugins: ['vscode', 'ssh'],
    })
    mocks.select
      .mockResolvedValueOnce('edit-destination')
      .mockResolvedValueOnce('local')
      .mockResolvedValueOnce('type')
      .mockResolvedValueOnce('edit-plugins')
      .mockResolvedValueOnce('save-exit')
    mocks.text.mockResolvedValueOnce('new').mockResolvedValueOnce('/tmp/new-backup')
    mocks.multiselect.mockResolvedValueOnce(['vscode'])

    await runWizard()

    expect(mocks.initializeRepository).toHaveBeenCalledWith({
      targetPath: '/tmp/new-backup',
      protection: 'plaintext',
    })
    expect(mocks.writeConfig).toHaveBeenCalledWith(
      expect.objectContaining({ plugins: ['vscode'], repository: existingConfig.repository }),
    )
    const pluginOptions = mocks.multiselect.mock.calls[0]?.[0].options as Array<{ value: string }>
    expect(pluginOptions.map((option) => option.value)).not.toContain('ssh')
  })

  it('preserves a non-secret user plugin when the destination changes', async () => {
    mocks.configExists.mockReturnValue(true)
    mocks.loadConfig.mockReturnValue({
      ...existingConfig,
      repository: { id: repository.repositoryId, protection: 'encrypted' },
      plugins: ['custom-public'],
    })
    mocks.select
      .mockResolvedValueOnce('edit-destination')
      .mockResolvedValueOnce('local')
      .mockResolvedValueOnce('type')
      .mockResolvedValueOnce('save-exit')
    mocks.text.mockResolvedValueOnce('new').mockResolvedValueOnce('/tmp/new-backup')

    await runWizard()

    expect(mocks.writeConfig).toHaveBeenCalledWith(
      expect.objectContaining({ plugins: ['custom-public'] }),
    )
  })

  it('does not save configuration when repository initialization fails', async () => {
    mocks.configExists.mockReturnValue(false)
    mocks.initializeRepository.mockRejectedValue(new Error('failed'))
    mocks.select.mockResolvedValueOnce('local').mockResolvedValueOnce('type')
    mocks.text
      .mockResolvedValueOnce('backup')
      .mockResolvedValueOnce('/tmp/backup')
      .mockResolvedValueOnce('12')
      .mockResolvedValueOnce('14')

    await runWizard()

    expect(mocks.writeConfig).not.toHaveBeenCalled()
  })
})
