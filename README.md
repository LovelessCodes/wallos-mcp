# wallos-mcp

An [MCP](https://modelcontextprotocol.io) server for [Wallos](https://github.com/ellite/Wallos), the open-source, self-hostable subscription tracker. It lets an assistant answer the questions you actually have about your subscriptions — what am I paying for, what is due next, how much did last month cost, am I inside my budget — and change them: add a subscription, cancel one, rename a category, set a budget.

It runs as a local process over stdio, started by your MCP client:

```jsonc
{
  "mcpServers": {
    "wallos": {
      "command": "npx",
      "args": ["-y", "wallos-mcp"],
      "env": {
        "WALLOS_URL": "https://wallos.example.com",
        "WALLOS_API_KEY": "your-api-key"
      }
    }
  }
}
```

## Why a local server

Your Wallos API key carries the same authority as your password. Nothing here sends it anywhere except to the instance you name, and there is no third party in the path.

It also means the instance never has to be reachable from the internet. A box on your LAN at `http://192.168.1.10:8282`, or a container on `http://localhost:8282`, works exactly as well as a public hostname — which is not true of a hosted or edge-deployed MCP server.

## Requirements

- **Node 20 or newer.**
- **Wallos v5.0.0 or newer**, which is where the API-key HTTP API that this server uses was added. Everything except the budget tools works from there. `get_period_budget` and `update_budget` arrived in **v5.3.0** and will simply fail on an older instance.
- Verified end to end against **Wallos v5.8.3**, including a full create / read / update / delete round trip.

### Getting your API key

In Wallos, open **Profile** and find the **API Key** field. Generate one if it is empty. The key is a long hex string; treat it like a password.

## Setup

The JSON above is the shape almost every MCP client takes. A few specifics:

**Claude Code**

```bash
claude mcp add wallos \
  --env WALLOS_URL=https://wallos.example.com \
  --env WALLOS_API_KEY=your-api-key \
  -- npx -y wallos-mcp
```

**Claude Desktop** — put the JSON block at the top of this file into `claude_desktop_config.json` (`Settings → Developer → Edit Config`) and restart the app.

**Cursor, Cline, Windsurf, Zed and friends** — the same `mcpServers` block goes in that client's MCP settings file. If the client has a "command / args / env" form, fill it in as `npx`, `-y wallos-mcp`, and the two environment variables.

**Behind a self-signed certificate** — add `"WALLOS_INSECURE_TLS": "true"`. Most self-hosted instances have one, and Node refuses them by default with `DEPTH_ZERO_SELF_SIGNED_CERT`.

**Just want to ask questions, not change anything** — set `"WALLOS_READ_ONLY": "true"` and the tools that write are never even offered to the model.

## What it can do

**Subscriptions**

| Tool | |
|---|---|
| `list_subscriptions` | What you pay for, filtered by category, payment method, household member or active state |
| `get_subscription` | One subscription in full |
| `create_subscription` | Add one |
| `update_subscription` | Change fields, leaving everything else alone |
| `delete_subscription` | Remove one (says what it removed) |
| `get_monthly_cost` | What a calendar month cost, converted to your main currency |
| `get_period_budget` | Budget, projected spend for the period, and what is left |
| `get_ical_feed` | The calendar export |

**Categories, currencies, payment methods, household**

| Tool | |
|---|---|
| `get_master_data` | All four lists with their ids, in one call |
| `manage_category` | add / rename / delete |
| `manage_currency` | add / edit / delete |
| `manage_payment_method` | add / rename / enable / delete |
| `manage_household` | add / edit / delete |

**Account and settings**

| Tool | |
|---|---|
| `get_account` | Who the key belongs to, main currency, budgets, instance version |
| `get_settings`, `update_settings` | Display preferences |
| `get_notification_settings` | Which channels are configured |
| `get_fixer_settings`, `update_fixer_settings` | Exchange rate provider |
| `update_budget` | Monthly budget, or a rolling period budget |

**Instance administration** — not registered at all unless you pass `WALLOS_ENABLE_ADMIN_TOOLS=true`. These change how *everyone* signs in and how the instance sends mail, so they are opt-in and each one says what a mistake costs: `get_admin_settings`, `update_admin_settings`, `get_oidc_settings`, `update_oidc_settings`, `set_password_login_disabled`.

### Names instead of ids

The Wallos API takes integer ids. You and your assistant have names, so the tools accept either:

```
create_subscription name="Netflix" price=15.99 category=Entertainment payment_method=Visa payer=Alice
```

`category`, `payment_method` and `payer` are matched case-insensitively against your instance's own lists and **created when missing**, so an instance with no categories yet still works. Pass `create_missing: false` to get an error listing what does exist instead. A numeric id always wins if you pass one.

### Human billing periods

Instead of Wallos's raw `cycle` (1–4) plus `frequency`, these tools take what people say:

```
billing_period: "monthly" | "weekly" | "biweekly" | "quarterly" | "yearly"
                "semiannually" | "every 10 days" | "every 3 months"
```

The raw `cycle` and `frequency` still work when you want them.

### Next payment dates that make sense

Wallos requires a `next_payment` on every subscription, and a date in the past means the subscription is overdue the moment it is created. When you do not supply one it is derived from the start date, advanced whole periods until it lands in the future — counting from the original day of the month, so a subscription that started on the 31st bills on the 31st in long months and clamps to the 30th only where the month is short.

## Configuration

Every setting has both a flag and an environment variable; MCP clients usually take the environment variable.

| Flag | Environment variable | Default | |
|---|---|---|---|
| `--url <url>` | `WALLOS_URL` | — | Your instance, e.g. `https://wallos.example.com`, `http://192.168.1.10:8282`, or `https://example.com/wallos` |
| `--api-key <key>` | `WALLOS_API_KEY` | — | From Profile → API Key |
| `--timeout <ms>` | `WALLOS_TIMEOUT_MS` | `30000` | Per-request timeout |
| `--read-only` | `WALLOS_READ_ONLY` | off | Register no tool that can change anything |
| `--admin-tools` | `WALLOS_ENABLE_ADMIN_TOOLS` | off | Add the five instance-wide admin tools |
| `--insecure-tls` | `WALLOS_INSECURE_TLS` | off | Accept a self-signed certificate |
| `--help` / `--version` | | | |

Run it by hand to check your settings:

```bash
npx -y wallos-mcp --url https://wallos.example.com --api-key "$KEY" --read-only
```

It prints one line to stderr when it connects. Your MCP client shows stderr as server logs, which is the first place to look when something is wrong.

## Safety

- **Read-only mode** removes the write tools from the tool list entirely, rather than offering them and refusing. A model cannot call what it cannot see.
- **Admin tools are off by default.** Disabling password login or pointing OIDC at a wrong issuer can lock you out of your own instance, so those tools only appear when you ask for them.
- **Credentials are masked on the way out.** Notification tokens, SMTP passwords, OIDC client secrets and webhook URLs are replaced with `********` in tool results, and the configured API key is scrubbed from error messages. Some of this Wallos already does; this server does it regardless.
- **Reads are distinguished from writes** in the tool metadata (`readOnlyHint`, `destructiveHint`), which clients use to decide what to ask you about.
- `delete_subscription` reads the subscription first, so the confirmation names what was deleted and a bad id fails before anything is destroyed. To stop paying for something while keeping its history, prefer `inactive: true` over deleting it.

## Notes on the Wallos API

A few things about this API are easy to get wrong, and this server handles them so you do not have to:

- **Every response is HTTP 200**, authentication failures included. `success` in the body is the only signal, and it is what decides whether a call succeeded.
- **Writes only read `$_POST`**, so request bodies are form-encoded. A JSON body arrives empty and the endpoint reports a missing API key.
- **Some flags are compared with `=== 'true'`.** `convert_currency=1` is silently ignored and returns unconverted prices; the flag has to be the literal string `true`. Other flags really are `1`/`0`.
- **The subscription list filter is `payment`, not `payment_method`**, whatever the documentation says.
- **`get_monthly_cost` returns money as a display string** — `"1,234.56"` — which is not a number until it is parsed. This server returns both the parsed figure and the original.
- **The calendar feed answers with a VCALENDAR document**, not JSON, despite the `Content-Type` header.

These were confirmed against a running instance and are written up in [docs/wallos-api-notes.md](docs/wallos-api-notes.md).

## Development

```bash
npm install
npm run build        # tsc -p tsconfig.build.json
npm run typecheck    # src, tests and scripts
npm test             # 96 tests, fetch stubbed
```

There is also an end-to-end run that starts the built server as a child process and speaks MCP to it, against a real instance:

```bash
WALLOS_URL=https://wallos.example.com WALLOS_API_KEY=... npm run e2e
WALLOS_URL=... WALLOS_API_KEY=... npm run e2e -- --write
```

The first pass only reads. `--write` additionally creates a category, a payment method, a household member and a subscription, checks them, and removes them again.

## License

MIT. Wallos itself is GPL-3.0; nothing from it is copied here, only its documented HTTP API is called.
