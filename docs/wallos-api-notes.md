# Wallos HTTP API notes

What this server had to work around, confirmed against a running **Wallos v5.8.3** and read out of the endpoint sources. Useful to anyone building something against the same API.

Base path is `<instance>/api/`. Every endpoint authenticates with an API key passed as a request parameter, `api_key` or `apiKey`.

## Version floors

| | |
|---|---|
| The API-key HTTP API | **v5.0.0** (2026-07-11, "complete ui overhaul") |
| `get_period_budget`, `users/set_budget` | **v5.3.0** (2026-07-18, payment-period budgeting) |
| Verified against | **v5.8.3** |

Before v5.0.0 the endpoints were UI form handlers under `endpoints/`, driven by a session cookie rather than an API key.

## Behaviour that is easy to get wrong

### The status code carries no information

Every response is **HTTP 200**, authentication failures and application errors included. The body is the only signal:

```json
{ "success": false, "title": "Invalid API key", "message": "Unauthorized access." }
```

Reads answer with `success`, `title`, their own payload key, and `notes` — an array that carries warnings worth surfacing, such as stale exchange rates. `get_user` returns `notes` as a string instead.

### Writes only read `$_POST`

PHP populates `$_POST` for `application/x-www-form-urlencoded` and `multipart/form-data` bodies. A JSON body is invisible to the endpoint, which answers `{"success":false,"title":"Missing API key"}` even when the key is in that JSON. Writes must be form-encoded POSTs.

Reads use `$_REQUEST`, so either verb works and parameters may travel in the query string.

### Some flags are compared against the literal string `"true"`

`get_subscriptions.php` and `get_subscription.php` test `$_REQUEST['convert_currency'] === 'true'`. Sending `convert_currency=1` is **silently ignored**: you get `success: true` and unconverted prices. Other flags are genuinely `1`/`0` — `notify`, `inactive`, `auto_renew`, and the settings toggles.

### The list filter is `payment`, not `payment_method`

`get_subscriptions.php` filters payment methods on `$_REQUEST['payment']`. The `payment_method` its own docblock names is never read, and passing it returns the unfiltered list with `success: true` rather than an error.

### The endpoint docblocks are not always accurate

Useful, but not gospel. Three examples:

| Docblock says | Source actually reads |
|---|---|
| `payment_method` filter | `payment` |
| `get_subscriptions` returns a `users` array | only with `all-user-subscription=1` as user id 1 |
| `get_ical_feed` accepts `convert_currency` | the flag is accepted, but the calendar is built from a separate unconverted read |

### Money comes back as display strings

`get_monthly_cost.php` answers with:

```json
{ "monthly_cost": "1,234.56", "localized_monthly_cost": "€1,235", "currency_code": "EUR" }
```

`monthly_cost` is `number_format($total, 2)` — grouped by thousands separator, so it does not parse as a number without stripping separators. `localized_monthly_cost` is rounded for display and is not the figure to do arithmetic on.

Subscription `price` values are plain numbers; only the cost endpoints format.

### The calendar feed is not JSON

`get_ical_feed.php` sends `Content-Type: application/json` and then writes a VCALENDAR document. Detect it by parsing, not by the header.

### Partial updates on subscriptions are safe

`set_subscriptions.php` with `action=edit` fetches the current row and merges `$_POST` over it, so specifying one field does not clear the others. To clear a field, send it as an empty string: `payment_method_id=''`, `payer_user_id=''`, `category_id=''`, `notify_days_before=''`, `cancellation_date=''`.

`replacement_subscription_id` is forced to `null` whenever `inactive` is `0`, so setting a replacement on an active subscription has no effect.

### Settings updates are partial too

`set_settings.php` builds its `UPDATE` only from the fields present in `$_POST`. Unknown values are rejected rather than ignored — `dark_theme` must be `0`, `1` or `2`, `upcoming_payments_limit` must be `3`, `5`, `10` or `20`.

### `set_fixer.php` clears the key when the field is absent

There is no way to change only the provider without also writing `fixer_api_key`. An empty or missing `fixer_api_key` **clears the stored key**. A tool that updates provider settings has to refuse an empty call rather than wipe the key by accident.

### Deleting master data is guarded

Categories, currencies, payment methods and household members each carry `in_use` in their list responses. The endpoints refuse to delete an entry that subscriptions still reference and name what is in the way.

## Known bugs in the API

- `all-user-subscription=1` combined with any filter builds `SELECT * FROM subscriptions AND ...`, which is a syntax error and fatals. Do not combine them.
- `payment_method` as a list filter is accepted and ignored (see above).
- `get_ical_feed` ignores `convert_currency` in practice (see above).

## Endpoint map

```
api/admin/            get_admin_settings, set_admin_settings, get_oidc_settings,
                      set_oidc_settings, set_disable_password_login
api/categories/       get_categories, set_categories
api/currencies/       get_currencies, set_currencies
api/fixer/            get_fixer, set_fixer
api/household/        get_household, set_household
api/notifications/    get_notification_settings          (no setter exists)
api/payment_methods/  get_payment_methods, set_payment_methods
api/settings/         get_settings, set_settings
api/status/           version
api/subscriptions/    get_subscriptions, get_subscription, set_subscriptions,
                      get_monthly_cost, get_period_budget, get_ical_feed
api/users/            get_user, set_budget
```

Reads accept GET or POST; `set_*` endpoints accept POST only. The `set_*` endpoints share a shape: `action=add|edit|delete`, with `id` required for edit and delete. Successful adds return the new id under a per-endpoint name — `categoryId`, `currencyId`, `paymentId`, `memberId`, `subscriptionId`.

`get_currencies.php` returns `main_currency` beside the list; it is the id a subscription falls back to.
