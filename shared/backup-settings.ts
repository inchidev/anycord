import { z } from 'zod'
export const backupStorageInputSchema = z.object({
  endpoint: z.url().max(2048), bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/), region: z.string().min(1).max(100).default('auto'),
  accessKeyId: z.string().max(256).default(''), secretAccessKey: z.string().max(512).default(''),
})
export const backupStorageStatusSchema = z.object({ configured: z.boolean(), endpoint: z.string(), bucket: z.string(), region: z.string(), verified: z.boolean() })
export const backupStorageSavedSchema = backupStorageStatusSchema.extend({ recoveryKey: z.string().optional() })
export const cloudUpdateInputSchema = z.object({ repository: z.string().trim().max(140).regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/), workflow: z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.ya?ml$/).max(100).default('installation-update.yml'), token: z.string().trim().max(512).default('') })
export const cloudUpdateStatusSchema = z.object({ configured: z.boolean(), repository: z.string(), workflow: z.string(), verified: z.boolean() })
export type BackupStorageConfig = z.infer<typeof backupStorageInputSchema> & { recoveryKey: string; verified: boolean }
export type CloudUpdateConfig = z.infer<typeof cloudUpdateInputSchema> & { verified: boolean }
