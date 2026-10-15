// Small GET helper for the authenticated JSON API. Throws an Error whose message
// is safe to show to the user.
export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let response: Response

  try {
    response = await fetch(url, { signal })
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
