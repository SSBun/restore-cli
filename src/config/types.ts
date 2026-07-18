import { z } from 'zod'

export const DestinationSchema = z
  .object({
    name: z.string().min(1),
    path: z.string().min(1),
    type: z.enum(['icloud', 'local', 'smb']).default('local'),
  })
  .strict()

export const RepositoryConfigSchema = z
  .object({
    id: z.string().uuid(),
    protection: z.enum(['encrypted', 'plaintext']),
  })
  .strict()

export const PlaintextSecretAcceptanceSchema = z
  .object({
    repositoryId: z.string().uuid(),
    sourceId: z.string().min(1).max(201),
    sourceContractFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    acceptedAt: z.string().datetime(),
  })
  .strict()

export const DaemonConfigSchema = z
  .object({
    intervalHours: z.number().nonnegative().default(12),
  })
  .strict()

export const ConfigSchema = z
  .object({
    destination: DestinationSchema.default({ name: 'icloud', path: '', type: 'icloud' }),
    repository: RepositoryConfigSchema.optional(),
    plugins: z.array(z.string().min(1).max(100)).max(256).default([]),
    plaintextSecretAcceptances: z.array(PlaintextSecretAcceptanceSchema).max(256).default([]),
    daemon: DaemonConfigSchema.default({}),
    maxSnapshots: z.number().int().positive().default(14),
  })
  .strict()

export type Destination = z.infer<typeof DestinationSchema>
export type DaemonConfig = z.infer<typeof DaemonConfigSchema>
export type RepositoryConfig = z.infer<typeof RepositoryConfigSchema>
export type PlaintextSecretAcceptance = z.infer<typeof PlaintextSecretAcceptanceSchema>
type ParsedConfig = z.infer<typeof ConfigSchema>
export type Config = Omit<ParsedConfig, 'plaintextSecretAcceptances'> & {
  plaintextSecretAcceptances?: PlaintextSecretAcceptance[]
}
