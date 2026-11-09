export class ApiError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

/** POST or PUT JSON; throws `ApiError` carrying the kit's error code on any non-2xx. */
export async function send<T = unknown>(url: string, method: 'POST' | 'PUT', body: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null
  if (!res.ok) {
    const code = data?.error?.code ?? 'store_error'
    const message = data?.error?.message ?? `request failed with status ${res.status}`
    throw new ApiError(code, message, res.status)
  }
  return data as T
}

export function describe(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`
  return err instanceof Error ? err.message : 'something went wrong'
}
