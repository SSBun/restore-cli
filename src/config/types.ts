import { z } from 'zod'

export const DestinationSchema = z
  .object({
    name: z.string().min(1),
    path: z.string().min(1),
    type: z.enum(['icloud', 'local', 'smb']).default('local'),
  })
  .strict()

export const ConfigSchema = z
  .object({
    destination: DestinationSchema,
    plugins: z.array(z.string().min(1).max(100)).max(256).default([]),
  })
  .strict()

export type Destination = z.infer<typeof DestinationSchema>
export type Config = z.infer<typeof ConfigSchema>
