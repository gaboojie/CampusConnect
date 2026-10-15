export type RouteId = 'profile' | 'resources' | 'reservations' | 'listings' | 'notifications' | 'announcements'

export type AppRoute = {
  id: RouteId
  label: string
  description: string
  // Stroke-only SVG path data drawn in a 24×24 viewBox.
  icon: string[]
}

export const routes: AppRoute[] = [
  {
    id: 'profile',
    label: 'User Profile',
    description: 'Your account details, credits, and notification settings.',
    icon: [
      'M12 4.75a3.25 3.25 0 1 1 0 6.5a3.25 3.25 0 1 1 0-6.5Z',
      'M5.5 20c.7-3.7 2.9-5.5 6.5-5.5s5.8 1.8 6.5 5.5',
    ],
  },
  {
    id: 'resources',
    label: 'Browse Resources',
    description: 'Search campus resources by type, building, date, time, and availability.',
    icon: ['M10.5 4a6.5 6.5 0 1 1 0 13a6.5 6.5 0 1 1 0-13Z', 'M15.5 15.5 20 20'],
  },
  {
    id: 'reservations',
    label: 'My Reservations',
    description: 'View, edit, and cancel your upcoming and past reservations.',
    icon: ['M5 6.5h14v13H5Z', 'M5 10.5h14', 'M9 4v4', 'M15 4v4'],
  },
  {
    id: 'listings',
    label: 'My Listings',
    description: 'Add and manage the resources you offer to the Virginia Tech community.',
    icon: ['M4 4h7.5l8.5 8.5-7.5 7.5L4 11.5Z', 'M8.5 8.5h.01'],
  },
  {
    id: 'notifications',
    label: 'Notifications',
    description: 'Updates about your reservations and listings.',
    icon: ['M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15Z', 'M10 20.5a2 2 0 0 0 4 0'],
  },
  {
    id: 'announcements',
    label: 'Announcements',
    description: 'Campus-wide maintenance notices and newly listed resources.',
    icon: ['M4 10v4h3l8 4.5v-13L7 10Z', 'M18 9.5a3.5 3.5 0 0 1 0 5', 'M7 14l1.5 5h2.5L10 14'],
  },
]

export const DEFAULT_ROUTE = routes[0]

export function routeHash(id: RouteId): string {
  return `#/${id}`
}

export type AppLocation = {
  route: AppRoute
  // Second path segment, e.g. the resource id in "#/resources/12".
  subpath: string | null
  // Query string after "?", without the "?".
  query: string
}

// Routes that accept a numeric second segment.
const ROUTES_WITH_ID: RouteId[] = ['resources']

// Only "#/<id>" hashes are routes, so other hashes such as "#verify=<token>" are left alone.
export function parseLocation(hash: string): AppLocation {
  const match = hash.match(/^#\/([\w-]+)(?:\/([\w-]+))?\/?(?:\?(.*))?$/)
  const route = routes.find((candidate) => candidate.id === match?.[1])

  if (!match || !route) {
    return { route: DEFAULT_ROUTE, subpath: null, query: '' }
  }

  const subpath = match[2] && ROUTES_WITH_ID.includes(route.id) && /^\d+$/.test(match[2]) ? match[2] : null
  return { route, subpath, query: match[3] ?? '' }
}

export function locationHash({ route, subpath, query }: AppLocation): string {
  return `${routeHash(route.id)}${subpath ? `/${subpath}` : ''}${query ? `?${query}` : ''}`
}
