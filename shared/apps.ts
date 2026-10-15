import { z } from 'zod'
import { idSchema, messageResultSchema } from './contracts'

// Only DNS HTTPS destinations are accepted; installation owners explicitly allow each origin.
export const appUrlSchema = z.string().max(2048).refine(value => {
  try {
    const u = new URL(value), host = u.hostname.toLowerCase()
    return u.protocol === 'https:' && !u.username && !u.password && !u.hash && !u.port &&
      /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) && host.includes('.') &&
      !/^[\d.]+$/.test(host) && !/(?:^|\.)(localhost|local|internal|invalid|test)$/.test(host)
  } catch { return false }
}, 'Use a public HTTPS domain without credentials, a port or fragment')
export const appPolicySchema = z.object({
  enabled: z.boolean(),
  allowedOrigins: z.array(appUrlSchema.refine(v => new URL(v).origin === v, 'Enter an origin such as https://hooks.example.com')).max(20),
})
const commandName = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/)
export const commandSchema = z.object({
  name: commandName, description: z.string().trim().min(1).max(120),
  arguments: z.array(z.object({ name: commandName, type: z.enum(['string', 'integer', 'boolean']), required: z.boolean().default(false) })).max(10).default([]),
}).refine(v => new Set(v.arguments.map(a => a.name)).size === v.arguments.length, 'Argument names must be unique')
export const appConfigSchema = z.object({
  name: z.string().trim().min(2).max(50), avatarUrl: z.union([z.literal(''), appUrlSchema]).default(''),
  kind: z.enum(['webhook', 'ping']).default('webhook'),
  channelIds: z.array(idSchema).min(1).max(50).refine(v => new Set(v).size === v.length, 'Choose each channel once'),
  enabled: z.boolean().default(true), endpointUrl: z.union([z.literal(''), appUrlSchema]).default(''),
  events: z.array(z.literal('message.created')).max(1).default([]), commands: z.array(commandSchema).max(20).default([]),
}).superRefine((v, ctx) => {
  if (new Set(v.commands.map(c => c.name)).size !== v.commands.length) ctx.addIssue({ code: 'custom', message: 'Command names must be unique', path: ['commands'] })
  if (v.kind === 'ping' && (v.endpointUrl || v.events.length || v.commands.length)) ctx.addIssue({ code: 'custom', message: 'Ping uses its built-in /ping command only' })
  if (v.kind !== 'ping' && (v.events.length || v.commands.length) && !v.endpointUrl) ctx.addIssue({ code: 'custom', message: 'An event endpoint is required', path: ['endpointUrl'] })
})
export const appSchema = appConfigSchema.extend({ id: idSchema, workspaceId: idSchema, status: z.enum(['active', 'disabled', 'policy-blocked']), createdAt: z.number(), permissions: z.array(z.string()) })
export const appCredentialSchema = z.object({ app: appSchema, token: z.string(), signingSecret: z.string() })
export const webhookMessageSchema = z.object({ id: z.uuid(), channelId: idSchema, text: z.string().trim().min(1).max(4000) }).strict()
export const commandInvokeSchema = z.object({ id: z.uuid(), appId: idSchema, name: commandName, arguments: z.record(z.string(), z.union([z.string().max(1000), z.number().int().min(-2147483648).max(2147483647), z.boolean()])).default({}) }).strict()
export const commandResultSchema = z.object({ id: z.uuid(), status: z.enum(['pending', 'completed', 'failed', 'cancelled']), message: messageResultSchema.nullable(), error: z.string().nullable() })
export const commandRegistrySchema = z.array(commandSchema.extend({ appId: idSchema, appName: z.string() }))
export const appAuditSchema = z.array(z.object({ id: idSchema, appId: idSchema.nullable(), actorId: idSchema, action: z.string(), createdAt: z.number() }))
export const appDeliverySchema = z.array(z.object({ id: idSchema, appId: idSchema, type: z.string(), status: z.string(), attempts: z.number(), createdAt: z.number(), lastError: z.string().nullable() }))
export type AppConfig = z.infer<typeof appConfigSchema>
export type AppCommand = z.infer<typeof commandSchema>
export const pingCommand: AppCommand = { name: 'ping', description: 'Check that this app is responding', arguments: [] }
export function validateCommandArguments(command: AppCommand, args: Record<string, unknown>) {
  const shape: Record<string, z.ZodType> = {}
  for (const arg of command.arguments) {
    const schema = arg.type === 'string' ? z.string().max(1000) : arg.type === 'integer' ? z.number().int().min(-2147483648).max(2147483647) : z.boolean()
    shape[arg.name] = arg.required ? schema : schema.optional()
  }
  return z.object(shape).strict().parse(args)
}

export class CommandInputError extends Error {}

// A small positional command grammar: /echo "hello world" 2 true.
// An app suffix disambiguates commands with the same name.
export function parseSlashCommand(text: string, registry: z.infer<typeof commandRegistrySchema>) {
  const match = /^\/([a-z][a-z0-9_-]*)(?:@([a-f0-9-]+))?(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match) throw new CommandInputError('Choose a slash command from the command list')
  const matches = registry.filter(c => c.name === match[1] && (!match[2] || c.appId === match[2]))
  if (matches.length !== 1) throw new CommandInputError(matches.length ? 'Several apps provide this command. Choose one from the command list.' : 'This command is unavailable in this channel')
  const command = matches[0]!, tokens: string[] = []
  let remaining = (match[3] || '').trim()
  while (remaining) {
    const token = /^("(?:[^"\\]|\\.)*"|[^\s"]+)(?:\s+|$)/.exec(remaining)
    if (!token) throw new CommandInputError('Use double quotes around arguments containing spaces')
    tokens.push(token[1]!); remaining = remaining.slice(token[0].length)
  }
  if (tokens.length > command.arguments.length) throw new CommandInputError('Too many command arguments')
  const args: Record<string, string | number | boolean> = {}
  for (let i = 0; i < tokens.length; i++) {
    const arg = command.arguments[i]!, token = tokens[i]!, value: string = token.startsWith('"') ? JSON.parse(token) : token
    if (arg.type === 'string') args[arg.name] = value
    else if (arg.type === 'integer' && /^-?\d+$/.test(value)) args[arg.name] = Number(value)
    else if (arg.type === 'boolean' && /^(true|false)$/.test(value)) args[arg.name] = value === 'true'
    else throw new CommandInputError(`${arg.name} must be ${arg.type === 'integer' ? 'an integer' : 'true or false'}`)
  }
  try { validateCommandArguments(command, args) } catch { throw new CommandInputError('Check the required arguments and types shown in the command list') }
  return { appId: command.appId, name: command.name, arguments: args }
}
