import { z } from 'zod'
import { attachmentSchema, idSchema, messageSchema } from './contracts'

export type MessageAttempt = { id: string; text: string; channelId: string; threadId?: string; replyToId?: string; attachmentIds?: string[] }
export const draftStateSchema = z.object({ text: z.string().max(4000), attachments: z.array(attachmentSchema).max(4).optional(), attempt: messageSchema.safeExtend({ channelId: idSchema }).optional(), threadDraft: z.object({ id: z.uuid(), name: z.string().max(100), createdId: idSchema.optional(), completedId: idSchema.optional() }).optional(), reply: z.object({ id: idSchema, author: z.string(), text: z.string(), channelId: idSchema, threadId: idSchema.nullable() }).optional() })
export type DraftState = z.infer<typeof draftStateSchema>
export function draftStoreKey(userId: string, scope = '') { return `anycord-message-drafts:${scope ? encodeURIComponent(scope) + ':' : ''}${encodeURIComponent(userId)}` }
export function prepareAttempt(previous: MessageAttempt | undefined, input: Omit<MessageAttempt, 'id'>, createId: () => string = () => crypto.randomUUID()): MessageAttempt {
  if (previous && previous.text === input.text && previous.channelId === input.channelId && previous.threadId === input.threadId && previous.replyToId === input.replyToId && JSON.stringify(previous.attachmentIds || []) === JSON.stringify(input.attachmentIds || [])) return previous
  return { ...input, id: createId() }
}
