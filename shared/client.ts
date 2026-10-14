import { endpoints, endpointUrl, type EndpointInput, type EndpointName, type EndpointOutput } from './api'

type Transport = (url: string, options: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown }) => Promise<unknown>
export class ContractError extends Error {
  constructor(public endpoint: EndpointName) { super('The server returned an incompatible response. Refresh or check the server version.'); this.name = 'ContractError' }
}
export function createApiClient(transport: Transport) {
  return async function request<K extends EndpointName>(name: K, ...args: {} extends EndpointInput<K> ? [input?: EndpointInput<K>] : [input: EndpointInput<K>]): Promise<EndpointOutput<K>> {
    const spec = endpoints[name]
    const input = args[0]
    const url = endpointUrl(name, input?.params || {}, input?.query)
    const body = spec.body.parse(input?.body)
    const raw = await transport(url, { method: spec.method, ...(body === undefined ? {} : { body }) })
    const result = spec.response.safeParse(raw)
    // Do not include response contents: an invalid response may contain private data.
    if (!result.success) throw new ContractError(name)
    return result.data as EndpointOutput<K>
  }
}
