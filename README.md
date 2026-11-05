# FIT FUEL — website + API + admin on Netlify

Everything runs on Netlify: the customer website (`public/`), the API and admin login (Netlify Functions),
and the data (Netlify Database = Postgres): discounts, promo codes, customers/orders, skipped days.

```
public/                      customer website + photos
netlify/functions/api.mjs    API  (/api/*)
netlify/functions/admin.mjs  admin page (/admin) — dashboard code is only sent after login
netlify/database/migrations  database tables (applied automatically on deploy)
netlify.toml                 settings + security headers
```

## Deploy (about 15 minutes)
> Important: do **not** use "drag and drop" deploy — it does not run functions or the database.
> Deploy from **GitHub** (below) or with the Netlify CLI.

1. Put this whole folder in a new **GitHub** repository (do not upload `node_modules` or any `.env` file).
2. On https://app.netlify.com → **Add new project → Import an existing project** → pick the GitHub repo.
   Leave "Build command" empty. Publish directory = `public` (already set in `netlify.toml`).
3. Before/after the first deploy go to **Project configuration → Environment variables** and add:
   | Name | Value |
   |---|---|
   | `ADMIN_USER` | the admin username you choose (e.g. `owner`) |
   | `ADMIN_PASSWORD` | a long password, **10+ characters** |
   | `SECRET` | any long random text, **20+ characters** |
   Then trigger a new deploy so the functions see them.
4. The database is created automatically on deploy because `@netlify/database` is in `package.json`.
   If Netlify does not create it: **Data & Storage → Database → Create a database manually**, then deploy again.
5. Open your site link. Admin = `https://YOUR-SITE.netlify.app/admin` (log in with the user/password from step 3).
6. Custom domain (e.g. fitfuel.ae): **Domain management → Add a domain**.

If `ADMIN_PASSWORD` or `SECRET` is missing/too short the admin login is switched off (it says so) — nothing is exposed.

## Admin (not visible to customers)
- `/admin` shows only a login form to the public; the dashboard itself is sent only after a successful server-side login.
- Session = HttpOnly + Secure + SameSite=Strict cookie (12 h), CSRF header check, 5 wrong passwords → 10 minute lock,
  `noindex`. Change the password = change `ADMIN_PASSWORD` in Netlify and redeploy (old sessions stop working).
- Tabs: Kitchen sheet (what to cook/pack per date, allergy flags, address, print), Offers & codes (10/15/20/25 % on/off,
  sponsor promo codes), Customers.

## Run on your computer (optional)
`npm install -g netlify-cli`, then in this folder `netlify dev` (it starts a local database too).
Put test values in a `.env` file (see `.env.example`).

## Still to do before taking real money
1. **Payment gateway** (Stripe / Telr). The card form is a demo. Charge on the server first, then create the order.
2. **Recompute the price on the server** from the chosen meals once the gateway is connected.
3. Terms, Privacy and Refund pages; WhatsApp/email confirmation to the customer.
4. Confirm delivery zones/fees (placeholders in `CFG.zones` inside `public/index.html`).
5. Check Netlify's current pricing for Functions + Database (they use credits) on your plan.

Dish photos: put a WebP in `public/photos/` and list it in `IMG` inside `public/index.html`.
