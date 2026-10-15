// Small JSON helpers for the authenticated API. They throw an Error whose
// message is safe to show to the user.
export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  return requestJson<T>(url, { signal })
}

export async function sendJson<T>(method: 'POST' | 'PATCH', url: string, body?: unknown): Promise<T> {
  return requestJson<T>(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
  let response: Response

  try {
    response = await fetch(url, init)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new Error('Unable to connect to CampusConnect.')
  }

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    // Non-JSON error bodies fall through to the generic message below.
  }

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : `Request failed (HTTP ${response.status}).`
    throw new Error(message)
  }

  return payload as T
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
