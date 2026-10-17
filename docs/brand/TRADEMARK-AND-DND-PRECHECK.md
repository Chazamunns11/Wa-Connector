# PingWren research (16 Oct 2026)

## 1. Trademark knock-out check: PINGWREN (classes 9, 38, 42)

**This is NOT legal clearance.** It is a preliminary screen with partial register coverage. Before filing, get a full search and opinion from a UK trade mark attorney (CITMA), especially for global use.

### What was checked and what came back

| Source | Access | Result |
|---|---|---|
| USPTO (tmsearch.uspto.gov, using the backend JSON API the site itself calls) | WORKED | `pingwren*`: 0 hits. `ping* AND wren*`: 0. `pingren*`: 0. `pingwyn*`: 0. `wrenping*`: 0. `pingrin*`: 1 (PINGRING, dead, cl. 9). `pingwin*`: 4 (PINGWIND live cl. 35/42, Pingwind Inc.; three PINGWIN/PINGWINS, all dead). |
| UK IPO (https://trademarks.ipo.gov.uk/ipo-tmtext) | BLOCKED (HTTP 403 to automated access) | Not checked. Search it by hand. |
| EUIPO eSearch (https://euipo.europa.eu/eSearch/) | Loads, but it is a JavaScript app, so no results could be read | Not checked. |
| TMview (https://www.tmdn.org/tmview/) | BLOCKED (503 / empty reply) | Not checked. TMview covers the UK, EU and many national offices, so it is the best single manual search. |
| WIPO Global Brand Database (https://branddb.wipo.int/en/quicksearch?by=brandName&v=pingwren) | BLOCKED (ALTCHA captcha) | Not checked. |
| UK Companies House | WORKED | "pingwren": no results. "ping wren": only loose fuzzy matches, no company named Ping Wren. |
| Web search for "PingWren" / "Ping Wren" | WORKED | No company, app or product found under either name. Nearest names: Pingwyn (a location-sharing app from about 2011) and many "Ping" brands. |

### Marks that share an element (relevant to how likely confusion is, live US marks in cl. 9/38/42)
- **PING**: Karsten Manufacturing (PING golf) holds many live PING registrations in classes 9, 38 and 42, including recent filings 99126339 (cl. 38/42), 98865748 (cl. 9/36/38/42) and 50156494 (cl. 9/38/42/45). Ping Identity holds PING IDENTITY (cl. 9/42). PING! (NexaConnect, cl. 9). "Ping" is common and fairly descriptive for messaging, so on its own it is weak. Karsten clearly enforces it across tech classes, though, so this is the main watch item.
- **WREN**: 22 live US marks in 9/38/42. The ones most relevant to software and comms:
  - PolyAI Ltd (UK, conversational AI) WREN, cl. 9/42 (serial 50018781). PolyAI uses "Wren" as the name of an AI agent product.
  - Wren, Inc. WREN, cl. 9/42 (99898281).
  - LITTLE WREN SOFTWARE, cl. 42.
  - Wren Kitchens (Wren US Holdings) has broad WREN filings, including cl. 9/42.
- Overall view (not legal advice): no identical or near-identical PINGWREN mark was found in the one register I could search (USPTO). The combined coined word looks distinctive. The main residual risks are (a) the UK/EU/WIPO registers, which I could not check, and (b) owners of PING or WREN marks, PolyAI in particular because it is a UK company in customer-conversation software.

### Domains
- pingwren.com: Verisign RDAP https://rdap.verisign.com/com/v1/domain/pingwren.com returns **404**, so the domain is **not registered**. The control lookup for google.com returned 200.
- pingwren.co.uk: Nominet RDAP https://rdap.nominet.uk/uk/domain/pingwren.co.uk returns **404 "Domain pingwren.co.uk not found"**, so it is **not registered**.
- pingwren.io / .app / .ai / .co: no DNS resolution. That suggests they are unregistered, but RDAP was not checked for these.

### Manual searches still needed
1. UK IPO: https://trademarks.ipo.gov.uk/ipo-tmtext. Search PINGWREN, PING WREN, PINGREN, and WREN in classes 9/38/42.
2. TMview: https://www.tmdn.org/tmview/. Same terms, all offices.
3. WIPO Brand DB: https://branddb.wipo.int. Covers Madrid filings.
4. App Store / Google Play name search.

## 2. GoHighLevel: setting contact DND via API v2

**Source:** GHL's official OpenAPI spec, `apps/contacts.json` in the official docs repo:
https://raw.githubusercontent.com/GoHighLevel/highlevel-api-docs/main/apps/contacts.json
Human-readable page: https://marketplace.gohighlevel.com/docs/ghl/contacts/update-contact

### Update Contact, as the spec defines it
- `PUT https://services.leadconnectorhq.com/contacts/{contactId}`
- Headers: `Authorization: Bearer <token>` and `Version: 2021-07-28` (the spec gives this as an enum with that single value). Body is `application/json`.
- OAuth scope: `contacts.write`.
- Body fields (from `UpdateContactDto`):
  - `dnd`: boolean. A blanket flag across all channels.
  - `dndSettings` (`DndSettingsSchema`): per-channel keys **`Call`, `Email`, `SMS`, `WhatsApp`, `GMB`, `FB`**. These are PascalCase, except SMS, GMB and FB, which are all caps.
    - Each key takes `{ "status": "active" | "inactive" | "permanent" (required), "message"?: string, "code"?: string }`.
  - `inboundDndSettings`: `{ "all": { "status": "active" | "inactive" (required), "message"?: string } }`.

Example:
```json
{ "dndSettings": { "SMS": { "status": "active", "message": "Opted out", "code": "STOP" },
                   "WhatsApp": { "status": "active", "message": "Opted out", "code": "STOP" } } }
```

### How setGhlContactDnd in /home/user/wa-connector-accounts/src/lib/ghl.ts (lines 897-920) compares
| Item | Code | Spec | Match? |
|---|---|---|---|
| Method/path | `PUT ${API_BASE}/contacts/{id}` | PUT /contacts/{contactId} | Yes |
| Version header | `CONTACTS_API_VERSION` = `"2021-07-28"` | `2021-07-28` | Yes. The "ASSUMED" comment on line 68 can now be updated to say it is confirmed. |
| Body field | `dndSettings` | `dndSettings` | Yes |
| Channel keys | `WhatsApp`, `SMS` | `WhatsApp`, `SMS` | Yes, casing matches |
| Status values | `"active"` / `"inactive"` | active / inactive / permanent | Yes |
| Extra fields | `message`, `code` (only when setting) | optional `message`, `code` | Yes |
| Blanket `dnd` flag | not sent | optional | Fine, and the right choice |
| Scope | SCOPES includes `contacts.write` | `contacts.write` | Yes |

**Against the v2 spec there is no mismatch.** One caveat: the live marketplace docs page now renders a **`Version: v3`** variant. Its example uses **lowercase** channel keys (`call`, `email`) and, for inbound, `inboundDndSettings.all`. If the integration ever moves to `Version: v3`, the keys may need to become lowercase (`sms`, `whatsapp`). That should be checked against the v3 schema at the time. As long as the code sends `2021-07-28`, the PascalCase keys are correct.

A small behaviour note, not a bug: when a contact sends START (dnd=false), the code sends `{status:"inactive"}`. That lifts DND only on SMS and WhatsApp. If GHL or a user has set the blanket `dnd: true`, that flag stays in place. This is intended.
