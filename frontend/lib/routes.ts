export type RouteId =
  | 'profile'
  | 'users'
  | 'resources'
  | 'maps'
  | 'reservations'
  | 'credits'
  | 'activity'
  | 'listings'
  | 'notifications'
  | 'announcements'
  | 'admin-overview'
  | 'admin-users'
  | 'admin-reservations'
  | 'admin-resources'

export type AppRoute = {
  id: RouteId
  label: string
  description: string
  // Stroke-only SVG path data drawn in a 24×24 viewBox.
  icon: string[]
  hidden?: boolean
  adminOnly?: boolean
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
    id: 'users',
    label: 'User Profile',
    description: 'View a CampusConnect user profile and their reservation reviews.',
    icon: [],
    hidden: true,
  },
  {
    id: 'resources',
    label: 'Browse Resources',
    description: 'Search campus resources by type, building, date, time, and availability.',
    icon: ['M10.5 4a6.5 6.5 0 1 1 0 13a6.5 6.5 0 1 1 0-13Z', 'M15.5 15.5 20 20'],
  },
  {
    id: 'maps',
    label: 'Maps',
    description: 'Explore Virginia Tech’s Blacksburg campus with an interactive map.',
    icon: [
      'M4 6.5 12 3l8 3.5-8 3.5L4 6.5Z',
      'M4 6.5v11L12 21l8-3.5v-11',
      'M12 10v11',
    ],
  },
  {
    id: 'reservations',
    label: 'My Reservations',
    description: 'View, edit, and cancel your upcoming and past reservations.',
    icon: ['M5 6.5h14v13H5Z', 'M5 10.5h14', 'M9 4v4', 'M15 4v4'],
  },
  {
    id: 'credits',
    label: 'My Credits',
    description: 'Your credit balance and the history of credits spent, refunded, and received.',
    icon: [
      'M12 3.75a8.25 8.25 0 1 1 0 16.5a8.25 8.25 0 1 1 0-16.5Z',
      'M14.5 9.5c-.35-.95-1.3-1.6-2.5-1.6-1.45 0-2.5.8-2.5 1.95 0 2.65 5 1.45 5 4.2 0 1.15-1.05 1.95-2.5 1.95-1.2 0-2.15-.65-2.5-1.6',
      'M12 6.4v1.5',
      'M12 16v1.6',
    ],
  },
  {
    id: 'activity',
    label: 'My Activity',
    description: 'Statistics about your reservations: monthly activity, categories, and favorite resources.',
    icon: ['M4 20h16', 'M7 16.5v-5', 'M12 16.5V7', 'M17 16.5v-8'],
  },
  {
    id: 'listings',
    label: 'My Listings',
    description: 'Add and manage the resources you offer to the Virginia Tech community.',
    icon: ['M4 4h7.5l8.5 8.5-7.5 7.5L4 11.5Z', 'M8.5 8.5h.01'],
  },
  {
    id: 'announcements',
    label: 'Announcements',
    description: 'Campus-wide maintenance notices and newly listed resources.',
    icon: ['M4 10v4h3l8 4.5v-13L7 10Z', 'M18 9.5a3.5 3.5 0 0 1 0 5', 'M7 14l1.5 5h2.5L10 14'],
  },
  {
    id: 'admin-overview',
    label: 'Overview',
    description: 'Totals for users, resources, and reservations.',
    icon: ['M4 13h6V4H4Z', 'M14 20h6V4h-6Z', 'M4 20h6v-4H4Z'],
    adminOnly: true,
  },
  {
    id: 'admin-users',
    label: 'Users',
    description: 'Every registered account and its details.',
    icon: [
      'M9 5.5a3 3 0 1 1 0 6a3 3 0 0 1-3-3a3 3 0 0 1 3-3Z',
      'M3.5 19c.6-3.3 2.6-5 5.5-5s4.9 1.7 5.5 5',
      'M16 5.8a3 3 0 0 1 0 5.4',
      'M17.5 14.3c1.6.5 2.6 2 3 4.7',
    ],
    adminOnly: true,
  },
  {
    id: 'admin-reservations',
    label: 'Reservations',
    description: 'All reservations across campus.',
    icon: ['M5 6.5h14v13H5Z', 'M5 10.5h14', 'M9 4v4', 'M15 4v4'],
    adminOnly: true,
  },
  {
    id: 'admin-resources',
    label: 'Resources',
    description: 'Review and manage every listed resource.',
    icon: ['M4 4h7.5l8.5 8.5-7.5 7.5L4 11.5Z', 'M8.5 8.5h.01'],
    adminOnly: true,
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
const ROUTES_WITH_ID: RouteId[] = ['resources', 'listings', 'users', 'admin-users']

// Only "#/<id>" hashes are routes, so other hashes such as "#verify=<token>" are left alone.
export function parseLocation(hash: string): AppLocation {
  const match = hash.match(/^#\/([\w-]+)(?:\/([\w-]+))?\/?(?:\?(.*))?$/)
  const route = routes.find((candidate) => candidate.id === match?.[1])

  if (!match || !route) {
    return { route: DEFAULT_ROUTE, subpath: null, query: '' }
  }

  const subpath = match[2] && ROUTES_WITH_ID.includes(route.id) && /^[1-9]\d*$/.test(match[2]) ? match[2] : null
  if (route.id === 'users' && subpath === null) {
    return { route: DEFAULT_ROUTE, subpath: null, query: '' }
  }
  return { route, subpath, query: match[3] ?? '' }
}

export function locationHash({ route, subpath, query }: AppLocation): string {
  return `${routeHash(route.id)}${subpath ? `/${subpath}` : ''}${query ? `?${query}` : ''}`
}
