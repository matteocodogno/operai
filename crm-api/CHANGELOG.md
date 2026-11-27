# @operai/crm-api

## 0.9.1

### Patch Changes

- 8653331: A `client.date` in an offer-wizard answer that is not a calendar date (`x`, `2026-13-45`, `2026-00-10`) is now the usual 422 `answers_invalid` on `PUT /deals/{id}/offer-draft`, where it answered a 500: the refinement called `toISOString()`, which throws on an Invalid Date, and zod 4 still runs it on a string the pattern refused. One `isCalendarDate` that never throws now serves the answers schema and the date-only fields.
- 8653331: Inner deadlines now fit inside their callers' (specs/20261126-teams R13). The host routes of projects-api and crm-api (`/activity-host/v1/resolve`, `/meeting-host/v1/resolve`) wait at most 500 ms for a permission check they have not cached, then answer the usual 503 `authz_unavailable`; the check is single flight per person, is not aborted, and fills its 30 s cache for the retry. hours-api waits 6 s, not 2 s, for activities-api's lists and the meetings list, which ask a host themselves; activities-api waits at most 800 ms for the names on a list, and meetings-api's list makes no permission call (it never read the answer) and waits at most 800 ms for its creators' names. A name not known in time reads as unknown and is known on the next load. No wire contract changes.
- 8653331: A U+0000 in any input is a 400, never a 500. Postgres text (and the text inside jsonb) cannot hold it; every backend's global error handler now answers the database's refusal (Postgres 22021 / 22P05, Prisma P2039 / P2010) with a 400 `validation_failed` (hours-api: `invalid_request`) that names no value and none of the database's words, so a route nobody remembered is still not a 500. In auth a guard in front of the whole app refuses a NUL in the path, the query or a JSON body before any route runs (`GET /admin/users?q=%00`, `POST /admin/departments`, roles, invitations, legal entities, …). In projects-api the shared text helpers (`requiredText`, `optionalText`, a new `searchText`) refuse it, which covers `GET /projects?q=`, a project's name, a T&M position's profile, the Bexio order id and `GET /system/purchase-orders?dealIds=`.
- 8653331: The safety net that answers 400 when Postgres refuses a U+0000 now leaves one log line, `[nul] database refused U+0000 or invalid text` and the Prisma and SQLSTATE codes (`P2039/22021`), so a value built by the server with bad bytes is no longer blamed on the client without a trace (security review A09). The line carries only codes taken from the two closed sets the detector already knows: no message, value, argument, request or person. No wire contract changes.

## 0.9.0

### Minor Changes

- 0eedc6b: A deal can carry its own code for its offers' file names ("Code in file names", up to 10 letters or digits); left empty, the initials of the deal's title are used as before.
- 6f6e2ac: A company can be a funding body (the issuer of public tenders, never invoiced): marked in the companies list and page, filterable by type, and never made a customer by winning its tender.
- 2004677: In the "Progetto a corpo" and "Progetto a corpo + servizi" offer templates the cost line has its own field ("Voce di costo"), independent of the object of the supply; stored templates still holding the shipped text are updated on first use, edited ones are left as they are.
- cd1a930: A deal can be a public tender ("bando di gara"): its company is the issuing body, it may carry a submission deadline, it is marked "Tender" on the pipeline, the company's deals and the deal page, and the pipeline filters by type.
- a17c260: A won public tender is taken from the to-start queue as a project without a purchase order: the funding body is its company, its project manager is chosen at the take, and the project shows it comes from a tender.

## 0.8.0

### Minor Changes

- 2b3d2fe: Activity-host resolve learns deals (specs/20261112-time-tracking, AC-2.3): `POST /activity-host/v1/resolve` accepts `entityType: "deal"` and answers each deal `open` (any stage, with label, `/crm/deals/<id>` and `involved`: the deal's owner, plus its technical contact once an estimate is linked) or `missing`, so hours-api can ask as the caller who may book time on a deal. A caller without `crm:access` still gets `reader:false` and nothing about any deal; `related` stays a company-only member (a deal request carrying it is a 422). Companies answer exactly as before.

## 0.7.0

### Minor Changes

- 241b97c: The author of a CRM activity or task now chooses who sees its details: everyone (the default, and every existing activity), the sales team (people who manage deals: today sales and admin), or only the author and, for a task, its assignee. Everyone else still sees the activity, its subject, people, dates and state, but not its text, description, pictures or attachments; it reads "Details are restricted". No role overrides the choice, administrators included. The subject is always visible, and the form says so. Projects' My tasks shows the same restricted line on a CRM task.
- a0f68e9: Offer PDFs now download under the name wellD uses in Drive: `WellD_<entity>_<client>_<deal>_<reference>.pdf`, for example `WellD_CH_STUDIOV_FMS_00092026.pdf`, and `WellD_CH_STUDIOV_FMS_00272026r2.pdf` for the second revision of offer 0027/2026. The client part is the company's name without spaces, accents or symbols, in upper case; the deal part is the initials of the deal's title ("Fleet Management System" → FMS). Offers generated earlier download under the new name too; the documents themselves are unchanged.
- cc2c3f4: Offer templates can now set the wording of the document title and centre or right-align paragraphs. In the template editor, "Document title" has a field for Italian and one for English; what you write replaces "CONTRATTO DI FORNITURA" / "SUPPLY CONTRACT" before the reference on page 1 (for example "OFFERTA" or "OFFER"), the reference is still added for you, and an empty field keeps the usual title. Offers already issued keep the title they were generated with. In the template text, a paragraph written as `->text<-` is centred and one written as `->text->` is right-aligned; a backslash before the opening marker (`\->`) prints it as written. Both apply to the layout service's pages and to the PDF crm-api draws itself.

## 0.6.0

### Minor Changes

- 8048f95: The issuer of an offer now comes from the legal entities registry in auth, not from the CRM's own settings: the legal name, address (in the document's language), VAT number and IBAN print on the wizard context, generation, edit and revise, the previews and the classic PDF are read from the registry, with a 30 s / 60 s cache. An entity whose registry details are incomplete answers 409 `legal_entity_incomplete` (with `entity` and `missing`) and uses no number; an unreadable registry answers 503 `legal_entities_unavailable` with `Retry-After: 5`. A missing CRM profile row no longer blocks an offer (place Lugano, no terms, a plain classic page); `entity_profile_missing` stays only on the two classic letterhead upload routes. The wizard context gains `issuerAddress` in Italian and English. Offer snapshots record the `legalEntityVersion` they were made from. The service path sends content version 2 without the issuer's details, pinned to the registry version it was built from, and does the work again once, after waiting past the layout service's refresh window, when the service reports a different version; a second mismatch, or an older service, answers 503 `layout_service_unavailable`. Entity settings now keep only the offer terms and the place of issue: the legal name, address, VAT number and IBAN keys are accepted and ignored. Nothing is dropped yet: the CRM's legal columns, the Italian-only `issuerAddressLines` field and the ignored legacy keys are removed in the next release (release step 6), once the registry has been the only source for a while.

## 0.5.0

### Minor Changes

- 268ef4e: CRM pipeline: filter the board by owner ("Mine" or anyone who owns a deal); the stage counts and totals follow the filter. New `GET /deals/owners` and `ownerId` on `GET /pipeline`.

### Patch Changes

- 080a1fb: Migration logs on Railway no longer show as errors: `bun run` no longer echoes the command on stderr (`[run] silent = true`) and `db:deploy` sends Prisma's informational stderr to stdout. A failing migration still exits non-zero and fails the deploy.

## 0.4.0

### Minor Changes

- 4b6e43e: Offers can be laid out by the letterhead service (specs/20261116-letterhead-service), behind `LETTERHEAD_SERVICE_ENABLED` (only the literal `true` turns it on; it needs `LETTERHEAD_API_URL` and the existing service-client pair, scope `letterhead:render`). Off, the default, nothing changes. On: a letterhead client (`letterheadClient.ts`) and `draftToBlocks` turn an offer draft into content blocks (`offers/blocks.ts`, `contentSchema.ts`); the wizard's generate and the classic offer routes draw their pages through the service and record the letterhead version in the new nullable `deal_offer.letterheadVersion` column (migration `offer_letterhead_version`, no row touched); two preview routes (offer draft and template try-out) answer with the service's pages, capped per person, and are 404 with the switch off; a page-less deal PDF is `attachment_unreadable`; `GET /scope` answers `letterheadService`; the letterhead upload routes answer 410 `letterhead_upload_retired`, with the 410 title in the problem table. Two scripts ship with it: `retire-uploaded-letterheads` (renders before it deletes) and `check-letterhead-service`. An over-long section is refused by the preview as it is by generate. Contract tests run against the real service, and the shared entity-scope fixture runs on the TypeScript side.

### Patch Changes

- f288283: Moves crm-api to zod 4 (4.6.7) and `@hono/zod-openapi` 1.6.3, and `@scalar/hono-api-reference` to 0.12.17, closing the zod memory-exhaustion advisory (GHSA-mrhx-c7xc-m3w5, zod before 4.6.6, no 3.x fix); the Scalar bump is needed because the old one pulled a second, vulnerable zod. Every rejected request keeps its Problem document (422 with `field` and `errors`, `answers_invalid` with `path` and `reason`, the NUL refusals with their wording), but zod's own wording of the default messages changes (for example `Required` for a missing member becomes `Invalid input: expected string, received undefined`), a wrong-typed string or array member can list one more error after the first, and when several members are wrong the one named first follows the schema's order. A JSON body sent with another Content-Type, or none, now answers 415 instead of 422. A datetime without seconds or with an offset written `+0200`, a notice id that is not a standard UUID, and an integer beyond the safe range (for example an attachment of more than 2^53 bytes, which used to answer `attachment_too_large`) are now refused with a plain 422. The wizard's decimal quantities and values keep being accepted: zod 4's `.safe()` means integer, so the range is stated outright. The OpenAPI document differs only in that nullable enums now list `null` and the free-form members (`z.record`, `.passthrough()`) state `additionalProperties`, which they always allowed. The `/docs` page loads Scalar through a different script.
- 07dca8d: The 503 of the isolated PDF checks is documented and translated. crm-api's OpenAPI now names `pdf_check_busy` and `pdf_check_unavailable` on the six routes that can answer them (letterhead confirm and link, attachment confirm, offer generate and edit, draft generate), and crm-ui says both in English and Italian instead of showing the server's English detail.
- 932de77: The isolated PDF check's low-severity security notes are closed (L-12 to L-15, I-22, I-23). The child no longer loads a dotenv file of the working directory (`--no-env-file`, a working directory of its own that is empty). The check's place is taken before a confirm reads the file's bytes, and one user holds at most two of the queue's six places. A kill for time is remembered for a minute instead of for the life of the process. SIGTERM and SIGINT kill the live children, and a child ends itself at its own deadline when the service is killed outright. Memory is polled every 20 ms on Linux.
- 8d5ed71: Pins `hono` to 4.13.16 in every backend (it was a `^4.6.16` range that had resolved to 4.12.12 through 4.13.16 depending on the service), closing the hono advisories reported by `bun audit`, among them the CORS wildcard-origin reflection with credentials (GHSA-88fw-hqm2-52qc), the `bodyLimit()` bypass for chunked bodies (GHSA-9vqf-7f2p-gf9v), the CORS preflight ReDoS (GHSA-8j4g-w8fx-2239), the `mount()` prefix bypass (GHSA-4m76-xfj5-7975) and the RegExpRouter wildcard-middleware skip (GHSA-h7mg-cq63-vhpq). `@hono/node-server`, which only reaches the services through `prisma > @prisma/dev` (pinned there to 1.19.11, used by `prisma dev` and never at runtime), is overridden to 2.1.6 in each `package.json`, closing four path-handling advisories (GHSA-92pp-h63x-v22m, GHSA-frvp-7c67-39w9, GHSA-rmxm-3fg6-px4f, GHSA-jpvv-r467-5p4w). No route, status code or response changes.
- fcdb417: The validation hook's issue path type accepts any property key (zod 4 may report symbols), so it type-checks under both zod 3 and zod 4. Responses are unchanged.

## 0.3.0

### Minor Changes

- 33ebd92: CRM offer wizard (specs/20261115-crm-offer-wizard): an offer is now built step by step from a
  template that declares what it asks for, instead of editing a long contract text by hand.
  Pick a template for the deal's entity and language, fill in its fields, lists, tables and optional
  blocks, check the cost table and generate the PDF. The draft lives on the server, so it resumes
  after a reload or on another device; a missing or invalid answer blocks generation and says where.
  An unsent offer can be edited under the same reference and a sent one revised as the next `rN`; a
  legacy contract offer still opens the classic dialog. Administrators write wizard templates in
  Settings (self-describing markup with live problems) and try them on sample answers before
  saving; the seven standard templates are seeded per entity and language.

  - **crm-api:** a new migration (`20261115120000_offer_wizard`, apply it before the UI ships);
    template format `wizard` alongside the classic one, with supersession per entity and language;
    draft routes (create, resume, save with If-Match, discard) and generation from the stored draft;
    renderer support for several total rows and option lines in the cost table.
  - **crm-ui:** the offer wizard page, the deal page's offers card (draft row, Continue, Discard,
    Edit, New revision) and the template editor with its "Try the wizard" view.
  - **ui:** new paper tokens used by the offer document and wizard preview.
  - **shell:** patch only: it ships the library with the new tokens.

  The wizard's preview draws the entity's letterhead behind its first page (pdf.js in the browser, fetched
  from the CRM's own bucket), and the seeded templates name the issuer — legal name and address — from the
  entity profile instead of their text; seeds created earlier and never edited are upgraded once in place.

  The preview is laid out as real A4 pages inside the PDF's frame, with the letterhead behind every page and
  page breaks approximating the PDF's. Uploaded letterheads are bounded by decoded size before any parser
  runs, stored as the checked bytes, and refused (409 `letterhead_unusable`) when a stored one fails the bound.

- 0d8b9df: Projects hand-off (specs/20261103-projects-handoff, ADR 20261104-projects-handoff-live-reads-between-crm-and-projects-over-service-credentials to 0094): a won deal reaches OPS "in series".
  Sales (and admins) see a to-start queue of the CRM's won deals that no project has taken, read live
  (a reopened deal leaves it, a re-won one returns), and turn one into a new project with its purchase
  order (PO): type, dates and terms, an optional referent among the company's CRM contacts, and the
  ops-manager the PO is assigned to. The project starts without a project manager; the ops-manager is
  notified and picks one (an admin may in their place), and `planned` to `active` is refused until then.
  A project has 0..1 terms and 0..1 purchase order: a PO is born only from a won deal, and a hand-made
  project may be of any type and carry terms but never a PO. A fixed-price PO from
  a deal with an estimate copies the estimate's man-days once, and they cannot be edited. The PO shows its
  deal, a "no longer won" notice, the estimate link and the referent's name, job title, email and phone,
  read live from the CRM and never stored; the CRM deal page shows its project and the PO's Bexio order id,
  read-only.
  - **auth:** the `projects` catalog gains `purchase-order:bexio` (held by `accounting`: the PO's Bexio
    order id), `purchase-order:receive` and `handoff:take`; new `ops-manager` system role; `sales` gains
    `handoff:take`. New `GET /authz/users/holders`, gated on `handoff:take`, lists the holders of
    `purchase-order:receive` for an entity as `{ id, name, unconditioned }` (ADR 20261105-handoff-take-and-purchase-order-receive-capabilities-auth-holders-listing-amends-0047 amends ADR 20261006-user-directory-endpoint-capability-gated). New
    service scopes `crm.deals.read`, `crm.contacts.read`, `estimai.estimates.read` and
    `projects.purchase-orders.read`.
  - **estimai-api:** its first `/system/*` route, `GET /system/estimates/{id}/summary`, returns only
    `{ id, name, manDays }` to a service credential with `estimai.estimates.read`; new optional
    `SERVICE_AUDIENCE`.
  - **crm-api:** new `GET /system/deals` (`crm.deals.read`, no amounts) and `GET /system/contacts`
    (`crm.contacts.read`, minimal shape per mode) for projects-api; the deal read gains `delivery` and
    `deliveryKnown`, read from projects-api's `GET /system/purchase-orders`; `SERVICE_CLIENT_ID` /
    `SERVICE_CLIENT_SECRET` are now required with either `NOTIFY_INTERNAL_URL` or the new optional
    `PROJECTS_INTERNAL_URL`.
  - **crm-ui:** a read-only "Delivery" card on the deal page.
  - **notify-api:** `system:projects-api` may raise `projects` notifications.
  - **notify-ui:** the notification centre labels the `projects` origin "Projects" / "Progetti".
  - **projects-api:** one new migration on top of the Projects module's own; the take (`POST /queue/{dealId}/project`) behind
    `handoff:take`, with ops-manager candidates from auth, referent contacts from the CRM and a best-effort
    notification; `GET /queue`, the terms and purchase-order routes, the referent and the project-manager
    pick, hand-made projects with optional terms, and `GET /system/purchase-orders`; `GET /scope` gains
    `take` and `oversees`; new `ESTIMAI_INTERNAL_URL`, `NOTIFY_INTERNAL_URL` and `SERVICE_AUDIENCE`.
  - **projects-ui:** the queue (sales only), "New project" from a deal with the ops-manager and referent
    pickers, the purchase-order and terms cards, the awaiting notice with "Pick project manager", the
    list's "Awaiting project manager" state and filter, and hand-made creation with optional terms.

## 0.2.0

### Minor Changes

- 4f8e70f: Add activities-api (specs/20261110-activities, ADR 20261110-activities-service-access-delegated-to-host/0082/0083): one backend-only service for the activities, tasks and
  task blockers of the CRM and of Projects, with no permission catalog of its own, so every access decision is
  asked of the host (`crm-api`, `projects-api`) as the caller and fails closed. `crm-api` moves its activities,
  participants, blockers and meeting host state out (they are copied in once by
  `activities-api/scripts/import-crm-activities.ts`, a later push drops the old tables) and calls
  `activities-api` with the new service scope `activities.write`; `projects-api` becomes a host. `auth`
  registers the scope and the `activities-api` service client; `notify-api` accepts the `projects` origin and
  binds `system:activities-api` to `crm` and `projects`; `notify-ui` tags it. The shell trusts the
  activities-api origin; `crm-ui` reads activities from it; `projects-ui` gains a Tasks card on a project and a
  My tasks page.
- 66c46c2: CRM activities name the colleagues who took part (specs/20261101-crm US-8). A call, a meeting, a note or a task can list up to 10 participants with CRM access, for example "Meeting at the client, with Paro". The activity shows them, a task appears in the task list of everyone taking part, and a colleague added by someone else is notified in-app. A task still has one assignee, who answers for it.
- e6fcd41: CRM company status follows the deals (specs/20261101-crm AC-1.8, AC-1.9):
  - **Won → customer:** moving a deal to won makes its company a customer if it was a prospect or a former client.
  - **Inactive → former client:** a customer with no deal won in the last 12 months and none open reads as a former client, in the record, the list and the status filter. It is derived on read, never written, and the company page says why. A new deal makes it a customer again.
- 2df31ab: CRM companies and deals record where they came from (specs/20261101-crm US-7): direct inbound, direct outbound, event, referral or other. For an event, a referral or other, a detail can name which event or who referred it. A new deal starts from its company's source, and both pages show it, for example "Event · Swiss Digital Day 2026".
- bc428e8: CRM notifications (specs/20261101-crm-notifications, ADR 20261101-notify-api-resolves-email-notice-address-from-auth):
  - **Notifications:** the CRM notifies people in the app when work is handed to them or concerns them: estimate requests and hand-backs, a new deal owner, an assigned task, a gate override, won and lost deals, a generated offer.
  - **Email notices:** estimate requested, ready or reopened, a new deal owner and an assigned task also send an email, in English. None of them contains any money.
  - **notify-api:** `POST /system/notifications` accepts `email: true`. The caller then needs the `emails.send` scope as well. notify-api looks up the recipient's address in auth and sends the new `notification_notice` email.
  - **auth:** new service endpoint `POST /system/users/contact` and new scope `users.contact`.
  - **Notification center:** `crm` is a new origin, shown in the bell and the notification center.
- bc428e8: CRM offer document (specs/20261102-crm-offer-document, ADR 20261102-crm-api-reads-attachment-bytes-for-offer-annexes):
  - **Letterhead:** each entity uploads its letterhead PDF in Settings; every offer page is printed on it.
  - **Offer templates:** wellD's contract structure as editable templates per entity and language (14 seeded from wellD's own offers, Italian and English), with a template editor in Settings.
  - **Generate dialog:** starts from a template; the draft is prefilled from the estimate (epics, phases, timing per release, man-days, amount split per release); cost lines with unit price, quantity, yearly lines and discounts (amount or percentage); deal PDFs can be appended as annexes; optional Annex A with the effort detail.
  - **Numbering:** `0017/2026`, then `0017/2026r1` for later revisions of the same deal.
  - **Companies:** legal name, street and postal code.
  - **Fix:** estimate activities are matched to their release by name as well as id, so the effort no longer lands under "Other".
- 3fc487d: CRM offers are edited until they are sent, then revised (specs/20261102-crm-offer-document US-7). While the newest offer has not been marked sent, "Edit" opens it with its own content and regenerates its PDF under the same reference. Marking it sent records when and by whom, and freezes it. After that, "New revision" starts from the sent offer and adds `r1`, `r2`… instead of starting again from the template. Offers of deals already at "Offer sent", won or lost count as sent.
- c867f3c: CRM offer numbering can continue from wellD's document system (specs/20261102-crm-offer-document US-8). Settings has an "offer numbering" card per entity that sets the next offer number of the year, so the next new offer is, for example, `0019/2026` instead of `0001/2026`. It can never be set to a number an offer already carries, so references never collide.
- c83bee6: CRM (specs/20261101-crm AC-2.3, AC-3.2):
  - **Deal amount optional:** a deal can be created without an amount, which is often only known after the estimate or qualification. It can be set or cleared later. The deal page shows "Not set yet", the pipeline counts the deal without adding it to the totals, and an offer drafted from it leaves the prices blank.
  - **Edit a contact from the company:** each contact on a company page has an Edit button that opens the contact form there, without going to the contacts list.
- 6411dd8: "Proceed without estimate" is open to every salesperson who manages the deal (deal:manage for its entity), not only to admins. The reason is still required and kept on the deal's timeline; a deal of another entity is refused (403 out_of_scope).
- 7d68d9a: The CRM pipeline board can show another calendar year (specs/20261101-crm AC-3.6). A "Won and lost in" picker chooses whose won and lost deals, and their totals, the board shows. It offers this year and every year a deal was closed in. Open deals still show whatever year they started in.
- bc428e8: CRM sales flow (specs/20261101-crm-sales-flow, ADR 20261101-crm-financial-visibility-permission/0055):

  - **Technical role:** a new `crm-technical` role that sees the CRM without the money. The new
    `deal:financials` permission is held by `admin` and `sales`.
  - **Estimates:** technical estimates are requested from a deal and created in EstimAI with the
    technician as editor. A deal reaches Proposal only once its estimate is marked ready; an
    admin can override that.
  - **Offers and attachments:** offer PDFs are generated and versioned, and files can be
    attached to a deal. Both live in the CRM's own EU bucket.
  - **Pipeline:** a card shows a badge while the deal waits for its technical estimate.
  - **CRM users only:** owners and task assignees must be users who can open the CRM.

  `auth`'s app-access check also answers by user id, and the user directory can be filtered by
  app.

  The `proposal` and `negotiation` stages are now shown as "Offer in preparation" and "Offer sent", and the newest offer has a "Mark as sent" action that moves the deal to "Offer sent".

- 624596d: CRM lists can be sorted and filtered (specs/20261101-crm US-9). Companies sort by name, status, entity, industry or city, and contacts by name, company, job title or email, by clicking the column header. The order is applied by the server, so it holds across every page. Companies also gain an owner filter: anyone, "mine", or one of the people who own a company.
- 5909c75: The event, referral and "other" detail of a company or deal suggests the details already written for that source (case, accents and spacing ignored), so the same event is not recorded three ways. New `GET /source-details?source=` in crm-api, readable by every `crm:access` holder.
- b8fe638: CRM tasks can be blocked by other tasks (specs/20261101-crm US-6). When a task is created or edited, it can wait on up to 10 open tasks of the same company, for example the deal's estimate task. While one of them is open, the task shows as Blocked, lists what it waits on and cannot be marked done. When the last one is done, including when the estimate is marked ready, the assignee is told in-app and by email.
- bc428e8: Add the CRM (specs/20261101-crm, ADR 20261101-crm-tool-shape-and-authorization/0053): companies, contacts, deals through a stage
  pipeline with per-currency weighted totals, activities and follow-up tasks. New services
  `crm-api` and `crm-ui`; `auth` registers the `crm` catalog and the `sales` role and lets
  `deal:manage` holders read the user directory; the shell mounts the tool at `/crm`.
- 3172659: EstimAI list (specs/20261108-estimate-list-oversight): an admin can list and open every estimate read-only (new `estimate:read-all` permission, seeded to `admin`; ADR 20261108-estimai-oversight-permission-amends-0036); closed estimates move from the default Open list to a Closed filter; an estimate linked to a CRM deal shows a Deal badge, kept up to date by crm-api's new deal-link notices (scope `deal-link-notices.send`, ADR 20261108-crm-pushes-deal-links-to-estimai). Deploy auth first, then add the scope to crm-api's `SERVICE_CLIENTS` entry, set `SERVICE_AUDIENCE` on estimai-api and `ESTIMAI_INTERNAL_URL` on crm-api, deploy both, and run `crm-api/scripts/backfill-estimate-links.ts --apply` once.
- d549baf: A technical estimate is finished when it is closed in EstimAI. The owner or an editor closes it from the estimate page, after which it is read-only until someone reopens it. The CRM follows on its own: the deal's estimate turns ready, its task is completed, and the requester and the deal owner are told; reopening it in EstimAI reverses that. The CRM no longer has its own "Mark ready" and "Reopen" buttons. Needs `estimate-notices.send` on estimai-api's service client in auth, `CRM_INTERNAL_URL` on estimai-api and `SERVICE_AUDIENCE` on crm-api.
- c30a110: Meetings on CRM deals (specs/20261104-meetings, US-14, ADR 20261104-meeting-host-contract-resolve-and-notices/0060):
  - **crm-ui:** the deal page embeds a Meetings panel, so you can start a meeting about a deal and list the ones already linked. If Meetings is unavailable the page shows its own fallback and keeps working. The company page does not roll up its deals' meetings in this release.
  - **crm-api:** a deal's meetings appear in its activity timeline as a "meeting" activity, kept in step when the meeting is linked, changed, relinked, unlinked or deleted. The activity carries no meeting content, and nothing with a title outlives a deletion. New routes: service-authenticated `POST /system/meeting-host/v1/notices` and `POST /meeting-host/v1/resolve`, which tells meetings-api whether the caller may open a deal. A migration adds `activity.meetingId` and a content-free ordering table, so duplicated or reordered notices are harmless.
  - **Operators:** crm-api needs `SERVICE_AUDIENCE` (the same value as notify-api's, different from `AUTH_AUDIENCE`). Without it the notice route answers 401 and the rest of the service is unaffected.
- 4f8e70f: Add the Projects module (specs/20261103-projects, ADR 20261103-projects-tool-shape-and-authorization/0080): the delivery work wellD runs. A
  project has a type (T&M, fixed price, maintenance, SaaS, internal), a state, a project manager and
  a team; its contracts record what each client bought as structured delivery terms (deadline and
  max effort, SLA, hour package, T&M positions, licence period), and `accounting` records the Bexio
  order id on each contract. No money anywhere in the module. New services `projects-api` and
  `projects-ui`; the shell mounts the tool at `/projects`.
  - **auth:** registers the `projects` catalog (`projects:access`, entity-scoped `project:manage`,
    `contract:bexio`) and the `project-manager` role; `sales` gains access and entity-scoped manage,
    `accounting` gains access and the Bexio order capability; `project:manage` holders can read the
    user directory; new service scope `crm.companies.read`.
  - **crm-api:** new `GET /system/companies`, readable only with a service credential carrying
    `crm.companies.read` (the first `/system/*` route on the CRM).

### Patch Changes

- c2c3b88: Editing a CRM activity now covers its contact and deal (specs/20261101-crm AC-4.2). They can be changed or cleared, among the activity's company's own, whereas before they were fixed once the activity was logged.
- 9eef7b8: The crm-api image now contains the deal-link backfill script, so it can be run inside the service as `infra/README.md` describes.
- 41824c4: Unlinking a deal's technical estimate deletes the task the request created, as long as it is still open; a completed one stays on the timeline. On the deal page, the activity list reloads after an estimate is requested, marked ready, reopened or unlinked, so the task shows up without a page refresh.
- 756cf37: A deal whose earlier offers were all deleted before being sent now takes a new offer number, so the numbering set in Settings applies. An offer still on the deal, or one marked sent, keeps holding the deal's number.
- 6d9e36c: A deal an admin let go without a technical estimate can now have an offer. The draft leaves the scope, man-days and timeline empty, and the generate dialog hides the AI-assisted and annex choices and says so; the person writes the scope and sets the costs.
- cf23e2f: The pipeline can be filtered by company, and its counts and totals follow the filter. A deal card now shows the company first and the deal's title under it.
