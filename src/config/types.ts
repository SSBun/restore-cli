import { z } from 'zod'

export const ProfileSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  type: z.enum(['icloud', 'local', 'smb']).default('local'),
  intervalHours: z.number().positive().optional(),
})

export const DaemonConfigSchema = z.object({
  intervalHours: z.number().positive().default(12),
})

export const ConfigSchema = z.object({
  profiles: z.array(ProfileSchema).min(1),
  plugins: z.array(z.string()).default([]),
  daemon: DaemonConfigSchema.default({}),
  maxSnapshots: z.number().int().positive().default(14),
})

export type Profile = z.infer<typeof ProfileSchema>
export type DaemonConfig = z.infer<typeof DaemonConfigSchema>
export type Config = z.infer<typeof ConfigSchema>
