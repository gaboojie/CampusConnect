import { Hono } from "hono";
import type { Context, Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  createSessionToken,
  createEmailVerificationToken,
  hashEmailVerificationToken,
  hashPassword,
  hashSessionToken,
  serializeUser,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  type PublicUser,
  validateChangePasswordInput,
  validateSignupInput,
  verifyPassword,
} from "./auth";
import {
  defaultDatabaseClientFactory,
  withDatabase,
  type DatabaseClient,
  type DatabaseClientFactory,
} from "../db/client";
import {
  createSessionRecord,
  createSignupRecord,
  createVerificationTokenRecord,
  deleteAccount,
  deleteSession,
  findAuthenticatedUser,
  clearFailedLogins,
  findLoginUser,
  recordFailedLogin,
  getPasswordHash,
  healthCheck,
  updatePassword,
  updateNotificationSettings,
  updateProfileImage,
  updateUsername,
  verifyEmailToken,
} from "../db/repositories/auth";
import {
  getResourceDetails,
  getResourceFilters,
  parsePositiveId,
  parseResourceSearch,
  searchResources,
} from "../db/repositories/resources";
import {
  createListing,
  deleteListing,
  getImageMetadata,
  getOwnedResource,
  listOwnedResources,
  parseListingInput,
  updateListing,
} from "../db/repositories/listings";
import { getAnnouncements, parseAnnouncementQuery } from "../db/repositories/announcements";
import { getMyAnalytics } from "../db/repositories/analytics";
import {
  findMapBuildingById,
  listMapBuildings,
} from "../db/repositories/maps";
import { fetchPlacePhotos, type PlacePhoto } from "./places";
import {
  createReservationReview,
  listOwnerReservationReviews,
  listUserReservationReviews,
  parseReservationReviewInput,
  parseReviewPageQuery,
} from "../db/repositories/reservationReviews";
import { getDayCalendar, parseCalendarQuery } from "../db/repositories/calendar";
import {
  listInbox,
  markAllInboxNotificationsRead,
  markInboxNotificationRead,
  parseInboxQuery,
} from "../db/repositories/inbox";
import {
  createUser as createAdminUser,
  deleteResource as deleteAdminResource,
  deleteUserAccount,
  getAdminResourceDetail,
  getStats,
  getUserDetail,
  listAdminResources,
  listReservations,
  listUsers,
  parseAdminCreateUser,
  parseAdminReservationQuery,
  parseAdminResourceQuery,
  parseAdminUpdateUser,
  parseAdminUserQuery,
  updateUser as updateAdminUser,
} from "../db/repositories/admin";
import {
  cancelReservation,
  createReservation,
  listMyReservations,
  parseCreateReservation,
  parseReservationSlot,
  rescheduleReservation,
  type Reservation,
  type ServiceResult,
} from "../db/repositories/reservations";
import {
  applyMonthlyCreditResets,
  getCreditSummary,
  listCreditTransactions,
  parseCreditTransactionQuery,
} from "../db/repositories/credits";
import {
  NotificationWorkflow,
  repairPendingNotificationWorkflows,
  startNotificationWorkflows,
  type NotificationWorkflowBinding,
} from "./notification-workflow";
import type { NotificationWorkflowPayload } from "../db/repositories/notifications";

type Bindings = {
  ASSETS: Fetcher;
  DB?: Hyperdrive;
  RESOURCE_IMAGES?: R2Bucket;
  APP_ENV?: string;
  PUBLIC_APP_ORIGIN?: string;
  GOOGLE_MAPS_JAVASCRIPT_API_KEY?: string;
  GOOGLE_MAPS_MAP_ID?: string;
  GOOGLE_PLACES_API_KEY?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  NOTIFICATION_WORKFLOW?: Workflow<NotificationWorkflowPayload>;
};

type AppEnv = {
  Bindings: Bindings;
  Variables: {
    user: PublicUser;
  };
};

type AppOptions = {
  createDatabaseClient?: DatabaseClientFactory;
  fetchGooglePlaces?: typeof fetch;
  sendVerificationEmail?: VerificationEmailSender;
  startNotificationWorkflows?: (
    binding: NotificationWorkflowBinding,
    notifications: Array<{ notificationId: number; workflowId?: string | null }>,
  ) => Promise<void>;
};

type LoginBody = {
  identifier?: unknown;
  password?: unknown;
};

type VerificationEmail = {
  email: string;
  token: string;
  userId: number;
};

type VerificationEmailSender = (email: VerificationEmail) => Promise<void>;

type VerificationBody = {
  token?: unknown;
};

type ResendVerificationBody = {
  email?: unknown;
};

const VERIFICATION_MESSAGE =
  "Check your Virginia Tech email to verify your account before signing in.";

const PUBLIC_API_PATHS = new Set([
  "/api/health",
  "/api/auth/signup",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/verify-email",
  "/api/auth/resend-verification",
]);

function databaseUnavailable(c: Context<AppEnv>) {
  return c.json({ ok: false, error: "Database is not configured" }, 503);
}

function getCookieOptions(c: Context<AppEnv>, expiresAt?: Date) {
  return {
    httpOnly: true,
    sameSite: "Lax" as const,
    secure: c.env.APP_ENV === "production",
    path: "/",
    ...(expiresAt
      ? { expires: expiresAt, maxAge: SESSION_TTL_SECONDS }
      : {}),
  };
}

function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE_NAME, {
    path: "/",
    secure: c.env.APP_ENV === "production",
  });
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

function isBannedPathAllowed(path: string): boolean {
  return path === "/api/auth/me" ||
    path === "/api/auth/delete-account" ||
    /^\/api\/profile-images\/\d+$/.test(path);
}

function currentSessionHash(c: Context<AppEnv>): Promise<string> {
  return hashSessionToken(getCookie(c, SESSION_COOKIE_NAME) ?? "");
}

async function readJson(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

function getVerificationLink(c: Context<AppEnv>, token: string): string {
  const origin = c.env.PUBLIC_APP_ORIGIN;
  if (!origin) {
    throw new Error("PUBLIC_APP_ORIGIN is not configured");
  }

  return `${origin.replace(/\/$/, "")}/#verify=${encodeURIComponent(token)}`;
}

function createDefaultVerificationEmailSender(
  c: Context<AppEnv>,
): VerificationEmailSender {
  return async ({ email, token, userId }) => {
    if (!c.env.RESEND_API_KEY || !c.env.RESEND_FROM_EMAIL) {
      throw new Error("Resend is not configured");
    }

    const verificationLink = getVerificationLink(c, token);
    const tokenHash = await hashEmailVerificationToken(token);
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `campusconnect-verification-${userId}-${tokenHash}`,
      },
      body: JSON.stringify({
        from: c.env.RESEND_FROM_EMAIL,
        to: [email],
        subject: "Verify your CampusConnect email",
        text: [
          "Verify your CampusConnect email",
          "",
          "Use the link below to confirm that you control this Virginia Tech email address:",
          verificationLink,
          "",
          "CampusConnect is a CS 5614 class project. Do not share sensitive information.",
        ].join("\n"),
        html: `
          <p>Verify your CampusConnect email.</p>
          <p><a href="${verificationLink}">Verify email</a></p>
          <p>CampusConnect is a CS 5614 class project. Do not share sensitive information.</p>
        `,
      }),
    });

    if (!response.ok) {
      throw new Error(`Resend returned HTTP ${response.status}`);
    }
  };
}

async function sendVerificationEmail(
  sender: VerificationEmailSender,
  email: VerificationEmail,
): Promise<void> {
  try {
    await sender(email);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    console.error(`Verification email could not be sent: ${reason}`);
  }
}

function setSessionCookie(
  c: Context<AppEnv>,
  token: string,
  expiresAt: Date,
): void {
  setCookie(c, SESSION_COOKIE_NAME, token, getCookieOptions(c, expiresAt));
}

async function requireAuthentication(
  c: Context<AppEnv>,
  next: Next,
  createDatabaseClient: DatabaseClientFactory,
) {
  const token = getCookie(c, SESSION_COOKIE_NAME);
  const path = new URL(c.req.url).pathname;

  if (!token) {
    return c.json({ error: "Authentication required" }, 401);
  }
  if (!c.env.DB) {
    return databaseUnavailable(c);
  }

  try {
    const tokenHash = await hashSessionToken(token);
    const user = await withDatabase(
      c.env.DB.connectionString,
      createDatabaseClient,
      (client) => findAuthenticatedUser(client, tokenHash),
    );

    if (!user) {
      clearSessionCookie(c);
      return c.json({ error: "Your session has expired. Please log in again." }, 401);
    }

    const publicUser = serializeUser(user);
    c.set("user", publicUser);
    if (publicUser.isBanned && publicUser.role !== "admin" && !isBannedPathAllowed(path)) {
      return c.json({ error: "Your account is banned. Only your profile and account deletion are available." }, 403);
    }
    return next();
  } catch {
    return c.json({ error: "Authentication service unavailable" }, 503);
  }
}

export function createApp(options: AppOptions = {}) {
  const createDatabaseClient =
    options.createDatabaseClient ?? defaultDatabaseClientFactory;
  const app = new Hono<AppEnv>();

  app.use("/api/*", async (c, next) => {
    const path = new URL(c.req.url).pathname;

    if (PUBLIC_API_PATHS.has(path)) {
      return next();
    }

    return requireAuthentication(c, next, createDatabaseClient);
  });

  app.use("/api/admin/*", async (c, next) => {
    if (c.get("user").role !== "admin") {
      return c.json({ error: "Administrator access required." }, 403);
    }

    return next();
  });

  const getEmailSender = (c: Context<AppEnv>): VerificationEmailSender =>
    options.sendVerificationEmail ?? createDefaultVerificationEmailSender(c);
  const startWorkflows = options.startNotificationWorkflows ?? startNotificationWorkflows;

  const dispatchNotificationWorkflows = async (
    c: Context<AppEnv>,
    notificationIds: number[] | undefined,
  ): Promise<void> => {
    if (!c.env.NOTIFICATION_WORKFLOW || !notificationIds?.length) return;
    try {
      await startWorkflows(
        c.env.NOTIFICATION_WORKFLOW,
        notificationIds.map((notificationId) => ({ notificationId })),
      );
    } catch (error) {
      console.error(`Unable to dispatch notification workflows: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const enqueueNotificationWorkflows = (
    c: Context<AppEnv>,
    notificationIds: number[] | undefined,
  ): void => {
    if (!c.env.NOTIFICATION_WORKFLOW || !notificationIds?.length) return;
    const dispatch = dispatchNotificationWorkflows(c, notificationIds);
    if (typeof c.executionCtx?.waitUntil === "function") {
      c.executionCtx.waitUntil(dispatch);
    } else {
      void dispatch;
    }
  };

  app.get("/api/health", async (c) => {
    if (!c.env.DB) {
      return c.json(
        {
          ok: false,
          database: "not-configured",
        },
        503,
      );
    }

    try {
      await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => healthCheck(client),
      );

      return c.json({
        ok: true,
        database: "connected",
      });
    } catch {
      return c.json(
        {
          ok: false,
          database: "unavailable",
        },
        503,
      );
    }
  });

  app.post("/api/auth/signup", async (c) => {
    const validation = validateSignupInput(await readJson(c));

    if (!validation.ok) {
      return c.json(
        { error: "Please correct the highlighted fields.", fieldErrors: validation.fieldErrors },
        400,
      );
    }
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    const passwordHash = await hashPassword(validation.value.password);
    const verificationToken = await createEmailVerificationToken();
    const verificationTokenHash = await hashEmailVerificationToken(verificationToken);

    try {
      const result = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) =>
          createSignupRecord(client, {
            username: validation.value.username,
            email: validation.value.email,
            passwordHash,
            emailNotificationsOn: validation.value.emailNotificationsOn,
            verificationTokenHash,
          }),
      );

      await sendVerificationEmail(getEmailSender(c), {
        email: result.email,
        token: verificationToken,
        userId: result.user_id,
      });
      return c.json({ message: VERIFICATION_MESSAGE }, 201);
    } catch (error) {
      if (isUniqueViolation(error)) {
        return c.json({ error: "That username or email is already in use." }, 409);
      }

      return c.json({ error: "Unable to create the account right now." }, 503);
    }
  });

  app.post("/api/auth/verify-email", async (c) => {
    const body = (await readJson(c)) as VerificationBody | null;
    const token = typeof body?.token === "string" ? body.token.trim() : "";

    if (!token) {
      return c.json({ error: "That verification link is invalid." }, 400);
    }
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    try {
      const tokenHash = await hashEmailVerificationToken(token);
      const verified = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => verifyEmailToken(client, tokenHash),
      );

      if (!verified) {
        return c.json({ error: "That verification link is invalid or has already been used." }, 400);
      }

      return c.json({ message: "Email verified. You can sign in now." });
    } catch {
      return c.json({ error: "Unable to verify the email right now." }, 503);
    }
  });

  app.post("/api/auth/resend-verification", async (c) => {
    const body = (await readJson(c)) as ResendVerificationBody | null;
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";

    if (!email) {
      return c.json({ error: "Enter your email address." }, 400);
    }
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    const token = await createEmailVerificationToken();
    const tokenHash = await hashEmailVerificationToken(token);

    try {
      const result = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => createVerificationTokenRecord(client, email, tokenHash),
      );

      if (result) {
        await sendVerificationEmail(getEmailSender(c), {
          ...result,
          token,
        });
      }

      return c.json({ message: VERIFICATION_MESSAGE }, 202);
    } catch {
      return c.json({ error: "Unable to resend the verification email right now." }, 503);
    }
  });

  app.post("/api/auth/login", async (c) => {
    const body = (await readJson(c)) as LoginBody | null;
    const identifier = typeof body?.identifier === "string" ? body.identifier.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";

    if (!identifier || !password) {
      return c.json({ error: "Enter your username or email and password." }, 400);
    }
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    try {
      const result = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        async (client) => {
          const user = await findLoginUser(client, identifier);

          if (!user) {
            return null;
          }
          if (user.is_account_deleted) {
            return { kind: "deleted" as const };
          }

          // While locked, even the correct password is refused.
          const lockSeconds = Number(user.lock_seconds_remaining ?? 0);
          if (lockSeconds > 0) {
            return { kind: "locked" as const, seconds: lockSeconds };
          }
          if (!user.email_verified_at) {
            return null;
          }
          if (!(await verifyPassword(password, user.password_hash))) {
            const failure = await recordFailedLogin(client, user.user_id);
            return failure.locked ? { kind: "locked" as const, seconds: failure.lockSeconds } : null;
          }

          await clearFailedLogins(client, user.user_id);
          const token = await createSessionToken();
          const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
          const tokenHash = await hashSessionToken(token);
          await createSessionRecord(client, user.user_id, tokenHash, expiresAt);
          return { kind: "session" as const, session: { token, expiresAt }, user };
        },
      );

      if (result?.kind === "deleted") {
        return c.json({ error: "Your account has been deleted." }, 403);
      }
      if (result?.kind === "locked") {
        const minutes = Math.max(1, Math.ceil(result.seconds / 60));
        return c.json(
          {
            error: `Too many failed sign-in attempts. Please wait ${minutes} ${minutes === 1 ? "minute" : "minutes"} before trying again.`,
            retryAfterSeconds: result.seconds,
          },
          429,
          { "Retry-After": String(result.seconds) },
        );
      }
      if (!result) {
        return c.json({ error: "Invalid username/email or password." }, 401);
      }

      setSessionCookie(c, result.session.token, result.session.expiresAt);
      return c.json({ user: serializeUser(result.user) });
    } catch {
      return c.json({ error: "Unable to sign in right now." }, 503);
    }
  });

  app.post("/api/auth/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE_NAME);

    if (token && c.env.DB) {
      try {
        const tokenHash = await hashSessionToken(token);
        await withDatabase(
          c.env.DB.connectionString,
          createDatabaseClient,
          (client) => deleteSession(client, tokenHash),
        );
      } catch {
        clearSessionCookie(c);
        return c.json({ error: "Unable to sign out right now." }, 503);
      }
    }

    clearSessionCookie(c);
    return c.body(null, 204);
  });

  app.post("/api/auth/change-password", async (c) => {
    const validation = validateChangePasswordInput(await readJson(c));

    if (!validation.ok) {
      return c.json(
        { error: "Please correct the highlighted fields.", fieldErrors: validation.fieldErrors },
        400,
      );
    }
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    const userId = c.get("user").userId;
    const currentTokenHash = await hashSessionToken(getCookie(c, SESSION_COOKIE_NAME) ?? "");

    try {
      const changed = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        async (client) => {
          const passwordHash = await getPasswordHash(client, userId);

          if (
            !(await verifyPassword(
              validation.value.currentPassword,
              passwordHash,
            ))
          ) {
            return false;
          }

          const nextPasswordHash = await hashPassword(validation.value.newPassword);
          await updatePassword(client, userId, nextPasswordHash, currentTokenHash);
          return true;
        },
      );

      if (!changed) {
        return c.json(
          {
            error: "Please correct the highlighted fields.",
            fieldErrors: { currentPassword: "Your current password is incorrect." },
          },
          400,
        );
      }

      return c.json({ message: "Your password has been updated." });
    } catch {
      return c.json({ error: "Unable to change your password right now." }, 503);
    }
  });

  app.patch("/api/profile/username", async (c) => {
    const body = await readJson(c);
    const values = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const username = typeof values.username === "string" ? values.username.trim() : "";
    if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) {
      return c.json({ error: "Use 3–32 letters, numbers, or underscores." }, 400);
    }
    if (!c.env.DB) return databaseUnavailable(c);

    try {
      const user = await withDatabase(c.env.DB.connectionString, createDatabaseClient, async (client) => {
        await updateUsername(client, c.get("user").userId, username);
        return findAuthenticatedUser(client, await currentSessionHash(c));
      });
      if (!user) return c.json({ error: "Your session has expired. Please log in again." }, 401);
      return c.json({ user: serializeUser(user), message: "Your username has been updated." });
    } catch (error) {
      if (isUniqueViolation(error)) return c.json({ error: "That username is already in use." }, 409);
      return c.json({ error: "Unable to update your username right now." }, 503);
    }
  });

  app.patch("/api/profile/notifications", async (c) => {
    const body = await readJson(c);
    const values = body && typeof body === "object" ? body as Record<string, unknown> : {};
    if (typeof values.emailNotificationsOn !== "boolean") {
      return c.json({ error: "Choose whether email notifications are on or off." }, 400);
    }
    if (!c.env.DB) return databaseUnavailable(c);

    try {
      const user = await withDatabase(c.env.DB.connectionString, createDatabaseClient, async (client) => {
        await updateNotificationSettings(
          client,
          c.get("user").userId,
          values.emailNotificationsOn as boolean,
        );
        return findAuthenticatedUser(client, await currentSessionHash(c));
      });
      if (!user) return c.json({ error: "Your session has expired. Please log in again." }, 401);
      return c.json({ user: serializeUser(user), message: "Notification settings have been updated." });
    } catch {
      return c.json({ error: "Unable to update notification settings right now." }, 503);
    }
  });

  app.patch("/api/profile/image", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.parseBody({ all: true }) as Record<string, unknown>;
    } catch {
      body = {};
    }
    const image = typeof File !== "undefined" && body.image instanceof File && body.image.size > 0
      ? body.image
      : null;
    const removeImage = body.removeImage === "true" || body.removeImage === true;
    if (!image && !removeImage) return c.json({ error: "Choose a profile image or remove the current image." }, 400);
    if (image && !new Set(["image/jpeg", "image/png", "image/webp"]).has(image.type)) {
      return c.json({ error: "Images must be JPEG, PNG, or WebP files." }, 400);
    }
    if (image && image.size > 1024 * 1024) return c.json({ error: "Images must be 1 MB or smaller." }, 400);
    if (!c.env.DB) return databaseUnavailable(c);

    try {
      const user = await withDatabase(c.env.DB.connectionString, createDatabaseClient, async (client) => {
        const result = await updateProfileImage(client, c.env.RESOURCE_IMAGES, c.get("user").userId, image, removeImage);
        if (!result.ok) return result;
        const nextUser = await findAuthenticatedUser(client, await currentSessionHash(c));
        return nextUser ? { ok: true as const, user: nextUser } : { ok: false as const, status: 401 as const, error: "Your session has expired. Please log in again." };
      });
      if (!user.ok) return c.json({ error: user.error }, user.status);
      return c.json({ user: serializeUser(user.user), message: "Your profile image has been updated." });
    } catch {
      return c.json({ error: "Unable to update your profile image right now." }, 503);
    }
  });

  app.delete("/api/auth/delete-account", async (c) => {
    const body = await readJson(c);
    const values = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const username = typeof values.username === "string" ? values.username.trim() : "";
    if (!username) return c.json({ error: "Type your username to confirm account deletion." }, 400);
    if (!c.env.DB) return databaseUnavailable(c);

    try {
      const deleted = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => deleteAccount(client, c.env.RESOURCE_IMAGES, c.get("user").userId, username),
      );
      if (!deleted) return c.json({ error: "The username you entered does not match your account." }, 400);
      clearSessionCookie(c);
      return c.body(null, 204);
    } catch {
      return c.json({ error: "Unable to delete your account right now." }, 503);
    }
  });

  app.get("/api/auth/me", (c) => c.json({ user: c.get("user") }));

  app.get("/api/maps/config", (c) => c.json({
    googleMapsJavaScriptApiKey: c.env.GOOGLE_MAPS_JAVASCRIPT_API_KEY?.trim() || null,
    mapId: c.env.GOOGLE_MAPS_MAP_ID?.trim() || null,
  }));

  app.get("/api/maps/buildings", async (c) => {
    if (!c.env.DB) return databaseUnavailable(c);

    try {
      const buildings = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => listMapBuildings(client),
      );
      return c.json({ buildings });
    } catch {
      return c.json({ error: "Unable to load campus buildings right now." }, 503);
    }
  });

  app.get("/api/maps/buildings/:id/details", async (c) => {
    const buildingId = parsePositiveId(c.req.param("id"));
    if (buildingId === null) {
      return c.json({ error: "Building id must be a positive whole number." }, 400);
    }
    if (!c.env.DB) return databaseUnavailable(c);

    try {
      const building = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => findMapBuildingById(client, buildingId),
      );
      if (!building) return c.json({ error: "Building not found." }, 404);

      const apiKey = c.env.GOOGLE_PLACES_API_KEY?.trim() || "";
      if (!building.googlePlaceId || !apiKey) {
        return c.json({
          building,
          photos: [],
          photoError: building.googlePlaceId && !apiKey
            ? "Google building photos are not configured for this environment."
            : null,
        });
      }

      let photos: PlacePhoto[] = [];
      let photoError: string | null = null;
      try {
        photos = await fetchPlacePhotos(
          building.googlePlaceId,
          apiKey,
          options.fetchGooglePlaces ?? fetch,
        );
      } catch {
        photoError = "Building photos are unavailable right now.";
      }

      return c.json({ building, photos, photoError });
    } catch {
      return c.json({ error: "Unable to load this building right now." }, 503);
    }
  });

  app.get("/api/profile-images/:id", async (c) => {
    const imageId = parsePositiveId(c.req.param("id"));
    if (imageId === null) return c.notFound();
    if (!c.env.DB || !c.env.RESOURCE_IMAGES) return c.notFound();
    try {
      const metadata = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => getImageMetadata(client, imageId),
      );
      if (!metadata || !metadata.objectKey.startsWith("users/")) return c.notFound();
      const object = await c.env.RESOURCE_IMAGES.get(metadata.objectKey);
      if (!object) return c.notFound();
      return new Response(object.body, {
        headers: {
          "Content-Type": object.httpMetadata?.contentType ?? metadata.contentType,
          "Content-Disposition": `inline; filename="${metadata.filename.replace(/["\\]/g, "_")}"`,
          "Cache-Control": "private, max-age=3600",
        },
      });
    } catch {
      return c.json({ error: "Unable to load this profile image right now." }, 503);
    }
  });

  app.get("/api/users/:id/reviews", async (c) => {
    const userId = parsePositiveId(c.req.param("id"));
    if (userId === null) return c.json({ error: "User id must be a positive whole number." }, 400);

    const query = parseReviewPageQuery(new URL(c.req.url).searchParams);
    if (!query.ok) return c.json({ error: query.error }, 400);
    if (!c.env.DB) return databaseUnavailable(c);

    try {
      const reviews = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => listUserReservationReviews(client, userId, query.value),
      );
      if (!reviews) return c.json({ error: "User not found." }, 404);
      return c.json(reviews);
    } catch {
      return c.json({ error: "Unable to load user reviews right now." }, 503);
    }
  });

  app.get("/api/resources", async (c) => {
    const search = parseResourceSearch(new URL(c.req.url).searchParams);

    if (!search.ok) {
      return c.json({ error: search.error }, 400);
    }
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    try {
      const result = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => searchResources(client, search.value),
      );
      return c.json(result);
    } catch {
      return c.json({ error: "Unable to load resources right now." }, 503);
    }
  });

  app.get("/api/resources/filters", async (c) => {
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    try {
      const filters = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => getResourceFilters(client),
      );
      return c.json(filters);
    } catch {
      return c.json({ error: "Unable to load filters right now." }, 503);
    }
  });

  app.get("/api/resources/:id", async (c) => {
    const resourceId = parsePositiveId(c.req.param("id"));

    if (resourceId === null) {
      return c.json({ error: "Resource id must be a positive whole number." }, 400);
    }
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    try {
      const resource = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => getResourceDetails(client, resourceId),
      );

      if (!resource) {
        return c.json({ error: "Resource not found." }, 404);
      }

      return c.json({ resource });
    } catch {
      return c.json({ error: "Unable to load this resource right now." }, 503);
    }
  });

  app.get("/api/listings", async (c) => {
    if (!c.env.DB) return databaseUnavailable(c);

    try {
      const listings = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => listOwnedResources(client, c.get("user").userId),
      );
      return c.json({ listings });
    } catch {
      return c.json({ error: "Unable to load your listings right now." }, 503);
    }
  });

  app.get("/api/listings/:id", async (c) => {
    const resourceId = parsePositiveId(c.req.param("id"));
    if (resourceId === null) return c.json({ error: "Listing id must be a positive whole number." }, 400);
    if (!c.env.DB) return databaseUnavailable(c);

    try {
      const result = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => getOwnedResource(client, resourceId, c.get("user").userId),
      );
      if (!result.ok) return c.json({ error: result.error }, result.status);
      return c.json({ listing: result.value });
    } catch {
      return c.json({ error: "Unable to load this listing right now." }, 503);
    }
  });

  app.get("/api/listings/:id/reservation-reviews", async (c) => {
    const resourceId = parsePositiveId(c.req.param("id"));
    if (resourceId === null) return c.json({ error: "Listing id must be a positive whole number." }, 400);
    if (!c.env.DB) return databaseUnavailable(c);

    try {
      const result = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => listOwnerReservationReviews(client, resourceId, c.get("user").userId),
      );
      if (!result.ok) return c.json({ error: result.error }, result.status);
      return c.json({ reservations: result.value });
    } catch {
      return c.json({ error: "Unable to load reservation reviews right now." }, 503);
    }
  });

  app.post("/api/listings/:id/reservation-reviews", async (c) => {
    const resourceId = parsePositiveId(c.req.param("id"));
    if (resourceId === null) return c.json({ error: "Listing id must be a positive whole number." }, 400);

    const input = parseReservationReviewInput(await readJson(c));
    if (!input.ok) return c.json({ error: input.error }, 400);
    if (!c.env.DB) return databaseUnavailable(c);

    try {
      const result = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => createReservationReview(client, resourceId, c.get("user").userId, input.value),
      );
      if (!result.ok) return c.json({ error: result.error }, result.status);
      return c.json({ reservation: result.value }, 201);
    } catch {
      return c.json({ error: "Unable to save this reservation review right now." }, 503);
    }
  });

  async function readListingForm(c: Context<AppEnv>): Promise<Record<string, unknown>> {
    try {
      const body = await c.req.parseBody({ all: true });
      return body as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  app.post("/api/listings", async (c) => {
    const user = c.get("user");
    if (!user.canAddResources) return c.json({ error: "Your account cannot add resources." }, 403);
    const parsed = parseListingInput(await readListingForm(c));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    if (!c.env.DB) return databaseUnavailable(c);

    try {
      const result = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => createListing(client, c.env.RESOURCE_IMAGES, user.userId, parsed.value),
      );
      if (!result.ok) return c.json({ error: result.error }, result.status);
      enqueueNotificationWorkflows(c, result.notificationIds);
      return c.json({ listing: result.value }, 201);
    } catch {
      return c.json({ error: "Unable to create the listing right now." }, 503);
    }
  });

  app.patch("/api/listings/:id", async (c) => {
    const resourceId = parsePositiveId(c.req.param("id"));
    if (resourceId === null) return c.json({ error: "Listing id must be a positive whole number." }, 400);
    const parsed = parseListingInput(await readListingForm(c));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    if (!c.env.DB) return databaseUnavailable(c);

    try {
      const result = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => updateListing(client, c.env.RESOURCE_IMAGES, c.get("user").userId, resourceId, parsed.value),
      );
      if (!result.ok) return c.json({ error: result.error }, result.status);
      enqueueNotificationWorkflows(c, result.notificationIds);
      return c.json({ listing: result.value });
    } catch {
      return c.json({ error: "Unable to update the listing right now." }, 503);
    }
  });

  app.delete("/api/listings/:id", async (c) => {
    const resourceId = parsePositiveId(c.req.param("id"));
    if (resourceId === null) return c.json({ error: "Listing id must be a positive whole number." }, 400);
    if (!c.env.DB) return databaseUnavailable(c);

    try {
      const result = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => deleteListing(client, c.env.RESOURCE_IMAGES, c.get("user").userId, resourceId),
      );
      if (!result.ok) return c.json({ error: result.error }, result.status);
      enqueueNotificationWorkflows(c, result.notificationIds);
      return c.body(null, 204);
    } catch {
      return c.json({ error: "Unable to delete the listing right now." }, 503);
    }
  });

  app.get("/api/resource-images/:id", async (c) => {
    const imageId = parsePositiveId(c.req.param("id"));
    if (imageId === null) return c.json({ error: "Image id must be a positive whole number." }, 400);
    if (!c.env.DB || !c.env.RESOURCE_IMAGES) return c.notFound();

    try {
      const metadata = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => getImageMetadata(client, imageId),
      );
      if (!metadata) return c.notFound();
      const object = await c.env.RESOURCE_IMAGES.get(metadata.objectKey);
      if (!object) return c.notFound();
      return new Response(object.body, {
        headers: {
          "Content-Type": object.httpMetadata?.contentType ?? metadata.contentType,
          "Content-Disposition": `inline; filename="${metadata.filename.replace(/[\"\\]/g, "_")}"`,
          "Cache-Control": "public, max-age=3600",
        },
      });
    } catch {
      return c.json({ error: "Unable to load this image right now." }, 503);
    }
  });

  app.get("/api/announcements", async (c) => {
    const query = parseAnnouncementQuery(new URL(c.req.url).searchParams);

    if (!query.ok) {
      return c.json({ error: query.error }, 400);
    }
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    try {
      const announcements = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => getAnnouncements(client, query.value),
      );
      return c.json({ announcements });
    } catch {
      return c.json({ error: "Unable to load announcements right now." }, 503);
    }
  });

  const runReservationWrite = async (
    c: Context<AppEnv>,
    successStatus: 200 | 201,
    work: (client: DatabaseClient) => Promise<ServiceResult<Reservation>>,
  ) => {
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    try {
      const result = await withDatabase(c.env.DB.connectionString, createDatabaseClient, work);

      if (!result.ok) {
        return c.json({ error: result.error }, result.status);
      }
      enqueueNotificationWorkflows(c, result.notificationIds);
      return c.json(
        result.credits ? { reservation: result.value, credits: result.credits } : { reservation: result.value },
        successStatus,
      );
    } catch {
      return c.json({ error: "Unable to save the reservation right now." }, 503);
    }
  };

  app.post("/api/reservations", async (c) => {
    const input = parseCreateReservation(await readJson(c));

    if (!input.ok) {
      return c.json({ error: input.error }, 400);
    }

    const userId = c.get("user").userId;
    return runReservationWrite(c, 201, (client) =>
      createReservation(client, userId, input.value),
    );
  });

  app.get("/api/reservations/mine", async (c) => {
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    try {
      const reservations = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => listMyReservations(client, c.get("user").userId),
      );
      return c.json(reservations);
    } catch {
      return c.json({ error: "Unable to load your reservations right now." }, 503);
    }
  });

  app.patch("/api/reservations/:id", async (c) => {
    const reservationId = parsePositiveId(c.req.param("id"));

    if (reservationId === null) {
      return c.json({ error: "Reservation id must be a positive whole number." }, 400);
    }

    const slot = parseReservationSlot(await readJson(c));
    if (!slot.ok) {
      return c.json({ error: slot.error }, 400);
    }

    const userId = c.get("user").userId;
    return runReservationWrite(c, 200, (client) =>
      rescheduleReservation(client, userId, reservationId, slot.value),
    );
  });

  app.post("/api/reservations/:id/cancel", async (c) => {
    const reservationId = parsePositiveId(c.req.param("id"));

    if (reservationId === null) {
      return c.json({ error: "Reservation id must be a positive whole number." }, 400);
    }

    const userId = c.get("user").userId;
    return runReservationWrite(c, 200, (client) =>
      cancelReservation(client, userId, reservationId),
    );
  });

  // Credits: always scoped to the session user; no endpoint accepts a user id.
  app.get("/api/credits", async (c) => {
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    try {
      const summary = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => getCreditSummary(client, c.get("user").userId),
      );
      if (!summary) {
        return c.json({ error: "Account not found." }, 404);
      }
      return c.json({ summary });
    } catch {
      return c.json({ error: "Unable to load your credits right now." }, 503);
    }
  });

  app.get("/api/credits/transactions", async (c) => {
    const query = parseCreditTransactionQuery(new URL(c.req.url).searchParams);

    if (!query.ok) {
      return c.json({ error: query.error }, 400);
    }
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    try {
      const page = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => listCreditTransactions(client, c.get("user").userId, query.value),
      );
      return c.json(page);
    } catch {
      return c.json({ error: "Unable to load your credit history right now." }, 503);
    }
  });

  // Analytics for the session user only; the route takes no user id.
  app.get("/api/analytics/me", async (c) => {
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    try {
      const analytics = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => getMyAnalytics(client, c.get("user").userId),
      );
      return c.json({ analytics });
    } catch {
      return c.json({ error: "Unable to load your activity right now." }, 503);
    }
  });

  // The signed-in user's in-app notifications: reminders that have come due and
  // cancellation notices, with read state.
  app.get("/api/notifications", async (c) => {
    const query = parseInboxQuery(new URL(c.req.url).searchParams);

    if (!query.ok) {
      return c.json({ error: query.error }, 400);
    }
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    try {
      const inbox = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => listInbox(client, c.get("user").userId, query.value),
      );
      return c.json(inbox);
    } catch {
      return c.json({ error: "Unable to load your notifications right now." }, 503);
    }
  });

  app.post("/api/notifications/read-all", async (c) => {
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    try {
      const updated = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => markAllInboxNotificationsRead(client, c.get("user").userId),
      );
      return c.json({ updated });
    } catch {
      return c.json({ error: "Unable to update your notifications right now." }, 503);
    }
  });

  app.post("/api/notifications/:id/read", async (c) => {
    const notificationId = parsePositiveId(c.req.param("id"));

    if (notificationId === null) {
      return c.json({ error: "Notification id must be a positive whole number." }, 400);
    }
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    try {
      const found = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => markInboxNotificationRead(client, c.get("user").userId, notificationId),
      );
      return found ? c.json({ read: true }) : c.json({ error: "Notification not found." }, 404);
    } catch {
      return c.json({ error: "Unable to update your notification right now." }, 503);
    }
  });

  // Day-grid availability for the calendar views. Everyone signed in can see which
  // slots are open or taken; only administrators also see who booked them.
  app.get("/api/calendar", async (c) => {
    const query = parseCalendarQuery(new URL(c.req.url).searchParams);

    if (!query.ok) {
      return c.json({ error: query.error }, 400);
    }
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    const viewer = { userId: c.get("user").userId, isAdmin: c.get("user").role === "admin" };

    try {
      const calendar = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => getDayCalendar(client, query.value, viewer),
      );
      return c.json(calendar);
    } catch {
      return c.json({ error: "Unable to load the calendar right now." }, 503);
    }
  });

  app.get("/api/admin/stats", async (c) => {
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    try {
      const stats = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => getStats(client),
      );
      return c.json({ stats });
    } catch {
      return c.json({ error: "Unable to load statistics right now." }, 503);
    }
  });

  app.get("/api/admin/users", async (c) => {
    const query = parseAdminUserQuery(new URL(c.req.url).searchParams);

    if (!query.ok) {
      return c.json({ error: query.error }, 400);
    }
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    try {
      const users = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => listUsers(client, query.value),
      );
      return c.json(users);
    } catch {
      return c.json({ error: "Unable to load users right now." }, 503);
    }
  });

  app.get("/api/admin/users/:id", async (c) => {
    const userId = parsePositiveId(c.req.param("id"));

    if (userId === null) {
      return c.json({ error: "User id must be a positive whole number." }, 400);
    }
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    try {
      const user = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => getUserDetail(client, userId),
      );

      if (!user) {
        return c.json({ error: "User not found." }, 404);
      }

      return c.json({ user });
    } catch {
      return c.json({ error: "Unable to load this user right now." }, 503);
    }
  });

  app.get("/api/admin/reservations", async (c) => {
    const query = parseAdminReservationQuery(new URL(c.req.url).searchParams);

    if (!query.ok) {
      return c.json({ error: query.error }, 400);
    }
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    try {
      const reservations = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => listReservations(client, query.value),
      );
      return c.json(reservations);
    } catch {
      return c.json({ error: "Unable to load reservations right now." }, 503);
    }
  });

  app.post("/api/admin/users", async (c) => {
    const validation = parseAdminCreateUser(await readJson(c));

    if (!validation.ok) {
      return c.json(
        { error: "Please correct the highlighted fields.", fieldErrors: validation.fieldErrors },
        400,
      );
    }
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    const { password, ...account } = validation.value;
    const passwordHash = await hashPassword(password);

    try {
      const user = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => createAdminUser(client, { ...account, passwordHash }),
      );
      return c.json({ user }, 201);
    } catch (error) {
      if (isUniqueViolation(error)) {
        return c.json({ error: "That username or email is already in use." }, 409);
      }
      return c.json({ error: "Unable to create the account right now." }, 503);
    }
  });

  app.patch("/api/admin/users/:id", async (c) => {
    const userId = parsePositiveId(c.req.param("id"));

    if (userId === null) {
      return c.json({ error: "User id must be a positive whole number." }, 400);
    }

    const validation = parseAdminUpdateUser(await readJson(c));
    if (!validation.ok) {
      return c.json(
        { error: "Please correct the highlighted fields.", fieldErrors: validation.fieldErrors },
        400,
      );
    }
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    const actingAdminId = c.get("user").userId;

    try {
      const result = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => updateAdminUser(client, actingAdminId, userId, validation.value),
      );

      if (!result.ok) {
        return c.json({ error: result.error }, result.status);
      }
      return c.json({ user: result.value });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return c.json({ error: "That username or email is already in use." }, 409);
      }
      return c.json({ error: "Unable to update this user right now." }, 503);
    }
  });

  app.delete("/api/admin/users/:id", async (c) => {
    const userId = parsePositiveId(c.req.param("id"));

    if (userId === null) {
      return c.json({ error: "User id must be a positive whole number." }, 400);
    }
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    const actingAdminId = c.get("user").userId;

    try {
      const result = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => deleteUserAccount(client, c.env.RESOURCE_IMAGES, actingAdminId, userId),
      );

      if (!result.ok) {
        return c.json({ error: result.error }, result.status);
      }
      return c.json({ deleted: true });
    } catch {
      return c.json({ error: "Unable to delete this account right now." }, 503);
    }
  });

  app.get("/api/admin/resources", async (c) => {
    const query = parseAdminResourceQuery(new URL(c.req.url).searchParams);

    if (!query.ok) {
      return c.json({ error: query.error }, 400);
    }
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    try {
      const resources = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => listAdminResources(client, query.value),
      );
      return c.json(resources);
    } catch {
      return c.json({ error: "Unable to load resources right now." }, 503);
    }
  });

  app.get("/api/admin/resources/:id", async (c) => {
    const resourceId = parsePositiveId(c.req.param("id"));

    if (resourceId === null) {
      return c.json({ error: "Resource id must be a positive whole number." }, 400);
    }
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    try {
      const resource = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => getAdminResourceDetail(client, resourceId),
      );

      if (!resource) {
        return c.json({ error: "Resource not found." }, 404);
      }
      return c.json({ resource });
    } catch {
      return c.json({ error: "Unable to load this resource right now." }, 503);
    }
  });

  app.delete("/api/admin/resources/:id", async (c) => {
    const resourceId = parsePositiveId(c.req.param("id"));

    if (resourceId === null) {
      return c.json({ error: "Resource id must be a positive whole number." }, 400);
    }
    if (!c.env.DB) {
      return databaseUnavailable(c);
    }

    try {
      const result = await withDatabase(
        c.env.DB.connectionString,
        createDatabaseClient,
        (client) => deleteAdminResource(client, c.env.RESOURCE_IMAGES, resourceId),
      );

      if (!result.ok) {
        return c.json({ error: result.error }, result.status);
      }
      enqueueNotificationWorkflows(c, result.notificationIds);
      return c.json({ deleted: true, cancelledReservations: result.value.cancelledReservations });
    } catch {
      return c.json({ error: "Unable to delete this resource right now." }, 503);
    }
  });

  app.all("*", async (c) => {
    const response = await c.env.ASSETS.fetch(c.req.raw);

    if (response.status !== 404) {
      return response;
    }

    return c.notFound();
  });

  return app;
}

export async function runMonthlyCreditSweep(
  env: Pick<Bindings, "DB">,
  createDatabaseClient: DatabaseClientFactory = defaultDatabaseClientFactory,
): Promise<Awaited<ReturnType<typeof applyMonthlyCreditResets>>> {
  if (!env.DB) {
    throw new Error("Database is not configured.");
  }

  return withDatabase(
    env.DB.connectionString,
    createDatabaseClient,
    (client) => applyMonthlyCreditResets(client),
  );
}

export async function scheduled(
  controller: ScheduledController,
  env: Bindings,
  createDatabaseClient: DatabaseClientFactory = defaultDatabaseClientFactory,
): Promise<void> {
  if (controller.cron === "0 6 * * *") {
    try {
      const result = await runMonthlyCreditSweep(env, createDatabaseClient);
      console.info(
        `Monthly credit sweep completed: ${result.usersProcessed} user(s), ` +
          `${result.periodsGranted} period(s), ${result.creditsGranted} credit(s).`,
      );
    } catch (error) {
      console.error(`Monthly credit sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    return;
  }

  if (controller.cron !== "*/15 * * * *") return;

  try {
    await repairPendingNotificationWorkflows(env, env.NOTIFICATION_WORKFLOW);
  } catch (error) {
    console.error(`Notification repair sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

const app = createApp();

export { NotificationWorkflow };
export default Object.assign(app, { scheduled });
