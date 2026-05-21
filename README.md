# Fika Job Scout

Internal tool for tracking hiring activity across the Fika Ventures portfolio.

**Live dashboard:** `fika-jobscout-production.up.railway.app` 

---

## Why this exists

When we meet someone interesting, it's hard to keep track of what all our portcos are actively hiring for — especially the newer investments where we're still getting up to speed. This tool scrapes job boards across the portfolio every weekday morning so you always have a current picture of who's hiring and for what.

The main use case is the **Find Roles** tab: paste a LinkedIn profile and it ranks every open role across the portfolio by fit. Instead of manually checking 30 job boards, you get a ranked list in a few seconds.

---

## What it does

- **Scrapes job boards** across 30 portfolio companies every weekday at 9am UTC
- **Slack notifications** when a new role is posted
- **Web dashboard** to see hiring trends, browse open roles, and filter by function/seniority
- **Candidate matching** — paste a LinkedIn profile, get the top 10 role matches ranked by fit with a one-click intro blurb

---

## Using Find Roles

1. Go to the candidate's LinkedIn profile
2. Press `Cmd+A` to select all, `Cmd+C` to copy
3. Open the dashboard → **Find Roles** tab
4. Paste the profile into the text box
5. Optionally add context (location, comp range, companies to prioritize)
6. Hit **Find Matches**

Claude reads the profile, extracts function/seniority/domain, and scores every active role in the portfolio for mutual fit. Scoring is intentionally critical — 80+ means a genuinely compelling match.

The **Copy intro blurb** button on each match generates a one-liner you can paste straight into a message to the portco.

---

## Portfolio companies tracked

| Company | ATS |
|---|---|
| AKKO | Greenhouse |
| BuildOps | Greenhouse |
| Chowbus | Greenhouse |
| Moment Energy | Greenhouse |
| Noyo | Greenhouse |
| Papaya | Greenhouse |
| Sunbound | Greenhouse |
| Field AI | Lever |
| Grid | Lever |
| Ivo | Lever |
| Ajax | Ashby |
| Allocate | Ashby |
| Apiphany | Ashby |
| Artemis | Ashby |
| Atticus | Ashby |
| Beeble | Ashby |
| Clarify | Ashby |
| Coverbase | Ashby |
| Dispatch | Ashby |
| First Resonance | Ashby |
| Inspectiv | Ashby |
| Payabli | Ashby |
| Sift | Ashby |
| Siro | Ashby |
| Accorded | Breezy HR |
| PathSpot | Breezy HR |
| Upwards | Breezy HR |
| Elementary | BambooHR |
| Bowery Valuation | Rippling |
| SubBase | Rippling |

Only works for portcos using one of these 7 ATS platforms (Greenhouse, Lever, Ashby, Breezy, BambooHR, Rippling, Workday). To add a company, see below.

---

## Adding or removing a company

Edit the `COMPANIES` array in `index.ts`:

```typescript
{ name: "Siro", ats: "ashby", slug: "siro" }
```

**Finding the slug** — look at the company's careers page URL:

| Careers page URL | ATS | Slug |
|---|---|---|
| `job-boards.greenhouse.io/acme` | `greenhouse` | `acme` |
| `jobs.lever.co/acme` | `lever` | `acme` |
| `jobs.ashbyhq.com/acme` | `ashby` | `acme` |
| `acme.breezy.hr` | `breezy` | `acme` |
| `acme.bamboohr.com/careers` | `bamboohr` | `acme` |
| `ats.rippling.com/acme/jobs` | `rippling` | `acme` |
| `acme.wd5.myworkdayjobs.com/SiteName` | `workday` | `acme.wd5` |

**Workday companies require one extra field** — `workdaySite`, which is the path segment after the domain:

```typescript
{ name: "Acme Corp", ats: "workday", slug: "acme.wd5", workdaySite: "SiteName" }
```

Also add the company's domain to `COMPANY_DOMAINS` in `dashboard.html` so the logo loads correctly:

```javascript
"Acme Corp": "acme.com",
```

After adding a company, run the scraper manually once to pull in their current openings:

```bash
DATABASE_URL=postgresql://postgres:...@mainline.proxy.rlwy.net:21558/railway npm start
```

---

## Infrastructure

Everything runs on Railway:

- **fika-jobscout** — the web dashboard, always on at `fika-jobscout-production.up.railway.app`
- **insightful-peace** — cron service, runs `node dist/index.js` at `0 9 * * 1-5` (weekday 9am UTC)
- **Postgres** — persistent database shared between both services

### Environment variables (set in Railway)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Auto-set by Railway Postgres |
| `SLACK_WEBHOOK_URL` | Slack alerts on new postings |
| `ANTHROPIC_API_KEY` | Required for Find Roles matching |

### Running locally

```bash
cd fika-jobscout
PORT=3001 npm run dashboard
```

Open [http://localhost:3001](http://localhost:3001). Uses local SQLite by default (no `DATABASE_URL` needed).
