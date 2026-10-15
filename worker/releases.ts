import { releaseManifestSchema, stableVersion, compareVersions } from '../shared/operations'
import build from '../shared/build-info.json'
import { HttpError, digest } from './security'
import { z } from 'zod'

export const releaseRepository = 'inchidev/anycord'
async function boundedJson(response: Response) {
  if (!response.ok) throw new HttpError(502, 'Release service unavailable. Try again later.')
  const reader = response.body!.getReader(), chunks: Uint8Array[] = []; let length = 0
  while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 512_000) { await reader.cancel(); throw new HttpError(502, 'Release metadata exceeds the allowed size') } chunks.push(part.value) }
  const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return new TextDecoder().decode(bytes)
}
export async function publishedRelease(engine: 'cloudflare' | 'celld', version?: string) {
  if (version) stableVersion.parse(version)
  const endpoint = version ? `tags/v${version}` : 'latest'
  const metadata = z.object({ tag_name: z.string(), immutable: z.literal(true), draft: z.literal(false), prerelease: z.literal(false), body: z.string().nullable(), assets: z.array(z.object({ name: z.string(), digest: z.string().nullable().optional() })) }).parse(JSON.parse(await boundedJson(await fetch(`https://api.github.com/repos/${releaseRepository}/releases/${endpoint}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Anycord' }, signal: AbortSignal.timeout(10_000) }))))
  const selected = stableVersion.parse(metadata.tag_name.slice(1))
  if (metadata.tag_name !== `v${selected}` || (version && version !== selected)) throw new HttpError(502, 'Unexpected release identity')
  const text = await boundedJson(await fetch(`https://github.com/${releaseRepository}/releases/download/v${selected}/anycord-release.json`, { signal: AbortSignal.timeout(10_000) }))
  const asset = metadata.assets.find(a => a.name === 'anycord-release.json')
  if (!asset || (asset.digest && asset.digest !== `sha256:${await digest(text)}`)) throw new HttpError(502, 'Release manifest integrity check failed')
  const manifest = releaseManifestSchema.parse(JSON.parse(text))
  if (manifest.version !== selected) throw new HttpError(502, 'Release manifest version mismatch')
  const schemaCompatible = manifest.schema === build.schema || (manifest.upgrade?.migrations === 'backward-compatible' && manifest.upgrade.fromSchemas.includes(build.schema))
  return { version: selected, commit: manifest.commit, apiVersion: manifest.apiVersion, schema: manifest.schema, notes: (metadata.body || '').slice(0, 20_000), url: `https://github.com/${releaseRepository}/releases/tag/v${selected}`, compatible: manifest.apiVersion === build.apiVersion && schemaCompatible && manifest.engines.includes(engine) && compareVersions(selected, build.version) >= 0 }
}
