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

export type ResourceDetails = {
  id: number
  name: string
  description: string
  locationDescription: string
  category: NamedOption & { description: string }
  building: NamedOption & { address: string }
  latitude: number
  longitude: number
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
    windows: Array<{ opensAt: string; closesAt: string }>
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
