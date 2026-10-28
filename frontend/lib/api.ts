// Small JSON helpers for the authenticated API. They throw an Error whose
// message is safe to show to the user.
export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  return requestJson<T>(url, { signal })
}

export async function sendJson<T>(method: 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<T> {
  return requestJson<T>(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

export function sendForm<T>(
  method: 'POST' | 'PATCH',
  url: string,
  body: FormData,
  onProgress?: (loaded: number, total: number) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open(method, url)
    request.responseType = 'json'
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded, event.total)
    })
    request.addEventListener('error', () => reject(new Error('Unable to connect to CampusConnect.')))
    request.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    request.addEventListener('load', () => {
      const payload = request.response as unknown
      if (request.status < 200 || request.status >= 300) {
        const message =
          payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
            ? payload.error
            : `Request failed (HTTP ${request.status}).`
        reject(new Error(message))
        return
      }
      resolve(payload as T)
    })
    request.send(body)
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
