import { createAuth, ensureProfile } from './better-auth'
import { digest, HttpError } from './security'

export async function currentIdentity(request: Request, env: Env) {
  const session = await createAuth(env).api.getSession({ headers: request.headers })
  if (!session) return null
  const user = await ensureProfile(env, session.user)
  if (!user) return null
  return { user, sessionHash: await digest(session.session.token), expiresAt: new Date(session.session.expiresAt).getTime() }
}
export async function currentUser(request: Request, env: Env) { return (await currentIdentity(request, env))?.user || null }
export async function requireUser(request: Request, env: Env) {
  const user = await currentUser(request, env)
  if (!user) throw new HttpError(401, 'Sign in to continue')
  return user
}
