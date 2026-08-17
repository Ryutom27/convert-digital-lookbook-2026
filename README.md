# Lookbook Feature

A native Shopify Lookbook feature for a fashion client trading in two markets (AUD, JPY). Built entirely with theme sections, a metaobject, and the Storefront API — no third-party apps.

**tl;dr — the key calls, detail below:**
- Metaobject uses a native **List of products** field, not plain-text handles — but only `.handle` is ever read from it server-side; price/image/variants come from the Storefront API at runtime, per the brief's constraint. ([why](#why-list-of-products-not-a-plain-text-list-of-handles))
- All products in a lookbook are fetched in **one batched GraphQL request** (aliased `product(handle:...)` lookups), not one request per product. ([detail](#runtime-product-fetching))
- `@inContext(country:...)` resolves price and compare-at correctly per AUD/JPY market. ([detail](#market-based-pricing-audjpy))
- Product-page "featured in" uses a **runtime scan** over lookbook entries, not a synced back-reference metafield — a documented O(n) vs O(1) trade-off. ([detail](#product-page-reverse-lookup))
- Shoppable row sits **beside** the cover image, not as hotspot markers on it — a deliberate call, not an oversight. ([why](#layout-a-shoppable-row-beside-the-banner-not-hotspot-markers-on-the-image))

## What's here

- **`sections/lookbook.liquid`** — customizer section, addable to any page. Merchant picks a `lookbook` metaobject entry from a native picker.
- **`sections/lookbook-featured-in.liquid`** — product-page section showing any lookbook(s) the current product is featured in. Renders nothing if it isn't in any.
- **`snippets/lookbook-card.liquid`** — the actual lookbook markup (image, title, description, shoppable product row, dialog), shared by both sections above so there's one rendering path, not two.
- **`assets/lookbook.js`** — fetches live product data from the Storefront API, renders the shoppable row, handles add-to-cart.
- **Theme setting**: *Storefront API → Storefront API access token* — the public token used for all client-side fetches.

## How to view it

1. In the Shopify admin, add a **Lookbook** section to any page via the theme customizer and pick a lookbook entry.
2. Visit a product page for a product that's included in a lookbook to see the **Featured in Lookbook** section.
3. Switch markets (AUD/JPY, via the header country selector) to see prices and compare-at pricing update.

## The metaobject

`lookbook` (Content → Metaobjects):

| Field | Type | Notes |
|---|---|---|
| `title` | Single line text | Shown as the lookbook's heading; also used for admin usability when picking entries. |
| `description` | Multi-line text | Optional supporting copy. |
| `image` | File (image) | The cover/hero image. |
| `products` | List of products | The products featured in this lookbook. |

No metaobject-level "Storefront API access" toggle needs to be enabled for this feature — the `lookbook` metaobject is only ever read server-side via native Liquid (`shop.metaobjects.lookbook.values`, `lookbook.products.value`), both for rendering a merchant-picked lookbook and for the product-page reverse lookup. The Storefront API is reserved entirely for fetching live `Product` data by handle (see below); it never queries metaobjects directly.

### Why "List of products," not a plain-text list of handles

The brief's handles-only constraint is about the **runtime fetch/integration layer** — the theme is never allowed to resolve price, image, or other product data natively through Liquid; that has to come from a live Storefront API call. It isn't a constraint on the *admin data model*. Using Shopify's native product reference field gives merchants a real visual product picker in the admin (search, thumbnails, drag-to-reorder) instead of hand-typing handles into a text field, which is what "easily managed via the Shopify admin interface" calls for.

The constraint is enforced in the code, not just by convention: every place that touches `lookbook.products.value` — `snippets/lookbook-card.liquid` (rendering) and `sections/lookbook-featured-in.liquid` (the reverse-lookup scan) — only ever reads `.handle` off each resolved product reference —

```liquid
assign product_handles = lookbook.products.value | map: 'handle' | join: ','
```

— and hand that off to JavaScript as a plain string. No `.price`, `.featured_image`, or any other product field is ever touched server-side. All of that comes back from the Storefront API at runtime instead.

## Runtime product fetching

`assets/lookbook.js` reads the handles off a `data-product-handles` attribute and fires **one** batched GraphQL request per lookbook — not one request per product:

```graphql
query LookbookProducts($country: CountryCode!) @inContext(country: $country) {
  product0: product(handle: "classic-cap") { ... }
  product1: product(handle: "denim-jacket") { ... }
}
```

Each product gets its own aliased `product(handle: ...)` lookup in the same request. This avoids N+1 requests, and using exact-handle lookups (rather than a `query:` search filter) means a deleted or unpublished handle just comes back `null` for that one alias — the rest of the response is unaffected, and that product's placeholder is quietly removed rather than showing broken content.

The API version is pinned as a constant (`API_VERSION` in `assets/lookbook.js`) rather than using `unstable`, so the query shape doesn't shift under this code without a deliberate bump. Shopify retires each version 12 months after release, so this needs occasional maintenance — a stale pin fails outright once its version is retired, rather than degrading quietly.

### Auth

The token is a **public Storefront API access token**, obtained via **Settings → Apps and sales channels → Headless → Create storefront**, pasted into the theme setting under **Storefront API**. This is the public token by design — it's meant to be readable client-side (sent as the `X-Shopify-Storefront-Access-Token` header), unlike the private token, which requires server-side use and buyer-IP forwarding and has no place in a browser-side fetch.

## Market-based pricing (AUD/JPY)

Two things had to line up for this to work correctly, and they're handled separately on purpose:

1. **Which country is the shopper in, right now?** This is resolved by Shopify's own localization system — via the header's manual country selector, or automatic IP-based market detection for first-time visitors (if enabled under Settings → Markets). Either way, the result lands in the same place: `localization.country.iso_code` in Liquid.
2. **Getting the Storefront API to respect that.** The Storefront API's GraphQL endpoint does *not* read the localization cookie on its own — `@inContext(country: $country)` only uses what's explicitly passed as a variable. So the section outputs `localization.country.iso_code` into a `data-country` attribute at render time, and the JS reads it once and passes it into the query. Since switching markets triggers a full page reload, this single read-at-load is always correct — no extra logic needed to distinguish "shopper picked JPY" from "shopper was auto-detected as being in Japan."

**Compare-at pricing**: both `priceRange` and `compareAtPriceRange` are requested per product, per market, in the same query — so a product on sale in JPY but not AUD (or vice versa) resolves correctly and independently in each market, not just the base price.

**Currency formatting**: JPY has no decimal places; a naive formatter would render `¥1500.00` instead of `¥1,500`. `assets/lookbook.js` reuses the theme's existing `money-formatting.js` module (`formatMoney`/`convertMoneyToMinorUnits`), the same code the rest of the theme already relies on for this, rather than re-implementing currency formatting.

## Making it shoppable

This part is **not** in the written brief — it's feedback the client (via the hiring team) gave on a previous attempt: a lookbook that was just images with prices next to them, with no way to actually buy, wasn't good enough. Documenting it here explicitly so it reads as a deliberate addition, not scope creep.

Clicking a thumbnail in the shoppable row opens a small dialog (image, title, price, a variant picker if there's more than one buyable option, and an Add to cart button). Add to cart posts to the standard `/cart/add.js` endpoint and dispatches the theme's existing `CartLinesUpdateEvent` — the same event `assets/product-form.js` dispatches after any other add-to-cart on the site. The existing cart drawer and cart icon already listen for this event and update themselves; nothing new was built for cart UI.

### Variants

The query requests `variants(first: 100)` — Shopify's actual maximum variants per product, not an arbitrary guess, so every option combination is fetched rather than most of them.

Sold-out variants still appear in the picker rather than being filtered out — they're rendered as disabled options labelled "- Sold out," so a shopper can see the full range a product comes in even when one option is unavailable, instead of a color or size just silently disappearing from the list. Selecting a different variant also swaps the dialog's image to that variant's own image where it has one (e.g. picking "Black" shows the black product shot, not the white one from `featuredImage`), falling back to the product's main image for variants that don't have a dedicated one.

### Layout: a shoppable row beside the banner, not hotspot markers on the image

Two options were considered for tying the shoppable part visually to the cover image:

- **Hotspot markers positioned on the image** (the theme has a native pattern for this, `sections/product-hotspots.liquid`) — visually striking, but its native block resolves products server-side via Liquid, which conflicts with the handles-only constraint; it would need to be rebuilt custom. It also needs new metaobject fields (an x/y position per product), and small fixed-position tap targets on an image are a known weak pattern on mobile.
- **A shoppable row directly beside/below the image** (what's built) — the cover image sits in a two-column layout (modeled on the theme's existing `media-with-content` grid technique, so it collapses to stacked on mobile the same way that section already does), with a horizontally-scrollable product row in the content column. No schema change, no new mobile-specific interaction pattern, and the products read clearly as "featured in this image" by proximity.

Documented here as a conscious choice, with hotspot markers noted below as a possible future enhancement rather than something ruled out for lack of consideration.

## Product-page reverse lookup

A product doesn't know which lookbook(s) it's featured in — only lookbooks know their own product list. Two ways to answer "is this product in a lookbook":

- **Runtime scan (what's built).** `sections/lookbook-featured-in.liquid` loops every `lookbook` metaobject entry and checks whether the current product's handle appears in its product list. This runs server-side in Liquid — it's O(n) in the number of lookbook entries per product-page render, but it's a native product-reference read, not a price/image resolution, so it doesn't touch the Storefront API or the handles-only constraint at all.
- **Synced back-reference (not built).** A metafield on the product, kept in sync via Shopify Flow whenever a lookbook's product list changes, would make this an O(1) metafield read instead of an O(n) scan. Rejected for this submission: it adds Flow trigger setup, handling the removal case, and sync testing — real work for a scaling concern that doesn't bite until a store has a large number of lookbook entries, which isn't indicated by the brief. Worth revisiting if the client's lookbook catalog grows large.

## Error handling & loading states

- A deleted, unpublished, or mistyped product handle doesn't break the section — that one card's placeholder is removed, everything else renders normally.
- If the Storefront API request itself fails (network error, bad token), it's logged to the console and the section fails quietly rather than throwing — the rest of the page is unaffected.
- While the batched request is in flight, product placeholders render as sized, pulsing skeleton boxes rather than an empty gap, so nothing flashes or jumps in once real content arrives.
- Thumbnail and dialog images use the variant/product image's own `altText` from the Storefront API where one is set, falling back to the product title when it isn't — so alt text is never left blank. The lookbook's own `title` field renders as a visible heading (`<h2>`) rather than an ARIA label, so it's available to screen readers the same way any other section heading is.

## Known limitations / possible future work

- **Single cover image per lookbook**, not a multi-image editorial gallery. A real fashion lookbook is often a small series of shots; this metaobject currently supports one hero image per entry. Kept intentionally simple for scope — the brief doesn't require an image field at all — but a natural next step if the client wants a fuller "lookbook" feel.
- **Hotspot-style markers on the image**, as a richer alternative to the row layout, if the client is comfortable trading off the mobile tap-target concerns and a metaobject schema change (x/y position per product).
- **Flow-synced back-reference metafield** for the product-page reverse lookup, once lookbook count grows large enough for the O(n) scan to matter.
- New UI strings (e.g. "Shop the look") were kept as plain English rather than added to the theme's ~40 locale files, since this is a single-market-language build for this exercise; a production rollout would need those translated.
- The dialog is a plain `<dialog>`, not the theme's shared `DialogComponent` (used by quick-add, search, and the cart tooltip). Not used from the start because none of what it adds — open/close animation, background-scroll lock, scroll-position restore — was needed to meet the brief; a native `<dialog>` inside the one `lookbook-component` element was the simplest thing that worked, without pulling in a second nested custom element. Adopting it later is possible but non-trivial: its dialog is a required ref on that separate component, and refs don't cross nested `*-component` boundaries in this theme, so every dialog touchpoint here would need rework to reach it. Deferred as a low-priority polish follow-up.
