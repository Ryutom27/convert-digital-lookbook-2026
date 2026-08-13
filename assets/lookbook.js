import { Component } from '@theme/component';
import { fetchConfig } from '@theme/utilities';
import { formatMoney, convertMoneyToMinorUnits } from '@theme/money-formatting';
import { CartLinesUpdateEvent, CartErrorEvent } from '@shopify/events';

/**
 * Storefront API version this section's queries target. Update alongside the
 * theme's other API-version references when bumping Shopify API versions.
 */
const API_VERSION = '2025-01';

const PRODUCT_FIELDS = `
  id
  title
  handle
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
  variants(first: 25) {
    nodes {
      id
      availableForSale
      title
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

/**
 * Builds a single batched GraphQL query fetching all given handles by alias,
 * so a lookbook with N products costs one Storefront API request, not N.
 * @param {string[]} handles
 * @returns {string}
 */
function buildQuery(handles) {
  const fields = handles
    .map((handle, index) => `product${index}: product(handle: ${JSON.stringify(handle)}) { ${PRODUCT_FIELDS} }`)
    .join('\n');

  return `query LookbookProducts($country: CountryCode!) @inContext(country: $country) {\n${fields}\n}`;
}

/**
 * A lookbook: fetches live product data for a set of handles via the Storefront
 * API, renders a shoppable thumbnail row, and adds to cart via a click-to-reveal
 * dialog wired into the theme's shared cart-update event.
 *
 * @typedef {object} Refs
 * @property {HTMLElement} thumbList
 * @property {HTMLDialogElement} dialog
 * @property {HTMLTemplateElement} [thumbIconTemplate]
 * @extends Component<Refs>
 */
export class LookbookComponent extends Component {
  requiredRefs = ['thumbList', 'dialog'];

  /** @type {Array<object | null>} */
  #products = [];

  /** @type {string | null} */
  #selectedVariantId = null;

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
    const country = this.dataset.country;

    if (handles.length === 0) return;

    if (!token) {
      console.error('[lookbook] Missing Storefront API access token — set it in Theme Settings > Storefront API.');
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
      // Storefront API being unreachable shouldn't break the page — the
      // placeholders just stay as-is and the section quietly renders nothing.
      console.error('[lookbook] Storefront API request failed', error);
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

    placeholder.replaceChildren(button);
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
    const dialog = this.refs.dialog;
    dialog.replaceChildren();

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'lookbook__dialog-close';
    closeButton.setAttribute('aria-label', 'Close');
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

    const availableVariants = product.variants.nodes.filter(
      (/** @type {any} */ variant) => variant.availableForSale
    );
    // Kept as the Storefront API's GraphQL global ID (not the numeric ID) —
    // CartLinesUpdateEvent's merchandiseId field expects that format. Only
    // converted to the numeric ID right before the /cart/add.js request, the
    // one place that needs it.
    this.#selectedVariantId = availableVariants[0]?.id ?? null;

    if (availableVariants.length > 1) {
      const select = document.createElement('select');
      select.className = 'lookbook__dialog-variant-select';
      select.setAttribute('on:change', '/handleVariantChange');
      select.setAttribute('aria-label', 'Options');

      for (const variant of availableVariants) {
        const option = document.createElement('option');
        option.value = variant.id;
        option.textContent = variant.selectedOptions
          .map((/** @type {any} */ selectedOption) => selectedOption.value)
          .join(' / ');
        select.append(option);
      }

      content.append(select);
    }

    const addToCartButton = document.createElement('button');
    addToCartButton.type = 'button';
    addToCartButton.className = 'button';
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
    const minorUnits = convertMoneyToMinorUnits(price.amount, price.currencyCode);
    return minorUnits === null ? price.amount : formatMoney(minorUnits, moneyFormat, price.currencyCode);
  }

  /**
   * @param {Event} event
   */
  handleVariantChange = (event) => {
    if (!(event.target instanceof HTMLSelectElement)) return;
    this.#selectedVariantId = event.target.value;
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

    this.dispatchEvent(
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
