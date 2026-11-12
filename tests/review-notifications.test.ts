import { describe, expect, it } from "vitest";
import { createDueReviewNotifications } from "../db/repositories/notifications";
import { FakeReadDatabase } from "./support/fakeReadDatabase";

describe("review notification sweep", () => {
  it("creates idempotent in-app notifications for both review directions", async () => {
    const database = new FakeReadDatabase().respond('INSERT INTO "Notification" (', [
      { notification_id: 101 },
      { notification_id: 102 },
    ]);

    const created = await createDueReviewNotifications(database.createClient());

    expect(created).toBe(2);
    const query = database.queries[0];
    expect(query.values).toEqual(["resource_review_due", "user_review_due"]);
    expect(query.text).toContain("rv.status IN ('confirmed', 'completed')");
    expect(query.text).toContain("rv.status = 'completed'");
    expect(query.text).toContain("interval '7 days'");
    expect(query.text).toContain("review.review_id IS NULL");
    expect(query.text).toContain("rv.user_id <> resource.owner_id");
    expect(query.text).toContain("ON CONFLICT (user_id, reservation_id, notification_type)");
  });
});
