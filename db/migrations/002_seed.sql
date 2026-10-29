-- =============================================================================
-- CampusConnect: Location-Aware Campus Resource Reservation System
-- Phase 4 - Seed data (PostgreSQL)
--
-- Run on a fresh database immediately after 001_schema.sql:
--   npm run migrate:dev
--
-- Snapshot: the data represents CampusConnect as of 2026-10-11 12:00
-- (America/New_York local time; columns are timestamp without time zone).
-- Reservations starting after that moment are 'confirmed'; earlier ones are
-- 'completed', 'cancelled', or 'no_show'.
--
-- Real data: building names, addresses, and coordinates come from official
-- vt.edu building pages; facility types come from recsports.vt.edu and
-- lib.vt.edu. Every reservable unit (e.g. "Group Study Room 4"), capacity,
-- credit price, availability window, maintenance period, user, reservation,
-- review, notification, session, and image record is SIMULATED.
-- See db/reference/vt_data_sources.txt for sources and assumptions.
--
-- Credit rules used (assumptions; not defined in the Phase 3 documents):
--   * New accounts receive 20 credits ('initial_grant').
--   * On the 1st of each month the balance is reset to 20; unused credits do
--     not roll over. A 'monthly_reset' row records the top-up amount and is
--     only written when the balance changes.
--   * Booking deducts the resource's required_credits once ('reservation_charge').
--   * Cancelling >= 24 hours before the start is fully refunded ('refund');
--     later cancellations and no-shows are not refunded.
--   * A cancellation caused by maintenance is always fully refunded.
--   * Suspended (is_banned) accounts do not receive monthly resets.
--   Therefore, for every user: credit_balance = SUM("CreditTransaction".amount).
--
-- Explicit IDs are used so rows can reference each other; identity sequences
-- are advanced at the end of this script.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- ImageMetadata (metadata matches db/reference/seed_images; R2 objects are uploaded separately)
-- -----------------------------------------------------------------------------
INSERT INTO "ImageMetadata" (image_id, object_key, content_type, size, width, height, alt_text, status, uploaded_at, filename) VALUES
    (1, 'resources/4/newman-group-study-4.jpg', 'image/jpeg', 116020, 900, 678, 'Group study room with a table, chairs, and a wall display', 'ready', '2026-08-14 10:05:00', 'newman-group-study-4.jpg'),
    (2, 'resources/10/mccomas-court-1.jpeg', 'image/jpeg', 41612, 678, 452, 'Indoor basketball court with hardwood floor', 'ready', '2026-08-14 10:20:00', 'mccomas-court-1.jpeg'),
    (3, 'resources/12/mccomas-lap-lane-1.jpg', 'image/jpeg', 160983, 1024, 768, 'Lap lane in an indoor pool', 'ready', '2026-08-14 10:30:00', 'mccomas-lap-lane-1.jpg'),
    (4, 'resources/14/war-memorial-racquetball-1.jpeg', 'image/jpeg', 10492, 547, 365, 'Enclosed racquetball court', 'ready', '2026-08-14 11:00:00', 'war-memorial-racquetball-1.jpeg'),
    (5, 'resources/20/war-memorial-yoga-studio.jpeg', 'image/jpeg', 4971, 299, 168, 'Yoga studio with mats laid out', 'ready', '2026-08-14 11:10:00', 'war-memorial-yoga-studio.jpeg'),
    (6, 'resources/21/squires-meeting-room-a.jpeg', 'image/jpeg', 32923, 638, 480, NULL, 'ready', '2026-08-14 14:30:00', 'squires-meeting-room-a.jpeg'),
    (7, 'users/6/avatar-1.jpeg', 'image/jpeg', 6328, 500, 500, 'Profile photo', 'ready', '2026-08-24 10:30:00', 'avatar-1.jpeg'),
    (8, 'users/8/avatar-2.jpeg', 'image/jpeg', 16396, 425, 470, NULL, 'ready', '2026-08-20 11:20:00', 'avatar-2.jpeg'),
    (9, 'users/12/avatar-3.png', 'image/png', 9496, 300, 300, 'Profile photo', 'ready', '2026-08-24 14:00:00', 'avatar-3.png');

-- -----------------------------------------------------------------------------
-- User (fictional accounts; example.com addresses; 555-01xx fictional phone numbers)
-- credit_balance and credit_last_reset are derived from the credit timeline.
-- Every seeded account uses the demo-only password CampusConnect123! and is
-- marked as verified so the sample data can be used to exercise login.
-- -----------------------------------------------------------------------------
INSERT INTO "User" (user_id, username, email, password_hash, email_verified_at, phone_number, role, created_at, credit_balance, credit_last_reset, is_banned, can_add_resources, email_notifications_on, text_notifications_on, profile_image_id) VALUES
    -- Owner account
    (1, 'cc_admin', 'cc.admin@example.com', 'pbkdf2_sha256$100000$QkJCQkJCQkJCQkJCQkJCQg$VtcGtF8YYpCFxQuXFLOc2ooANWJhF_sOOSuxtkK0ZdA', '2026-08-10 09:00:00', NULL, 'admin', '2026-08-10 09:00:00', 20, '2026-10-01', FALSE, TRUE, TRUE, FALSE, NULL),
    -- Owner account
    (2, 'newman_spaces_rk', 'newman.spaces.rk@example.com', 'pbkdf2_sha256$100000$QkJCQkJCQkJCQkJCQkJCQg$VtcGtF8YYpCFxQuXFLOc2ooANWJhF_sOOSuxtkK0ZdA', '2026-08-10 10:30:00', NULL, 'staff', '2026-08-10 10:30:00', 20, '2026-10-01', FALSE, TRUE, TRUE, FALSE, NULL),
    -- Owner account
    (3, 'recsports_mccomas_tj', 'recsports.mccomas.tj@example.com', 'pbkdf2_sha256$100000$QkJCQkJCQkJCQkJCQkJCQg$VtcGtF8YYpCFxQuXFLOc2ooANWJhF_sOOSuxtkK0ZdA', '2026-08-11 09:15:00', NULL, 'staff', '2026-08-11 09:15:00', 20, '2026-10-01', FALSE, TRUE, TRUE, FALSE, NULL),
    -- Owner account
    (4, 'recsports_warmem_ab', 'recsports.warmem.ab@example.com', 'pbkdf2_sha256$100000$QkJCQkJCQkJCQkJCQkJCQg$VtcGtF8YYpCFxQuXFLOc2ooANWJhF_sOOSuxtkK0ZdA', '2026-08-11 09:40:00', NULL, 'staff', '2026-08-11 09:40:00', 20, '2026-10-01', FALSE, TRUE, TRUE, FALSE, NULL),
    -- Owner account
    (5, 'squires_events_mp', 'squires.events.mp@example.com', 'pbkdf2_sha256$100000$QkJCQkJCQkJCQkJCQkJCQg$VtcGtF8YYpCFxQuXFLOc2ooANWJhF_sOOSuxtkK0ZdA', '2026-08-12 13:20:00', NULL, 'staff', '2026-08-12 13:20:00', 20, '2026-10-01', FALSE, TRUE, TRUE, FALSE, NULL),
    -- Journey A
    (6, 'maya_r', 'maya.r@example.com', 'pbkdf2_sha256$100000$QkJCQkJCQkJCQkJCQkJCQg$VtcGtF8YYpCFxQuXFLOc2ooANWJhF_sOOSuxtkK0ZdA', '2026-08-24 10:15:00', '+15405550106', 'student', '2026-08-24 10:15:00', 18, '2026-10-01', FALSE, FALSE, TRUE, TRUE, 7),
    -- Journey B
    (7, 'liam_k', 'liam.k@example.com', 'pbkdf2_sha256$100000$QkJCQkJCQkJCQkJCQkJCQg$VtcGtF8YYpCFxQuXFLOc2ooANWJhF_sOOSuxtkK0ZdA', '2026-08-26 16:45:00', '+15405550107', 'student', '2026-08-26 16:45:00', 20, '2026-10-01', FALSE, FALSE, TRUE, FALSE, NULL),
    -- Journey C
    (8, 'priya_s', 'priya.s@example.com', 'pbkdf2_sha256$100000$QkJCQkJCQkJCQkJCQkJCQg$VtcGtF8YYpCFxQuXFLOc2ooANWJhF_sOOSuxtkK0ZdA', '2026-08-20 11:05:00', '+15405550108', 'student', '2026-08-20 11:05:00', 15, '2026-10-01', FALSE, FALSE, TRUE, TRUE, 8),
    -- Journey D
    (9, 'diego_m', 'diego.m@example.com', 'pbkdf2_sha256$100000$QkJCQkJCQkJCQkJCQkJCQg$VtcGtF8YYpCFxQuXFLOc2ooANWJhF_sOOSuxtkK0ZdA', '2026-09-03 10:00:00', '+15405550109', 'student', '2026-09-03 10:00:00', 19, '2026-10-01', FALSE, FALSE, TRUE, TRUE, NULL),
    (10, 'hannah_w', 'hannah.w@example.com', 'pbkdf2_sha256$100000$QkJCQkJCQkJCQkJCQkJCQg$VtcGtF8YYpCFxQuXFLOc2ooANWJhF_sOOSuxtkK0ZdA', '2026-08-21 09:30:00', NULL, 'student', '2026-08-21 09:30:00', 18, '2026-10-01', FALSE, FALSE, TRUE, FALSE, NULL),
    (11, 'noah_b', 'noah.b@example.com', 'pbkdf2_sha256$100000$QkJCQkJCQkJCQkJCQkJCQg$VtcGtF8YYpCFxQuXFLOc2ooANWJhF_sOOSuxtkK0ZdA', '2026-08-22 20:10:00', '+15405550111', 'student', '2026-08-22 20:10:00', 16, '2026-10-01', FALSE, FALSE, TRUE, TRUE, NULL),
    (12, 'sofia_l', 'sofia.l@example.com', 'pbkdf2_sha256$100000$QkJCQkJCQkJCQkJCQkJCQg$VtcGtF8YYpCFxQuXFLOc2ooANWJhF_sOOSuxtkK0ZdA', '2026-08-24 13:40:00', '+15405550112', 'student', '2026-08-24 13:40:00', 17, '2026-10-01', FALSE, FALSE, TRUE, FALSE, 9),
    (13, 'ethan_c', 'ethan.c@example.com', 'pbkdf2_sha256$100000$QkJCQkJCQkJCQkJCQkJCQg$VtcGtF8YYpCFxQuXFLOc2ooANWJhF_sOOSuxtkK0ZdA', '2026-08-25 15:00:00', NULL, 'student', '2026-08-25 15:00:00', 18, '2026-10-01', FALSE, FALSE, FALSE, FALSE, NULL),
    (14, 'zara_h', 'zara.h@example.com', 'pbkdf2_sha256$100000$QkJCQkJCQkJCQkJCQkJCQg$VtcGtF8YYpCFxQuXFLOc2ooANWJhF_sOOSuxtkK0ZdA', '2026-08-27 08:20:00', '+15405550114', 'student', '2026-08-27 08:20:00', 17, '2026-10-01', FALSE, FALSE, TRUE, TRUE, NULL),
    (15, 'owen_p', 'owen.p@example.com', 'pbkdf2_sha256$100000$QkJCQkJCQkJCQkJCQkJCQg$VtcGtF8YYpCFxQuXFLOc2ooANWJhF_sOOSuxtkK0ZdA', '2026-08-28 12:00:00', NULL, 'student', '2026-08-28 12:00:00', 20, '2026-10-01', FALSE, FALSE, TRUE, FALSE, NULL),
    (16, 'aisha_n', 'aisha.n@example.com', 'pbkdf2_sha256$100000$QkJCQkJCQkJCQkJCQkJCQg$VtcGtF8YYpCFxQuXFLOc2ooANWJhF_sOOSuxtkK0ZdA', '2026-08-30 17:35:00', '+15405550116', 'student', '2026-08-30 17:35:00', 19, '2026-10-01', FALSE, FALSE, TRUE, FALSE, NULL),
    (17, 'lucas_g', 'lucas.g@example.com', 'pbkdf2_sha256$100000$QkJCQkJCQkJCQkJCQkJCQg$VtcGtF8YYpCFxQuXFLOc2ooANWJhF_sOOSuxtkK0ZdA', '2026-09-01 14:10:00', '+15405550117', 'student', '2026-09-01 14:10:00', 19, '2026-10-01', FALSE, FALSE, FALSE, TRUE, NULL),
    (18, 'chloe_d', 'chloe.d@example.com', 'pbkdf2_sha256$100000$QkJCQkJCQkJCQkJCQkJCQg$VtcGtF8YYpCFxQuXFLOc2ooANWJhF_sOOSuxtkK0ZdA', '2026-09-02 06:50:00', '+15405550118', 'student', '2026-09-02 06:50:00', 18, '2026-10-01', FALSE, FALSE, TRUE, TRUE, NULL),
    (19, 'marcus_t', 'marcus.t@example.com', 'pbkdf2_sha256$100000$QkJCQkJCQkJCQkJCQkJCQg$VtcGtF8YYpCFxQuXFLOc2ooANWJhF_sOOSuxtkK0ZdA', '2026-09-04 19:25:00', NULL, 'student', '2026-09-04 19:25:00', 18, '2026-10-01', FALSE, FALSE, TRUE, FALSE, NULL),
    (20, 'elena_v', 'elena.v@example.com', 'pbkdf2_sha256$100000$QkJCQkJCQkJCQkJCQkJCQg$VtcGtF8YYpCFxQuXFLOc2ooANWJhF_sOOSuxtkK0ZdA', '2026-09-05 10:45:00', '+15405550120', 'student', '2026-09-05 10:45:00', 20, '2026-10-01', FALSE, FALSE, TRUE, FALSE, NULL),
    (21, 'ben_o', 'ben.o@example.com', 'pbkdf2_sha256$100000$QkJCQkJCQkJCQkJCQkJCQg$VtcGtF8YYpCFxQuXFLOc2ooANWJhF_sOOSuxtkK0ZdA', '2026-09-08 21:00:00', NULL, 'student', '2026-09-08 21:00:00', 17, '2026-10-01', FALSE, FALSE, TRUE, FALSE, NULL),
    (22, 'grace_y', 'grace.y@example.com', 'pbkdf2_sha256$100000$QkJCQkJCQkJCQkJCQkJCQg$VtcGtF8YYpCFxQuXFLOc2ooANWJhF_sOOSuxtkK0ZdA', '2026-09-10 12:30:00', '+15405550122', 'student', '2026-09-10 12:30:00', 17, '2026-10-01', FALSE, FALSE, TRUE, TRUE, NULL),
    -- Suspended after two no-shows
    (23, 'ryan_f', 'ryan.f@example.com', 'pbkdf2_sha256$100000$QkJCQkJCQkJCQkJCQkJCQg$VtcGtF8YYpCFxQuXFLOc2ooANWJhF_sOOSuxtkK0ZdA', '2026-09-12 23:10:00', NULL, 'student', '2026-09-12 23:10:00', 12, '2026-09-12', TRUE, FALSE, FALSE, FALSE, NULL),
    (24, 'nina_j', 'nina.j@example.com', 'pbkdf2_sha256$100000$QkJCQkJCQkJCQkJCQkJCQg$VtcGtF8YYpCFxQuXFLOc2ooANWJhF_sOOSuxtkK0ZdA', '2026-09-15 09:55:00', NULL, 'student', '2026-09-15 09:55:00', 19, '2026-10-01', FALSE, FALSE, TRUE, FALSE, NULL),
    -- Joined 2026-10-09; no reservations yet
    (25, 'sam_q', 'sam.q@example.com', 'pbkdf2_sha256$100000$QkJCQkJCQkJCQkJCQkJCQg$VtcGtF8YYpCFxQuXFLOc2ooANWJhF_sOOSuxtkK0ZdA', '2026-10-09 18:40:00', NULL, 'student', '2026-10-09 18:40:00', 20, '2026-10-09', FALSE, FALSE, TRUE, FALSE, NULL);

-- Seeded accounts are already verified. These are synthetic consumed
-- SHA-256 token hashes so the verification-token table contains valid
-- relational sample data without leaving active login links in the seed.
INSERT INTO "EmailVerificationToken" (user_id, token_hash, created_at, used_at) VALUES
    (1, decode('516dfd0a3a6a0a7fd076765fe642b48daa1aefc23a5e9b0a5592d2212bc96c9d', 'hex'), '2026-08-10 09:00:00', '2026-08-10 09:00:00'),
    (2, decode('e736aae99f47b254256470276b509340bb96ca1c48050e3ee8ee95b72a9faa43', 'hex'), '2026-08-10 10:30:00', '2026-08-10 10:30:00'),
    (3, decode('ba24f337988ce88c8751e171378f3fe3fa7f8c84806a6b380d631d0888c5fe35', 'hex'), '2026-08-11 09:15:00', '2026-08-11 09:15:00'),
    (4, decode('38bac616e70d3e259e9ad1a20e606d1cfe3acb34b1978f48188ec3fe78413d9f', 'hex'), '2026-08-11 09:40:00', '2026-08-11 09:40:00'),
    (5, decode('9c012d8331dcfadc942ccfba9b77ec0702c6ac288bcf1aabb2e2ffec1f1caab0', 'hex'), '2026-08-12 13:20:00', '2026-08-12 13:20:00'),
    (6, decode('4f3589b5730e4d17a7815039f2ff6456660ffff8a0ac7892e6b53d94812c3e35', 'hex'), '2026-08-24 10:15:00', '2026-08-24 10:15:00'),
    (7, decode('c7d536dc3db4b17002d749341817f7c20aeba05548975b170420d681b62263bc', 'hex'), '2026-08-26 16:45:00', '2026-08-26 16:45:00'),
    (8, decode('8fe7d112251b5993704e054e12e3333698ed776ece10c4650a4cb1215f93c134', 'hex'), '2026-08-20 11:05:00', '2026-08-20 11:05:00'),
    (9, decode('25878b0e2dfb9f2165d18a88d2995d968f5efb9811215ea53d580404c852a867', 'hex'), '2026-09-03 10:00:00', '2026-09-03 10:00:00'),
    (10, decode('59ccef8d81cde8d2a68a2b99200719e685b725d52d9c493f7afd0eeda064e8fe', 'hex'), '2026-08-21 09:30:00', '2026-08-21 09:30:00'),
    (11, decode('fe4332e146330da770dadf3e22400ec5554d03679313b7bdbd132136e753f174', 'hex'), '2026-08-22 20:10:00', '2026-08-22 20:10:00'),
    (12, decode('247d0fe97be23e89c5502337bb235821afd62b73205f7ed08c62bdba11c7951b', 'hex'), '2026-08-24 13:40:00', '2026-08-24 13:40:00'),
    (13, decode('64b7b0f128641be2c5669f2785083c4e9ab2cda89dc641792e8ef1f7be611168', 'hex'), '2026-08-25 15:00:00', '2026-08-25 15:00:00'),
    (14, decode('79b28120aa95f728249922b01d2a714126299dbb3e6b0977820869f553e793f7', 'hex'), '2026-08-27 08:20:00', '2026-08-27 08:20:00'),
    (15, decode('186435cf357f7ab714a65bd00ccfe1c0933ad0ad699b833d7f89438a8a3d9109', 'hex'), '2026-08-28 12:00:00', '2026-08-28 12:00:00'),
    (16, decode('869ff431310699ba8a28ccd9dcebd5cdf37a6f58259b0816e41d044e731b0951', 'hex'), '2026-08-30 17:35:00', '2026-08-30 17:35:00'),
    (17, decode('d2c0697a6fd969e336e38ddfa71878950f639b97f36107e6c9ad75f9610c1251', 'hex'), '2026-09-01 14:10:00', '2026-09-01 14:10:00'),
    (18, decode('a16f6b2613749409d2fa55ab18509dc74ae75b34d5b85e94a7141c4955389fa4', 'hex'), '2026-09-02 06:50:00', '2026-09-02 06:50:00'),
    (19, decode('26ff9b07bc476bf44d252527c5032dc11709b31044e8c80b0779fed35cdc94ed', 'hex'), '2026-09-04 19:25:00', '2026-09-04 19:25:00'),
    (20, decode('628cd873ca56cf735dfb9cb84a5bb6cbd35fc61151844821c23a15efacea05e0', 'hex'), '2026-09-05 10:45:00', '2026-09-05 10:45:00'),
    (21, decode('7b924df8b3c404f83f8b7c1f3204e8a552a8b8401c47329c82edd425e29d0df4', 'hex'), '2026-09-08 21:00:00', '2026-09-08 21:00:00'),
    (22, decode('1289dd64d2840d6c65c9e9561d6f9405928e61eb5b640f8dc62df2c19ecca4c5', 'hex'), '2026-09-10 12:30:00', '2026-09-10 12:30:00'),
    (23, decode('b13a9b2f1ec1f6d0bffe8f92568afb6f3d6ba6bd3a4ebffb7e194400b318420c', 'hex'), '2026-09-12 23:10:00', '2026-09-12 23:10:00'),
    (24, decode('cdfd456d3b52b44ec0fb85094981f845c8b620587d07774909ca51e60935b436', 'hex'), '2026-09-15 09:55:00', '2026-09-15 09:55:00'),
    (25, decode('d015d0597cb55d0973f19f9e111c2dd4ed3a0cb29f977bfb10590cda36e5d73f', 'hex'), '2026-10-09 18:40:00', '2026-10-09 18:40:00');

-- -----------------------------------------------------------------------------
-- Building (names, addresses, coordinates from official vt.edu building pages)
-- google_place_id is NULL: no Place ID was verified.
-- -----------------------------------------------------------------------------
INSERT INTO "Building" (building_id, building_name, address, latitude, longitude, google_place_id) VALUES
    (1, 'Carol M. Newman Library', '560 Drillfield Drive, Blacksburg, VA 24061', '37.228760', '-80.419240', NULL),
    (2, 'Torgersen Hall', '620 Drillfield Drive, Blacksburg, VA 24061', '37.229780', '-80.419970', NULL),
    (3, 'McComas Hall', '895 Washington St. SW, Blacksburg, VA 24061', '37.220690', '-80.422300', NULL),
    (4, 'War Memorial Hall', '370 Drillfield Drive, Blacksburg, VA 24061', '37.226290', '-80.420590', NULL),
    (5, 'Squires Student Center', '290 College Ave., Blacksburg, VA 24061', '37.229620', '-80.417960', NULL);

-- -----------------------------------------------------------------------------
-- ResourceCategory
-- -----------------------------------------------------------------------------
INSERT INTO "ResourceCategory" (category_id, category_name, description) VALUES
    (1, 'Group Study Room', 'Enclosed rooms for small-group study and project work.'),
    (2, 'Meeting Room', 'Bookable rooms for student organization meetings, project teams, and presentations.'),
    (3, 'Indoor Court', 'Indoor hardwood courts for basketball, volleyball, badminton, or pickleball.'),
    (4, 'Racquet Court', 'Enclosed walled courts for racquetball and squash.'),
    (5, 'Aquatics', 'Pool lanes reserved for lap swimming.'),
    (6, 'Fitness Studio', 'Studios for group workouts, yoga, and other fitness activities.'),
    (7, 'Table Tennis', 'Table tennis tables available for casual and competitive play.');

-- -----------------------------------------------------------------------------
-- Resource (simulated reservable units inside real VT facilities)
-- Resource locations use the selected building; room-level positions were not
-- verified. Credits and capacities are fictional.
-- -----------------------------------------------------------------------------
INSERT INTO "Resource" (resource_id, owner_id, building_id, category_id, name, description, location_description, max_reservation_time, required_credits, capacity, created_at, resource_image_id) VALUES
    (1, 2, 1, 1, 'Newman Group Study Room 1', 'Small group study room with a whiteboard and table seating for four.', 'Fourth floor, group study room area', '2 hours', 2, 4, '2026-08-13 10:00:00', NULL),
    (2, 2, 1, 1, 'Newman Group Study Room 2', 'Small group study room with a whiteboard and table seating for four.', 'Fourth floor, group study room area', '2 hours', 2, 4, '2026-08-13 10:00:00', NULL),
    (3, 2, 1, 1, 'Newman Group Study Room 3', 'Mid-size group study room with a whiteboard and wall-mounted display.', 'Fourth floor, group study room area', '2 hours', 2, 6, '2026-08-13 10:00:00', NULL),
    (4, 2, 1, 1, 'Newman Group Study Room 4', 'Mid-size group study room with a whiteboard and wall-mounted display.', 'Fourth floor, group study room area', '2 hours', 2, 6, '2026-08-13 10:00:00', 1),
    (5, 2, 1, 1, 'Newman Group Study Room 5', 'Large group study room suited to project teams, with a display and two whiteboards.', 'Fourth floor, group study room area', '2 hours', 2, 8, '2026-08-13 10:00:00', NULL),
    (6, 2, 1, 1, 'Newman Group Study Room 6', 'Large group study room suited to project teams, with a display and two whiteboards.', 'Fourth floor, group study room area', '2 hours', 2, 8, '2026-08-13 10:00:00', NULL),
    (7, 1, 2, 2, 'Torgersen Project Room 1', 'Project room for team meetings and presentation practice.', 'Torgersen Hall (simulated room; no official room number assigned)', '3 hours', 2, 8, '2026-08-13 09:00:00', NULL),
    (8, 1, 2, 2, 'Torgersen Project Room 2', 'Project room for team meetings and presentation practice.', 'Torgersen Hall (simulated room; no official room number assigned)', '3 hours', 2, 8, '2026-08-13 09:00:00', NULL),
    (9, 1, 2, 1, 'Torgersen Atrium Study Table', 'Reservable table in the first-floor atrium study court with laptop power.', 'First-floor atrium (electronic study court)', '2 hours', 1, 4, '2026-08-13 09:00:00', NULL),
    (10, 3, 3, 3, 'McComas Basketball/Volleyball Court 1', 'Full hardwood court for pickup basketball or volleyball.', 'Gymnasium level, Court 1 of 3', '2 hours', 4, 12, '2026-08-14 09:00:00', 2),
    (11, 3, 3, 3, 'McComas Basketball/Volleyball Court 2', 'Full hardwood court for pickup basketball or volleyball.', 'Gymnasium level, Court 2 of 3', '2 hours', 4, 12, '2026-08-14 09:00:00', NULL),
    (12, 3, 3, 5, 'McComas Pool Lap Lane 1', 'One lap lane in the 25-yard, 8-lane pool.', 'McComas pool, Lane 1', '1 hours', 1, 2, '2026-08-14 09:00:00', 3),
    (13, 3, 3, 6, 'McComas Multipurpose Studio', 'Open multipurpose fitness studio with mats and mirrors.', 'Multipurpose fitness studio', '1 hours 30 minutes', 3, 25, '2026-08-14 09:00:00', NULL),
    (14, 4, 4, 4, 'War Memorial Racquetball Court 1', 'Enclosed racquetball court.', 'Racquetball court area, Court 1 of 5', '1 hours', 2, 4, '2026-08-14 10:00:00', 4),
    (15, 4, 4, 4, 'War Memorial Racquetball Court 2', 'Enclosed racquetball court.', 'Racquetball court area, Court 2 of 5', '1 hours', 2, 4, '2026-08-14 10:00:00', NULL),
    (16, 4, 4, 4, 'War Memorial Squash Court', 'War Memorial Hall''s single squash court.', 'Squash court', '1 hours', 2, 4, '2026-08-14 10:00:00', NULL),
    (17, 4, 4, 3, 'War Memorial Badminton/Pickleball Court A', 'One badminton/pickleball layout on the converted basketball courts.', 'Main gym, badminton/pickleball layout A', '1 hours 30 minutes', 2, 4, '2026-08-14 10:00:00', NULL),
    (18, 4, 4, 7, 'War Memorial Table Tennis Table 1', 'Table tennis table with paddles available at the service desk.', 'Table tennis space', '1 hours', 1, 4, '2026-08-14 10:00:00', NULL),
    (19, 4, 4, 7, 'War Memorial Table Tennis Table 2', 'Table tennis table with paddles available at the service desk.', 'Table tennis space', '1 hours', 1, 4, '2026-08-14 10:00:00', NULL),
    (20, 4, 4, 6, 'War Memorial Yoga Studio', 'Yoga studio for small-group practice sessions.', 'Yoga studio', '1 hours 30 minutes', 3, 20, '2026-08-14 10:00:00', 5),
    (21, 5, 5, 2, 'Squires Meeting Room A', 'Meeting room for student organization meetings, with a projector and conference seating.', 'Squires Student Center (simulated room; no official room number assigned)', '3 hours', 3, 12, '2026-08-14 14:00:00', 6),
    (22, 5, 5, 2, 'Squires Meeting Room B', 'Larger meeting room for organization general body meetings, with a projector.', 'Squires Student Center (simulated room; no official room number assigned)', '3 hours', 3, 20, '2026-08-14 14:00:00', NULL);

-- -----------------------------------------------------------------------------
-- ResourceFeature
-- -----------------------------------------------------------------------------
INSERT INTO "ResourceFeature" (feature_id, resource_id, feature_name, description) VALUES
    (1, 1, 'Whiteboard', 'Wall-mounted whiteboard with markers.'),
    (2, 1, 'Power station', 'Power outlets for charging laptops and phones.'),
    (3, 2, 'Whiteboard', 'Wall-mounted whiteboard with markers.'),
    (4, 2, 'Power station', 'Power outlets for charging laptops and phones.'),
    (5, 3, 'Wall display', 'Wall-mounted display with HDMI input for laptop screen sharing.'),
    (6, 3, 'Power station', 'Power outlets for charging laptops and phones.'),
    (7, 4, 'Wall display', 'Wall-mounted display with HDMI input for laptop screen sharing.'),
    (8, 4, 'Power station', 'Power outlets for charging laptops and phones.'),
    (9, 5, 'Wall display', 'Wall-mounted display with HDMI input for laptop screen sharing.'),
    (10, 5, 'Two whiteboards', 'Two wall-mounted whiteboards for larger teams.'),
    (11, 6, 'Wall display', 'Wall-mounted display with HDMI input for laptop screen sharing.'),
    (12, 6, 'Two whiteboards', 'Two wall-mounted whiteboards for larger teams.'),
    (13, 7, 'Projector', 'Ceiling projector with HDMI input.'),
    (14, 8, 'Projector', 'Ceiling projector with HDMI input.'),
    (15, 9, 'Laptop power', 'Power outlets built into the table.'),
    (16, 10, 'Adjustable volleyball net', 'Volleyball net that can be set up on request.'),
    (17, 11, 'Adjustable volleyball net', 'Volleyball net that can be set up on request.'),
    (18, 12, 'Lane line', 'Lane line separating the lap lane from open swim.'),
    (19, 13, 'Mats and mirrors', 'Exercise mats and full-length wall mirrors.'),
    (20, 16, 'Glass back wall', 'Glass back wall for spectators and coaching.'),
    (21, 17, 'Badminton/pickleball net', 'Portable net set to the selected layout.'),
    (22, 20, 'Yoga mats', 'Yoga mats and blocks stored in the studio.'),
    (23, 21, 'Projector', 'Ceiling projector with HDMI input.'),
    (24, 22, 'Projector', 'Ceiling projector with HDMI input.'),
    (25, 22, 'Microphone', 'Wireless microphone for general body meetings.');

-- -----------------------------------------------------------------------------
-- ResourceAvailability (simulated hours for the fall 2026 semester)
-- A window runs start_time..end_time and repeats every repeats_offset until
-- repeats_until. Squires rooms are weekday-only: one weekly row per weekday.
-- -----------------------------------------------------------------------------
INSERT INTO "ResourceAvailability" (availability_id, resource_id, start_time, end_time, repeats_until, repeats_offset) VALUES
    (1, 1, '2026-08-17 08:00:00', '2026-08-17 23:00:00', '2026-12-18 23:00:00', '1 day'),
    (2, 2, '2026-08-17 08:00:00', '2026-08-17 23:00:00', '2026-12-18 23:00:00', '1 day'),
    (3, 3, '2026-08-17 08:00:00', '2026-08-17 23:00:00', '2026-12-18 23:00:00', '1 day'),
    (4, 4, '2026-08-17 08:00:00', '2026-08-17 23:00:00', '2026-12-18 23:00:00', '1 day'),
    (5, 5, '2026-08-17 08:00:00', '2026-08-17 23:00:00', '2026-12-18 23:00:00', '1 day'),
    (6, 6, '2026-08-17 08:00:00', '2026-08-17 23:00:00', '2026-12-18 23:00:00', '1 day'),
    (7, 7, '2026-08-17 08:00:00', '2026-08-17 22:00:00', '2026-12-18 22:00:00', '1 day'),
    (8, 8, '2026-08-17 08:00:00', '2026-08-17 22:00:00', '2026-12-18 22:00:00', '1 day'),
    (9, 9, '2026-08-17 08:00:00', '2026-08-17 22:00:00', '2026-12-18 22:00:00', '1 day'),
    (10, 10, '2026-08-17 07:00:00', '2026-08-17 22:00:00', '2026-12-18 22:00:00', '1 day'),
    (11, 11, '2026-08-17 07:00:00', '2026-08-17 22:00:00', '2026-12-18 22:00:00', '1 day'),
    (12, 12, '2026-08-17 07:00:00', '2026-08-17 22:00:00', '2026-12-18 22:00:00', '1 day'),
    (13, 13, '2026-08-17 07:00:00', '2026-08-17 22:00:00', '2026-12-18 22:00:00', '1 day'),
    (14, 14, '2026-08-17 07:00:00', '2026-08-17 22:00:00', '2026-12-18 22:00:00', '1 day'),
    (15, 15, '2026-08-17 07:00:00', '2026-08-17 22:00:00', '2026-12-18 22:00:00', '1 day'),
    (16, 16, '2026-08-17 07:00:00', '2026-08-17 22:00:00', '2026-12-18 22:00:00', '1 day'),
    (17, 17, '2026-08-17 07:00:00', '2026-08-17 22:00:00', '2026-12-18 22:00:00', '1 day'),
    (18, 18, '2026-08-17 07:00:00', '2026-08-17 22:00:00', '2026-12-18 22:00:00', '1 day'),
    (19, 19, '2026-08-17 07:00:00', '2026-08-17 22:00:00', '2026-12-18 22:00:00', '1 day'),
    (20, 20, '2026-08-17 07:00:00', '2026-08-17 22:00:00', '2026-12-18 22:00:00', '1 day'),
    (21, 21, '2026-08-17 09:00:00', '2026-08-17 21:00:00', '2026-12-18 21:00:00', '7 days'),
    (22, 21, '2026-08-18 09:00:00', '2026-08-18 21:00:00', '2026-12-18 21:00:00', '7 days'),
    (23, 21, '2026-08-19 09:00:00', '2026-08-19 21:00:00', '2026-12-18 21:00:00', '7 days'),
    (24, 21, '2026-08-20 09:00:00', '2026-08-20 21:00:00', '2026-12-18 21:00:00', '7 days'),
    (25, 21, '2026-08-21 09:00:00', '2026-08-21 21:00:00', '2026-12-18 21:00:00', '7 days'),
    (26, 22, '2026-08-17 09:00:00', '2026-08-17 21:00:00', '2026-12-18 21:00:00', '7 days'),
    (27, 22, '2026-08-18 09:00:00', '2026-08-18 21:00:00', '2026-12-18 21:00:00', '7 days'),
    (28, 22, '2026-08-19 09:00:00', '2026-08-19 21:00:00', '2026-12-18 21:00:00', '7 days'),
    (29, 22, '2026-08-20 09:00:00', '2026-08-20 21:00:00', '2026-12-18 21:00:00', '7 days'),
    (30, 22, '2026-08-21 09:00:00', '2026-08-21 21:00:00', '2026-12-18 21:00:00', '7 days');

-- -----------------------------------------------------------------------------
-- MaintenancePeriod (simulated)
-- -----------------------------------------------------------------------------
INSERT INTO "MaintenancePeriod" (maintenance_id, resource_id, start_time, end_time, reason) VALUES
    (1, 11, '2026-08-17 07:00:00', '2026-08-19 22:00:00', 'Court floor refinishing before the fall semester.'),
    (2, 3, '2026-09-02 08:00:00', '2026-09-02 12:00:00', 'Replacing the wall-mounted display bracket.'),
    (3, 12, '2026-09-14 07:00:00', '2026-09-16 22:00:00', 'Pool water treatment and lane line inspection.'),
    (4, 7, '2026-09-26 08:00:00', '2026-09-26 14:00:00', 'Network equipment upgrade.'),
    (5, 15, '2026-10-13 07:00:00', '2026-10-15 22:00:00', 'Wall panel repair.'),
    (6, 22, '2026-10-20 09:00:00', '2026-10-20 21:00:00', 'Projector replacement.');

-- -----------------------------------------------------------------------------
-- Reservation
-- Status values: completed, confirmed (upcoming), cancelled, no_show.
-- -----------------------------------------------------------------------------
INSERT INTO "Reservation" (reservation_id, user_id, resource_id, start_time, end_time, status, created_at) VALUES
    -- Journey A (maya_r)
    (1, 6, 4, '2026-09-03 18:00:00', '2026-09-03 20:00:00', 'completed', '2026-09-01 14:20:00'),
    -- Journey A (maya_r)
    (2, 6, 4, '2026-10-14 18:00:00', '2026-10-14 20:00:00', 'confirmed', '2026-10-09 15:05:00'),
    -- Journey B (liam_k); cancelled by user 2026-09-12 10:00; refunded
    (3, 7, 21, '2026-09-15 18:00:00', '2026-09-15 21:00:00', 'cancelled', '2026-09-08 11:30:00'),
    -- Journey C (priya_s)
    (4, 8, 2, '2026-08-27 14:00:00', '2026-08-27 16:00:00', 'completed', '2026-08-25 09:10:00'),
    -- Journey C (priya_s)
    (5, 8, 9, '2026-09-04 10:00:00', '2026-09-04 12:00:00', 'completed', '2026-09-02 08:45:00'),
    -- Journey C (priya_s)
    (6, 8, 10, '2026-09-10 19:00:00', '2026-09-10 21:00:00', 'completed', '2026-09-06 13:00:00'),
    -- Journey C (priya_s)
    (7, 8, 14, '2026-09-24 17:00:00', '2026-09-24 18:00:00', 'completed', '2026-09-21 20:15:00'),
    -- Journey C (priya_s)
    (8, 8, 20, '2026-10-06 07:30:00', '2026-10-06 09:00:00', 'completed', '2026-10-03 18:40:00'),
    -- Journey C (priya_s)
    (9, 8, 5, '2026-10-15 13:00:00', '2026-10-15 15:00:00', 'confirmed', '2026-10-10 21:30:00'),
    -- Journey D (diego_m); cancelled 2026-09-11 16:00 because of maintenance; refunded
    (10, 9, 12, '2026-09-15 07:00:00', '2026-09-15 08:00:00', 'cancelled', '2026-09-09 08:40:00'),
    -- Journey D (diego_m)
    (11, 9, 12, '2026-09-18 07:00:00', '2026-09-18 08:00:00', 'completed', '2026-09-11 16:25:00'),
    -- Journey D (diego_m)
    (12, 9, 16, '2026-09-24 18:00:00', '2026-09-24 19:00:00', 'completed', '2026-09-22 12:00:00'),
    -- Journey D (diego_m)
    (13, 9, 12, '2026-10-12 07:00:00', '2026-10-12 08:00:00', 'confirmed', '2026-10-07 22:10:00'),
    (14, 10, 1, '2026-08-31 19:00:00', '2026-08-31 21:00:00', 'completed', '2026-08-28 16:00:00'),
    (15, 10, 1, '2026-09-16 19:00:00', '2026-09-16 21:00:00', 'completed', '2026-09-12 10:20:00'),
    (16, 10, 1, '2026-10-13 19:00:00', '2026-10-13 21:00:00', 'confirmed', '2026-10-08 09:00:00'),
    (17, 11, 10, '2026-08-29 18:00:00', '2026-08-29 20:00:00', 'completed', '2026-08-25 22:00:00'),
    (18, 11, 10, '2026-09-12 18:00:00', '2026-09-12 20:00:00', 'completed', '2026-09-08 19:30:00'),
    (19, 11, 11, '2026-10-03 18:00:00', '2026-10-03 20:00:00', 'completed', '2026-09-29 21:45:00'),
    (20, 11, 10, '2026-10-17 18:00:00', '2026-10-17 20:00:00', 'confirmed', '2026-10-10 20:00:00'),
    (21, 12, 22, '2026-09-09 18:00:00', '2026-09-09 20:00:00', 'completed', '2026-08-31 12:00:00'),
    (22, 12, 22, '2026-10-07 18:00:00', '2026-10-07 20:00:00', 'completed', '2026-09-30 12:15:00'),
    (23, 12, 22, '2026-10-21 18:00:00', '2026-10-21 20:00:00', 'confirmed', '2026-10-08 13:00:00'),
    (24, 13, 7, '2026-09-08 15:00:00', '2026-09-08 17:00:00', 'completed', '2026-09-04 11:00:00'),
    (25, 13, 7, '2026-09-26 15:00:00', '2026-09-26 17:00:00', 'completed', '2026-09-23 10:30:00'),
    (26, 13, 8, '2026-10-12 14:00:00', '2026-10-12 17:00:00', 'confirmed', '2026-10-06 17:20:00'),
    (27, 14, 20, '2026-09-06 08:00:00', '2026-09-06 09:30:00', 'completed', '2026-09-03 21:00:00'),
    (28, 14, 13, '2026-09-20 10:00:00', '2026-09-20 11:30:00', 'completed', '2026-09-17 19:45:00'),
    (29, 14, 20, '2026-10-04 08:00:00', '2026-10-04 09:30:00', 'completed', '2026-10-01 07:30:00'),
    (30, 15, 14, '2026-09-03 17:00:00', '2026-09-03 18:00:00', 'completed', '2026-08-31 15:30:00'),
    -- cancelled by user 2026-09-19 09:00; less than 24h ahead, not refunded
    (31, 15, 15, '2026-09-19 16:00:00', '2026-09-19 17:00:00', 'cancelled', '2026-09-17 13:10:00'),
    (32, 15, 18, '2026-10-02 15:00:00', '2026-10-02 16:00:00', 'completed', '2026-09-30 11:00:00'),
    (33, 16, 6, '2026-09-14 13:00:00', '2026-09-14 15:00:00', 'completed', '2026-09-09 18:00:00'),
    (34, 16, 6, '2026-10-05 13:00:00', '2026-10-05 15:00:00', 'completed', '2026-09-30 17:00:00'),
    (35, 16, 9, '2026-10-16 10:00:00', '2026-10-16 12:00:00', 'confirmed', '2026-10-09 20:30:00'),
    (36, 17, 17, '2026-09-13 10:00:00', '2026-09-13 11:30:00', 'completed', '2026-09-10 12:00:00'),
    (37, 17, 17, '2026-09-27 10:00:00', '2026-09-27 11:30:00', 'completed', '2026-09-24 09:40:00'),
    (38, 17, 19, '2026-10-11 16:00:00', '2026-10-11 17:00:00', 'confirmed', '2026-10-10 19:15:00'),
    (39, 18, 12, '2026-09-08 07:00:00', '2026-09-08 08:00:00', 'completed', '2026-09-05 20:00:00'),
    (40, 18, 12, '2026-09-22 07:00:00', '2026-09-22 08:00:00', 'completed', '2026-09-19 21:00:00'),
    (41, 18, 12, '2026-10-06 07:00:00', '2026-10-06 08:00:00', 'completed', '2026-10-02 22:30:00'),
    (42, 18, 12, '2026-10-13 07:00:00', '2026-10-13 08:00:00', 'confirmed', '2026-10-09 21:15:00'),
    (43, 19, 16, '2026-09-10 18:00:00', '2026-09-10 19:00:00', 'completed', '2026-09-07 20:00:00'),
    (44, 19, 14, '2026-10-08 18:00:00', '2026-10-08 19:00:00', 'completed', '2026-10-05 12:30:00'),
    (45, 20, 3, '2026-09-17 10:00:00', '2026-09-17 12:00:00', 'completed', '2026-09-13 15:00:00'),
    (46, 20, 3, '2026-10-01 10:00:00', '2026-10-01 12:00:00', 'completed', '2026-09-27 14:20:00'),
    -- cancelled by user 2026-10-08 18:30; refunded
    (47, 20, 2, '2026-10-14 10:00:00', '2026-10-14 12:00:00', 'cancelled', '2026-10-06 16:00:00'),
    (48, 21, 11, '2026-09-19 14:00:00', '2026-09-19 16:00:00', 'completed', '2026-09-15 22:00:00'),
    (49, 21, 13, '2026-10-10 17:00:00', '2026-10-10 18:30:00', 'completed', '2026-10-06 10:10:00'),
    (50, 22, 8, '2026-09-23 18:00:00', '2026-09-23 21:00:00', 'completed', '2026-09-17 12:45:00'),
    (51, 22, 21, '2026-10-15 18:00:00', '2026-10-15 21:00:00', 'confirmed', '2026-10-02 09:00:00'),
    (52, 23, 11, '2026-09-18 20:00:00', '2026-09-18 22:00:00', 'no_show', '2026-09-14 23:30:00'),
    (53, 23, 10, '2026-09-25 20:00:00', '2026-09-25 22:00:00', 'no_show', '2026-09-17 00:15:00'),
    (54, 24, 5, '2026-09-29 16:00:00', '2026-09-29 18:00:00', 'completed', '2026-09-25 13:00:00'),
    (55, 24, 18, '2026-10-09 12:00:00', '2026-10-09 13:00:00', 'completed', '2026-10-07 10:00:00');

-- -----------------------------------------------------------------------------
-- CreditTransaction (derived: balance = SUM(amount) per user)
-- -----------------------------------------------------------------------------
INSERT INTO "CreditTransaction" (transaction_id, user_id, amount, transaction_type, created_at) VALUES
    (1, 1, 20, 'initial_grant', '2026-08-10 09:00:00'),
    (2, 2, 20, 'initial_grant', '2026-08-10 10:30:00'),
    (3, 3, 20, 'initial_grant', '2026-08-11 09:15:00'),
    (4, 4, 20, 'initial_grant', '2026-08-11 09:40:00'),
    (5, 5, 20, 'initial_grant', '2026-08-12 13:20:00'),
    (6, 8, 20, 'initial_grant', '2026-08-20 11:05:00'),
    (7, 10, 20, 'initial_grant', '2026-08-21 09:30:00'),
    (8, 11, 20, 'initial_grant', '2026-08-22 20:10:00'),
    (9, 6, 20, 'initial_grant', '2026-08-24 10:15:00'),
    (10, 12, 20, 'initial_grant', '2026-08-24 13:40:00'),
    (11, 8, -2, 'reservation_charge', '2026-08-25 09:10:00'),
    (12, 13, 20, 'initial_grant', '2026-08-25 15:00:00'),
    (13, 11, -4, 'reservation_charge', '2026-08-25 22:00:00'),
    (14, 7, 20, 'initial_grant', '2026-08-26 16:45:00'),
    (15, 14, 20, 'initial_grant', '2026-08-27 08:20:00'),
    (16, 15, 20, 'initial_grant', '2026-08-28 12:00:00'),
    (17, 10, -2, 'reservation_charge', '2026-08-28 16:00:00'),
    (18, 16, 20, 'initial_grant', '2026-08-30 17:35:00'),
    (19, 12, -3, 'reservation_charge', '2026-08-31 12:00:00'),
    (20, 15, -2, 'reservation_charge', '2026-08-31 15:30:00'),
    (21, 8, 2, 'monthly_reset', '2026-09-01 00:00:00'),
    (22, 10, 2, 'monthly_reset', '2026-09-01 00:00:00'),
    (23, 11, 4, 'monthly_reset', '2026-09-01 00:00:00'),
    (24, 12, 3, 'monthly_reset', '2026-09-01 00:00:00'),
    (25, 15, 2, 'monthly_reset', '2026-09-01 00:00:00'),
    (26, 17, 20, 'initial_grant', '2026-09-01 14:10:00'),
    (27, 6, -2, 'reservation_charge', '2026-09-01 14:20:00'),
    (28, 18, 20, 'initial_grant', '2026-09-02 06:50:00'),
    (29, 8, -1, 'reservation_charge', '2026-09-02 08:45:00'),
    (30, 9, 20, 'initial_grant', '2026-09-03 10:00:00'),
    (31, 14, -3, 'reservation_charge', '2026-09-03 21:00:00'),
    (32, 13, -2, 'reservation_charge', '2026-09-04 11:00:00'),
    (33, 19, 20, 'initial_grant', '2026-09-04 19:25:00'),
    (34, 20, 20, 'initial_grant', '2026-09-05 10:45:00'),
    (35, 18, -1, 'reservation_charge', '2026-09-05 20:00:00'),
    (36, 8, -4, 'reservation_charge', '2026-09-06 13:00:00'),
    (37, 19, -2, 'reservation_charge', '2026-09-07 20:00:00'),
    (38, 7, -3, 'reservation_charge', '2026-09-08 11:30:00'),
    (39, 11, -4, 'reservation_charge', '2026-09-08 19:30:00'),
    (40, 21, 20, 'initial_grant', '2026-09-08 21:00:00'),
    (41, 9, -1, 'reservation_charge', '2026-09-09 08:40:00'),
    (42, 16, -2, 'reservation_charge', '2026-09-09 18:00:00'),
    (43, 17, -2, 'reservation_charge', '2026-09-10 12:00:00'),
    (44, 22, 20, 'initial_grant', '2026-09-10 12:30:00'),
    (45, 9, 1, 'refund', '2026-09-11 16:00:00'),
    (46, 9, -1, 'reservation_charge', '2026-09-11 16:25:00'),
    (47, 7, 3, 'refund', '2026-09-12 10:00:00'),
    (48, 10, -2, 'reservation_charge', '2026-09-12 10:20:00'),
    (49, 23, 20, 'initial_grant', '2026-09-12 23:10:00'),
    (50, 20, -2, 'reservation_charge', '2026-09-13 15:00:00'),
    (51, 23, -4, 'reservation_charge', '2026-09-14 23:30:00'),
    (52, 24, 20, 'initial_grant', '2026-09-15 09:55:00'),
    (53, 21, -4, 'reservation_charge', '2026-09-15 22:00:00'),
    (54, 23, -4, 'reservation_charge', '2026-09-17 00:15:00'),
    (55, 22, -2, 'reservation_charge', '2026-09-17 12:45:00'),
    (56, 15, -2, 'reservation_charge', '2026-09-17 13:10:00'),
    (57, 14, -3, 'reservation_charge', '2026-09-17 19:45:00'),
    (58, 18, -1, 'reservation_charge', '2026-09-19 21:00:00'),
    (59, 8, -2, 'reservation_charge', '2026-09-21 20:15:00'),
    (60, 9, -2, 'reservation_charge', '2026-09-22 12:00:00'),
    (61, 13, -2, 'reservation_charge', '2026-09-23 10:30:00'),
    (62, 17, -2, 'reservation_charge', '2026-09-24 09:40:00'),
    (63, 24, -2, 'reservation_charge', '2026-09-25 13:00:00'),
    (64, 20, -2, 'reservation_charge', '2026-09-27 14:20:00'),
    (65, 11, -4, 'reservation_charge', '2026-09-29 21:45:00'),
    (66, 15, -1, 'reservation_charge', '2026-09-30 11:00:00'),
    (67, 12, -3, 'reservation_charge', '2026-09-30 12:15:00'),
    (68, 16, -2, 'reservation_charge', '2026-09-30 17:00:00'),
    (69, 6, 2, 'monthly_reset', '2026-10-01 00:00:00'),
    (70, 8, 7, 'monthly_reset', '2026-10-01 00:00:00'),
    (71, 9, 3, 'monthly_reset', '2026-10-01 00:00:00'),
    (72, 10, 2, 'monthly_reset', '2026-10-01 00:00:00'),
    (73, 11, 8, 'monthly_reset', '2026-10-01 00:00:00'),
    (74, 12, 3, 'monthly_reset', '2026-10-01 00:00:00'),
    (75, 13, 4, 'monthly_reset', '2026-10-01 00:00:00'),
    (76, 14, 6, 'monthly_reset', '2026-10-01 00:00:00'),
    (77, 15, 3, 'monthly_reset', '2026-10-01 00:00:00'),
    (78, 16, 4, 'monthly_reset', '2026-10-01 00:00:00'),
    (79, 17, 4, 'monthly_reset', '2026-10-01 00:00:00'),
    (80, 18, 2, 'monthly_reset', '2026-10-01 00:00:00'),
    (81, 19, 2, 'monthly_reset', '2026-10-01 00:00:00'),
    (82, 20, 4, 'monthly_reset', '2026-10-01 00:00:00'),
    (83, 21, 4, 'monthly_reset', '2026-10-01 00:00:00'),
    (84, 22, 2, 'monthly_reset', '2026-10-01 00:00:00'),
    (85, 24, 2, 'monthly_reset', '2026-10-01 00:00:00'),
    (86, 14, -3, 'reservation_charge', '2026-10-01 07:30:00'),
    (87, 22, -3, 'reservation_charge', '2026-10-02 09:00:00'),
    (88, 18, -1, 'reservation_charge', '2026-10-02 22:30:00'),
    (89, 8, -3, 'reservation_charge', '2026-10-03 18:40:00'),
    (90, 19, -2, 'reservation_charge', '2026-10-05 12:30:00'),
    (91, 21, -3, 'reservation_charge', '2026-10-06 10:10:00'),
    (92, 20, -2, 'reservation_charge', '2026-10-06 16:00:00'),
    (93, 13, -2, 'reservation_charge', '2026-10-06 17:20:00'),
    (94, 24, -1, 'reservation_charge', '2026-10-07 10:00:00'),
    (95, 9, -1, 'reservation_charge', '2026-10-07 22:10:00'),
    (96, 10, -2, 'reservation_charge', '2026-10-08 09:00:00'),
    (97, 12, -3, 'reservation_charge', '2026-10-08 13:00:00'),
    (98, 20, 2, 'refund', '2026-10-08 18:30:00'),
    (99, 6, -2, 'reservation_charge', '2026-10-09 15:05:00'),
    (100, 25, 20, 'initial_grant', '2026-10-09 18:40:00'),
    (101, 16, -1, 'reservation_charge', '2026-10-09 20:30:00'),
    (102, 18, -1, 'reservation_charge', '2026-10-09 21:15:00'),
    (103, 17, -1, 'reservation_charge', '2026-10-10 19:15:00'),
    (104, 11, -4, 'reservation_charge', '2026-10-10 20:00:00'),
    (105, 8, -2, 'reservation_charge', '2026-10-10 21:30:00');

-- -----------------------------------------------------------------------------
-- Notification
-- -----------------------------------------------------------------------------
INSERT INTO "Notification" (
    notification_id,
    user_id,
    reservation_id,
    message,
    notification_type,
    created_at,
    scheduled_for,
    email_status,
    email_workflow_id,
    email_sent_at,
    email_error
)
SELECT
    notification_id,
    user_id,
    CASE notification_id
        WHEN 45 THEN 10
        WHEN 47 THEN 3
        WHEN 59 THEN 31
        WHEN 102 THEN 47
        ELSE NULL
    END AS reservation_id,
    message,
    notification_type,
    created_at::timestamp,
    created_at::timestamp AS scheduled_for,
    'sent' AS email_status,
    'seed-notification-' || notification_id AS email_workflow_id,
    created_at::timestamp AS email_sent_at,
    NULL::text AS email_error
FROM (VALUES
    (1, 1, 'Welcome to CampusConnect! 20 credits have been added to your account.', 'account', '2026-08-10 09:00:00'),
    (2, 2, 'Welcome to CampusConnect! 20 credits have been added to your account.', 'account', '2026-08-10 10:30:00'),
    (3, 3, 'Welcome to CampusConnect! 20 credits have been added to your account.', 'account', '2026-08-11 09:15:00'),
    (4, 4, 'Welcome to CampusConnect! 20 credits have been added to your account.', 'account', '2026-08-11 09:40:00'),
    (5, 5, 'Welcome to CampusConnect! 20 credits have been added to your account.', 'account', '2026-08-12 13:20:00'),
    (6, 8, 'Welcome to CampusConnect! 20 credits have been added to your account.', 'account', '2026-08-20 11:05:00'),
    (7, 10, 'Welcome to CampusConnect! 20 credits have been added to your account.', 'account', '2026-08-21 09:30:00'),
    (8, 11, 'Welcome to CampusConnect! 20 credits have been added to your account.', 'account', '2026-08-22 20:10:00'),
    (9, 6, 'Welcome to CampusConnect! 20 credits have been added to your account.', 'account', '2026-08-24 10:15:00'),
    (10, 12, 'Welcome to CampusConnect! 20 credits have been added to your account.', 'account', '2026-08-24 13:40:00'),
    (11, 8, 'Your reservation for Newman Group Study Room 2 on Thu Aug 27, 2:00 PM-4:00 PM is confirmed. 2 credits deducted.', 'reservation_confirmed', '2026-08-25 09:10:00'),
    (12, 13, 'Welcome to CampusConnect! 20 credits have been added to your account.', 'account', '2026-08-25 15:00:00'),
    (13, 11, 'Your reservation for McComas Basketball/Volleyball Court 1 on Sat Aug 29, 6:00 PM-8:00 PM is confirmed. 4 credits deducted.', 'reservation_confirmed', '2026-08-25 22:00:00'),
    (14, 7, 'Welcome to CampusConnect! 20 credits have been added to your account.', 'account', '2026-08-26 16:45:00'),
    (15, 14, 'Welcome to CampusConnect! 20 credits have been added to your account.', 'account', '2026-08-27 08:20:00'),
    (16, 15, 'Welcome to CampusConnect! 20 credits have been added to your account.', 'account', '2026-08-28 12:00:00'),
    (17, 10, 'Your reservation for Newman Group Study Room 1 on Mon Aug 31, 7:00 PM-9:00 PM is confirmed. 2 credits deducted.', 'reservation_confirmed', '2026-08-28 16:00:00'),
    (18, 16, 'Welcome to CampusConnect! 20 credits have been added to your account.', 'account', '2026-08-30 17:35:00'),
    (19, 12, 'Your reservation for Squires Meeting Room B on Wed Sep 9, 6:00 PM-8:00 PM is confirmed. 3 credits deducted.', 'reservation_confirmed', '2026-08-31 12:00:00'),
    (20, 15, 'Your reservation for War Memorial Racquetball Court 1 on Thu Sep 3, 5:00 PM-6:00 PM is confirmed. 2 credits deducted.', 'reservation_confirmed', '2026-08-31 15:30:00'),
    (21, 8, 'Your monthly credits have been reset to 20.', 'credits', '2026-09-01 00:00:00'),
    (22, 10, 'Your monthly credits have been reset to 20.', 'credits', '2026-09-01 00:00:00'),
    (23, 11, 'Your monthly credits have been reset to 20.', 'credits', '2026-09-01 00:00:00'),
    (24, 12, 'Your monthly credits have been reset to 20.', 'credits', '2026-09-01 00:00:00'),
    (25, 15, 'Your monthly credits have been reset to 20.', 'credits', '2026-09-01 00:00:00'),
    (26, 17, 'Welcome to CampusConnect! 20 credits have been added to your account.', 'account', '2026-09-01 14:10:00'),
    (27, 6, 'Your reservation for Newman Group Study Room 4 on Thu Sep 3, 6:00 PM-8:00 PM is confirmed. 2 credits deducted.', 'reservation_confirmed', '2026-09-01 14:20:00'),
    (28, 18, 'Welcome to CampusConnect! 20 credits have been added to your account.', 'account', '2026-09-02 06:50:00'),
    (29, 8, 'Your reservation for Torgersen Atrium Study Table on Fri Sep 4, 10:00 AM-12:00 PM is confirmed. 1 credit deducted.', 'reservation_confirmed', '2026-09-02 08:45:00'),
    (30, 9, 'Welcome to CampusConnect! 20 credits have been added to your account.', 'account', '2026-09-03 10:00:00'),
    (31, 14, 'Your reservation for War Memorial Yoga Studio on Sun Sep 6, 8:00 AM-9:30 AM is confirmed. 3 credits deducted.', 'reservation_confirmed', '2026-09-03 21:00:00'),
    (32, 13, 'Your reservation for Torgersen Project Room 1 on Tue Sep 8, 3:00 PM-5:00 PM is confirmed. 2 credits deducted.', 'reservation_confirmed', '2026-09-04 11:00:00'),
    (33, 19, 'Welcome to CampusConnect! 20 credits have been added to your account.', 'account', '2026-09-04 19:25:00'),
    (34, 20, 'Welcome to CampusConnect! 20 credits have been added to your account.', 'account', '2026-09-05 10:45:00'),
    (35, 18, 'Your reservation for McComas Pool Lap Lane 1 on Tue Sep 8, 7:00 AM-8:00 AM is confirmed. 1 credit deducted.', 'reservation_confirmed', '2026-09-05 20:00:00'),
    (36, 8, 'Your reservation for McComas Basketball/Volleyball Court 1 on Thu Sep 10, 7:00 PM-9:00 PM is confirmed. 4 credits deducted.', 'reservation_confirmed', '2026-09-06 13:00:00'),
    (37, 19, 'Your reservation for War Memorial Squash Court on Thu Sep 10, 6:00 PM-7:00 PM is confirmed. 2 credits deducted.', 'reservation_confirmed', '2026-09-07 20:00:00'),
    (38, 7, 'Your reservation for Squires Meeting Room A on Tue Sep 15, 6:00 PM-9:00 PM is confirmed. 3 credits deducted.', 'reservation_confirmed', '2026-09-08 11:30:00'),
    (39, 11, 'Your reservation for McComas Basketball/Volleyball Court 1 on Sat Sep 12, 6:00 PM-8:00 PM is confirmed. 4 credits deducted.', 'reservation_confirmed', '2026-09-08 19:30:00'),
    (40, 21, 'Welcome to CampusConnect! 20 credits have been added to your account.', 'account', '2026-09-08 21:00:00'),
    (41, 9, 'Your reservation for McComas Pool Lap Lane 1 on Tue Sep 15, 7:00 AM-8:00 AM is confirmed. 1 credit deducted.', 'reservation_confirmed', '2026-09-09 08:40:00'),
    (42, 16, 'Your reservation for Newman Group Study Room 6 on Mon Sep 14, 1:00 PM-3:00 PM is confirmed. 2 credits deducted.', 'reservation_confirmed', '2026-09-09 18:00:00'),
    (43, 17, 'Your reservation for War Memorial Badminton/Pickleball Court A on Sun Sep 13, 10:00 AM-11:30 AM is confirmed. 2 credits deducted.', 'reservation_confirmed', '2026-09-10 12:00:00'),
    (44, 22, 'Welcome to CampusConnect! 20 credits have been added to your account.', 'account', '2026-09-10 12:30:00'),
    (45, 9, 'Your reservation for McComas Pool Lap Lane 1 on Tue Sep 15, 7:00 AM-8:00 AM was cancelled because of scheduled maintenance. 1 credit refunded.', 'reservation_cancelled', '2026-09-11 16:00:00'),
    (46, 9, 'Your reservation for McComas Pool Lap Lane 1 on Fri Sep 18, 7:00 AM-8:00 AM is confirmed. 1 credit deducted.', 'reservation_confirmed', '2026-09-11 16:25:00'),
    (47, 7, 'You cancelled your reservation for Squires Meeting Room A on Tue Sep 15, 6:00 PM-9:00 PM. 3 credits refunded.', 'reservation_cancelled', '2026-09-12 10:00:00'),
    (48, 10, 'Your reservation for Newman Group Study Room 1 on Wed Sep 16, 7:00 PM-9:00 PM is confirmed. 2 credits deducted.', 'reservation_confirmed', '2026-09-12 10:20:00'),
    (49, 23, 'Welcome to CampusConnect! 20 credits have been added to your account.', 'account', '2026-09-12 23:10:00'),
    (50, 20, 'Your reservation for Newman Group Study Room 3 on Thu Sep 17, 10:00 AM-12:00 PM is confirmed. 2 credits deducted.', 'reservation_confirmed', '2026-09-13 15:00:00'),
    (51, 23, 'Your reservation for McComas Basketball/Volleyball Court 2 on Fri Sep 18, 8:00 PM-10:00 PM is confirmed. 4 credits deducted.', 'reservation_confirmed', '2026-09-14 23:30:00'),
    (52, 24, 'Welcome to CampusConnect! 20 credits have been added to your account.', 'account', '2026-09-15 09:55:00'),
    (53, 21, 'Your reservation for McComas Basketball/Volleyball Court 2 on Sat Sep 19, 2:00 PM-4:00 PM is confirmed. 4 credits deducted.', 'reservation_confirmed', '2026-09-15 22:00:00'),
    (54, 23, 'Your reservation for McComas Basketball/Volleyball Court 1 on Fri Sep 25, 8:00 PM-10:00 PM is confirmed. 4 credits deducted.', 'reservation_confirmed', '2026-09-17 00:15:00'),
    (55, 22, 'Your reservation for Torgersen Project Room 2 on Wed Sep 23, 6:00 PM-9:00 PM is confirmed. 2 credits deducted.', 'reservation_confirmed', '2026-09-17 12:45:00'),
    (56, 15, 'Your reservation for War Memorial Racquetball Court 2 on Sat Sep 19, 4:00 PM-5:00 PM is confirmed. 2 credits deducted.', 'reservation_confirmed', '2026-09-17 13:10:00'),
    (57, 14, 'Your reservation for McComas Multipurpose Studio on Sun Sep 20, 10:00 AM-11:30 AM is confirmed. 3 credits deducted.', 'reservation_confirmed', '2026-09-17 19:45:00'),
    (58, 23, 'You did not check in for McComas Basketball/Volleyball Court 2 on Fri Sep 18, 8:00 PM-10:00 PM. The reservation was marked as a no-show and credits were not refunded.', 'no_show', '2026-09-18 22:05:00'),
    (59, 15, 'You cancelled your reservation for War Memorial Racquetball Court 2 on Sat Sep 19, 4:00 PM-5:00 PM. Cancellations less than 24 hours before the start time are not refunded.', 'reservation_cancelled', '2026-09-19 09:00:00'),
    (60, 18, 'Your reservation for McComas Pool Lap Lane 1 on Tue Sep 22, 7:00 AM-8:00 AM is confirmed. 1 credit deducted.', 'reservation_confirmed', '2026-09-19 21:00:00'),
    (61, 8, 'Your reservation for War Memorial Racquetball Court 1 on Thu Sep 24, 5:00 PM-6:00 PM is confirmed. 2 credits deducted.', 'reservation_confirmed', '2026-09-21 20:15:00'),
    (62, 9, 'Your reservation for War Memorial Squash Court on Thu Sep 24, 6:00 PM-7:00 PM is confirmed. 2 credits deducted.', 'reservation_confirmed', '2026-09-22 12:00:00'),
    (63, 13, 'Your reservation for Torgersen Project Room 1 on Sat Sep 26, 3:00 PM-5:00 PM is confirmed. 2 credits deducted.', 'reservation_confirmed', '2026-09-23 10:30:00'),
    (64, 17, 'Your reservation for War Memorial Badminton/Pickleball Court A on Sun Sep 27, 10:00 AM-11:30 AM is confirmed. 2 credits deducted.', 'reservation_confirmed', '2026-09-24 09:40:00'),
    (65, 24, 'Your reservation for Newman Group Study Room 5 on Tue Sep 29, 4:00 PM-6:00 PM is confirmed. 2 credits deducted.', 'reservation_confirmed', '2026-09-25 13:00:00'),
    (66, 23, 'You did not check in for McComas Basketball/Volleyball Court 1 on Fri Sep 25, 8:00 PM-10:00 PM. The reservation was marked as a no-show and credits were not refunded.', 'no_show', '2026-09-25 22:05:00'),
    (67, 23, 'Your account has been suspended after repeated no-shows. Contact CampusConnect support to appeal.', 'account_status', '2026-09-26 10:00:00'),
    (68, 20, 'Your reservation for Newman Group Study Room 3 on Thu Oct 1, 10:00 AM-12:00 PM is confirmed. 2 credits deducted.', 'reservation_confirmed', '2026-09-27 14:20:00'),
    (69, 11, 'Your reservation for McComas Basketball/Volleyball Court 2 on Sat Oct 3, 6:00 PM-8:00 PM is confirmed. 4 credits deducted.', 'reservation_confirmed', '2026-09-29 21:45:00'),
    (70, 15, 'Your reservation for War Memorial Table Tennis Table 1 on Fri Oct 2, 3:00 PM-4:00 PM is confirmed. 1 credit deducted.', 'reservation_confirmed', '2026-09-30 11:00:00'),
    (71, 12, 'Your reservation for Squires Meeting Room B on Wed Oct 7, 6:00 PM-8:00 PM is confirmed. 3 credits deducted.', 'reservation_confirmed', '2026-09-30 12:15:00'),
    (72, 16, 'Your reservation for Newman Group Study Room 6 on Mon Oct 5, 1:00 PM-3:00 PM is confirmed. 2 credits deducted.', 'reservation_confirmed', '2026-09-30 17:00:00'),
    (73, 6, 'Your monthly credits have been reset to 20.', 'credits', '2026-10-01 00:00:00'),
    (74, 8, 'Your monthly credits have been reset to 20.', 'credits', '2026-10-01 00:00:00'),
    (75, 9, 'Your monthly credits have been reset to 20.', 'credits', '2026-10-01 00:00:00'),
    (76, 10, 'Your monthly credits have been reset to 20.', 'credits', '2026-10-01 00:00:00'),
    (77, 11, 'Your monthly credits have been reset to 20.', 'credits', '2026-10-01 00:00:00'),
    (78, 12, 'Your monthly credits have been reset to 20.', 'credits', '2026-10-01 00:00:00'),
    (79, 13, 'Your monthly credits have been reset to 20.', 'credits', '2026-10-01 00:00:00'),
    (80, 14, 'Your monthly credits have been reset to 20.', 'credits', '2026-10-01 00:00:00'),
    (81, 15, 'Your monthly credits have been reset to 20.', 'credits', '2026-10-01 00:00:00'),
    (82, 16, 'Your monthly credits have been reset to 20.', 'credits', '2026-10-01 00:00:00'),
    (83, 17, 'Your monthly credits have been reset to 20.', 'credits', '2026-10-01 00:00:00'),
    (84, 18, 'Your monthly credits have been reset to 20.', 'credits', '2026-10-01 00:00:00'),
    (85, 19, 'Your monthly credits have been reset to 20.', 'credits', '2026-10-01 00:00:00'),
    (86, 20, 'Your monthly credits have been reset to 20.', 'credits', '2026-10-01 00:00:00'),
    (87, 21, 'Your monthly credits have been reset to 20.', 'credits', '2026-10-01 00:00:00'),
    (88, 22, 'Your monthly credits have been reset to 20.', 'credits', '2026-10-01 00:00:00'),
    (89, 24, 'Your monthly credits have been reset to 20.', 'credits', '2026-10-01 00:00:00'),
    (90, 14, 'Your reservation for War Memorial Yoga Studio on Sun Oct 4, 8:00 AM-9:30 AM is confirmed. 3 credits deducted.', 'reservation_confirmed', '2026-10-01 07:30:00'),
    (91, 22, 'Your reservation for Squires Meeting Room A on Thu Oct 15, 6:00 PM-9:00 PM is confirmed. 3 credits deducted.', 'reservation_confirmed', '2026-10-02 09:00:00'),
    (92, 18, 'Your reservation for McComas Pool Lap Lane 1 on Tue Oct 6, 7:00 AM-8:00 AM is confirmed. 1 credit deducted.', 'reservation_confirmed', '2026-10-02 22:30:00'),
    (93, 8, 'Your reservation for War Memorial Yoga Studio on Tue Oct 6, 7:30 AM-9:00 AM is confirmed. 3 credits deducted.', 'reservation_confirmed', '2026-10-03 18:40:00'),
    (94, 19, 'Your reservation for War Memorial Racquetball Court 1 on Thu Oct 8, 6:00 PM-7:00 PM is confirmed. 2 credits deducted.', 'reservation_confirmed', '2026-10-05 12:30:00'),
    (95, 21, 'Your reservation for McComas Multipurpose Studio on Sat Oct 10, 5:00 PM-6:30 PM is confirmed. 3 credits deducted.', 'reservation_confirmed', '2026-10-06 10:10:00'),
    (96, 20, 'Your reservation for Newman Group Study Room 2 on Wed Oct 14, 10:00 AM-12:00 PM is confirmed. 2 credits deducted.', 'reservation_confirmed', '2026-10-06 16:00:00'),
    (97, 13, 'Your reservation for Torgersen Project Room 2 on Mon Oct 12, 2:00 PM-5:00 PM is confirmed. 2 credits deducted.', 'reservation_confirmed', '2026-10-06 17:20:00'),
    (98, 24, 'Your reservation for War Memorial Table Tennis Table 1 on Fri Oct 9, 12:00 PM-1:00 PM is confirmed. 1 credit deducted.', 'reservation_confirmed', '2026-10-07 10:00:00'),
    (99, 9, 'Your reservation for McComas Pool Lap Lane 1 on Mon Oct 12, 7:00 AM-8:00 AM is confirmed. 1 credit deducted.', 'reservation_confirmed', '2026-10-07 22:10:00'),
    (100, 10, 'Your reservation for Newman Group Study Room 1 on Tue Oct 13, 7:00 PM-9:00 PM is confirmed. 2 credits deducted.', 'reservation_confirmed', '2026-10-08 09:00:00'),
    (101, 12, 'Your reservation for Squires Meeting Room B on Wed Oct 21, 6:00 PM-8:00 PM is confirmed. 3 credits deducted.', 'reservation_confirmed', '2026-10-08 13:00:00'),
    (102, 20, 'You cancelled your reservation for Newman Group Study Room 2 on Wed Oct 14, 10:00 AM-12:00 PM. 2 credits refunded.', 'reservation_cancelled', '2026-10-08 18:30:00'),
    (103, 6, 'Your reservation for Newman Group Study Room 4 on Wed Oct 14, 6:00 PM-8:00 PM is confirmed. 2 credits deducted.', 'reservation_confirmed', '2026-10-09 15:05:00'),
    (104, 25, 'Welcome to CampusConnect! 20 credits have been added to your account.', 'account', '2026-10-09 18:40:00'),
    (105, 16, 'Your reservation for Torgersen Atrium Study Table on Fri Oct 16, 10:00 AM-12:00 PM is confirmed. 1 credit deducted.', 'reservation_confirmed', '2026-10-09 20:30:00'),
    (106, 18, 'Your reservation for McComas Pool Lap Lane 1 on Tue Oct 13, 7:00 AM-8:00 AM is confirmed. 1 credit deducted.', 'reservation_confirmed', '2026-10-09 21:15:00'),
    (107, 17, 'Your reservation for War Memorial Table Tennis Table 2 on Sun Oct 11, 4:00 PM-5:00 PM is confirmed. 1 credit deducted.', 'reservation_confirmed', '2026-10-10 19:15:00'),
    (108, 11, 'Your reservation for McComas Basketball/Volleyball Court 1 on Sat Oct 17, 6:00 PM-8:00 PM is confirmed. 4 credits deducted.', 'reservation_confirmed', '2026-10-10 20:00:00'),
    (109, 8, 'Your reservation for Newman Group Study Room 5 on Thu Oct 15, 1:00 PM-3:00 PM is confirmed. 2 credits deducted.', 'reservation_confirmed', '2026-10-10 21:30:00')
) AS seed(notification_id, user_id, message, notification_type, created_at);

-- -----------------------------------------------------------------------------
-- ReservationReview: the reserving student reviews the resource owner.
-- Only completed reservations are reviewed; created after the reservation ends.
-- -----------------------------------------------------------------------------
INSERT INTO "ReservationReview" (reservation_id, reviewer_user_id, reviewee_user_id, rating, reason, created_at, is_anonymous_review) VALUES
    (1, 6, 2, 5, 'Room was unlocked and ready on time. Booking was easy.', '2026-09-03 21:18:00', FALSE),
    (4, 8, 2, 5, 'Everything matched the listing.', '2026-08-27 19:00:00', FALSE),
    (6, 8, 3, 4, 'Court was set up when we arrived, but the net was not.', '2026-09-10 22:36:00', FALSE),
    (8, 8, 4, 5, 'Studio was clean and ready for us.', '2026-10-06 13:00:00', FALSE),
    (11, 9, 3, 5, 'Clear notice about the pool maintenance, and rebooking was easy.', '2026-09-18 10:00:00', FALSE),
    (14, 10, 2, 5, 'Smooth booking every time.', '2026-08-31 22:00:00', FALSE),
    (17, 11, 3, 4, 'Court was ready but the scoreboard was locked.', '2026-08-29 23:00:00', TRUE),
    (21, 12, 5, 5, 'Quick confirmation and the projector was already on.', '2026-09-09 22:30:00', FALSE),
    (24, 13, 1, 4, 'Room was ready, but the listing could mention the Wi-Fi issue.', '2026-09-08 23:00:00', FALSE),
    (30, 15, 4, 5, 'No issues at all.', '2026-09-03 20:00:00', FALSE),
    (33, 16, 2, 5, 'Great experience, will book again.', '2026-09-14 16:30:00', FALSE),
    (39, 18, 3, 5, 'Lane was reserved for me as promised.', '2026-09-08 09:00:00', FALSE),
    (45, 20, 2, 4, 'Room was fine; check-in instructions could be clearer.', '2026-09-17 15:00:00', TRUE),
    (50, 22, 1, 5, 'Room was ready and the setup matched the listing.', '2026-09-23 23:00:00', FALSE);

-- -----------------------------------------------------------------------------
-- ResourceReview: written by users who completed a reservation of that resource.
-- -----------------------------------------------------------------------------
INSERT INTO "ResourceReview" (review_id, resource_id, reviewer_user_id, rating, reason, created_at, is_anonymous_review) VALUES
    -- reservation 1
    (1, 4, 6, 5, 'Quiet room with plenty of space. Great for our group study session.', '2026-09-03 21:12:00', FALSE),
    -- reservation 4
    (2, 2, 8, 4, 'Good room for two people working on a lab report. Whiteboard markers were running low.', '2026-08-27 19:00:00', FALSE),
    -- reservation 5
    (3, 9, 8, 4, 'Nice spot to study between classes. Gets a little noisy around noon.', '2026-09-04 14:00:00', FALSE),
    -- reservation 6
    (4, 10, 8, 5, 'Courts were in great shape and we had plenty of room for a full game.', '2026-09-10 22:30:00', FALSE),
    -- reservation 7
    (5, 14, 8, 4, 'Court was clean and the booking was easy. Lighting is a bit dim at the back.', '2026-09-25 14:00:00', FALSE),
    -- reservation 8
    (6, 20, 8, 5, 'Peaceful studio for an early morning session. Mats were clean.', '2026-10-06 13:00:00', FALSE),
    -- reservation 11
    (7, 12, 9, 5, 'Having a lane to myself before class was great.', '2026-09-18 10:00:00', FALSE),
    -- reservation 12
    (8, 16, 9, 4, 'Good court, though it was warm inside.', '2026-09-25 10:00:00', TRUE),
    -- reservation 14
    (9, 1, 10, 5, 'Our go-to room for exam prep. The whiteboard is huge.', '2026-08-31 22:00:00', FALSE),
    -- reservation 15
    (10, 1, 10, 4, 'Still a good room, but someone left trash from the earlier session.', '2026-09-16 23:00:00', FALSE),
    -- reservation 17
    (11, 10, 11, 5, 'Great for our pickup group of ten.', '2026-08-29 23:00:00', FALSE),
    -- reservation 18
    (12, 10, 11, 4, 'Solid court. The volleyball net took a few minutes to set up.', '2026-09-13 14:00:00', FALSE),
    -- reservation 21
    (13, 22, 12, 5, 'Projector worked right away and the room fit our whole club.', '2026-09-09 22:30:00', FALSE),
    -- reservation 24
    (14, 7, 13, 4, 'Comfortable for a team meeting. Wi-Fi was a little slow.', '2026-09-08 23:00:00', FALSE),
    -- reservation 27
    (15, 20, 14, 5, 'Good size and nice and quiet for a morning flow.', '2026-09-06 12:30:00', FALSE),
    -- reservation 28
    (16, 13, 14, 3, 'Studio was fine but the sound system was not working.', '2026-09-20 16:30:00', TRUE),
    -- reservation 30
    (17, 14, 15, 4, 'Court was ready on time. Floor is a bit slippery near the door.', '2026-09-03 20:00:00', FALSE),
    -- reservation 33
    (18, 6, 16, 5, 'Two large whiteboards made planning our project so much easier.', '2026-09-14 16:30:00', FALSE),
    -- reservation 36
    (19, 17, 17, 4, 'Fun court for doubles. Wish the nets were a little taller.', '2026-09-13 15:30:00', FALSE),
    -- reservation 39
    (20, 12, 18, 5, 'Lane was always open when I arrived. Very easy to use.', '2026-09-08 09:00:00', FALSE),
    -- reservation 43
    (21, 16, 19, 4, 'Good court for a quick match after class.', '2026-09-10 21:00:00', FALSE),
    -- reservation 45
    (22, 3, 20, 5, 'The display made it easy for our group to review slides together.', '2026-09-17 15:00:00', FALSE),
    -- reservation 50
    (23, 8, 22, 5, 'Plenty of room for our whole design team.', '2026-09-23 23:00:00', FALSE),
    -- reservation 55
    (24, 18, 24, 4, 'Quick, easy game during lunch. Paddles were a little worn.', '2026-10-09 14:00:00', FALSE);

-- -----------------------------------------------------------------------------
-- Session (synthetic SHA-256 token hashes; sessions last 7 days)
-- -----------------------------------------------------------------------------
INSERT INTO "Session" (session_id, user_id, token_hash, created_at, expires_at) VALUES
    (1, 1, '\x9a1ec3f58ae63d1d52ea999df62dae6afdcd826618b826520f0cd4a276dbaab7', '2026-08-10 09:00:00', '2026-08-17 09:00:00'),
    (2, 2, '\xb7c20a13412507534f60f169e8aad4246faab4ce97a886f0fb51500a4162cbc4', '2026-08-10 10:30:00', '2026-08-17 10:30:00'),
    (3, 3, '\xae314f6e25b2ef9289cc476b60008bd2bbb1cff770894ef5a26a5ebe63ac3d7a', '2026-08-11 09:15:00', '2026-08-18 09:15:00'),
    (4, 4, '\x85ca997093064b741c15cd2a4ed561acd8d5f2ef2598db11d4c79c0f98be185e', '2026-08-11 09:40:00', '2026-08-18 09:40:00'),
    (5, 5, '\x752cccb4328a448c1ac6cc27d644cee25bfb7ed86159b6ef2d9178f1b05731db', '2026-08-12 13:20:00', '2026-08-19 13:20:00'),
    (6, 8, '\x8ab5dd46bc3ab8770882c186fba2dc03cdd8f9ebc3015ed1b232ab8093c13049', '2026-08-25 09:05:00', '2026-09-01 09:05:00'),
    (7, 6, '\xfaa32266b07194ec9073c3e60c4d4701f2e83e3bfead9c138de8000cb836b995', '2026-09-01 14:15:00', '2026-09-08 14:15:00'),
    (8, 11, '\xbfe7c1fcc9ea238a9fceb23541446ae01afa3786386b90e41d9d89033e44d58f', '2026-09-08 19:25:00', '2026-09-15 19:25:00'),
    (9, 2, '\x1853d502e91f005b896be723d03a3730401310d609ee470a32894027a9ad86cc', '2026-09-11 15:50:00', '2026-09-18 15:50:00'),
    (10, 9, '\xc18f962e37571d2e3272222ca30ade20a7cd463232a260068e4756df9deea74c', '2026-09-11 16:20:00', '2026-09-18 16:20:00'),
    (11, 7, '\xbf0ed05113c21275005d13e89ab84edbb99888621ac6e3fa7b706ee9b7c77570', '2026-09-12 09:57:00', '2026-09-19 09:57:00'),
    (12, 23, '\xf6eda1d8a9881312c8824f0c5804b8caacfa7ae64b0c5c03e524e4ecdc7b34c3', '2026-09-16 21:00:00', '2026-09-23 21:00:00'),
    (13, 8, '\x61684709200a5a5874b8f09ef78a7ab48ba5cb2aa2b25dc8a601eb66c8e6019b', '2026-09-21 20:10:00', '2026-09-28 20:10:00'),
    (14, 15, '\xfe0868165f4debd571c370d4cad9837db61d8cb2d19501ada1cb4608625885c6', '2026-09-30 10:57:00', '2026-10-07 10:57:00'),
    (15, 14, '\x34a8c369e584556933f15b8ded6a9359b31afcf3fd58570c0609a8c5f8f4054b', '2026-10-01 07:27:00', '2026-10-08 07:27:00'),
    (16, 22, '\x3af2eebdd06efa1787eff1e3fa5b46ab4f1282f42e3c35128d0ba4020d6085fa', '2026-10-02 08:57:00', '2026-10-09 08:57:00'),
    (17, 19, '\xeae08d7efb2865f99efe8e96bbf14fda6b5730eadbf477695871f8dbf0486545', '2026-10-05 12:27:00', '2026-10-12 12:27:00'),
    (18, 21, '\x6ce8be00a2ed68392aeaeebb2502a133ebebedc22df163348c6c6a26a80fa4cf', '2026-10-06 10:07:00', '2026-10-13 10:07:00'),
    (19, 13, '\xb855b57d2798f737c5030a2f9c8d6b6d091912334d1f7daad16711314b0f4a7c', '2026-10-06 17:17:00', '2026-10-13 17:17:00'),
    (20, 9, '\xa646946722d5e4e53048b8bc6a166188ad464cc771b03524e274be49703e851a', '2026-10-07 22:07:00', '2026-10-14 22:07:00'),
    (21, 10, '\x8b499eb3328e94e7fcac16b6324192cdbd88aedd904d5d2c6c5af56e1cb2e683', '2026-10-08 08:57:00', '2026-10-15 08:57:00'),
    (22, 12, '\x6945a3f5e6ea3b047f9bf7b17d7cd5501483599c0a79a392ab68ed4dd9b5bc0d', '2026-10-08 12:57:00', '2026-10-15 12:57:00'),
    (23, 20, '\xf03a01c3648912932a406fcfd596d888244a93d31071cca489a1a95d78a8bce0', '2026-10-08 18:27:00', '2026-10-15 18:27:00'),
    (24, 24, '\x35cf5c902b45848e0617010fa58b53cd1e78461de07b2109395aa5151b57bb1c', '2026-10-09 13:57:00', '2026-10-16 13:57:00'),
    (25, 6, '\x423e9ab5b3a30764f032ddc2b381ac854a93c8f46acce5425ec45447d36a5664', '2026-10-09 15:02:00', '2026-10-16 15:02:00'),
    (26, 25, '\xb3e76d7a3dc64aff070e68f98c95e7a289ec66bf7214e60f13ef48f4a04c2f9e', '2026-10-09 18:40:00', '2026-10-16 18:40:00'),
    (27, 16, '\x09eaf7a1cb7eed33c7959e1775f21ea7f49661509f78327cf88df6a00204886a', '2026-10-09 20:27:00', '2026-10-16 20:27:00'),
    (28, 18, '\x06d693a045910e4bda543544c5778ee7fb77c0cf7cfec353fadc66e4342b9b72', '2026-10-09 21:12:00', '2026-10-16 21:12:00'),
    (29, 17, '\x60ec5375bc262732e1124159981b48afdad5651c3b4485feb6398745532fc414', '2026-10-10 19:12:00', '2026-10-17 19:12:00'),
    (30, 11, '\xd235d548114ee6b2002b333742fa45f588d67715481f35a002e10e32541c01d5', '2026-10-10 19:57:00', '2026-10-17 19:57:00'),
    (31, 8, '\x1abe9a4d60c71d97e8b20eda66f0a1638f098bab3028afc6dd337a851eafe53e', '2026-10-10 21:27:00', '2026-10-17 21:27:00');

-- -----------------------------------------------------------------------------
-- Advance identity sequences past the explicit IDs used above.
-- (reservationreview has no identity column: its PK is reservation_id.)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    PERFORM setval(pg_get_serial_sequence('"ImageMetadata"', 'image_id'), (SELECT MAX(image_id) FROM "ImageMetadata"));
    PERFORM setval(pg_get_serial_sequence('"User"', 'user_id'), (SELECT MAX(user_id) FROM "User"));
    PERFORM setval(pg_get_serial_sequence('"EmailVerificationToken"', 'token_id'), (SELECT MAX(token_id) FROM "EmailVerificationToken"));
    PERFORM setval(pg_get_serial_sequence('"Building"', 'building_id'), (SELECT MAX(building_id) FROM "Building"));
    PERFORM setval(pg_get_serial_sequence('"ResourceCategory"', 'category_id'), (SELECT MAX(category_id) FROM "ResourceCategory"));
    PERFORM setval(pg_get_serial_sequence('"Resource"', 'resource_id'), (SELECT MAX(resource_id) FROM "Resource"));
    PERFORM setval(pg_get_serial_sequence('"ResourceFeature"', 'feature_id'), (SELECT MAX(feature_id) FROM "ResourceFeature"));
    PERFORM setval(pg_get_serial_sequence('"ResourceAvailability"', 'availability_id'), (SELECT MAX(availability_id) FROM "ResourceAvailability"));
    PERFORM setval(pg_get_serial_sequence('"MaintenancePeriod"', 'maintenance_id'), (SELECT MAX(maintenance_id) FROM "MaintenancePeriod"));
    PERFORM setval(pg_get_serial_sequence('"Reservation"', 'reservation_id'), (SELECT MAX(reservation_id) FROM "Reservation"));
    PERFORM setval(pg_get_serial_sequence('"CreditTransaction"', 'transaction_id'), (SELECT MAX(transaction_id) FROM "CreditTransaction"));
    PERFORM setval(pg_get_serial_sequence('"Notification"', 'notification_id'), (SELECT MAX(notification_id) FROM "Notification"));
    PERFORM setval(pg_get_serial_sequence('"ResourceReview"', 'review_id'), (SELECT MAX(review_id) FROM "ResourceReview"));
    PERFORM setval(pg_get_serial_sequence('"Session"', 'session_id'), (SELECT MAX(session_id) FROM "Session"));
END
$$;

