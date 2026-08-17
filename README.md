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

Metaobjects are read server-side via native Liquid only (`shop.metaobjects.lookbook.values`) — never through the Storefront API, so no metaobject-level API access toggle needs enabling.

### Why "List of products," not a plain-text list of handles

We wanted lookbooks to be easily manageable in the Shopify admin. A native product reference field gives merchants a real visual picker — search, thumbnails, drag-to-reorder — instead of hand-typing product handles into a text field.

This doesn't conflict with the brief's handles-only constraint, because that constraint is about the *runtime fetch layer*, not the admin data model: price, image, and every other product field are still only ever fetched live via the Storefront API, never resolved through Liquid. Only `.handle` is read server-side, and that's all that gets handed to JavaScript:

```liquid
assign product_handles = lookbook.products.value | map: 'handle' | join: ','
```

## Runtime product fetching

`assets/lookbook.js` reads the handles off a `data-product-handles` attribute and fires **one** batched GraphQL request per lookbook — not one request per product:

```graphql
query LookbookProducts($country: CountryCode) @inContext(country: $country) {
  product0: product(handle: "classic-cap") { ... }
  product1: product(handle: "denim-jacket") { ... }
}
```

A few deliberate details in that query:

- **`$country` is nullable**, not `CountryCode!`. If `localization.country.iso_code` is ever blank (an edge case in market resolution, or a theme-editor preview), a non-null variable would fail the *entire* batched request. Nullable, it just falls back to the shop's default market instead.
- **Each product gets its own aliased lookup**, avoiding N+1 requests. Using exact-handle lookups (rather than a `query:` search filter) also means a deleted or unpublished handle just comes back `null` for that one alias — the rest of the response is unaffected, and that product's placeholder is quietly removed.
- **The API version is pinned** as a constant (`API_VERSION` in `assets/lookbook.js`) rather than `unstable`, so the query shape can't shift without a deliberate bump. Shopify retires each version 12 months after release, so this needs occasional maintenance — a stale pin fails outright rather than degrading quietly.

### Auth

The token is a **public Storefront API access token**, obtained via **Settings → Apps and sales channels → Headless → Create storefront**, pasted into the theme setting under **Storefront API**. It's public by design — meant to be readable client-side (sent as the `X-Shopify-Storefront-Access-Token` header) — unlike the private token, which requires server-side use and buyer-IP forwarding and has no place in a browser-side fetch.

## Market-based pricing (AUD/JPY)

Two things have to line up, handled separately on purpose:

1. **Which country is the shopper in, right now?** Resolved by Shopify's own localization system — the header's manual country selector, or automatic IP-based detection for first-time visitors (if enabled under Settings → Markets). Either way, it lands in `localization.country.iso_code` in Liquid.
2. **Getting the Storefront API to respect that.** The Storefront API doesn't read the localization cookie on its own — `@inContext(country: $country)` only uses what's explicitly passed in. So the section outputs `localization.country.iso_code` into a `data-country` attribute at render time, and the JS reads it once and passes it into the query. Switching markets triggers a full page reload, so this single read-at-load is always correct.

**Compare-at pricing**: both `priceRange` and `compareAtPriceRange` are requested per product, per market, in the same query — so a product on sale in JPY but not AUD (or vice versa) resolves correctly and independently in each market.

**Currency formatting**: JPY has no decimal places, so a naive formatter would render `¥1500.00` instead of `¥1,500`. `assets/lookbook.js` reuses the theme's existing `money-formatting.js` (`formatMoney`) for display, rather than reimplementing it.

Getting the API's response into that formatter's expected input needed its own fix, though. `money-formatting.js` also exports `convertMoneyToMinorUnits`, a *fuzzy* parser built for human-typed input (a price filter field) that guesses whether trailing digits are a decimal or a thousands separator — and for zero-decimal currencies, that guess is always wrong. It misread JPY's `MoneyV2.amount` (e.g. `"12000.0"`) as `120000`, a 10x price inflation caught during testing. Since the API's amount is an unambiguous plain-decimal string, not human input, `#formatPrice` parses it directly with `getCurrencyDivisor` instead of routing it through that heuristic.

## Making it shoppable

This wasn't in the written brief — it's considered feedback from a previous attempt, where a lookbook of just images and prices, with no way to actually buy, wasn't good enough.

Clicking a thumbnail in the shoppable row opens a small dialog (image, title, price, a variant picker if there's more than one buyable option, and an Add to cart button). Add to cart posts to the standard `/cart/add.js` endpoint and dispatches the theme's existing `CartLinesUpdateEvent` — the same event `assets/product-form.js` dispatches after any other add-to-cart on the site. The existing cart drawer and cart icon already listen for this event and update themselves; nothing new was built for cart UI.

### Variants

The query requests `variants(first: 100)` — Shopify's actual maximum variants per product, not an arbitrary guess, so every option combination is fetched.

Sold-out variants still appear in the picker, rendered as disabled options labelled "- Sold out," so a shopper can see the full range a product comes in rather than a size or color silently disappearing. Selecting a different variant also swaps the dialog's image to that variant's own image where it has one (e.g. picking "Black" shows the black product shot, not the white one from `featuredImage`), falling back to the product's main image otherwise.

### Layout: a shoppable row beside the banner, not hotspot markers on the image

Two options were considered for tying the shoppable part to the cover image:

- **Hotspot markers on the image** (the theme has a native pattern for this, `sections/product-hotspots.liquid`) — visually striking, but its native block resolves products server-side via Liquid, conflicting with the handles-only constraint; it would need a custom rebuild. It also needs new metaobject fields (an x/y position per product), and small fixed-position tap targets are a known weak pattern on mobile.
- **A shoppable row beside/below the image** (what's built) — the cover image sits in a two-column layout (modeled on the theme's existing `media-with-content` grid, so it collapses to stacked on mobile the same way), with a horizontally-scrollable product row in the content column. No schema change, no new mobile interaction pattern, and the products read clearly as "featured in this image" by proximity.

Documented here as a conscious choice, with hotspot markers noted below as a possible future enhancement rather than something ruled out for lack of consideration.

## Product-page reverse lookup

A product doesn't know which lookbook(s) it's featured in — only lookbooks know their own product list. Two ways to answer "is this product in a lookbook":

- **Runtime scan (what's built).** `sections/lookbook-featured-in.liquid` loops every `lookbook` metaobject entry and checks whether the current product's handle appears in its product list. This runs server-side in Liquid — O(n) in the number of lookbook entries per product-page render — but it's a native product-reference read, not a price/image resolution, so it doesn't touch the Storefront API or the handles-only constraint at all.
- **Synced back-reference (not built).** A metafield on the product, kept in sync via Shopify Flow whenever a lookbook's product list changes, would make this an O(1) metafield read instead of an O(n) scan. Rejected for this submission: it adds Flow trigger setup, handling the removal case, and sync testing — real work for a scaling concern that doesn't bite until a store has a large number of lookbook entries, which isn't indicated by the brief. Worth revisiting if the client's lookbook catalog grows large.

## Error handling & loading states

- A deleted, unpublished, or mistyped product handle doesn't break the section — that one card's placeholder is removed, everything else renders normally.
- If the Storefront API request itself fails (missing token, network error), it's logged to the console and the skeleton placeholders are removed rather than left pulsing forever — the section fails quietly, and the rest of the page is unaffected.
- While the batched request is in flight, product placeholders render as sized, pulsing skeleton boxes rather than an empty gap, so nothing flashes or jumps in once real content arrives.
- Thumbnail and dialog images use the variant/product image's own `altText` from the Storefront API where one is set, falling back to the product title when it isn't — alt text is never left blank. The lookbook's own `title` field renders as a visible heading (`<h2>`) rather than an ARIA label, so it's available to screen readers the same way any other section heading is.

## Known limitations / possible future work

- **Single cover image per lookbook**, not a multi-image editorial gallery. A real fashion lookbook is often a small series of shots; this metaobject currently supports one hero image per entry. Kept intentionally simple for scope — the brief doesn't require an image field at all — but a natural next step if the client wants a fuller "lookbook" feel.
- **Hotspot-style markers on the image**, as a richer alternative to the row layout, if the client is comfortable trading off the mobile tap-target concerns and a metaobject schema change (x/y position per product).
- **Flow-synced back-reference metafield** for the product-page reverse lookup, once lookbook count grows large enough for the O(n) scan to matter.
- New UI strings (e.g. "Shop the look") were kept as plain English rather than added to the theme's ~40 locale files, since this is a single-market-language build for this exercise; a production rollout would need those translated.
- **Plain `<dialog>`**, not the theme's shared `DialogComponent` (used by quick-add, search, and the cart tooltip). It wasn't needed here — none of what `DialogComponent` adds (open/close animation, scroll lock, scroll-position restore) was required to meet the brief, and a native `<dialog>` inside one `lookbook-component` element was the simplest thing that worked. Adopting it later is possible but not trivial: its dialog is a required ref on a separate component, and refs don't cross nested `*-component` boundaries in this theme, so every touchpoint here would need rework. Deferred as low-priority polish.
