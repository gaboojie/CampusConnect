export type PublicUser = {
  userId: number
  username: string
  email: string
  phoneNumber: string | null
  role: string
  createdAt: string
  creditBalance: number
  creditLastReset: string
  emailNotificationsOn: boolean
  textNotificationsOn: boolean
  canAddResources: boolean
  isBanned: boolean
  profileImageUrl: string | null
}

// Timestamps from the resource and announcement APIs are campus wall-clock time
// without a time zone suffix, e.g. "2026-10-20T09:00:00".

export type NamedOption = {
  id: number
  name: string
}

export type ResourceSummary = {
  id: number
  name: string
  category: NamedOption
  building: NamedOption
  capacity: number
  shortDescription: string
  averageRating: number | null
  reviewCount: number
  thumbnailUrl: string | null
}

export type ResourceSearchResponse = {
  resources: ResourceSummary[]
  total: number
  limit: number
  offset: number
}

export type ResourceFilterOptions = {
  categories: NamedOption[]
  buildings: NamedOption[]
  features: string[]
}

export type AvailabilityRepeat = 'none' | 'daily' | 'every_other_day' | 'weekly' | 'every_other_week'

export type AvailabilitySlot = {
  id: number
  startTime: string
  endTime: string
  repeat: AvailabilityRepeat
  repeatsUntil: string | null
}

export type ResourceDetails = {
  id: number
  name: string
  description: string
  locationDescription: string
  category: NamedOption & { description: string }
  building: NamedOption & { address: string; latitude: number; longitude: number }
  capacity: number
  requiredCredits: number
  maxReservationMinutes: number | null
  ownerUsername: string
  createdAt: string
  averageRating: number | null
  reviewCount: number
  features: Array<{ name: string; description: string }>
  weeklyHours: Array<{
    date: string
    weekday: string
    windows: Array<{ opensAt: string; closesAt: string; allDay: boolean }>
  }>
  upcomingMaintenance: Array<{ id: number; startTime: string; endTime: string; reason: string }>
  images: Array<{ id: number; altText: string | null; url: string | null }>
  recentReviews: Array<{
    id: number
    rating: number
    reason: string | null
    createdAt: string
    reviewerUsername: string | null
  }>
}

export type ListingSummary = ResourceSummary & {
  hasActiveReservation: boolean
  activeReservation: { startTime: string; endTime: string } | null
}

export type ListingDetails = ResourceDetails & {
  hasActiveReservation: boolean
  activeReservation: { startTime: string; endTime: string } | null
  availability: AvailabilitySlot[]
}

export type ListingFormOptions = {
  categories: NamedOption[]
  buildings: NamedOption[]
}

export type Reservation = {
  id: number
  resource: NamedOption
  building: NamedOption
  startTime: string
  endTime: string
  // 'confirmed' | 'completed' | 'cancelled' | 'no_show'
  status: string
  createdAt: string
  // Confirmed and not started yet, so the time can be changed or it can be cancelled.
  canModify: boolean
}

export type MyReservationsResponse = {
  upcoming: Reservation[]
  past: Reservation[]
}

// Same-day slot in campus time: "YYYY-MM-DD", "HH:MM", "HH:MM".
export type SlotInput = {
  date: string
  start: string
  end: string
}

export type AnnouncementType = 'maintenance' | 'new'

export type Announcement = {
  id: string
  type: AnnouncementType
  title: string
  message: string
  date: string
  resourceId: number
}

export type AdminUser = {
  userId: number
  username: string
  email: string
  phoneNumber: string | null
  role: string
  createdAt: string
  emailVerifiedAt: string | null
  creditBalance: number
  isBanned: boolean
  canAddResources: boolean
  emailNotificationsOn: boolean
  textNotificationsOn: boolean
  status: 'active' | 'banned' | 'unverified'
}

export type AdminUserDetail = AdminUser & {
  creditLastReset: string
  resourcesOwned: number
  reservationCounts: Record<string, number>
}

export type AdminPage<T> = {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export type AdminReservation = {
  id: number
  status: string
  startTime: string
  endTime: string
  createdAt: string
  user: { id: number; username: string }
  resource: { id: number; name: string }
}

export type AdminStats = {
  users: { total: number; verified: number; unverified: number; banned: number; byRole: Record<string, number> }
  resources: { total: number }
  reservations: { total: number; byStatus: Record<string, number> }
}
