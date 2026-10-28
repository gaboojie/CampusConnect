# Task: Generate `seed.sql` for CampusConnect — Phase 4

We are implementing **Phase 4: Database Initialization & Working Application** for our CampusConnect project, a Location-Aware Campus Resource Reservation System.

I have already generated `db/migrations/001_schema.sql`. Your task is to generate the seed migration and its provenance notes:

1. `db/migrations/002_seed.sql` — Realistic, consistent synthetic data for all tables.
2. `db/reference/vt_data_sources.txt` — Documentation of real-world information, sources, assumptions, and AI-generated data.

**Do not modify `001_schema.sql` without my permission.**

## Step 1: Understand the existing database

First, carefully read:

- `db/migrations/001_schema.sql` — The authoritative physical schema.
- The approved Phase 3 logical schema — Our finalized Phase 3 logical schema.
- `phase3_documentation.pdf` — Business rules, referential actions, and general constraints.

Understand all 14 tables, their relationships, primary keys, foreign keys, `NOT NULL`, `UNIQUE`, `CHECK`, and other constraints.

Do not assume a relationship or business rule that is not supported by these files. If something is ambiguous, make a reasonable assumption, document it, and clearly explain it.

## Step 2: Plan realistic data population

According to the assignment:

- **Major tables must contain at least 20 records each.**
- **Minor, lookup, or supporting tables do not need 20 records.** Use as many records as realistically make sense, preferably at least 5 where possible.
- Do not artificially generate unnecessary records just to reach 20 rows in a minor table.
- Populate all tables with believable and meaningful data.

Before implementation, classify the 14 tables into major and minor tables and provide their planned row counts.

The goal is not simply to generate random rows. The database should resemble a campus reservation system that students have actively used for several months.

Use October 11, 2026, as the reference date for determining past and future events.

## Step 3: Use real Virginia Tech buildings and facilities

I want the buildings, resources, and geographical information to be as realistic as possible.

Research official Virginia Tech webpages and use verified information where available.

Prioritize locations such as:

- Newman Library — study rooms, collaborative spaces.
- Torgersen Hall — academic and study-related spaces.
- McComas Hall — gym, fitness areas, courts, swimming pool.
- War Memorial Hall — recreational facilities, courts, swimming pool.
- Other relevant Virginia Tech campus buildings and facilities.

Use real information wherever possible, such as:

- Building names.
- Addresses.
- Latitude and longitude.
- Actual facility types.
- Descriptions of facilities.
- Resource locations within buildings, where verifiable.

Prefer official Virginia Tech sources, including `vt.edu`, `lib.vt.edu`, `recsports.vt.edu`, and `facilities.vt.edu`.

**Important requirements:**

1. Do not invent exact latitude/longitude coordinates and present them as verified.
2. If coordinates are approximate, clearly label them as approximate.
3. Ensure resources are located in appropriate buildings.
4. Do not invent official room numbers or policies and attribute them to Virginia Tech.
5. You may simulate fictional reservable resources inside real facilities where appropriate, but clearly distinguish them from officially verified resources.
6. Any reservation credits or prices in our system are fictional unless explicitly specified by our project documentation.

## Step 4: Simulate four complete and sensible user journeys

This is one of the most important requirements.

I do not want entirely independent, random reservation records. I want several users to have a meaningful history of using CampusConnect.

Create at least four fictional users with coherent activity histories. Other users can have simpler histories.

### Journey A: Successful reservation and positive review

For example:

1. A student creates an account.
2. The student receives their initial or monthly credits.
3. They reserve a study room in Newman Library.
4. The appropriate number of credits is deducted according to our credit rules.
5. They receive a reservation confirmation notification.
6. They successfully use the room.
7. The reservation is marked completed.
8. They leave a short, natural, positive review, such as "Quiet room with plenty of space. Great for our group study session."

The final credit balance must be mathematically consistent with the transaction history.

No photo is required for this review.

### Journey B: Reservation followed by cancellation

1. Another student reserves a meeting room or other resource.
2. Credits are deducted if required.
3. The student receives a confirmation notification.
4. The student later cancels the reservation.
5. The cancellation policy determines whether credits are refunded.
6. The final reservation status, credit transactions, and credit balance must be consistent.

Do not invent a refund policy if one already exists in the project documentation.

### Journey C: Repeat active user

Create a user who has actively used the platform over several weeks.

For example:

1. Reserves a study room.
2. Completes the reservation.
3. Later reserves a recreational resource.
4. Completes another reservation.
5. Leaves one or two reasonable reviews.
6. Receives relevant notifications.
7. Has a consistent credit transaction history and final balance.

The reservations should occur on different realistic dates.

### Journey D: Additional realistic scenario

Create another meaningful situation, such as:

- A reservation cancelled because of maintenance.
- A student who cancelled one reservation and later completed another.
- A user who reserved several different resources across campus.

Use only scenarios that can actually be represented by our existing schema.

**For all four journeys:**

- Keep the timeline logically consistent.
- Ensure the user existed before making reservations.
- Ensure reservations were created before their scheduled start times.
- Ensure credit deductions and refunds match the documented business rules.
- Do not charge credits twice for the same reservation.
- Ensure reviews are consistent with the completed activity and permitted reviewer relationships.
- Do not imply that the database stores events or historical transitions for which no corresponding table or field exists.
- Do not create real personal information.

## Step 5: Ensure realism throughout the dataset

Beyond the four main user journeys, create a believable dataset involving multiple fictional users.

Include different reservation statuses where allowed, various resource categories, multiple dates, and different types of campus activities.

Maintain these conditions:

- No logically conflicting confirmed reservations for an exclusive resource.
- No confirmed reservations overlapping a resource's maintenance period.
- Reservation end times must be later than start times.
- Resource availability should agree with reservation scenarios.
- Credit balances should reconcile with the credit transactions according to documented rules.
- Reviews should be natural, concise, and contextually appropriate.
- Notifications should correspond to relevant user activity.
- Resource capacities, required credits, and maximum reservation durations should be plausible.
- Dates and times should be sensible and chronologically consistent.

Use fictional student names and reserved example domains for email addresses.

For `ImageMetadata`, use synthetic metadata where needed. Do not claim that fictional image objects actually exist in Cloudflare R2.

For `Session`, use unique synthetic binary token hashes consistent with PostgreSQL `BYTEA`, and ensure session expiration timestamps make sense.

## Step 6: Generate `data_sources.txt`

Create `db/reference/vt_data_sources.txt` documenting all real-world information used to generate the dataset.

For each real building or facility, include:

- Building or facility name.
- Official source URL.
- Source webpage title.
- Date accessed.
- Which information was taken from the source.
- Address and coordinate source, when applicable.
- Whether latitude/longitude is exact, approximate, or unavailable.
- Which fields were simulated rather than verified.

Also document:

- Fictional resource details.
- Synthetic user identities.
- Simulated reservations and reviews.
- Assumptions about credit charges, cancellations, and refunds.
- Any relevant limitations of the dataset.
- The use of Claude Code or generative AI in creating sample data.

**Never fabricate references or source URLs.** If you cannot verify something, explicitly mark it as unverified.

## Step 7: Generate `seed.sql`

After planning the data, create `db/migrations/002_seed.sql`.

Requirements:

1. Use valid PostgreSQL syntax compatible with the existing `schema.sql`.
2. Populate all 14 tables.
3. Respect all primary keys, foreign keys, unique constraints, checks, and nullability requirements.
4. Insert records in an appropriate dependency order.
5. Handle explicit IDs and identity sequences correctly.
6. Use readable, organized SQL with comments where useful.
7. Preserve realistic relationships among users, buildings, resources, reservations, transactions, reviews, notifications, and other records.
8. Ensure that the seed data works on a fresh database immediately after running `001_schema.sql`.
9. Do not include intentionally invalid records in this file.
10. Do not modify or delete data in an existing non-test database.

## Step 8: Validation and final report

After generating the files, provide:

1. A table showing the actual number of generated records for each of the 14 tables.
2. A summary of the four complete user journeys.
3. A credit reconciliation for each main user, showing initial credits, deductions, refunds, and final balance.
4. A summary of real Virginia Tech information used and its sources.
5. A list of assumptions made.
6. Any schema limitations or inconsistencies discovered.

If a disposable local PostgreSQL test database is available, run the migrations, verify the row counts and constraints, and report the actual execution results.

If PostgreSQL is unavailable, clearly state that execution has not been performed. We can verify the scripts later.

**Important:** Do not silently fix or modify `schema.sql`. Report any problems separately.

## Final objective

The final database should not look like it was populated with arbitrary sample rows.

It should look like a realistic snapshot of CampusConnect at Virginia Tech, with genuine campus locations, fictional users who have actively used the platform, coherent reservations, credit transactions, reviews, notifications, and meaningful relationships between the records.

Prioritize **realism, consistency, reproducibility, and compliance with the assignment rubric** over generating unnecessarily large amounts of data.

First present a brief population plan and the proposed four user journeys. Then generate the two files.
