export type AdminRouteId = 'overview' | 'users' | 'reservations' | 'resources'

export type AdminRoute = {
  id: AdminRouteId
  label: string
  description: string
  icon: string[]
}

export const ADMIN_BASE_PATH = '/admin'

export const adminRoutes: AdminRoute[] = [
  {
    id: 'overview',
    label: 'Overview',
    description: 'Totals for users, resources, and reservations.',
    icon: ['M4 13h6V4H4Z', 'M14 20h6V4h-6Z', 'M4 20h6v-4H4Z'],
  },
  {
    id: 'users',
    label: 'Users',
    description: 'Every registered account and its details.',
    icon: [
      'M9 5.5a3 3 0 1 1 0 6a3 3 0 1 1 0-6Z',
      'M3.5 19c.6-3.3 2.6-5 5.5-5s4.9 1.7 5.5 5',
      'M16 5.8a3 3 0 0 1 0 5.4',
      'M17.5 14.3c1.6.5 2.6 2 3 4.7',
    ],
  },
  {
    id: 'reservations',
    label: 'Reservations',
    description: 'All reservations across campus.',
    icon: ['M5 6.5h14v13H5Z', 'M5 10.5h14', 'M9 4v4', 'M15 4v4'],
  },
  {
    id: 'resources',
    label: 'Resources',
    description: 'Review and manage every listed resource.',
    icon: ['M4 4h7.5l8.5 8.5-7.5 7.5L4 11.5Z', 'M8.5 8.5h.01'],
  },
]

export const DEFAULT_ADMIN_ROUTE = adminRoutes[0]

export type AdminLocation = {
  route: AdminRoute
  // Second segment, e.g. the user id in "#/users/12".
  subpath: string | null
}

export function adminHash(id: string): string {
  return `#/${id}`
}

export function isAdminPath(pathname: string): boolean {
  return pathname === ADMIN_BASE_PATH || pathname.startsWith(`${ADMIN_BASE_PATH}/`)
}

export function parseAdminLocation(hash: string): AdminLocation {
  const match = hash.match(/^#\/([\w-]+)(?:\/(\d+))?\/?$/)
  const route = adminRoutes.find((candidate) => candidate.id === match?.[1])

  if (!match || !route) return { route: DEFAULT_ADMIN_ROUTE, subpath: null }
  return { route, subpath: route.id === 'users' ? match[2] ?? null : null }
}

export function adminLocationHash({ route, subpath }: AdminLocation): string {
  return `${adminHash(route.id)}${subpath ? `/${subpath}` : ''}`
}
