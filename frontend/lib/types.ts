export type PublicUser = {
  userId: number
  username: string
  email: string
  role: string
  createdAt: string
  creditBalance: number
  creditLastReset: string
  emailNotificationsOn: boolean
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

export type MapBuilding = {
  id: number
  name: string
  address: string
  latitude: number
  longitude: number
  googlePlaceId: string | null
}

export type MapBuildingPhoto = {
  url: string
  authorAttributions: Array<{ displayName: string; uri: string }>
}

export type MapBuildingDetails = {
  building: MapBuilding
  photos: MapBuildingPhoto[]
  photoError: string | null
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

export type OwnerReservationReview = {
  reservationId: number
  reserver: { id: number; username: string }
  startTime: string
  endTime: string
  review: {
    rating: number
    reason: string | null
    createdAt: string
    isAnonymous: boolean
  } | null
}

export type UserReviewItem = {
  id: number
  reservationId: number
  rating: number
  reason: string | null
  createdAt: string
  resource: { id: number; name: string }
  reviewer: { id: number; username: string } | null
}

export type UserReviewPage = {
  profile: { id: number; username: string }
  items: UserReviewItem[]
  total: number
  page: number
  pageSize: number
  averageRating: number | null
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
  // Credits paid for this booking; null when no charge could be matched to it
  // (for example, bookings made before credits were charged).
  creditsCharged: number | null
  // Cancelling now (at least 24 hours before the start) returns creditsCharged.
  refundEligible: boolean
}

export type RefundStatus = 'refunded' | 'late' | 'not_charged' | 'unverified'

// Credit movement reported by a booking or cancellation request.
export type CreditChange = {
  charged: number
  refunded: number
  balance: number
  refundStatus?: RefundStatus
}

export type ReservationWriteResponse = {
  reservation: Reservation
  credits?: CreditChange
}

export type CreditSummary = {
  balance: number
  creditLastReset: string
  spent: number
  refunded: number
  granted: number
  received: number
  transactionCount: number
  // The history adds up to the balance, so the running balance column is reliable.
  historyMatchesBalance: boolean
}

export type CreditFilter = 'all' | 'charges' | 'refunds' | 'grants'

export type CreditTransaction = {
  id: number
  // 'initial_grant' | 'reservation_charge' | 'refund' | 'monthly_reset'
  type: string
  amount: number
  createdAt: string
  balanceAfter: number
  reservation: {
    id: number
    resource: NamedOption
    building: { name: string }
    startTime: string
    endTime: string
  } | null
}

export type CreditTransactionPage = {
  items: CreditTransaction[]
  total: number
  page: number
  pageSize: number
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

export type AppNotification = {
  id: number
  type: string
  message: string
  reservationId: number | null
  // Campus wall-clock time the notification was delivered.
  deliveredAt: string
  isRead: boolean
}

export type Inbox = {
  items: AppNotification[]
  unreadCount: number
  total: number
  page: number
  pageSize: number
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
  role: string
  createdAt: string
  emailVerifiedAt: string | null
  creditBalance: number
  isBanned: boolean
  canAddResources: boolean
  emailNotificationsOn: boolean
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

export type AdminResource = {
  id: number
  name: string
  building: { id: number; name: string }
  category: { id: number; name: string }
  owner: { id: number; username: string }
  createdAt: string
  upcomingReservations: number
}

// Day-grid availability. All times are minutes since midnight in campus time.
export type CalendarSpan = { start: number; end: number }

export type CalendarBooking = CalendarSpan & {
  // Only administrators receive the reservation id and the booker's username.
  id: number | null
  userId: number | null
  username: string | null
  status: string
  mine: boolean
}

export type CalendarResource = {
  id: number
  name: string
  building: NamedOption
  category: NamedOption
  capacity: number
  requiredCredits: number
  maxReservationMinutes: number | null
  windows: CalendarSpan[]
  bookings: CalendarBooking[]
  maintenance: Array<CalendarSpan & { reason: string }>
}

export type DayCalendar = {
  date: string
  today: string
  nowMinutes: number
  total: number
  limit: number
  resources: CalendarResource[]
}

export type AdminResourceDetail = ResourceDetails & {
  owner: { id: number; username: string }
  reservationCounts: Record<string, number>
  upcomingReservations: number
}

export type AdminStats = {
  users: { total: number; verified: number; unverified: number; banned: number; byRole: Record<string, number> }
  resources: { total: number }
  reservations: { total: number; byStatus: Record<string, number> }
  activity: Array<{ date: string; reservations: number; signups: number }>
}

// Mirrors db/repositories/analytics.ts. 'completed' is the stored status;
// 'past' is a confirmed reservation whose booked time has ended.
export type ReservationOutcome =
  | 'upcoming'
  | 'in_progress'
  | 'completed'
  | 'past'
  | 'no_show'
  | 'cancelled'
  | 'other'

export type OutcomeCounts = Record<ReservationOutcome, number>

export type UserAnalytics = {
  overview: {
    total: number
    upcoming: number
    past: number
    cancelled: number
    pastReservedHours: number
    byOutcome: OutcomeCounts
  }
  monthly: {
    // "YYYY-MM", oldest first.
    months: Array<{ month: string; total: number; byOutcome: OutcomeCounts }>
    beforeWindow: number
    afterWindow: number
  }
  categories: Array<{ id: number; name: string; reservations: number; hours: number }>
  topResources: Array<{
    id: number
    name: string
    building: NamedOption
    reservations: number
    hours: number
    lastReservedAt: string
  }>
}
