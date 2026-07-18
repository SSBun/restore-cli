import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type CreateOperationResultInput,
  type OperationResult,
  createOperationResult,
  initializeRepository,
  openRepository,
  recordOperationResult,
} from '../../src/repository/index.js'

const SECRET = 'restore-recovery-v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const temporaryDirectories: string[] = []

const successInput: CreateOperationResultInput = {
  operation: 'backup',
  state: 'success',
  category: 'success',
  repositoryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  pointId: 'point-1',
  startedAt: '2026-07-18T00:00:00.000Z',
  endedAt: '2026-07-18T00:00:01.000Z',
  counts: { filesConsidered: 1, filesWritten: 1 },
}

const warningInput: CreateOperationResultInput = {
  ...successInput,
  state: 'warning',
  category: 'warning',
  issues: [{ code: 'OPTIONAL_MISSING', category: 'warning', message: 'optional source missing' }],
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe('operation result runtime schema', () => {
  it.each([
    ['operation', { ...successInput, operation: 1 }],
    ['state', { ...successInput, state: 1 }],
    ['category', { ...successInput, category: false }],
    ['repositoryId', { ...successInput, repositoryId: 7 }],
    ['pointId', { ...successInput, pointId: {} }],
    ['startedAt', { ...successInput, startedAt: 0 }],
    ['endedAt', { ...successInput, endedAt: [] }],
    ['counts', { ...successInput, counts: { filesConsidered: '1' } }],
    ['issues', { ...warningInput, issues: 'warning' }],
    ['issue code', { ...warningInput, issues: [{ code: 1, category: 'warning', message: 'x' }] }],
    ['verification scope', { ...successInput, verificationScope: 1 }],
    ['unknown field', { ...successInput, secret: 'hidden' }],
  ])('rejects wrong primitive or unknown field: %s', (_name, value) => {
    expect(() => createOperationResult(value as never)).toThrowError(
      expect.objectContaining({ code: 'INVALID_OPERATION_RESULT' }),
    )
  })

  it.each([
    [
      'success with failed files',
      { ...successInput, counts: { filesConsidered: 1, filesFailed: 1 } },
    ],
    ['success with issues', { ...successInput, issues: warningInput.issues }],
    [
      'failure with success category',
      { ...successInput, state: 'failure', issues: warningInput.issues },
    ],
    ['warning with destination category', { ...warningInput, category: 'destination' }],
    ['partial without issues', { ...successInput, state: 'partial', category: 'partial' }],
    [
      'count sum exceeds considered',
      { ...successInput, counts: { filesConsidered: 1, filesWritten: 1, filesSkipped: 1 } },
    ],
  ])('rejects semantic contradiction: %s', (_name, value) => {
    expect(() => createOperationResult(value as never)).toThrowError(
      expect.objectContaining({ code: 'INVALID_OPERATION_RESULT' }),
    )
  })

  it.each([
    ['operation', { ...successInput, operation: SECRET }],
    ['repository ID', { ...successInput, repositoryId: SECRET }],
    ['point ID', { ...successInput, pointId: SECRET }],
    [
      'issue code',
      { ...warningInput, issues: [{ code: SECRET, category: 'warning', message: 'warning' }] },
    ],
    [
      'issue message',
      { ...warningInput, issues: [{ code: 'WARNING', category: 'warning', message: SECRET }] },
    ],
    [
      'next action',
      {
        ...warningInput,
        issues: [{ code: 'WARNING', category: 'warning', message: 'warning', nextAction: SECRET }],
      },
    ],
  ])('rejects recovery material in %s', (_name, value) => {
    expect(() => createOperationResult(value as never)).toThrowError(
      expect.objectContaining({ code: 'INVALID_OPERATION_RESULT' }),
    )
  })

  it('never persists rejected fields and rejects forged write handles', async () => {
    const target = await mkdtemp(join(tmpdir(), 'restore-operation-schema-'))
    temporaryDirectories.push(target)
    const initialized = await initializeRepository({ targetPath: target, protection: 'plaintext' })
    const repository = await openRepository(initialized.repositoryPath, {
      intent: 'write',
      expectedRepositoryId: initialized.repositoryId,
      expectedProtection: 'plaintext',
    })
    const valid = createOperationResult({
      ...successInput,
      repositoryId: initialized.repositoryId,
    })

    await expect(
      recordOperationResult(repository, { ...valid, operation: SECRET } as OperationResult),
    ).rejects.toMatchObject({ code: 'INVALID_OPERATION_RESULT' })
    expect(await readdir(repository.layout.operations)).toEqual([])

    await expect(recordOperationResult({ ...repository }, valid)).rejects.toMatchObject({
      code: 'WRITE_AUTHORIZATION_REQUIRED',
    })
  })
})
