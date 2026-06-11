import { z } from 'zod'

export const DestinationSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  type: z.enum(['icloud', 'local', 'smb']).default('local'),
})

export const DaemonConfigSchema = z.object({
  intervalHours: z.number().positive().default(12),
})

export const ConfigSchema = z.object({
  destination: DestinationSchema.default({ name: 'icloud', path: '', type: 'icloud' }),
  plugins: z.array(z.string()).default([]),
  daemon: DaemonConfigSchema.default({}),
  maxSnapshots: z.number().int().positive().default(14),
})

export type Destination = z.infer<typeof DestinationSchema>
export type DaemonConfig = z.infer<typeof DaemonConfigSchema>
export type Config = z.infer<typeof ConfigSchema>
