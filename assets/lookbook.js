import { Component } from '@theme/component';
import { fetchConfig } from '@theme/utilities';
import { formatMoney, getCurrencyDivisor } from '@theme/money-formatting';
import { CartLinesUpdateEvent, CartErrorEvent } from '@shopify/events';

/**
 * Storefront API version this section's queries target. Update alongside the
 * theme's other API-version references when bumping Shopify API versions.
 */
const API_VERSION = '2026-04';

const PRODUCT_FIELDS = `
  id
  title
  handle
  descriptionHtml
  onlineStoreUrl
  featuredImage {
    url
    altText
  }
  priceRange {
    minVariantPrice {
      amount
      currencyCode
    }
  }
  compareAtPriceRange {
    minVariantPrice {
      amount
      currencyCode
    }
  }
  variants(first: 100) {
    nodes {
      id
      availableForSale
      title
      image {
        url
        altText
      }
      selectedOptions {
        name
        value
      }
    }
  }
`;

/**
 * Storefront API IDs are GraphQL global IDs (e.g. "gid://shopify/ProductVariant/123"),
 * but the Ajax Cart API (/cart/add.js) expects the plain numeric ID — the same
 * format Liquid's `variant.id` outputs everywhere else in this theme.
 * @param {string} gid
 * @returns {string}
 */
function toNumericId(gid) {
  return gid.split('/').pop() ?? gid;
}

const DESCRIPTION_EXCERPT_LENGTH = 120;

/**
 * Truncates plain text to a max length on a word boundary, for a short
 * dialog excerpt rather than a merchant's full (possibly long) description.
 * @param {string} text
 * @param {number} maxLength
 * @returns {string}
 */
function excerpt(text, maxLength) {
  if (text.length <= maxLength) return text;

  const sliced = text.slice(0, maxLength);
  const lastSpace = sliced.lastIndexOf(' ');
  // Only back off to the last space if there is one to back off to —
  // a single word longer than maxLength still needs a hard cut.
  const truncated = lastSpace > 0 ? sliced.slice(0, lastSpace) : sliced;

  return `${truncated.trimEnd()}…`;
}

/**
 * Converts a product's descriptionHtml into plain text. Block-level tags
 * become a space before stripping, so merchant content shaped like
 * "<p><strong>Name</strong></p><p>Body copy</p>" — a common rich-text
 * pattern — doesn't collapse into "NameBody copy" once tags are removed.
 * @param {string} html
 * @returns {string}
 */
function htmlToText(html) {
  const withSpaces = html.replace(/<\/(p|div|h[1-6]|li|tr)>|<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '');

  // Decode entities (&amp;, &#39;, etc.) without executing any markup — a
  // <textarea>'s value never parses its content as HTML.
  const textarea = document.createElement('textarea');
  textarea.innerHTML = withSpaces;

  return textarea.value.replace(/\s+/g, ' ').trim();
}

/**
 * Builds a single batched GraphQL query fetching all given handles by alias,
 * so a lookbook with N products costs one Storefront API request, not N.
 *
 * No chunking/cap on handle count: a very large lookbook (dozens of
 * products, each with variants(first: 100)) could approach the Storefront
 * API's query cost limit in one request. Not addressed here — lookbooks in
 * this build are small, curated "looks" (a handful of products), so
 * request-chunking would be speculative complexity for a case the brief
 * doesn't exercise. Worth revisiting if lookbooks grow much larger.
 * @param {string[]} handles
 * @returns {string}
 */
function buildQuery(handles) {
  const fields = handles
    .map((handle, index) => `product${index}: product(handle: ${JSON.stringify(handle)}) { ${PRODUCT_FIELDS} }`)
    .join('\n');

  // $country is nullable (not CountryCode!) so a blank/missing localization
  // value degrades to the shop's default market context instead of failing
  // GraphQL variable coercion for the whole batched request.
  return `query LookbookProducts($country: CountryCode) @inContext(country: $country) {\n${fields}\n}`;
}

/**
 * A lookbook: fetches live product data for a set of handles via the Storefront
 * API, renders a shoppable thumbnail row, and adds to cart via a click-to-reveal
 * dialog wired into the theme's shared cart-update event.
 *
 * @typedef {object} Refs
 * @property {HTMLElement} [thumbList] - Absent when the lookbook has no products (snippets/lookbook-card.liquid only renders it when products.size > 0)
 * @property {HTMLDialogElement} dialog
 * @property {HTMLTemplateElement} [thumbIconTemplate]
 * @property {HTMLTemplateElement} [selectCaretTemplate]
 * @extends Component<Refs>
 */
export class LookbookComponent extends Component {
  requiredRefs = ['dialog'];

  /** @type {Array<object | null>} */
  #products = [];

  /** @type {string | null} */
  #selectedVariantId = null;

  /** @type {any} */
  #currentProduct = null;

  connectedCallback() {
    super.connectedCallback();
    this.#fetchProducts();

    // Native <dialog> doesn't close on backdrop click by default — a click
    // on the backdrop bubbles with the dialog itself as the target (nothing
    // inside it does), so this check distinguishes "outside" from "inside".
    this.refs.dialog.addEventListener('click', (event) => {
      if (event.target === this.refs.dialog) this.refs.dialog.close();
    });
  }

  async #fetchProducts() {
    const handles = (this.dataset.productHandles ?? '').split(',').filter(Boolean);
    const token = this.dataset.storefrontToken;
    // Falsy (missing/blank) becomes undefined rather than "" so
    // JSON.stringify omits the variable entirely — an empty string would
    // still fail enum coercion even with $country now nullable.
    const country = this.dataset.country || undefined;

    if (handles.length === 0) return;

    if (!token) {
      console.error('[lookbook] Missing Storefront API access token — set it in Theme Settings > Storefront API.');
      this.#clearPlaceholders();
      return;
    }

    /** @type {any} */
    let json;

    try {
      const response = await fetch(`/api/${API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Storefront-Access-Token': token,
        },
        body: JSON.stringify({
          query: buildQuery(handles),
          variables: { country },
        }),
      });

      json = await response.json();
    } catch (error) {
      // Storefront API being unreachable shouldn't break the page — remove
      // the (now-permanently-stuck) skeleton placeholders rather than leave
      // them pulsing forever.
      console.error('[lookbook] Storefront API request failed', error);
      this.#clearPlaceholders();
      return;
    }

    if (json.errors) {
      console.error('[lookbook] Storefront API returned errors', json.errors);
    }

    const placeholders = [...(this.refs.thumbList?.children ?? [])];

    handles.forEach((_handle, index) => {
      const product = json.data?.[`product${index}`] ?? null;
      this.#products[index] = product;

      // Fail gracefully per-product: a deleted/unpublished handle just
      // removes its placeholder rather than showing a broken card.
      if (!product) {
        placeholders[index]?.remove();
        return;
      }

      this.#renderThumb(placeholders[index], product, index);
    });
  }

  /**
   * Removes all skeleton placeholders — used when the fetch never ran (no
   * token) or failed outright, so there's no per-product data to render
   * instead. Leaving them in place would pulse forever.
   */
  #clearPlaceholders() {
    for (const placeholder of [...(this.refs.thumbList?.children ?? [])]) {
      placeholder.remove();
    }
  }

  /**
   * @param {Element | undefined} placeholder
   * @param {any} product
   * @param {number} index
   */
  #renderThumb(placeholder, product, index) {
    if (!placeholder) return;

    // Keep the <li>, just swap its skeleton state for real content — preserves
    // the list semantics (<ul role="list"> of <li>s) and the sizing/radius
    // styling already defined for .lookbook__thumb.
    placeholder.classList.remove('lookbook__thumb--loading');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lookbook__thumb-button';
    button.dataset.handle = product.handle;
    button.setAttribute('aria-label', product.title);
    button.setAttribute('on:click', `/openProduct/${index}`);

    const image = product.featuredImage;
    if (image) {
      const img = document.createElement('img');
      img.src = image.url;
      img.alt = image.altText || product.title;
      img.loading = 'lazy';
      button.append(img);
    }

    // Signals the thumbnail is clickable/shoppable, not just another photo —
    // matches the theme's existing icon-badge convention.
    if (this.refs.thumbIconTemplate instanceof HTMLTemplateElement) {
      button.append(this.refs.thumbIconTemplate.content.cloneNode(true));
    }

    const priceEl = document.createElement('span');
    priceEl.className = 'lookbook__thumb-price';
    priceEl.textContent = this.#formatPrice(
      product.priceRange.minVariantPrice,
      this.dataset.moneyFormat ?? '{{ amount }}'
    );

    placeholder.replaceChildren(button, priceEl);
  }

  /**
   * Opens the click-to-reveal product dialog for a thumbnail.
   * @param {number} index
   */
  openProduct = (index) => {
    const product = this.#products[index];
    if (!product) return;

    this.#populateDialog(product);
    this.refs.dialog.showModal();
  };

  closeDialog = () => {
    this.refs.dialog.close();
  };

  /**
   * @param {any} product
   */
  #populateDialog(product) {
    this.#currentProduct = product;

    const dialog = this.refs.dialog;
    dialog.replaceChildren();

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'lookbook__dialog-close';
    closeButton.setAttribute('aria-label', this.dataset.labelClose || 'Close');
    closeButton.setAttribute('on:click', '/closeDialog');
    closeButton.textContent = '×';
    dialog.append(closeButton);

    const moneyFormat = this.dataset.moneyFormat ?? '{{ amount }}';
    const price = product.priceRange.minVariantPrice;
    const compareAt = product.compareAtPriceRange?.minVariantPrice;
    const isOnSale = compareAt && Number(compareAt.amount) > Number(price.amount);

    const image = product.featuredImage;
    if (image) {
      const img = document.createElement('img');
      img.className = 'lookbook__dialog-image';
      img.src = image.url;
      img.alt = image.altText || product.title;
      dialog.append(img);
    }

    const content = document.createElement('div');
    content.className = 'lookbook__dialog-content';

    const title = document.createElement('p');
    title.className = 'lookbook__dialog-title';
    title.textContent = product.title;
    content.append(title);

    const priceEl = document.createElement('p');
    priceEl.className = 'lookbook__dialog-price';
    priceEl.append(this.#formatPrice(price, moneyFormat));

    if (isOnSale) {
      const compareEl = document.createElement('s');
      compareEl.className = 'lookbook__dialog-compare-at';
      compareEl.append(this.#formatPrice(compareAt, moneyFormat));
      priceEl.append(' ', compareEl);
    }

    content.append(priceEl);

    if (product.descriptionHtml) {
      const descriptionEl = document.createElement('p');
      descriptionEl.className = 'lookbook__dialog-description';
      descriptionEl.textContent = excerpt(htmlToText(product.descriptionHtml), DESCRIPTION_EXCERPT_LENGTH);
      content.append(descriptionEl);
    }

    const detailsLink = document.createElement('a');
    detailsLink.className = 'lookbook__dialog-link';
    detailsLink.href = product.onlineStoreUrl || `/products/${product.handle}`;
    detailsLink.target = '_blank';
    detailsLink.rel = 'noopener';
    detailsLink.textContent = 'View full details';
    content.append(detailsLink);

    const allVariants = product.variants.nodes;
    const availableVariants = allVariants.filter((/** @type {any} */ variant) => variant.availableForSale);
    // Kept as the Storefront API's GraphQL global ID (not the numeric ID) —
    // CartLinesUpdateEvent's merchandiseId field expects that format. Only
    // converted to the numeric ID right before the /cart/add.js request, the
    // one place that needs it.
    this.#selectedVariantId = availableVariants[0]?.id ?? null;

    if (allVariants.length > 1) {
      const selectWrapper = document.createElement('div');
      selectWrapper.className = 'lookbook__dialog-variant-select-wrapper';

      const select = document.createElement('select');
      select.className = 'lookbook__dialog-variant-select';
      select.setAttribute('on:change', '/handleVariantChange');
      select.setAttribute('aria-label', 'Options');

      // Sold-out variants still render — as a disabled option, so shoppers
      // can see the full range rather than have it silently disappear —
      // they just can't be selected.
      for (const variant of allVariants) {
        const option = document.createElement('option');
        option.value = variant.id;
        const label = variant.selectedOptions
          .map((/** @type {any} */ selectedOption) => selectedOption.value)
          .join(' / ');
        option.textContent = variant.availableForSale ? label : `${label} - Sold out`;
        option.disabled = !variant.availableForSale;
        option.selected = variant.id === this.#selectedVariantId;
        select.append(option);
      }

      selectWrapper.append(select);

      // Stripping the select's native appearance (below) also removes its
      // native dropdown arrow, so a custom one takes its place — same
      // pattern the theme's own localization-form select already uses.
      if (this.refs.selectCaretTemplate instanceof HTMLTemplateElement) {
        selectWrapper.append(this.refs.selectCaretTemplate.content.cloneNode(true));
      }

      content.append(selectWrapper);
    }

    const addToCartButton = document.createElement('button');
    addToCartButton.type = 'button';
    addToCartButton.className = 'button lookbook__dialog-add-to-cart';
    addToCartButton.setAttribute('on:click', '/addToCart');
    addToCartButton.textContent = availableVariants.length > 0 ? 'Add to cart' : 'Sold out';
    addToCartButton.disabled = availableVariants.length === 0;
    content.append(addToCartButton);

    const errorEl = document.createElement('p');
    errorEl.className = 'lookbook__dialog-error';
    errorEl.hidden = true;
    content.append(errorEl);

    dialog.append(content);
  }

  /**
   * @param {string} message
   */
  #showError(message) {
    const errorEl = this.refs.dialog.querySelector('.lookbook__dialog-error');
    if (!(errorEl instanceof HTMLElement)) return;
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  /**
   * @param {{ amount: string, currencyCode: string }} price
   * @param {string} moneyFormat
   */
  #formatPrice(price, moneyFormat) {
    // price.amount is the Storefront API's MoneyV2 Decimal scalar — an
    // unambiguous plain-decimal string (e.g. "12000.0" for JPY, "15.00" for
    // AUD), never locale-formatted. Parsing it directly avoids the
    // thousands-vs-decimal guessing convertMoneyToMinorUnits does for
    // human-typed input, which misreads zero-decimal currencies like JPY
    // (it has no fractional digits to expect, so a trailing ".0" gets
    // folded into the whole number instead of discarded, inflating the
    // price by a factor of 10).
    const amount = Number.parseFloat(price.amount);
    if (Number.isNaN(amount)) return price.amount;

    const minorUnits = Math.round(amount * getCurrencyDivisor(price.currencyCode));
    return formatMoney(minorUnits, moneyFormat, price.currencyCode);
  }

  /**
   * @param {Event} event
   */
  handleVariantChange = (event) => {
    if (!(event.target instanceof HTMLSelectElement)) return;
    const select = event.target;
    this.#selectedVariantId = select.value;

    const product = this.#currentProduct;
    if (!product) return;

    const variant = product.variants.nodes.find((/** @type {any} */ node) => node.id === select.value);
    const image = variant?.image ?? product.featuredImage;
    if (!image) return;

    const img = this.refs.dialog.querySelector('.lookbook__dialog-image');
    if (img instanceof HTMLImageElement) {
      img.src = image.url;
      img.alt = image.altText || product.title;
    }
  };

  /**
   * @param {Event} event
   */
  addToCart = async (event) => {
    const variantId = this.#selectedVariantId;
    if (!variantId) return;

    const button = /** @type {HTMLButtonElement} */ (event.target);
    button.disabled = true;

    const cartItemsComponents = document.querySelectorAll('cart-items-component');
    const sectionIds = [...cartItemsComponents]
      .map((component) => /** @type {HTMLElement} */ (component).dataset.sectionId)
      .filter(Boolean);

    const deferredEventPromise = CartLinesUpdateEvent.createPromise();

    // Dispatched from the dialog itself, not `this` (the lookbook-component)
    // — cart-drawer.js detects an in-flight modal via
    // `event.target.closest('dialog:modal')`, which only walks ancestors.
    // The dialog is a descendant of lookbook-component, so dispatching from
    // `this` would make that lookup fail and let the cart drawer open
    // immediately instead of waiting for this dialog to close first.
    this.refs.dialog.dispatchEvent(
      new CartLinesUpdateEvent({
        action: 'add',
        context: 'dialog',
        lines: [{ merchandiseId: variantId, quantity: 1 }],
        promise: deferredEventPromise.promise,
      })
    );

    try {
      const response = await fetch(Theme.routes.cart_add_url, {
        ...fetchConfig('json', {
          body: JSON.stringify({
            items: [{ id: toNumericId(variantId), quantity: 1 }],
            sections: sectionIds.join(','),
          }),
        }),
      });
      const result = await response.json();

      if (result.status) {
        // A handled cart API error (e.g. out of stock) — still resolve the
        // promise with a refetched cart, matching product-form.js's contract.
        // Only genuine unexpected exceptions (below) reject it.
        const message = result.message || 'Add to cart failed';
        this.#showError(message);
        this.dispatchEvent(new CartErrorEvent({ error: message, code: 'INVALID' }));

        const cart = await this.#refreshCart();
        deferredEventPromise.resolve({
          cart: CartLinesUpdateEvent.createCartFromAjaxResponse(cart),
          detail: { didError: true, items: cart.items, source: 'lookbook-component' },
        });
        return;
      }

      const cart = await this.#refreshCart();

      deferredEventPromise.resolve({
        cart: CartLinesUpdateEvent.createCartFromAjaxResponse(cart),
        detail: {
          sections: result.sections,
          items: cart.items,
          didError: false,
          source: 'lookbook-component',
        },
      });

      this.refs.dialog.close();
    } catch (error) {
      console.error('[lookbook] Add to cart failed', error);
      this.#showError(/** @type {Error} */ (error).message || 'Something went wrong. Please try again.');
      this.dispatchEvent(
        new CartErrorEvent({ error: /** @type {Error} */ (error).message, code: 'SERVICE_UNAVAILABLE' })
      );
      deferredEventPromise.reject(error);
    } finally {
      button.disabled = false;
    }
  };

  async #refreshCart() {
    const cartItemsComponent = document.querySelector('cart-items-component');

    if (cartItemsComponent) {
      await customElements.whenDefined('cart-items-component');
      return /** @type {any} */ (cartItemsComponent).fetchCartData();
    }

    const response = await fetch(`${Theme.routes.cart_url}.json`, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    });

    if (!response.ok) throw new Error(`Failed to fetch cart: ${response.status}`);
    return response.json();
  }
}

customElements.define('lookbook-component', LookbookComponent);
